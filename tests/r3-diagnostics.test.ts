import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {nativeQaDiagnostic,remoteDiagnostic,waitDiagnostic} from '../src/diagnostic-projections.ts';
import {agentControlDiagnosticFindingSchema} from '../upstream/cezar/packages/contract/src/agent-control-operations.ts';
import {Ledger} from '../src/ledger.ts';
import {ContextDiagnostics} from '../src/diagnostics.ts';
import {createDiagnosticsApi} from '../src/diagnostics-api.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
const secret='SECRET_R3_KEY_PATH_TOKEN_TRANSCRIPT';
const qaSource=()=>{
 const row={id:randomUUID(),intent_id:randomUUID(),artifact_id:randomUUID(),grant_id:randomUUID(),session_id:randomUUID(),contract_digest:'a'.repeat(64),state:'failed',stop_reason:null as string|null,receipt:null as unknown};
 row.receipt={jobId:row.id,artifactId:row.artifact_id,grantId:row.grant_id,sessionId:row.session_id,contractDigest:row.contract_digest,logSha256:'b'.repeat(64),exitCode:1,logsAvailable:true,status:'failed',stderr:secret};return row;
};
test('QA diagnostics distinguish missing evidence, cancellation, timeout and test failure without raw receipts',()=>{
 const cases:[Partial<ReturnType<typeof qaSource>>,string|null][]=[
  [{state:'uncertain'},'native_qa_uncertain'],[{state:'running'},null],
  [{receipt:null},'native_qa_unknown'],[{receipt:{status:'passed'}},'native_qa_unknown'],
  [{stop_reason:'timeout'},'native_qa_unknown'],[{stop_reason:'canceled'},'native_qa_unknown'],
 ];
 for(const [change,code] of cases){const row={...qaSource(),...change},finding=nativeQaDiagnostic(row);assert.equal(finding?.code??null,code);assert(!JSON.stringify(finding).includes(secret));if(finding)agentControlDiagnosticFindingSchema.parse(finding);}
 for(const [status,logsAvailable,expected] of [['missing_result',false,'native_qa_missing_result'],['canceled',true,'native_qa_canceled'],['failed',true,'native_qa_failed'],['failed',false,'native_qa_unknown']] as const){
  const row=qaSource();row.receipt={...(row.receipt as object),status,logsAvailable};if(status==='canceled')row.stop_reason='canceled';assert.equal(nativeQaDiagnostic(row)?.code,expected);
 }
 const timeout=qaSource();timeout.stop_reason='timeout';timeout.receipt={...(timeout.receipt as object),status:'missing_result'};assert.equal(nativeQaDiagnostic(timeout)?.code,'native_qa_timeout');
 for(const contradiction of [{exitCode:17},{logsAvailable:false}]){const row=qaSource();row.state='completed';row.receipt={...(row.receipt as object),status:'passed',exitCode:0,...contradiction};assert.equal(nativeQaDiagnostic(row)?.code,'native_qa_unknown');}
 const wrong=qaSource();wrong.receipt={...(wrong.receipt as object),jobId:randomUUID()};assert.equal(nativeQaDiagnostic(wrong)?.code,'native_qa_unknown');
 const passed=qaSource();passed.state='completed';passed.receipt={...(passed.receipt as object),status:'passed',exitCode:0};assert.equal(nativeQaDiagnostic(passed),null);
});
test('remote and capacity projection use closed persisted facts and reject private reasons',()=>{
 const intent=randomUUID(),id=randomUUID();
 assert.equal(remoteDiagnostic({id,intent_id:intent,state:'running'}),null);
 for(const [state,code] of [['registered','remote_effect_uncertain'],['uncertain','remote_effect_uncertain'],['failed','remote_execution_failed'],['canceled_confirmed','remote_execution_canceled']] as const)assert.equal(remoteDiagnostic({id,intent_id:intent,state})?.code,code);
 for(const reason of ['NO_ELIGIBLE_CAPACITY','ORIGINAL_RESERVE_NOT_NEEDED','CAPACITY_BUSY','CAPACITY_QUEUED','GLOBAL_CAPACITY_LIMIT','CONTEXT_CAPACITY_LIMIT','ACCOUNT_CAPACITY_LIMIT'])assert.equal(waitDiagnostic({attempt_id:id,intent_id:intent,reason,exclusions:[]}).capacityWait?.reason,reason);
 const profileId=randomUUID();
 const wait=waitDiagnostic({attempt_id:id,intent_id:intent,reason:'NO_ELIGIBLE_CAPACITY',exclusions:[{profileId,reason:'quota_unknown'}]});
 assert.deepEqual(wait.capacityWait,{reason:'NO_ELIGIBLE_CAPACITY',exclusions:[{profileId,reason:'quota_unknown'}]});
 for(const reason of ['quota_rate_limited','authentication_required','provider_unreachable','provider_configuration_error','quota_disabled']){const value=waitDiagnostic({attempt_id:id,intent_id:intent,reason:'NO_ELIGIBLE_CAPACITY',exclusions:[{profileId,reason}]});assert.equal(value.capacityWait?.exclusions[0]?.reason,reason);}
 assert.deepEqual(waitDiagnostic({attempt_id:id,intent_id:intent,reason:'NO_ELIGIBLE_CAPACITY',exclusions:[{profileId,reason:'rate_limited'}]}).capacityWait?.exclusions,[]);
 const poisoned=waitDiagnostic({attempt_id:id,intent_id:intent,reason:secret,exclusions:[{profileId,reason:secret}]});
 assert.deepEqual(poisoned.capacityWait,{reason:'unknown',exclusions:[]});assert(!JSON.stringify(poisoned).includes(secret));
 agentControlDiagnosticFindingSchema.parse(wait);agentControlDiagnosticFindingSchema.parse(poisoned);
});

