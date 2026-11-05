import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {agentControlDiagnosticFindingSchema, agentControlDiagnosticsSchema} from '../upstream/cezar/packages/contract/src/agent-control-operations.ts';
import {NATIVE_TERMINAL_FAILURE_COPY, projectNativeTerminalFailure, type NativeTerminalFailureSource} from '../src/native-failure-diagnostics.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const SECRET='STDOUT_SENTINEL_/tmp/native-key.pem messageRef QUOTA_EXHAUSTED stack';
const FOREIGN='99999999-9999-4999-8999-999999999999';
const base=():NativeTerminalFailureSource=>({
 jobId:'11111111-1111-4111-8111-111111111111',
 intentId:'22222222-2222-4222-8222-222222222222',
 contextId:'33333333-3333-4333-8333-333333333333',
 role:'programmer' as const,
 state:'failed',
 jobReceipt:{payload:{jobId:'11111111-1111-4111-8111-111111111111',intentId:'22222222-2222-4222-8222-222222222222',contextId:'33333333-3333-4333-8333-333333333333',exitCode:1},signature:SECRET,stdout:SECRET},
 operationId:'11111111-1111-4111-8111-111111111111',
 operationReceipt:null as unknown,
 stageId:null as string|null,
 stageNode:null as string|null,
 stageReceipt:null as unknown,
 finalizerState:null as string|null,
 finalizerReceipt:null as unknown,
});

test('pure projection keeps a coherent closed cause and drops private receipt fields',()=>{
 const source=base();
 source.operationReceipt={operationId:source.jobId,exitCode:1,failureCode:'INVALID_SCOPE',stdout:SECRET,messageRef:SECRET,nativeExecution:{payload:{jobId:source.jobId,intentId:source.intentId,contextId:source.contextId,exitCode:1,output:SECRET},signature:SECRET}};
 source.finalizerState='failed';
 source.finalizerReceipt={jobId:source.jobId,status:'failed',failureCode:'INVALID_SCOPE',identity:null,stderr:SECRET};
 const finding=projectNativeTerminalFailure(source);
 assert.ok(finding);
 assert.equal(finding.nativeFailure?.cause,'invalid_scope');
 assert.equal(finding.nativeFailure?.origin,'stored_agreement');
 assert.deepEqual(finding.evidence.map(item=>item.kind),['native_execution_job','operation']);
 assert.equal(JSON.stringify(finding).includes(SECRET),false);
 assert.equal(JSON.stringify(finding).includes('INVALID_SCOPE'),false);
 assert.equal(finding.meaning,NATIVE_TERMINAL_FAILURE_COPY.meaning);
});

test('pure projection redacts an unknown or absent code and does not infer quota or success',()=>{
 const absent=base();
 absent.operationReceipt={operationId:absent.jobId,exitCode:1,failureCode:null,nativeExecution:{payload:{jobId:absent.jobId,intentId:absent.intentId,contextId:absent.contextId,exitCode:1}}};
 const absentFinding=projectNativeTerminalFailure(absent);
 assert.equal(absentFinding?.nativeFailure?.cause,'unknown');
 assert.equal(absentFinding?.nativeFailure?.origin,'stored_agreement');
 const malicious=base();
 malicious.operationReceipt={operationId:malicious.jobId,exitCode:1,failureCode:SECRET,stdout:SECRET};
 malicious.finalizerState='failed';
 malicious.finalizerReceipt={jobId:malicious.jobId,status:'failed',failureCode:SECRET};
 const redacted=projectNativeTerminalFailure(malicious);
 assert.equal(redacted?.nativeFailure?.cause,'unknown');
 assert.equal(redacted?.nativeFailure?.origin,'unreconciled');
 const body=JSON.stringify(redacted);
 assert.equal(body.includes(SECRET),false);
 assert.equal(body.includes('cota'),false);
 assert.equal(body.includes('sucesso'),false);
});

