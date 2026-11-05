import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';import {NativePlanningSupervisor} from '../src/native-planning-supervisor.ts';

test('execution refuses a legacy blocked model before effects and reconciles existing jobs',async()=>{
 const supervisor=Object.create(NativeExecutionSupervisor.prototype) as any;let exists=false,effects=0,reconciled=0;
 supervisor.ledger={pool:{query:async()=>({rows:exists?[{id:'existing'}]:[]})},tx:async fn=>fn({})};supervisor.identity=async()=>({model:'gpt-6-astra'});supervisor.validateReplay=async()=>{};supervisor.reconcile=async()=>{reconciled++;return {state:'running'};};supervisor.docker={create:async()=>{effects++;}};supervisor.config={};
 const id=()=>randomUUID(),input={jobId:id(),intentId:id(),grantId:id(),sessionId:id(),base:'a'.repeat(40),role:'programmer',task:'safe',writePaths:['src/a.ts']},authority={contextId:id(),instanceId:id(),epoch:1};
 await assert.rejects(supervisor.start('principal',authority,input),/ModelDisabledByPolicy/);assert.equal(effects,0);exists=true;assert.deepEqual(await supervisor.start('principal',authority,input),{state:'running'});assert.equal(reconciled,1);assert.equal(effects,0);
});

test('planning refuses a legacy blocked model before resources but reconciles an existing call',async()=>{
 const supervisor=Object.create(NativePlanningSupervisor.prototype) as any;const id=()=>randomUUID(),account=id(),profile=id(),call=id(),grant=id(),intent=id(),context=id(),session=id(),project=id();const hash='a'.repeat(64);let exists=false,effects=0,reconciled=0;
 const input={callId:call,grantId:grant,intentId:intent,contextId:context,sessionId:session,executionEpoch:1,inputDigest:hash,profile:{id:profile,accountId:account,provider:'codex',mode:'subscription_cli',model:'gpt-6.1-astra',effort:'medium'},assertAuthorized:async()=>{}};
 supervisor.config={id:'exec',executorDigest:hash};supervisor.subjects=new Map([[account,hash]]);supervisor.ledger={tx:async fn=>fn({query:async sql=>{
  if(sql.startsWith('SELECT * FROM ac_semantic_planning_calls'))return {rows:[{state:'uncertain',grant_id:grant,execution_epoch:1,input_digest:hash,selected_executor_id:'exec',selected_executor_digest:hash}]};
  if(sql.includes('FROM ac_capacity_grants g'))return {rows:[{state:'reserved',context_id:context,intent_id:intent,manager_epoch:1,role:'manager',profile_role:'manager',account_id:account,profile_id:profile,model:input.profile.model,effort:'medium',provider:'codex',mode:'subscription_cli',eligibility:'documented_supported',account_enabled:true,profile_enabled:true,resource_identity:'codex:'+hash,principal_id:'principal',project_id:project}]};
  if(sql.startsWith('SELECT id FROM ac_native_planning_jobs'))return {rows:exists?[{id:call}]:[]};throw Error('UNEXPECTED_SQL');}})};supervisor.reconcile=async()=>{reconciled++;return {state:'completed'};};supervisor.docker={create:async()=>{effects++;}};
 await assert.rejects(supervisor.execute(input),/ModelDisabledByPolicy/);assert.equal(effects,0);exists=true;assert.deepEqual(await supervisor.execute(input),{state:'completed'});assert.equal(reconciled,1);assert.equal(effects,0);
});
