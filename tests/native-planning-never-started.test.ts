import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,createHash,verify} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {Cancellations} from '../src/cancellation.ts';
import {NativePlanningSupervisor,nativePlanningExecutorDigest} from '../src/native-planning-supervisor.ts';
import {SemanticPlanning,PlanningPhysicalReceipt,planningReceiptMessage} from '../src/semantic-planning.ts';
import {Refusal,digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('a personal planning call whose container never started is rejected, and the same call without the sweep receipt stays uncertain',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'neverstarted'),db=new Ledger(fixture.url),capacity=new Capacity(db),area=await mkdtemp(join(tmpdir(),'ac-never-started-'));
 const spool=join(area,'spool'),accounts=join(area,'accounts');await mkdir(spool,{mode:0o700});await mkdir(accounts,{mode:0o700});
 try{
  await db.migrate();
  const project=randomUUID(),principal='never-started-'+randomUUID(),account=randomUUID(),profile=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated never started']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const subject='a'.repeat(64);
  await capacity.addAccount(principal,project,{id:account,provider:'codex',label:'personal metadata',resourceIdentity:'codex:'+subject,mode:'subscription_cli',eligibility:'documented_supported',eligibilitySource:'https://example.invalid/fixture',maxConcurrent:1});
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium','manager',false)",[profile,account]);
  await db.pool.query("INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",[project,'b'.repeat(64),principal]);
  const imageId='sha256:'+'c'.repeat(64),executorDigest=nativePlanningExecutorDigest(imageId),keys=generateKeyPairSync('ed25519');
  const supervisor=new NativePlanningSupervisor(db,{id:'codex-native-planning',executorDigest,imageId,hostRoot:spool,accountRoot:accounts,protectedRepositories:[],signingKeyPem:keys.privateKey.export({format:'pem',type:'pkcs8'}).toString(),providerNetwork:'ac-native-provider',accountSubjects:[{accountId:account,subjectDigest:subject}],active:false});
  let inspects=0;Object.defineProperty(supervisor,'docker',{value:{inspect:async()=>{inspects++;return null;}}});
  const planning=new SemanticPlanning(db,supervisor.executor);
  const fingerprint=createHash('sha256').update(Buffer.from(supervisor.executor.publicKey,'base64')).digest('hex');
  const plant=async(physical:Record<string,unknown>,cancel=false)=>{
   const context=await db.createContext(principal,project,randomUUID());
   const authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
   const call=randomUUID(),grant=randomUUID(),session=randomUUID();
   const request={id:call,intentId:intent.id,contextId:context,expectedRevision:0,sourceMessageRef:'message:fixture-request' as const,qualityRevision:1,targetRef:'refs/heads/protected' as const,text:'pedido cujo contêiner nunca existiu'};
   const inputDigest=digest({principal,...request});
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,physical_receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,'manager',$8,1,1,$9,false,'released',$10)`,[grant,randomUUID(),intent.id,context,authority.epoch,account,profile,project,inputDigest,physical]);
   await db.pool.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,grant_id,profile_id,execution_epoch,state,selected_executor_id,selected_executor_digest,selected_key_fingerprint)
    VALUES($1,$2,$3,$4,$5,'semantic-planning-v1',$6,0,$7,$8,$9,$10,$11,'uncertain',$12,$13,$14)`,[call,context,intent.id,principal,inputDigest,digest({contract:'semantic-planning-v1'}),randomUUID(),session,grant,profile,authority.epoch,supervisor.executor.id,executorDigest,fingerprint]);
   await db.pool.query(`INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,state) VALUES($1,$2,$3,$4,$5,$6,'uncertain')`,[call,grant,context,inputDigest,'d'.repeat(64),'ac-native-plan-'+call]);
   if(cancel)await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[intent.id,context,principal,intent.plan_revision]);
   return {authority,intent,call,grant,request};
  };
  const code=async(run:Promise<unknown>)=>{
   try{await run;assert.fail('expected a refusal');}catch(error){assert.ok(error instanceof Refusal);return error.code;}
  };
  const sweep={source:'personal-startup-sweep',containersAbsent:true,jobs:[] as string[]};
  const swept=await plant(sweep);
  const plain=await plant({executionStarted:false,source:'other',containersAbsent:false});
  const before=inspects;
  assert.equal(await code(planning.plan(principal,swept.request,swept.authority)),'PLANNING_RESULT_UNCERTAIN');
  assert.equal(inspects-before,1);
  assert.equal((await db.pool.query('SELECT state FROM ac_semantic_planning_calls WHERE id=$1',[swept.call])).rows[0].state,'uncertain');
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  const sealing=inspects;
  assert.equal(await code(planning.plan(principal,swept.request,swept.authority)),'PLANNING_EXECUTOR_FAILED');
  assert.ok(inspects-sealing>=3);
  const saved=(await db.pool.query('SELECT state,failure_code,receipt FROM ac_semantic_planning_calls WHERE id=$1',[swept.call])).rows[0];
  assert.equal(saved.state,'rejected');assert.equal(saved.failure_code,'PLANNING_EXECUTOR_FAILED');
  const receipt=PlanningPhysicalReceipt.parse(saved.receipt);
  assert.notEqual(receipt.payload.exitCode,0);assert.equal(receipt.payload.failureCode,'NATIVE_CONTAINER_NEVER_STARTED');
  assert.equal(verify(null,planningReceiptMessage(receipt.payload),keys.publicKey,Buffer.from(receipt.signature,'hex')),true);
  const grant=(await db.pool.query('SELECT physical_receipt,state FROM ac_capacity_grants WHERE id=$1',[swept.grant])).rows[0];
  assert.equal(grant.state,'released');assert.equal(grant.physical_receipt.source,'personal-startup-sweep');assert.equal(grant.physical_receipt.containersAbsent,true);
  assert.equal(receipt.payload.physicalDigest,digest(grant.physical_receipt));
  const job=(await db.pool.query('SELECT state,container_id FROM ac_native_planning_jobs WHERE id=$1',[swept.call])).rows[0];
  assert.equal(job.state,'failed');assert.equal(job.container_id,null);
  assert.equal(await code(planning.plan(principal,plain.request,plain.authority)),'PLANNING_RESULT_UNCERTAIN');
  assert.equal((await db.pool.query('SELECT state,failure_code,receipt FROM ac_semantic_planning_calls WHERE id=$1',[plain.call])).rows[0].state,'uncertain');
  assert.equal((await db.pool.query('SELECT state,receipt FROM ac_native_planning_jobs WHERE id=$1',[plain.call])).rows[0].state,'uncertain');
  const canceled=await plant(sweep,true);
  assert.deepEqual(await supervisor.reconcileCancellation(principal,canceled.authority,canceled.call),{state:'reconciled'});
  const canceledCall=(await db.pool.query('SELECT state,failure_code,receipt FROM ac_semantic_planning_calls WHERE id=$1',[canceled.call])).rows[0];
  assert.equal(canceledCall.state,'rejected');assert.equal(canceledCall.failure_code,'PLANNING_CANCELED');
  assert.equal(PlanningPhysicalReceipt.parse(canceledCall.receipt).payload.failureCode,'NATIVE_CONTAINER_NEVER_STARTED');
  await new Cancellations(db).reconcile(canceled.authority,()=>{});
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[canceled.intent.id])).rows[0].state,'confirmed');
  assert.equal((await db.pool.query('SELECT state FROM ac_intents WHERE id=$1',[canceled.intent.id])).rows[0].state,'canceled');
 }finally{await db.close();await fixture.close();await rm(area,{recursive:true,force:true});}
});