test('pure projection treats prototype failure codes as unknown and keeps the sibling diagnosis',()=>{
 const sibling=base();
 sibling.operationReceipt={operationId:sibling.jobId,exitCode:1,failureCode:'EXECUTION_FAILED'};
 assert.equal(projectNativeTerminalFailure(sibling)?.nativeFailure?.cause,'execution_failed');
 for(const code of ['constructor','toString','__proto__']){
  const source=base();
  source.operationReceipt={operationId:source.jobId,exitCode:1,failureCode:code,stdout:SECRET,messageRef:code,nativeExecution:{payload:{jobId:source.jobId,intentId:source.intentId,contextId:source.contextId,exitCode:1,failureCode:code,output:SECRET}}};
  source.finalizerState='failed';
  source.finalizerReceipt={jobId:source.jobId,status:'failed',failureCode:code,stderr:code};
  const finding=projectNativeTerminalFailure(source);
  assert.equal(finding?.nativeFailure?.cause,'unknown');
  assert.equal(finding?.nativeFailure?.origin,'unreconciled');
  const text=JSON.stringify(finding);
  assert.equal(text.includes(code),false);
  assert.equal(text.includes(SECRET),false);
  assert.equal(agentControlDiagnosticFindingSchema.safeParse(finding).success,true);
 }
 assert.equal(projectNativeTerminalFailure(sibling)?.nativeFailure?.cause,'execution_failed');
});

test('pure projection ignores non-terminal, success, foreign ids and evaluator/implementation mix',()=>{
 const running=base();running.state='running';running.operationReceipt={failureCode:'INVALID_SCOPE',stdout:SECRET};
 assert.equal(projectNativeTerminalFailure(running),null);
 const done=base();done.state='completed';done.jobReceipt={payload:{jobId:done.jobId,intentId:done.intentId,contextId:done.contextId,exitCode:0}};
 done.operationReceipt={operationId:done.jobId,exitCode:0,failureCode:null};
 assert.equal(projectNativeTerminalFailure(done),null);
 const divergent=base();
 divergent.operationReceipt={operationId:FOREIGN,exitCode:0,failureCode:'INVALID_SCOPE',stdout:SECRET,nativeExecution:{payload:{jobId:FOREIGN,intentId:FOREIGN,contextId:FOREIGN,exitCode:0,output:SECRET}}};
 const mixed=projectNativeTerminalFailure(divergent);
 assert.equal(mixed?.nativeFailure?.cause,'unknown');
 assert.equal(mixed?.nativeFailure?.origin,'unreconciled');
 assert.equal(JSON.stringify(mixed).includes(FOREIGN),false);
 assert.equal(JSON.stringify(mixed).includes(SECRET),false);
 const reviewer:NativeTerminalFailureSource={...base(),role:'reviewer',operationId:null,operationReceipt:null,stageId:base().jobId,stageNode:'review',
  stageReceipt:{exitCode:1,failureCode:'EXECUTION_FAILED',stdout:SECRET},finalizerState:null};
 const review=projectNativeTerminalFailure(reviewer);
 assert.equal(review?.nativeFailure?.cause,'execution_failed');
 assert.deepEqual(review?.evidence.map(item=>item.kind),['native_execution_job','stage']);
 assert.equal(JSON.stringify(review).includes(SECRET),false);
 const confused:NativeTerminalFailureSource={...base(),stageId:FOREIGN,stageNode:'review',stageReceipt:{failureCode:'NO_CHANGES',stdout:SECRET}};
 const hidden=projectNativeTerminalFailure(confused);
 assert.equal(hidden?.nativeFailure?.origin,'unreconciled');
 assert.equal(JSON.stringify(hidden).includes(FOREIGN),false);
 assert.equal(JSON.stringify(hidden).includes('NO_CHANGES'),false);
 assert.equal(hidden?.evidence.some(item=>item.kind==='stage'),false);
});

