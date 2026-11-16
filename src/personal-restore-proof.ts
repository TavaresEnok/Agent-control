import {randomUUID} from 'node:crypto';
import {chmod,lstat,readdir,rename,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {Refusal} from './contracts.ts';
import {loadInstallation} from './installation.ts';
import {databaseEndpoint,dockerListing,dumpProcessEnv,personalPgContainer,spawnCollected,verifyBackupManifest} from './personal-backup.ts';
import {deliverPersonalPush} from './personal-push.ts';

export const restoreProofFailedNotice='A prova mensal de restauração do backup falhou.';
const stamp=/^\d{8}-\d{6}$/;

export type RestoreProofDeps={
 now?:()=>Date;
 notify?:(dataDirectory:string,body:string)=>Promise<void>;
 dockerPs?:()=>Promise<string>;
 /** Loads database.dump into the named empty database. */
 restore?:(dumpFile:string,database:string)=>Promise<void>;
};

/** The newest dated backup folder, then the single backup folder inside it. */
export async function newestBackup(root:string){
 const dated=(await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&stamp.test(entry.name)).map(entry=>entry.name).sort();
 const latest=dated.at(-1);
 if(!latest)throw new Refusal('RESTORE_PROOF_NO_BACKUP');
 const inner=(await readdir(join(root,latest),{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith('agent-control-'));
 if(inner.length!==1)throw new Refusal('RESTORE_PROOF_NO_BACKUP');
 return join(root,latest,inner[0]!.name);
}

function proofDatabaseName(now:Date){
 return 'ac_restore_proof_'+now.toISOString().replace(/[^0-9]/g,'').slice(0,14);
}

async function writeResult(dataDirectory:string,result:unknown){
 const path=join(dataDirectory,'restore-proof.json');
 const temporary=`${path}.${randomUUID()}.tmp`;
 await writeFile(temporary,JSON.stringify(result)+'\n',{mode:0o600,flag:'wx'});
 await chmod(temporary,0o600);
 await rename(temporary,path);
}

/** Restores the newest backup into a new, throwaway database on the same server, counts the main tables, and drops it.
 * The installation's own database is only read for its address. A failure sends one phone notice. */
export async function runPersonalRestoreProof(argv:string[],deps:RestoreProofDeps={}){
 const [installationArg,backupRootArg]=argv;
 if(!installationArg||!backupRootArg||argv.length!==2||argv.some(arg=>arg.startsWith('--')))throw new Refusal('RESTORE_PROOF_USAGE');
 const config=await loadInstallation(resolve(installationArg));
 if(config.activation!=='personal')throw new Refusal('RESTORE_PROOF_PERSONAL_REQUIRED');
 const now=(deps.now??(()=>new Date()))();
 const notify=deps.notify??((dataDirectory,body)=>deliverPersonalPush(dataDirectory,{messageId:'restore-proof-'+randomUUID(),title:'Agent Control',body,url:'/'}));
 const db=databaseEndpoint(config.databaseUrl);
 const database=proofDatabaseName(now);
 if(database===db.database)throw new Refusal('RESTORE_PROOF_DATABASE_CONFLICT');
 const admin=new URL(config.databaseUrl);admin.pathname='/postgres';
 const target=new URL(config.databaseUrl);target.pathname='/'+database;
 let created=false,backup='';
 const pool=new pg.Pool({connectionString:admin.href,max:1,connectionTimeoutMillis:10_000});
 try{
  const root=resolve(backupRootArg);
  const info=await lstat(root).catch(()=>null);
  if(!info||info.isSymbolicLink()||!info.isDirectory())throw new Refusal('RESTORE_PROOF_NO_BACKUP');
  backup=await newestBackup(root);
  const files=await verifyBackupManifest(backup);
  await pool.query(`CREATE DATABASE "${database}"`);created=true;
  const dumpFile=join(backup,'database.dump');
  if(deps.restore)await deps.restore(dumpFile,database);
  else{
   const container=personalPgContainer(await dockerListing(deps.dockerPs),db.port);
   const plan=container?{command:'docker',args:['exec','-i','-e','PGPASSWORD',container,'pg_restore','--no-owner','--exit-on-error','-w','-U',db.user,'-d',database]}
    :{command:'pg_restore',args:['--no-owner','--exit-on-error','-w','-h',db.host,'-p',db.port,'-U',db.user,'-d',database]};
   const result=await spawnCollected(plan.command,plan.args,dumpProcessEnv(process.env,db),dumpFile,null,30*60*1000);
   if(result.code!==0)throw new Refusal('RESTORE_PROOF_RESTORE_FAILED');
  }
  const restored=new pg.Client({connectionString:target.href,connectionTimeoutMillis:10_000});
  await restored.connect();
  let counts:{projects:number;contexts:number;intents:number};
  try{
   const row=(await restored.query('SELECT (SELECT count(*) FROM ac_projects)::int projects,(SELECT count(*) FROM ac_contexts)::int contexts,(SELECT count(*) FROM ac_intents)::int intents')).rows[0];
   counts={projects:Number(row.projects),contexts:Number(row.contexts),intents:Number(row.intents)};
  }finally{await restored.end();}
  if(counts.projects<1||counts.contexts<1)throw new Refusal('RESTORE_PROOF_EMPTY');
  await writeResult(config.dataDirectory,{at:now.toISOString(),ok:true,backup,files,...counts});
  return [`Backup ${backup} restaurado num banco descartável.`,`${files} arquivos conferidos; ${counts.projects} projetos, ${counts.contexts} conversas e ${counts.intents} pedidos.`];
 }catch(error){
  const code=error instanceof Refusal?error.code:'RESTORE_PROOF_FAILED';
  try{await writeResult(config.dataDirectory,{at:now.toISOString(),ok:false,backup,code});}catch{/* the notice still goes */}
  try{await notify(config.dataDirectory,restoreProofFailedNotice);}catch{/* reported by the exit code */}
  throw error instanceof Refusal?error:new Refusal(code);
 }finally{
  if(created)await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(()=>{});
  await pool.end();
 }
}