test('actual PG/API diagnostics include per-intent uncertainty, SSH, QA, wait exclusions, ACL and truncation',{timeout:60000},async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'r3diag'),db=new Ledger(fixture.url);
 try{
  await db.migrate();const project=randomUUID(),otherProject=randomUUID(),owner='owner-'+randomUUID(),outsider='outsider-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2),($3,$4)',[project,'fixture',otherProject,'other']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($3,$4,'owner')",[project,owner,otherProject,outsider]);
  const context=await db.createContext(owner,project,randomUUID()),other=await db.createContext(outsider,otherProject,randomUUID());
  const authority=await db.acquire(owner,context,randomUUID(),'fixture-manager',60);
  const create=()=>db.accept(owner,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:secret}},authority,'api');
  const unknown=await create(),remoteIntent=await create(),qaIntent=await create(),waitIntent=await create();
  await db.pool.query("UPDATE ac_intents SET state='failed' WHERE id=$1",[unknown.id]);
  const host=randomUUID(),remoteId=randomUUID();
  await db.pool.query(`INSERT INTO ac_remote_hosts(id,project_id,label,hostname,port,username,public_key,fingerprint,credential_ref,remote_root,allowed_tasks,max_concurrent,registration_digest)
   VALUES($1,$2,$3,$3,22,$3,$3,$3,$4,$3,ARRAY['fixture'],2,$3)`,[host,project,secret,randomUUID()]);
  await db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,intent_id,remote_receipt)
   VALUES($1,$2,$3,'fixture',$4,$5,'uncertain',$6,$7)`,[remoteId,context,host,secret,authority.epoch,remoteIntent.id,{stderr:secret}]);
  await db.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,$3,$4)',[project,'a'.repeat(64),{},owner]);
  const account=randomUUID(),profile=randomUUID();
  await db.pool.query(`INSERT INTO ac_accounts(id,owner_id,provider,label,resource_identity,mode,eligibility,eligibility_source,max_concurrent)
   VALUES($1,$2,'fixture',$3,$4,'synthetic','documented_supported','synthetic://fixture',4)`,[account,owner,secret,account]);
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,'fixture','medium','programmer')",[profile,account]);
  const grant=randomUUID();
  await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,'qa',$8,1,1,$9,false,'released')`,[grant,randomUUID(),qaIntent.id,context,authority.epoch,account,profile,project,'a'.repeat(64)]);
  await db.pool.query('INSERT INTO ac_quality_policies(project_id,revision,snapshot,digest) VALUES($1,1,$2,$3)',[project,{},'a'.repeat(64)]);
  const artifact=randomUUID(),job=randomUUID(),session=randomUUID();
  await db.pool.query(`INSERT INTO ac_artifacts VALUES($1,$2,$3,$4,$5,$6,1,$7,$7,$7,$8,'low')`,[artifact,context,qaIntent.id,grant,randomUUID(),project,'a'.repeat(40),'b'.repeat(64)]);
  await db.pool.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,grant_id,manager_epoch,state)
   VALUES($1,$2,'qa',$3,$4,$5,$6,'completed')`,[job,qaIntent.id,session,randomUUID(),grant,authority.epoch]);
  const receipt={jobId:job,artifactId:artifact,grantId:grant,sessionId:session,contractDigest:'a'.repeat(64),logSha256:'b'.repeat(64),exitCode:137,logsAvailable:false,status:'missing_result',stderr:secret};
  await db.pool.query(`INSERT INTO ac_native_qa_jobs(id,context_id,intent_id,artifact_id,grant_id,session_id,manager_epoch,request_digest,contract_digest,state,deadline_at,receipt)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'failed',clock_timestamp(),$9)`,[job,context,qaIntent.id,artifact,grant,session,authority.epoch,'a'.repeat(64),receipt]);
  const attempt=randomUUID();await db.pool.query(`INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,reason,exclusions)
   VALUES($1,$2,$3,'programmer',$4,$5,'NO_ELIGIBLE_CAPACITY',$6)`,[attempt,context,waitIntent.id,'a'.repeat(64),authority.epoch,JSON.stringify([{profileId:profile,reason:'quota_unknown'}])]);
  // More than one page of legitimate passes must not hide the later failed job.
  for(let index=0;index<101;index++){
   const passedJob=randomUUID(),passedGrant=randomUUID(),passedSession=randomUUID();
   await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,'qa',$8,1,1,$9,false,'released')`,[passedGrant,randomUUID(),qaIntent.id,context,authority.epoch,account,profile,project,'a'.repeat(64)]);
   await db.pool.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,grant_id,manager_epoch,state)
    VALUES($1,$2,'qa',$3,$4,$5,$6,'completed')`,[passedJob,qaIntent.id,passedSession,randomUUID(),passedGrant,authority.epoch]);
   const passedReceipt={...receipt,jobId:passedJob,grantId:passedGrant,sessionId:passedSession,status:'passed',exitCode:0,logsAvailable:true};
   await db.pool.query(`INSERT INTO ac_native_qa_jobs(id,context_id,intent_id,artifact_id,grant_id,session_id,manager_epoch,request_digest,contract_digest,state,deadline_at,receipt,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'completed',clock_timestamp(),$9,'2000-01-01T00:00:00Z')`,[passedJob,context,qaIntent.id,artifact,passedGrant,passedSession,authority.epoch,'a'.repeat(64),passedReceipt]);
  }
  const fingerprint=async()=>(await db.pool.query(`SELECT md5(string_agg(value,',' ORDER BY value)) value FROM (
   SELECT t::text value FROM ac_intents t UNION ALL SELECT t::text FROM ac_remote_operations t
   UNION ALL SELECT t::text FROM ac_native_qa_jobs t UNION ALL SELECT t::text FROM ac_audit t) rows`)).rows[0].value;
  const before=await fingerprint(),service=new ContextDiagnostics(db,project),result=await service.read(owner,context);
  for(const code of ['task_diagnosis_unknown','remote_effect_uncertain','native_qa_missing_result','capacity_wait'])assert(result.findings.some(f=>f.code===code),code);
  assert(result.findings.find(f=>f.code==='task_diagnosis_unknown')?.evidence.some(e=>e.id===unknown.id));
  assert(result.findings.find(f=>f.code==='capacity_wait')?.capacityWait?.exclusions.some(e=>e.reason==='quota_unknown'));
  assert(!JSON.stringify(result).includes(secret));assert.equal(await fingerprint(),before);assert.equal(result.truncated,false,'coherent passed QA must not occupy diagnostic page');
  await assert.rejects(service.read(outsider,context),/CONTEXT_FORBIDDEN/);await assert.rejects(service.read(outsider,other),/PROJECT_RUNTIME_MISMATCH/);
  const app=new Hono<{Variables:{principal:string}}>();app.use('*',async(c,next)=>{const value=c.req.header('x-test-principal');if(value)c.set('principal',value);await next();});app.route('/api/v1/ac',createDiagnosticsApi(db,project));
  const path='/api/v1/ac/contexts/'+context+'/diagnostics';assert.equal((await app.request(path)).status,401);
  const response=await app.request(path,{headers:{'x-test-principal':owner}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert(!JSON.stringify(await response.json()).includes(secret));
  for(let index=0;index<101;index++){
   await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state,created_at)
    VALUES($1,$2,$3,$4,'{}',$5,$6,$7,1,'accepted','2000-01-01T00:00:00Z')`,[randomUUID(),context,owner,'a'.repeat(64),randomUUID(),randomUUID(),authority.epoch]);
  }
  const prioritized=await service.read(owner,context);assert(prioritized.truncated);assert(prioritized.findings.some(f=>f.code==='task_diagnosis_unknown'&&f.evidence.some(e=>e.id===unknown.id)),'healthy tasks must not hide terminal failure');
  for(let index=0;index<101;index++)await db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state,intent_id)
   VALUES($1,$2,$3,'fixture',$4,$5,'uncertain',$6)`,[randomUUID(),context,host,'a'.repeat(64),authority.epoch,remoteIntent.id]);
  const limited=await service.read(owner,context);assert(limited.truncated);assert.equal(limited.findings.filter(f=>f.code==='remote_effect_uncertain').length,100);
  // A stopped task after a full page remains addressable independently.
  for(let index=0;index<101;index++)await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state,created_at)
   VALUES($1,$2,$3,$4,'{}',$5,$6,$7,1,'failed','2001-01-01T00:00:00Z')`,[randomUUID(),context,owner,'a'.repeat(64),randomUUID(),randomUUID(),authority.epoch]);
  assert(!(await service.read(owner,context)).findings.some(f=>f.code==='task_diagnosis_unknown'&&f.evidence.some(e=>e.id===unknown.id)),'fixture must put selected stopped task beyond first page');
  const child=randomUUID(),stage=randomUUID();
  await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state,parent_intent_id,parent_unit_id)
   VALUES($1,$2,$3,$4,'{}',$5,$6,$7,$8,'running',$9,'fixture-child')`,[child,context,owner,'a'.repeat(64),randomUUID(),randomUUID(),authority.epoch,unknown.plan_revision,unknown.id]);
  await db.pool.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state)
   VALUES($1,$2,'qa',$3,$4,$5,'uncertain')`,[stage,child,randomUUID(),randomUUID(),authority.epoch]);
  const targeted=await service.read(owner,context,unknown.id);assert.equal(targeted.intentId,unknown.id);assert.equal(targeted.truncated,false);
  assert(targeted.findings.some(f=>f.code==='task_diagnosis_unknown'&&f.evidence.some(e=>e.id===unknown.id)));
  assert(targeted.findings.some(f=>f.code==='stage_uncertain'&&f.evidence.some(e=>e.kind==='intent'&&e.id===child)),'targeted root includes child stages');
  assert(!targeted.findings.some(f=>f.code==='remote_effect_uncertain'),'other task evidence must not cross target');
  const qaTarget=await service.read(owner,context,qaIntent.id);assert(qaTarget.findings.some(f=>f.code==='native_qa_missing_result'));
  const remoteTarget=await service.read(owner,context,remoteIntent.id);assert(remoteTarget.findings.some(f=>f.code==='remote_effect_uncertain'));
  const waitTarget=await service.read(owner,context,waitIntent.id);assert(waitTarget.findings.some(f=>f.code==='capacity_wait'));
  assert.equal((await app.request(path+'?intentId='+unknown.id,{headers:{'x-test-principal':owner}})).status,200);
  assert.equal((await app.request(path+'?intentId=invalid',{headers:{'x-test-principal':owner}})).status,400);
  assert.equal((await app.request(path+'?intentId='+randomUUID(),{headers:{'x-test-principal':owner}})).status,403);
  const alien=randomUUID();await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state)
   VALUES($1,$2,$3,$4,'{}',$5,$6,1,1,'failed')`,[alien,other,outsider,'a'.repeat(64),randomUUID(),randomUUID()]);
  assert.equal((await app.request(path+'?intentId='+alien,{headers:{'x-test-principal':owner}})).status,403);
  assert.equal((await app.request(path+'?intentId='+unknown.id,{headers:{'x-test-principal':outsider}})).status,403);

 }finally{await db.close();await fixture.close();}
});