test('legacy diagnostic findings remain valid and arbitrary cause codes are rejected',()=>{
 const legacy=agentControlDiagnosticsSchema.parse({contextId:'33333333-3333-4333-8333-333333333333',findings:[{code:'context_paused',meaning:'A pausa humana está ativa.',owner:'Operador do contexto',nextCondition:'Retomada explícita e autorizada.',evidence:[{kind:'context',id:'33333333-3333-4333-8333-333333333333'}]}],truncated:false,assessment:'observed'});
 assert.equal(legacy.findings[0]?.nativeFailure,undefined);
 const source=base();
 source.operationReceipt={operationId:source.jobId,exitCode:1,failureCode:'WORKER_EXITED_WITHOUT_RESULT'};
 const parsed=agentControlDiagnosticFindingSchema.parse(projectNativeTerminalFailure(source));
 assert.equal(parsed.nativeFailure?.cause,'worker_exited_without_result');
 assert.equal(agentControlDiagnosticFindingSchema.safeParse({...parsed,nativeFailure:{cause:SECRET,origin:'stored_agreement'}}).success,false);
 assert.equal(agentControlDiagnosticFindingSchema.safeParse({...parsed,stdout:SECRET}).success,false);
});

const skip=process.env.AC_TEST_DATABASE_URL?false:'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado';

