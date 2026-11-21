import {randomUUID} from 'node:crypto';
import {chmod,lstat,readdir,rename,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import pg from 'pg';
import {Refusal} from './contracts.ts';
import {loadInstallation} from './installation.ts';
import {databaseEndpoint,databaseRestorePlan,dumpProcessEnv,resolvePgInstance,spawnCollected,verifyBackupManifest} from './personal-backup.ts';
import {deliverPersonalPush} from './personal-push.ts';

export const restoreProofFailedNotice='A prova mensal de restauração do backup falhou.';
export const restoreProofCleanupFailedNotice='A prova de restauração terminou, mas o banco descartável não foi removido.';
const stamp=/^\d{8}-\d{6}$/;

export type RestoreProofDeps={
 now?:()=>Date;
 notify?:(dataDirectory:string,body:string)=>Promise<void>;
 dockerPs?:()=>Promise<string>;
 /** Loads database.dump into the named empty database. */
 restore?:(dumpFile:string,database:string)=>Promise<void>;
 /** Runs the restore command. The default spawns the command with the dump on stdin. */
 run?:(command:string,args:string[],env:NodeJS.ProcessEnv,dumpFile:string)=>Promise<{code:number;stderr:string}>;
 /** The server that holds the throwaway database. Create, count and drop all go through it. */
 server?:ProofServer;
};

export type ProofServer={
 create:(database:string)=>Promise<void>;
 count:(database:string)=>Promise<{projects:number;contexts:number;intents:number}>;
 drop:(database:string)=>Promise<void>;
 close:()=>Promise<void>;
};

function postgresProofServer(databaseUrl:string):ProofServer{
 const admin=new URL(databaseUrl);admin.pathname='/postgres';
 const pool=new pg.Pool({connectionString:admin.href,max:1,connectionTimeoutMillis:10_000});
 return {
  create:async database=>{await pool.query(`CREATE DATABASE "${database}"`);},
  count:async database=>{
   const target=new URL(databaseUrl);target.pathname='/'+database;
   const restored=new pg.Client({connectionString:target.href,connectionTimeoutMillis:10_000});
   await restored.connect();
   try{
    const row=(await restored.query('SELECT (SELECT count(*) FROM ac_projects)::int projects,(SELECT count(*) FROM ac_contexts)::int contexts,(SELECT count(*) FROM ac_intents)::int intents')).rows[0];
    return {projects:Number(row.projects),contexts:Number(row.contexts),intents:Number(row.intents)};
   }finally{await restored.end();}
  },
  drop:async database=>{await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);},
  close:async()=>{await pool.end();},
 };
}


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
 * One instance (see `resolvePgInstance`) serves create, restore, count and drop. The installation's own database is only read for its address.
 * A failure sends one phone notice. A failed drop is recorded apart from the proof result. */
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
 let created=false,backup='';
 const server=deps.server??postgresProofServer(config.databaseUrl);
 let failure:unknown=null;
 let proved:{files:number;counts:{projects:number;contexts:number;intents:number}}|null=null;
 try{
  const root=resolve(backupRootArg);
  const info=await lstat(root).catch(()=>null/* absent → null, the caller handles it */);
  if(!info||info.isSymbolicLink()||!info.isDirectory())throw new Refusal('RESTORE_PROOF_NO_BACKUP');
  backup=await newestBackup(root);
  const files=await verifyBackupManifest(backup);
  await server.create(database);created=true;
  const dumpFile=join(backup,'database.dump');
  if(deps.restore)await deps.restore(dumpFile,database);
  else{
   const container=await resolvePgInstance(db,deps.dockerPs);
   const plan=databaseRestorePlan(container,db,database);
   const env=dumpProcessEnv(process.env,db);
   const result=await (deps.run?deps.run(plan.command,plan.args,env,dumpFile):spawnCollected(plan.command,plan.args,env,dumpFile,null,30*60*1000));
   if(result.code!==0)throw new Refusal('RESTORE_PROOF_RESTORE_FAILED');
  }
  const counts=await server.count(database);
  if(counts.projects<1||counts.contexts<1)throw new Refusal('RESTORE_PROOF_EMPTY');
  proved={files,counts};
 }catch(error){failure=error;}
 let cleanupFailed=false;
 if(created){
  try{await server.drop(database);}catch{cleanupFailed=true;}
 }
 await server.close().catch(()=>{/* best-effort close; the result was already decided */});
 const cleanup=created?(cleanupFailed?{ok:false,database,code:'RESTORE_PROOF_CLEANUP_FAILED'}:{ok:true}):undefined;
 if(failure===null&&proved){
  try{
   await writeResult(config.dataDirectory,{at:now.toISOString(),ok:true,backup,files:proved.files,...proved.counts,...(cleanup?{cleanup}:{})});
  }catch(error){failure=error;}
 }
 if(failure===null&&proved){
  const lines=[`Backup ${backup} restaurado num banco descartável.`,`${proved.files} arquivos conferidos; ${proved.counts.projects} projetos, ${proved.counts.contexts} conversas e ${proved.counts.intents} pedidos.`];
  if(cleanupFailed){
   try{await notify(config.dataDirectory,restoreProofCleanupFailedNotice);}catch{/* the line below still reports it */}
   lines.push(`ATENÇÃO: o banco descartável ${database} não foi removido. Remova-o à mão.`);
  }
  return lines;
 }
 const code=failure instanceof Refusal?failure.code:'RESTORE_PROOF_FAILED';
 try{await writeResult(config.dataDirectory,{at:now.toISOString(),ok:false,backup,code,...(cleanup?{cleanup}:{})});}catch{/* the notice still goes */}
 try{await notify(config.dataDirectory,restoreProofFailedNotice);}catch{/* reported by the exit code */}
 throw failure instanceof Refusal?failure:new Refusal(code);
}
