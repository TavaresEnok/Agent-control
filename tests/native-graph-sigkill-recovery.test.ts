import {cleanupGraphFixture,readGraphManifest} from './fixtures/native-graph-cleanup.ts';
import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash,createHmac} from 'node:crypto';
import {lstat,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import pg from 'pg';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {ProviderEligibility} from '../src/provider-eligibility.ts';
import {AccountHomes} from '../src/account-homes.ts';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {NativeImplementation} from '../src/native-implementation.ts';
import {NativeVerification} from '../src/native-verification.ts';
import type {NativeQa} from '../src/native-qa.ts';
import {Quality,VerificationReceipt} from '../src/quality.ts';
import {GitArtifacts} from '../src/git.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {canonical,digest,Refusal} from '../src/contracts.ts';

test('synthetic native graph resumes after controller SIGKILL at retired programmer boundary', {timeout:120000,skip:!(process.env.AC_TEST_DATABASE_URL&&process.env.AC_TEAM_GRAPH_IMAGE&&process.env.AC_TEAM_GRAPH_NETWORK)},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-graph-kill-')),marker=join(root,'marker.json'),initial=join(root,'initial.json');let info:any,db:Ledger|undefined,runtime:CezarRuntime|undefined,primary:unknown;
 const childEnv:NodeJS.ProcessEnv={...process.env,AC_TEAM_GRAPH_CRASH_MARKER:marker,AC_TEAM_GRAPH_INITIAL_MANIFEST:initial};delete childEnv.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--import','tsx','tests/native-graph-physical-recovery.test.ts'],{env:childEnv,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=String(x));child.stderr.on('data',x=>output+=String(x));
 const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
 try{
  for(let i=0;i<400;i++){try{info=JSON.parse(await readFile(marker,'utf8'));break;}catch{}if(child.exitCode!==null)throw Error('CHILD_FAILED '+output);await new Promise(r=>setTimeout(r,100));}
  assert(info,'SIGKILL marker missing '+output);const manifest=await readGraphManifest(initial,root);assert.equal(info.url,manifest.url);assert.equal(info.area,manifest.area);child.kill('SIGKILL');await closed;assert.equal(child.signalCode,'SIGKILL');
  db=new Ledger(info.url);await db.pause(info.principal,info.context,true);await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[info.context]);
  const next=await db.acquire(info.principal,info.context,randomUUID(),'fixture-manager',60);await assert.rejects(db.tx(c=>db!.fence(c,info.authority)),/STALE_MANAGER/);
  const supervisor=new NativeExecutionSupervisor(db,info.supervisorConfig),quality=new Quality(db,Buffer.from(info.verifierKey,'base64'),new GitArtifacts(info.repo));
  mock.method(ProviderEligibility.prototype,'view',async()=>({accountId:info.account,latest:{fresh:true,effectiveStatus:'documented_supported',provider:'codex',authenticationMode:'subscription_oauth',executionMode:'central_isolated_cli',adapterId:info.supervisorConfig.id,adapterVersion:supervisor.executorDigest,revision:1},history:[]}));
  mock.method(AccountHomes.prototype,'inspectGranted',async()=>({accountId:info.account,projectId:info.project,ownerId:info.principal,uid:'1',device:'1',inode:'1'}));
  const reserve=Capacity.prototype.reserve;mock.method(Capacity.prototype,'reserve',async function(this:Capacity,...args:Parameters<Capacity['reserve']>){try{await db!.pool.query("UPDATE ac_accounts SET mode='synthetic' WHERE id=$1",[info.account]);return await reserve.apply(this,args);}finally{await db!.pool.query("UPDATE ac_accounts SET mode='subscription_cli' WHERE id=$1",[info.account]);}});
  const nativeQa={ledger:db,quality,verifierDigest:info.qaDigest,reconcileContext:async()=>{},async run(owner:string,intent:{id:string;context_id:string},a:typeof next,stage:{id:string;session_id:string},grantId:string,artifact:{id:string;policy_revision:number;commit_id:string;tree_id:string;base_id:string}){
   const receipt=VerificationReceipt.parse({schemaVersion:1,id:randomUUID(),artifactId:artifact.id,kind:'qa',sessionId:stage.session_id,grantId,policyRevision:artifact.policy_revision,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,status:'passed',exitCode:0,verifierDigest:info.qaDigest,logSha256:createHash('sha256').update('substitute-pass').digest('hex'),commandDigest:digest({executor:'native-multitask-qa-substitute-v1'}),verifierVersion:'native-multitask-qa-substitute-v1'});
   const signature=createHmac('sha256',Buffer.from(info.verifierKey,'base64')).update(canonical(receipt)).digest('hex');await db!.tx(async c=>{await db!.authorize(c,owner,a.contextId);await db!.fence(c,a,true);const changed=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state='reserved' AND role='qa' RETURNING id",[grantId,{state:'exited',exitCode:0,source:'native-multitask-qa-substitute'}]);if(!changed.rowCount)throw new Refusal('GRANT_RECONCILIATION_REQUIRED');await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1",[stage.id,{verification:receipt,signature}]);});await quality.record(owner,receipt,signature,a);return receipt;
  }} as unknown as NativeQa;
  const git=new GitArtifacts(info.repo),implementation=new NativeImplementation(db,info.repo,quality,[supervisor]),verification=new NativeVerification(db,quality,[supervisor],Buffer.from(info.verifierKey,'base64'));
  runtime=new CezarRuntime(db,info.repo,info.project,{quality,git,qualityRevision:2,targetRef:'refs/heads/protected',verifierKey:Buffer.from(info.verifierKey,'base64'),allowedTargets:['refs/heads/protected'],nativeQa,nativeVerification:verification},undefined,undefined,{nativeExecutions:[supervisor],nativeImplementation:implementation});await runtime.start();
  const parent=(await db.pool.query('SELECT * FROM ac_intents WHERE id=$1',[info.parentId])).rows[0];await runtime.recoverManaged(next);assert.equal(runtime.store.getRun(parent.run_id)?.status,'waiting');
  await db.pause(info.principal,info.context,false);let done=false;for(let i=0;i<400;i++){await runtime.recoverManaged(next);const run=runtime.store.getRun(parent.run_id);if(run?.status==='failed')throw Error('RESUME_FAILED '+JSON.stringify({error:run.error,steps:run.steps}));if(run?.status==='done'){done=true;break;}await new Promise(r=>setTimeout(r,100));}
  assert(done,'graph did not resume');const jobs=(await db.pool.query('SELECT id,role,state FROM ac_native_execution_jobs ORDER BY role')).rows;assert.deepEqual(jobs.map(j=>[j.role,j.state]),[['programmer','completed'],['reviewer','completed']]);assert.equal(jobs[0].id,info.jobId);const writer=(await db.pool.query('SELECT state FROM ac_worktree_writers WHERE parent_intent_id=$1',[info.parentId])).rows;assert.deepEqual(writer.map(w=>w.state),['neutralized']);console.log(JSON.stringify({controller:'SIGKILL',pausePreserved:true,programmerJob:info.jobId,programmerJobs:1,reviewJobs:1,modelCalls:0,capacity:'substituted',qa:'substituted'}));
 }catch(error){primary=error;}finally{
  const errors:unknown[]=[];
  try{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}mock.restoreAll();await runtime?.close();}catch(error){errors.push(error);}
  let manifest:{url:string;area:string}|undefined;
  try{manifest=await readGraphManifest(initial,root);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')errors.push(error);}
  if(manifest){try{await cleanupGraphFixture(manifest,process.env.AC_TEAM_GRAPH_IMAGE!,db);db=undefined;}catch(error){errors.push(error);db=undefined;}}
  if(db)try{await db.close();}catch(error){errors.push(error);}
  if(!errors.length)try{await rm(root,{recursive:true,force:true});}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'NATIVE_GRAPH_CLEANUP_FAILED');
 }if(primary)throw primary;
});