describe('stored native terminal failure on isolated postgres',{skip},()=>{
 test('read is scoped, ordered, limited and free of false or raw failures',async()=>{
  const url=process.env.AC_TEST_DATABASE_URL;
  if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
  const fixture=await isolatedDatabase(url,'natfail');
  const {Ledger}=await import('../src/ledger.ts');
  const {ContextDiagnostics}=await import('../src/diagnostics.ts');
  const db=new Ledger(fixture.url);
  try{
   await db.migrate();
   const project=randomUUID(),otherProject=randomUUID(),owner='owner-'+randomUUID(),outsider='outsider-'+randomUUID();
   await db.pool.query('INSERT INTO ac_projects VALUES($1,$2),($3,$4)',[project,'fixture',otherProject,'other']);
   await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($3,$4,'owner'),($3,$2,'owner')",[project,owner,otherProject,outsider]);
   await db.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,$3::jsonb,$4)',[project,'ab'.repeat(32),JSON.stringify({schemaVersion:1}),owner]);
   const account=randomUUID(),profile=randomUUID();
   await db.pool.query(`INSERT INTO ac_accounts(id,owner_id,provider,label,resource_identity,mode,eligibility,eligibility_source,max_concurrent)
    VALUES($1,$2,'fixture','fixture',$3,'synthetic','documented_supported','synthetic://fixture',4)`,[account,owner,account]);
   await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,'fixture-model','medium','programmer')",[profile,account]);
   const context=await db.createContext(owner,project,randomUUID()),other=await db.createContext(owner,project,randomUUID()),alien=await db.createContext(outsider,otherProject,randomUUID());
   const authority=await db.acquire(owner,context,randomUUID(),'fixture-manager',60);
   const hex=(chars:number)=>'cd'.repeat(chars/2);
   const plant=async(target:string,epoch:number,input:{role:'programmer'|'reviewer';state:'failed'|'completed'|'uncertain';when:string;operation:'same'|'other'|'none';stage?:'review'|'qa';code?:string|null;exitCode?:number;foreign?:boolean;finalizer?:boolean;poison?:boolean})=>{
    const intentId=randomUUID(),operationId=randomUUID(),runId=randomUUID(),jobId=input.operation==='same'?operationId:randomUUID();
    await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state)
     VALUES($1,$2,$3,$4,'{"schemaVersion":1}'::jsonb,$5,$6,$7,1,'failed')`,[intentId,target,owner,hex(64),operationId,runId,epoch]);
    const receipt=input.poison||input.code!==undefined||input.foreign?{operationId:input.foreign?FOREIGN:jobId,exitCode:input.exitCode??1,failureCode:input.code===undefined?'INVALID_SCOPE':input.code,stdout:SECRET,messageRef:SECRET,nativeExecution:{payload:{jobId:input.foreign?FOREIGN:jobId,intentId:input.foreign?FOREIGN:intentId,contextId:input.foreign?FOREIGN:target,exitCode:input.exitCode??1,output:SECRET},signature:SECRET}}:null;
    await db.pool.query('INSERT INTO ac_operations(id,intent_id,state,manager_epoch,receipt) VALUES($1,$2,$3,$4,$5)',[operationId,intentId,input.state==='uncertain'?'registered':'completed',epoch,input.operation==='none'?{stdout:SECRET,failureCode:SECRET}:receipt]);
    const grant=randomUUID();
    await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,$10,false,'released')`,[grant,randomUUID(),intentId,target,epoch,account,profile,input.role,project,hex(64)]);
    await db.pool.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,account_id,profile_id,profile_digest,eligibility_revision,executor_digest,key_fingerprint,input_digest,base_id,role,state,receipt,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16,$17)`,[jobId,grant,intentId,target,epoch,randomUUID(),account,profile,hex(64),hex(64),hex(64),hex(64),'e'.repeat(40),input.role,input.state,{payload:{jobId,intentId,contextId:target,exitCode:input.exitCode??(input.state==='completed'?0:1)},signature:SECRET,stdout:SECRET},input.when]);
    if(input.stage)await db.pool.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state,receipt)
     VALUES($1,$2,$3,$4,$5,$6,'completed',$7)`,[jobId,intentId,input.stage,randomUUID(),randomUUID(),epoch,receipt]);
    if(input.finalizer)await db.pool.query(`INSERT INTO ac_native_artifact_finalizations(job_id,context_id,manager_epoch,input_digest,scope_digest,base_id,state,receipt)
     VALUES($1,$2,$3,$4,$5,$6,'failed',$7)`,[jobId,target,epoch,hex(64),hex(64),'e'.repeat(40),{jobId,status:'failed',failureCode:input.code??'INVALID_SCOPE',stderr:SECRET}]);
    return {jobId,operationId,intentId};
   };
   const coherent=await plant(context,authority.epoch,{role:'programmer',state:'failed',when:'2026-11-04T00:00:01Z',operation:'same',code:'INVALID_SCOPE',finalizer:true,poison:true});
   const absent=await plant(context,authority.epoch,{role:'programmer',state:'failed',when:'2026-11-04T00:00:02Z',operation:'same',code:null});
   const malicious=await plant(context,authority.epoch,{role:'programmer',state:'failed',when:'2026-11-04T00:00:03Z',operation:'same',code:SECRET,finalizer:true});
   const inheritedCodes=['constructor','toString','__proto__'] as const;
   const inherited=await Promise.all(inheritedCodes.map((code,index)=>plant(context,authority.epoch,{role:'programmer',state:'failed',when:`2026-11-04T00:00:03.${index+1}00Z`,operation:'same',code,finalizer:true})));
   const divergent=await plant(context,authority.epoch,{role:'programmer',state:'failed',when:'2026-11-04T00:00:04Z',operation:'same',foreign:true,finalizer:true});
   const unrelated=await plant(context,authority.epoch,{role:'programmer',state:'failed',when:'2026-11-04T00:00:05Z',operation:'other',poison:true});
   const reviewer=await plant(context,authority.epoch,{role:'reviewer',state:'failed',when:'2026-11-04T00:00:06Z',operation:'none',stage:'review',code:'EXECUTION_FAILED'});
   const success=await plant(context,authority.epoch,{role:'programmer',state:'completed',when:'2026-11-04T00:00:07Z',operation:'same',code:null,exitCode:0});
   const pending=await plant(context,authority.epoch,{role:'programmer',state:'uncertain',when:'2026-11-04T00:00:08Z',operation:'same',code:'INVALID_SCOPE'});
   const elsewhere=await plant(other,authority.epoch,{role:'programmer',state:'failed',when:'2026-11-04T00:00:09Z',operation:'same',code:'INVALID_SCOPE',finalizer:true,poison:true});
   const outside=await plant(alien,1,{role:'programmer',state:'failed',when:'2026-11-04T00:00:10Z',operation:'same',code:'INVALID_SCOPE',poison:true});
   const ordered:string[]=[];
   for(let index=0;index<101;index++){
    const row=await plant(other,authority.epoch,{role:'programmer',state:'failed',when:new Date(Date.UTC(2026,0,1,0,0,index)).toISOString(),operation:'same',code:'NO_CHANGES',finalizer:true});
    ordered.push(row.jobId);
   }
   const fingerprint=async()=>(await db.pool.query(`SELECT coalesce(md5(string_agg(row_text, ',' ORDER BY row_text)),'') h FROM (
    SELECT t::text AS row_text FROM ac_native_execution_jobs t
    UNION ALL SELECT t::text FROM ac_operations t
    UNION ALL SELECT t::text FROM ac_stage_operations t
    UNION ALL SELECT t::text FROM ac_native_artifact_finalizations t
    UNION ALL SELECT t::text FROM ac_intents t
    UNION ALL SELECT t::text FROM ac_audit t) rows`)).rows[0].h;
   const before=await fingerprint();
   const service=new ContextDiagnostics(db,project);
   const result=await service.read(owner,context);
   assert.equal(await fingerprint(),before);
   const native=result.findings.filter(item=>item.code==='native_execution_failed');
   const byJob=(id:string)=>native.find(item=>item.evidence.some(evidence=>evidence.kind==='native_execution_job'&&evidence.id===id));
   const coherentFinding=byJob(coherent.jobId);
   assert.equal(coherentFinding?.nativeFailure?.cause,'invalid_scope');
   assert.equal(coherentFinding?.nativeFailure?.origin,'stored_agreement');
   assert.deepEqual(coherentFinding?.evidence.map(item=>item.kind),['native_execution_job','operation','intent']);
   assert.equal(byJob(absent.jobId)?.nativeFailure?.cause,'unknown');
   assert.equal(byJob(absent.jobId)?.nativeFailure?.origin,'stored_agreement');
   assert.equal(byJob(malicious.jobId)?.nativeFailure?.cause,'unknown');
   assert.equal(byJob(malicious.jobId)?.nativeFailure?.origin,'unreconciled');
   for(const [index,row] of inherited.entries()){
    const finding=byJob(row.jobId);
    assert.equal(finding?.nativeFailure?.cause,'unknown');
    assert.equal(finding?.nativeFailure?.origin,'unreconciled');
    assert.equal(JSON.stringify(finding).includes(inheritedCodes[index]),false);
   }
   assert.equal(byJob(coherent.jobId)?.nativeFailure?.cause,'invalid_scope');
   const divergentFinding=byJob(divergent.jobId);
   assert.equal(divergentFinding?.nativeFailure?.cause,'unknown');
   assert.equal(divergentFinding?.nativeFailure?.origin,'unreconciled');
   assert.equal(divergentFinding?.evidence.some(item=>item.id===FOREIGN),false);
   const unrelatedFinding=byJob(unrelated.jobId);
   assert.equal(unrelatedFinding?.evidence.some(item=>item.id===unrelated.operationId),false);
   assert.equal(unrelatedFinding?.nativeFailure?.origin,'unreconciled');
   const reviewFinding=byJob(reviewer.jobId);
   assert.equal(reviewFinding?.nativeFailure?.cause,'execution_failed');
   assert.deepEqual(reviewFinding?.evidence.map(item=>item.kind),['native_execution_job','stage','intent']);
   assert.equal(reviewFinding?.evidence.some(item=>item.id===reviewer.operationId),false);
   assert.equal(byJob(success.jobId),undefined);
   assert.equal(byJob(pending.jobId),undefined);
   assert.equal(byJob(elsewhere.jobId),undefined);
   assert.equal(byJob(outside.jobId),undefined);
   const body=JSON.stringify(result);
   assert.equal(body.includes(SECRET),false);
   assert.equal(body.includes(FOREIGN),false);
   assert.equal(body.includes('cota'),false);
   assert.equal(body.includes('sucesso'),false);
   await assert.rejects(service.read(owner,alien),/PROJECT_RUNTIME_MISMATCH/);
   await assert.rejects(service.read(outsider,context),/CONTEXT_FORBIDDEN/);
   assert.equal(await fingerprint(),before);
   const limited=await service.read(owner,other);
   assert.equal(limited.truncated,true);
   const limitedIds=limited.findings.filter(item=>item.code==='native_execution_failed').map(item=>item.evidence.find(evidence=>evidence.kind==='native_execution_job')?.id);
   assert.deepEqual(limitedIds,ordered.slice(0,100));
   assert.equal(limitedIds.includes(ordered[100]),false);
   assert.equal(limited.findings.filter(item=>item.code==='native_execution_failed').every(item=>item.nativeFailure?.cause==='no_changes'),true);
   assert.equal(await fingerprint(),before);
  }finally{await db.close();await fixture.close();}
 });
});
