import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {Cancellations} from '../src/cancellation.ts';
import {NativePlanningSupervisor,nativePlanningExecutorDigest} from '../src/native-planning-supervisor.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('a canceled native planning job is stopped and released only after its original terminal identity is observed',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'nativecancel'),db=new Ledger(fixture.url),capacity=new Capacity(db),area=await mkdtemp(join(tmpdir(),'ac-native-cancel-'));
 const spool=join(area,'spool'),accounts=join(area,'accounts');await mkdir(spool,{mode:0o700});await mkdir(accounts,{mode:0o700});
 try{
  await db.migrate();const project=randomUUID(),principal='native-cancel-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated canceled planning']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const subject='a'.repeat(64);await capacity.addAccount(principal,project,{id:account,provider:'codex',label:'synthetic metadata',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','manager',false)",[profile,account]);
  const context=await db.createContext(principal,project,randomUUID());const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const imageId='sha256:'+'c'.repeat(64),executorDigest=nativePlanningExecutorDigest(imageId),keys=generateKeyPairSync('ed25519');
  const supervisor=new NativePlanningSupervisor(db,{id:'codex-native-planning',executorDigest,imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:subject}]});
  const grant=randomUUID(),call=randomUUID(),session=randomUUID(),inputDigest=digest({fixture:'cancel'}),launchDigest='d'.repeat(64),containerId='e'.repeat(64);
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'manager',$8,1,1,$9,false,'running')`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,inputDigest]);
  const fingerprint=createHash('sha256').update(Buffer.from(supervisor.executor.publicKey,'base64')).digest('hex');
  await db.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,grant_id,profile_id,execution_epoch,state,selected_executor_id,selected_executor_digest,selected_key_fingerprint)
   VALUES($1,$2,$3,$4,$5,'semantic-planning-v1',$6,0,$7,$8,$9,$10,$11,'uncertain',$12,$13,$14)`,[call,context,intent.id,principal,inputDigest,digest({contract:'semantic-planning-v1'}),randomUUID(),session,grant,profile,authority.epoch,supervisor.executor.id,executorDigest,fingerprint]);
  const name='ac-native-plan-'+call;
  await db.pool.query(`INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,container_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,'running')`,[call,grant,context,inputDigest,launchDigest,name,containerId]);
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,context,principal,intent.plan_revision]);
  const root=join(spool,call);await mkdir(root,{mode:0o700});await mkdir(join(root,'output'),{mode:0o700});
  const physical={Id:containerId,Image:imageId,Config:{User:`${process.getuid?.()}:${process.getgid?.()}`,Entrypoint:['node','/opt/agent-control/dist/src/native-planning-worker.mjs'],Cmd:[],WorkingDir:'/planning',Env:['PATH=/usr/bin'],Labels:{'agent-control.job':call,'agent-control.launch':launchDigest,'agent-control.contract':'native-planning-v1'}},
   HostConfig:{NetworkMode:'ac-native-provider',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9},
   State:{Running:true,Status:'running',ExitCode:0,FinishedAt:'0001-01-01T00:00:00Z'},Mounts:[
    {Source:join(accounts,account),Destination:'/account',RW:true},{Source:join(root,'input'),Destination:'/input',RW:false},
    {Source:join(root,'output'),Destination:'/output',RW:true},{Source:join(root,'planning'),Destination:'/planning',RW:false},
    {Source:join(root,'public-key.pem'),Destination:'/runner/planning-public-key.pem',RW:false}]};
  let stops=0;const fakeDocker={inspect:async()=>physical,stop:async()=>{stops++;physical.State={Running:false,Status:'exited',ExitCode:137,FinishedAt:new Date().toISOString()};}};
  Object.defineProperty(supervisor,'docker',{value:fakeDocker});
  const cancellation=new Cancellations(db);await cancellation.reconcile(authority,()=>{});
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[intent.id])).rows[0].state,'requested');
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);assert.equal(successor.epoch,authority.epoch+1);
  await assert.rejects(supervisor.reconcileCancellation(principal,authority,call),/STALE_MANAGER/);assert.equal(stops,0);
  const otherKeys=generateKeyPairSync('ed25519');
  const wrongSupervisor=new NativePlanningSupervisor(db,{id:'codex-native-planning',executorDigest,imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:otherKeys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:subject}]});
  Object.defineProperty(wrongSupervisor,'docker',{value:fakeDocker});
  await assert.rejects(wrongSupervisor.reconcileCancellation(principal,successor,call),/PLANNING_EXECUTOR_KEY_MISMATCH/);assert.equal(stops,0);
  physical.Image='sha256:'+'f'.repeat(64);
  await assert.rejects(supervisor.reconcileCancellation(principal,successor,call),/PLANNING_CONTAINER_MISMATCH/);assert.equal(stops,0);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant])).rows[0].state,'running');physical.Image=imageId;
  assert.deepEqual(await supervisor.reconcileCancellation(principal,successor,call),{state:'reconciled'});assert.equal(stops,1);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant])).rows[0].state,'released');
  assert.equal((await db.pool.query('SELECT state FROM ac_semantic_planning_calls WHERE id=$1',[call])).rows[0].state,'rejected');
  await cancellation.reconcile(successor,()=>{});assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[intent.id])).rows[0].state,'confirmed');
  assert.deepEqual(await supervisor.reconcileCancellation(principal,successor,call),{state:'not_applicable'});assert.equal(stops,1);
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
