import {DockerDaemon} from '../../src/sandbox-broker.ts';
import type {Ledger} from '../../src/ledger.ts';

/** Clean only resources journaled by this disposable test database. Errors are
 * collected so a failed cleanup cannot mask the original test failure. */
export async function cleanupGraphResources(db:Ledger,image:string){
 const docker=new DockerDaemon(),errors:unknown[]=[];
 const present=(await db.pool.query("SELECT to_regclass('ac_native_execution_jobs') AS name")).rows[0]?.name;
 if(!present)return;
 const jobs=(await db.pool.query('SELECT id,worker_id,tools_id,network_id FROM ac_native_execution_jobs')).rows;
 for(const job of jobs){
  for(const id of [job.worker_id,job.tools_id])if(id)try{
   const container=await docker.inspect(id);if(!container)continue;
   if(container.Config.Labels['agent-control.job']!==job.id||container.Image!==image)throw Error('FIXTURE_CONTAINER_IDENTITY_MISMATCH');
   if(container.State.Running)await docker.stop(id);await docker.remove(id);
   if(await docker.inspect(id))throw Error('FIXTURE_CONTAINER_REMAINS');
  }catch(error){errors.push(error);}
  if(job.network_id)try{
   const network=await docker.inspectPrivateNetwork(job.network_id);if(!network)continue;
   if(network.Labels?.['agent-control.job']!==job.id||Object.keys(network.Containers??{}).length)throw Error('FIXTURE_NETWORK_IDENTITY_MISMATCH');
   await docker.removePrivateNetwork(job.network_id);if(await docker.inspectPrivateNetwork(job.network_id))throw Error('FIXTURE_NETWORK_REMAINS');
  }catch(error){errors.push(error);}
 }
 if(errors.length)throw new AggregateError(errors,'NATIVE_GRAPH_CLEANUP_FAILED');
}

/** The parent accepts only its private manifest and its preallocated area. */
export async function readGraphManifest(path:string,root:string){
 const {lstat,readFile}=await import('node:fs/promises');const {join}=await import('node:path');
 const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600)throw Error('INVALID_GRAPH_MANIFEST');
 const value=JSON.parse(await readFile(path,'utf8')),actual=new URL(value.url),base=new URL(process.env.AC_TEST_DATABASE_URL!);
 if(actual.protocol!==base.protocol||actual.host!==base.host||actual.username!==base.username||actual.password!==base.password||actual.search!==base.search||
    !/^\/ac_implementation_test_nativemulti_[a-f0-9]{20}$/.test(actual.pathname)||value.area!==join(root,'native-multi-fixture'))throw Error('INVALID_GRAPH_MANIFEST');
 return value as {url:string;area:string;context:null};
}

export async function cleanupGraphFixture(manifest:{url:string;area:string},image:string,db?:Ledger){
 const {default:pg}=await import('pg');const {rm}=await import('node:fs/promises');
 const admin=new pg.Pool({connectionString:process.env.AC_TEST_DATABASE_URL});const name=new URL(manifest.url).pathname.slice(1);
 try{
  const exists=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount;
  if(exists){const cleanupDb=db??new (await import('../../src/ledger.ts')).Ledger(manifest.url);try{await cleanupGraphResources(cleanupDb,image);}finally{await cleanupDb.close();}
   await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[name]);await admin.query(`DROP DATABASE "${name}"`);}
  else await db?.close();
 }finally{await admin.end();}
 await rm(manifest.area,{recursive:true,force:true});
}
