import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionSupervisor,NativeExecutionRequest} from '../src/native-execution-supervisor.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('native execution retains uncertain capacity, fences takeover and replays only physical receipts',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'nativeexec'),db=new Ledger(fixture.url),area=await mkdtemp(join(tmpdir(),'ac-native-exec-'));let runtime:CezarRuntime|undefined;
 try{
  await db.migrate();const capacity=new Capacity(db),project=randomUUID(),principal='native-exec-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  const repo=join(area,'repo'),spool=join(area,'spool'),accounts=join(area,'accounts');for(const path of [repo,spool,accounts])await mkdir(path,{mode:0o700});
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated executor fixture']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,repo]);
  const subject='a'.repeat(64);await capacity.addAccount(principal,project,{id:account,provider:'codex',label:'dormant fixture',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','programmer',false)",[profile,account]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const grant=randomUUID(),keys=generateKeyPairSync('ed25519'),image='sha256:'+'c'.repeat(64);
  const config={id:'codex-native-execution',workerImage:image,toolsImage:image,hostRoot:spool,accountRoot:accounts,repository:repo,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetworkId:'d'.repeat(64),socketPath:'/no-operational-docker.sock',accountSubjects:[{accountId:account,subjectDigest:subject}],workerEnv:[],toolsEnv:[]};
  const supervisor=new NativeExecutionSupervisor(db,config),input=NativeExecutionRequest.parse({jobId:intent.operation_id,intentId:intent.id,grantId:grant,sessionId:randomUUID(),base:'e'.repeat(40),role:'programmer',task:'synthetic metadata only',writePaths:['src/example.ts']});
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'reserved')`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,digest(input)]);
  // No auth file exists. A dormant account is refused before socket or home access.
  await assert.rejects(supervisor.start(principal,authority,input),/NATIVE_EXECUTION_NOT_ELIGIBLE/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs')).rows[0].n,0);
  const workerId='f'.repeat(64),toolsId='1'.repeat(64),network='2'.repeat(64),hash=digest(input),fingerprint=createHash('sha256').update(keys.publicKey.export({format:'der',type:'spki'})).digest('hex');
  await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,worker_id,tools_id,network_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,'programmer','running',$14,$15,$16)`,[input.jobId,grant,intent.id,context,authority.epoch,input.sessionId,account,profile,digest({fixture:true}),supervisor.executorDigest,fingerprint,hash,input.base,workerId,toolsId,network]);
  await db.pool.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[grant]);
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2,native_session_id=$3 WHERE id=$1",[input.jobId,grant,input.sessionId]);
  const root=join(spool,input.jobId);await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});await writeFile(join(root,'request.json'),JSON.stringify(input),{mode:0o600});
  const labels={'agent-control.job':input.jobId,'agent-control.launch':hash,'agent-control.contract':'native-execution-v1'};
  const physical=(id:string)=>({Id:id,Image:image,Config:{Labels:labels},State:{Status:'running',Running:true,ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'}});
  const worker=physical(workerId),tools=physical(toolsId);let stops=0;
  const docker={inspect:async(name:string)=>name.startsWith('ac-native-worker-')?worker:tools,stop:async(id:string)=>{stops++;const p=id===workerId?worker:tools;p.State={Status:'exited',Running:false,ExitCode:137,FinishedAt:new Date().toISOString()};}};
  Object.defineProperty(supervisor,'docker',{value:docker});
  assert.deepEqual(await supervisor.reconcile(principal,authority,input),{state:'running'});
  await assert.rejects(supervisor.reconcile(principal,authority,{...input,task:'collision'}),/NATIVE_EXECUTION_REPLAY_MISMATCH/);
  await db.pause(principal,context,true);await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await assert.rejects(supervisor.stop(principal,authority,input),/STALE_MANAGER/);assert.equal(stops,0);
  worker.Image='sha256:'+'9'.repeat(64);await assert.rejects(supervisor.stop(principal,successor,input),/NATIVE_EXECUTION_CONTAINER_MISMATCH/);assert.equal(stops,0);worker.Image=image;
  await supervisor.stop(principal,successor,input);assert.equal(stops,2);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant])).rows[0].state,'uncertain');
  const terminal=await supervisor.reconcile(principal,successor,input);assert.equal(terminal.state,'failed');assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant])).rows[0].state,'released');
  assert.deepEqual(await supervisor.reconcileRegistered(principal,successor,input.jobId),terminal);
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2 WHERE id=$1",[input.jobId,grant]);
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,context,principal,intent.plan_revision]);
  runtime=new CezarRuntime(db,repo,project,undefined,undefined,undefined,{nativeExecutions:[supervisor]});await runtime.start('administration-only');
  await runtime.reconcileCancellations(successor,principal);
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[intent.id])).rows[0].state,'confirmed');
  assert.equal((await db.pool.query('SELECT receipt FROM ac_operations WHERE id=$1',[input.jobId])).rows[0].receipt.cancellation,true);
  assert.equal(stops,2);
  await assert.rejects(db.pool.query('UPDATE ac_native_execution_jobs SET input_digest=$2 WHERE id=$1',[input.jobId,'0'.repeat(64)]),/NATIVE_EXECUTION_JOB_IMMUTABLE/);
  const other=new NativeExecutionSupervisor(db,{...config,signingKeyPem:generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}).toString()});
  await assert.rejects(other.reconcile(principal,successor,input),/NATIVE_EXECUTION_REPLAY_MISMATCH/);
 }finally{await runtime?.close();await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
