import {constants} from 'node:fs';
import {lstat,open,readFile,readdir,realpath} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve,sep} from 'node:path';
import type {Ledger} from './ledger.ts';
import type {Installation} from './installation.ts';
import {projectRepositoryIdentity} from './project-repository.ts';
import {digest} from './contracts.ts';
import pg from 'pg';

type Status='ok'|'blocked'|'unknown';
type Check={code:'private_directory'|'browser_session_key'|'project_roots'|'git_repositories'|'cezar_web'|'database'|'migrations'|'registered_projects';status:Status};
export type InstallationReadiness={schemaVersion:1;mode:'administration-only';checks:Check[]};
type DatabaseClient=Pick<pg.Client,'connect'|'end'|'query'|'connection'>;
const exec=promisify(execFile),timeoutMs=3000;
async function timed<T>(promise:Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('READINESS_TIMEOUT')),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);}
}
async function privateDir(path:string):Promise<boolean>{
 if(resolve(path)!==path||await realpath(path)!==path)return false;
 const info=await lstat(path),uid=process.getuid?.();
 return uid!==undefined&&info.isDirectory()&&!info.isSymbolicLink()&&info.uid===uid&&(info.mode&0o077)===0;
}
async function sessionKey(path:string):Promise<boolean>{
 const handle=await open(join(path,'browser-session.key'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await handle.stat(),uid=process.getuid?.();
  return uid!==undefined&&info.isFile()&&info.nlink===1&&info.uid===uid&&(info.mode&0o077)===0&&info.size===32;
 }finally{await handle.close();}
}
async function projectRoot(path:string):Promise<boolean>{
 if(resolve(path)!==path||await realpath(path)!==path)return false;
 const info=await lstat(path),uid=process.getuid?.();
 return uid!==undefined&&info.isDirectory()&&!info.isSymbolicLink()&&info.uid===uid&&(info.mode&0o022)===0;
}
async function repository(path:string):Promise<boolean>{
 await projectRepositoryIdentity(path);
 const result=await exec('/usr/bin/git',['--no-optional-locks','-c','core.hooksPath=/dev/null','-C',path,'rev-parse','--show-toplevel'],{
  env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'},timeout:timeoutMs,maxBuffer:8192});
 return result.stdout.trim()===path;
}
async function webDistribution():Promise<boolean>{
 const root=await realpath(resolve('upstream/cezar/packages/cezar/web/dist'));
 const index=await realpath(join(root,'index.html'));
 if(!index.startsWith(root+sep))return false;
 const stat=await lstat(index);if(!stat.isFile()||stat.size<1||stat.size>1024*1024)return false;
 const html=await readFile(index,'utf8');
 const files=[...html.matchAll(/(?:src|href)=["']\/?assets\/([A-Za-z0-9_.-]+\.(?:js|css))["']/g)].map(match=>match[1]!);
 if(!files.some(file=>file.endsWith('.js')))return false;
 for(const file of files){const asset=await realpath(join(root,'assets',file));
  if(!asset.startsWith(join(root,'assets')+sep)||(await lstat(asset)).size===0||!(await lstat(asset)).isFile())return false;
 }
 return true;
}
async function migrationDigests(){
 const dir=new URL('../db/migrations/',import.meta.url),files=(await readdir(dir)).filter(name=>/^\d+_.+\.sql$/.test(name)).sort();
 if(!files.length)throw Error('MIGRATIONS_UNAVAILABLE');
 const values=new Map<number,string>();
 for(const name of files){const version=Number(name.split('_')[0]);if(values.has(version))throw Error('DUPLICATE_MIGRATION');
  values.set(version,digest(await readFile(new URL(name,dir),'utf8')));}
 return values;
}
function filesystemStatus(fn:()=>Promise<boolean>):Promise<Status>{return timed(fn()).then(ok=>ok?'ok':'blocked',error=>{
 const code=(error as NodeJS.ErrnoException).code;
 if((error as Error).message==='READINESS_TIMEOUT'||code==='EACCES'||code==='EPERM')return 'unknown';
 return 'blocked';
});}
/** Reports local evidence only; it never initializes the installation or starts a runtime. */
export async function inspectInstallationReadiness(ledger:Ledger,config:Installation,options?:{clientFactory?:(url:string)=>DatabaseClient}):Promise<InstallationReadiness>{
 const projects=[config.project,...config.projects];
 const [privateStatus,keyStatus,rootsStatus,reposStatus,webStatus]=await Promise.all([
  filesystemStatus(()=>privateDir(config.dataDirectory)),filesystemStatus(async()=>await privateDir(config.dataDirectory)&&await sessionKey(config.dataDirectory)),
  filesystemStatus(async()=>(await Promise.all(config.projectRoots.map(root=>projectRoot(root.path)))).every(Boolean)),
  filesystemStatus(async()=>(await Promise.all(projects.map(project=>repository(project.repo)))).every(Boolean)),
  filesystemStatus(webDistribution),
 ]);
 let database:Status='unknown',migrations:Status='unknown',registered:Status='unknown',registeredRepos:Status='unknown';
 let client:DatabaseClient|undefined;
 try{
  if(ledger.pool.options.connectionString!==config.databaseUrl)throw Error('READINESS_DATABASE_MISMATCH');
  client=options?.clientFactory?.(config.databaseUrl)??new pg.Client({connectionString:config.databaseUrl,connectionTimeoutMillis:timeoutMs,query_timeout:timeoutMs,statement_timeout:timeoutMs});
  const databaseCall=async<T>(promise:Promise<T>)=>{
   try{return await timed(promise);}catch(error){if((error as Error).message==='READINESS_TIMEOUT')client?.connection.stream.destroy();throw error;}
  };
  await databaseCall(client.connect());
  await databaseCall(client.query('SELECT 1'));database='ok';
  try{
   const expected=await timed(migrationDigests());
   const result=await databaseCall(client.query('SELECT version,digest FROM ac_schema_migrations ORDER BY version'));
   migrations=result.rows.length===expected.size&&result.rows.every(row=>expected.get(Number(row.version))===row.digest)?'ok':'blocked';
  }catch(error){migrations=(error as {code?:string}).code==='42P01'?'blocked':'unknown';}
  try{
   const result=await databaseCall(client.query({text:`SELECT count(*)::int AS matched FROM unnest($1::uuid[],$2::text[],$3::text[]) AS e(id,repo,owner)
    JOIN ac_projects p ON p.id=e.id JOIN ac_project_repositories r ON r.project_id=p.id AND r.repo=e.repo
    JOIN ac_memberships m ON m.project_id=p.id AND m.principal_id=e.owner AND m.role='owner'`,
    values:[projects.map(p=>p.id),projects.map(p=>p.repo),projects.map(p=>p.owner)]}));
   registered=result.rows[0]?.matched===projects.length?'ok':'blocked';
  }catch(error){registered=(error as {code?:string}).code==='42P01'?'blocked':'unknown';}
  try{
   const result=await databaseCall(client.query('SELECT repo FROM ac_project_repositories ORDER BY project_id LIMIT 1001'));
   if(result.rows.length>1000)registeredRepos='unknown';
   else{
    registeredRepos='ok';const deadline=Date.now()+timeoutMs;
    for(const row of result.rows){
     if(Date.now()>=deadline){registeredRepos='unknown';break;}
     if(typeof row.repo!=='string'||config.dataDirectory===row.repo||config.dataDirectory.startsWith(row.repo+sep)){registeredRepos='blocked';break;}
     const status=await filesystemStatus(()=>repository(row.repo));if(status!=='ok'){registeredRepos=status;break;}
    }
   }
  }catch(error){registeredRepos=(error as {code?:string}).code==='42P01'?'blocked':'unknown';}
 }catch{database='unknown';}
 finally{if(client){try{await timed(client.end());}catch{client.connection.stream.destroy();}}}
 return {schemaVersion:1,mode:'administration-only',checks:[
  {code:'private_directory',status:privateStatus},{code:'browser_session_key',status:keyStatus},{code:'project_roots',status:rootsStatus},
  {code:'git_repositories',status:reposStatus==='ok'?registeredRepos:reposStatus},{code:'cezar_web',status:webStatus},{code:'database',status:database},
  {code:'migrations',status:migrations},{code:'registered_projects',status:registered},
 ]};
}