test('initial private manifest permits cleanup before migration and final marker', {timeout:30000,skip:!(process.env.AC_TEST_DATABASE_URL&&process.env.AC_TEAM_GRAPH_IMAGE&&process.env.AC_TEAM_GRAPH_NETWORK)},async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-graph-early-')),initial=join(root,'initial.json');
 const env:NodeJS.ProcessEnv={...process.env,AC_TEAM_GRAPH_INITIAL_MANIFEST:initial,AC_TEAM_GRAPH_HOLD_INITIAL:'after-area'};delete env.NODE_TEST_CONTEXT;
 const child=spawn(process.execPath,['--import','tsx','tests/native-graph-physical-recovery.test.ts'],{env,stdio:['ignore','pipe','pipe']});let output='';child.stderr.on('data',x=>output+=String(x));const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));let primary:unknown,manifest:Awaited<ReturnType<typeof readGraphManifest>>|undefined;
 try{
  for(let i=0;i<200;i++){try{manifest=await readGraphManifest(initial,root);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(child.exitCode!==null)throw Error('CHILD_FAILED '+output);await new Promise(r=>setTimeout(r,50));}
  assert(manifest,'initial manifest missing');for(let i=0;i<200;i++){try{await readFile(join(manifest.area,'early-ready'));break;}catch{if(child.exitCode!==null)throw Error('CHILD_FAILED '+output);if(i===199)throw Error('EARLY_READY_MISSING');await new Promise(r=>setTimeout(r,50));}}child.kill('SIGKILL');await closed;assert.equal(child.signalCode,'SIGKILL');
  const admin=new pg.Pool({connectionString:process.env.AC_TEST_DATABASE_URL});try{assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[new URL(manifest.url).pathname.slice(1)])).rowCount,1);await cleanupGraphFixture(manifest,process.env.AC_TEAM_GRAPH_IMAGE!);assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[new URL(manifest.url).pathname.slice(1)])).rowCount,0);}finally{await admin.end();}
  await assert.rejects(lstat(manifest.area),/ENOENT/);
  console.log(JSON.stringify({controller:'SIGKILL',boundary:'database created before migration',manifest:'private validated',database:'absent',area:'absent'}));
 }catch(error){primary=error;}finally{const errors:unknown[]=[];try{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}}catch(error){errors.push(error);}try{if(manifest)await cleanupGraphFixture(manifest,process.env.AC_TEAM_GRAPH_IMAGE!);}catch(error){errors.push(error);}if(!errors.length)try{await rm(root,{recursive:true,force:true});}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,'NATIVE_GRAPH_CLEANUP_FAILED');}if(primary)throw primary;
});
