import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CezarRuntime} from '../src/cezar.ts';
import {Cancellations} from '../src/cancellation.ts';

test('one uncertain native job does not block another job or remote cancellation',async()=>{
 const ids=Array.from({length:33},()=>randomUUID()),seen:string[]=[];
 mock.method(Cancellations.prototype,'reconcile',async()=>{});
 const supervisor={supportsAccount:()=>true,executorDigest:'digest',keyFingerprint:'key',async reconcileCancellation(_p:string,_a:unknown,id:string){seen.push(id);if(id===ids[0])throw Error('UNCERTAIN');},async retireTerminal(){seen.push('retire');}};
 const ledger={heartbeat:async()=>{},pool:{query:async(sql:string)=>sql.includes('SELECT j.id,j.role')?{rows:ids.map(id=>({id,role:'reviewer',account_id:'a',executor_digest:'digest',key_fingerprint:'key',cancellation_state:'requested'}))}:{rows:[],rowCount:0}}};
 const runtime={running:true,lock:true,ledger,manager:{cancel(){}},nativePlanning:[],nativeExecutions:[supervisor],remote:{async reconcileCancellationRequests(){seen.push('remote');}}};
 try{await assert.rejects(CezarRuntime.prototype.reconcileCancellations.call(runtime as never,{contextId:randomUUID(),epoch:1,instanceId:randomUUID()},'owner'),(error:any)=>error instanceof AggregateError&&error.errors.length===1&&error.errors[0].cause.message==='UNCERTAIN');assert.deepEqual(seen,[...ids,'remote']);}finally{mock.restoreAll();}
});

test('confirmed reviewer cancellation retires without recording verification',async()=>{
 const id=randomUUID(),seen:string[]=[];
 mock.method(Cancellations.prototype,'reconcile',async()=>{});
 const supervisor={supportsAccount:()=>true,executorDigest:'digest',keyFingerprint:'key',async reconcileRegistered(){seen.push('reconcile');return {state:'completed'};},async retireTerminal(_p:string,_a:unknown,job:string){assert.equal(job,id);seen.push('retire');}};
 const ledger={heartbeat:async()=>{},pool:{query:async(sql:string)=>sql.includes('SELECT j.id,j.role')?{rows:[{id,role:'reviewer',account_id:'a',executor_digest:'digest',key_fingerprint:'key',cancellation_state:'confirmed'}]}:sql.includes('SELECT 1 FROM ac_native_execution_jobs j')?{rows:[{}],rowCount:1}:{rows:[],rowCount:0}}};
 const runtime={running:true,lock:true,ledger,manager:{cancel(){}},nativePlanning:[],nativeExecutions:[supervisor],engineering:{reconcileIntegrationResult:async()=>{},options:{nativeVerification:{record:async()=>{seen.push('record');}}}}};
 try{await CezarRuntime.prototype.reconcileCancellations.call(runtime as never,{contextId:randomUUID(),epoch:1,instanceId:randomUUID()},'owner');assert.deepEqual(seen,['reconcile','retire']);}finally{mock.restoreAll();}
});

test('sandbox, QA and planning failures do not prevent remote reconciliation',async()=>{
 const seen:string[]=[],id=randomUUID();
 mock.method(Cancellations.prototype,'reconcile',async()=>{});
 mock.method(Cancellations.prototype,'reconcileSandbox',async()=>{throw Error('sandbox');});
 const ledger={pool:{query:async(sql:string)=>sql.includes('ac_semantic_planning_calls')?{rows:[{id}]}:{rows:[]}}};
 const runtime={running:true,lock:true,ledger,manager:{cancel(){}},isolated:{client:{}},engineering:{options:{nativeQa:{reconcileContext:async()=>{throw Error('qa');}}}},nativePlanning:[{reconcileCancellation:async()=>{throw Error('planning');}}],nativeExecutions:[],remote:{reconcileCancellationRequests:async()=>{seen.push('remote');}}};
 try{await assert.rejects(CezarRuntime.prototype.reconcileCancellations.call(runtime as never,{contextId:randomUUID(),epoch:1,instanceId:randomUUID()},'owner'),(e:any)=>e instanceof AggregateError&&e.errors.length===3);assert.deepEqual(seen,['remote']);}finally{mock.restoreAll();}
});

test('completed reviewer without stored verification records before retirement',async()=>{
 const id=randomUUID(),seen:string[]=[];mock.method(Cancellations.prototype,'reconcile',async()=>{});
 const supervisor={supportsAccount:()=>true,executorDigest:'digest',keyFingerprint:'key',async reconcileRegistered(){return {state:'completed'};},async retireTerminal(){seen.push('retire');}};
 const ledger={heartbeat:async()=>{},pool:{query:async(sql:string)=>sql.includes('SELECT j.id,j.role')?{rows:[{id,role:'reviewer',account_id:'a',executor_digest:'digest',key_fingerprint:'key',cancellation_state:null}]}:sql.includes('SELECT 1 FROM ac_native_execution_jobs j')?{rows:[{}],rowCount:1}:{rows:[],rowCount:0}}};
 const runtime={running:true,lock:true,ledger,manager:{cancel(){}},nativePlanning:[],nativeExecutions:[supervisor],engineering:{options:{nativeVerification:{record:async()=>{seen.push('record');}}}}};
 try{await CezarRuntime.prototype.reconcileCancellations.call(runtime as never,{contextId:randomUUID(),epoch:1,instanceId:randomUUID()},'owner');assert.deepEqual(seen,['record','retire']);}finally{mock.restoreAll();}
});
