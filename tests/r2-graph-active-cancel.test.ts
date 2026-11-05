import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {DockerDaemon} from '../src/sandbox-broker.ts';
import {cleanupGraphFixture,readGraphManifest} from './fixtures/native-graph-cleanup.ts';

test('successor cancels a programmer still physically running after controller SIGKILL',{timeout:120000,skip:!(process.env.AC_TEST_DATABASE_URL&&process.env.AC_TEAM_GRAPH_IMAGE&&process.env.AC_TEAM_GRAPH_NETWORK)},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-graph-active-')),initial=join(root,'initial.json'),marker=join(root,'active.json');let db:Ledger|undefined,runtime:CezarRuntime|undefined,primary:unknown;
 const env:NodeJS.ProcessEnv={...process.env,AC_TEAM_GRAPH_INITIAL_MANIFEST:initial,AC_R2_GRAPH_ACTIVE_MARKER:marker};delete env.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--import','tsx','tests/r2-graph-physical.test.ts'],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=String(x));child.stderr.on('data',x=>output+=String(x));const closed=new Promise<void>(r=>child.once('close',()=>r()));
 try{
  let info:any;for(let i=0;i<500;i++){try{info=JSON.parse(await readFile(marker,'utf8'));break;}catch{}if(child.exitCode!==null)throw Error('CHILD_FAILED '+output);await new Promise(r=>setTimeout(r,100));}assert(info,'ACTIVE_MARKER_MISSING '+output);
  const manifest=await readGraphManifest(initial,root);assert.equal(info.url,manifest.url);db=new Ledger(info.url);const docker=new DockerDaemon();
  const job=(await db.pool.query('SELECT worker_id,tools_id,network_id,intent_id,grant_id FROM ac_native_execution_jobs WHERE id=$1',[info.jobId])).rows[0];assert(job);assert.equal((await docker.inspect(job.worker_id))?.State.Running,true);
  child.kill('SIGKILL');await closed;assert.equal(child.signalCode,'SIGKILL');assert.equal((await docker.inspect(job.worker_id))?.State.Running,true);
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[info.context]);const next=await db.acquire(info.principal,info.context,randomUUID(),'fixture-manager',60);await assert.rejects(db.tx(c=>db!.fence(c,info.authority)),/STALE_MANAGER/);
  const intents=(await db.pool.query('SELECT DISTINCT i.* FROM ac_intents i JOIN ac_native_execution_jobs j ON j.intent_id=i.id WHERE j.context_id=$1',[info.context])).rows;
  for(const intent of intents)await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[intent.id,info.context,info.principal,intent.plan_revision]);
  const supervisor=new NativeExecutionSupervisor(db,info.supervisorConfig);runtime=new CezarRuntime(db,info.repo,info.project,undefined,undefined,undefined,{nativeExecutions:[supervisor]});await runtime.start('administration-only');
  let terminal=false;for(let i=0;i<60;i++){await runtime.reconcileCancellations(next,info.principal);const row=(await db.pool.query('SELECT j.state,g.state grant_state,w.state writer_state FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_intents i ON i.id=j.intent_id JOIN ac_worktree_writers w ON w.parent_intent_id=i.parent_intent_id AND w.run_id=i.run_id WHERE j.id=$1',[info.jobId])).rows[0];if(row?.state==='failed'&&row.grant_state==='released'&&row.writer_state==='neutralized'){terminal=true;break;}await new Promise(r=>setTimeout(r,500));}assert(terminal,'ACTIVE_CANCEL_NOT_RECONCILED');
  assert.equal(await docker.inspect(job.worker_id),null);assert.equal(await docker.inspect(job.tools_id),null);assert.equal(await docker.inspectPrivateNetwork(job.network_id),null);assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs WHERE id=$1',[info.jobId])).rows[0].n,1);
  console.log(JSON.stringify({controller:'SIGKILL',boundary:'worker running',sameJob:info.jobId,cancellation:'reconciled',grant:'released',writer:'neutralized',worker:'absent',network:'absent',modelCalls:0,request:'fixture-inserted'}));
 }catch(error){primary=error;}finally{const errors:unknown[]=[];try{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}await runtime?.close();}catch(e){errors.push(e);}let manifest;try{manifest=await readGraphManifest(initial,root);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')errors.push(e);}if(manifest){try{await cleanupGraphFixture(manifest,process.env.AC_TEAM_GRAPH_IMAGE!,db);db=undefined;}catch(e){errors.push(e);db=undefined;}}if(db)try{await db.close();}catch(e){errors.push(e);}if(!errors.length)try{await rm(root,{recursive:true,force:true});}catch(e){errors.push(e);}if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'ACTIVE_GRAPH_CLEANUP_FAILED');}if(primary)throw primary;
});
