import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {NativeExecutionSupervisor} from '../src/native-execution-supervisor.ts';
import {canonical,digest} from '../src/contracts.ts';

test('terminal retirement journals logs before deletion and recovers a lost Docker acknowledgement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ac-terminal-test-'));await mkdir(join(root,'11111111-1111-4111-8111-111111111111'),{mode:0o700});
 const jobId='11111111-1111-4111-8111-111111111111',intentId='22222222-2222-4222-8222-222222222222',grantId='33333333-3333-4333-8333-333333333333',sessionId='44444444-4444-4444-8444-444444444444',contextId='55555555-5555-4555-8555-555555555555';
 const worker='a'.repeat(64),tools='b'.repeat(64),network='c'.repeat(64),provider='d'.repeat(64),executor='e'.repeat(64),fingerprint='f'.repeat(64);
 const input={jobId,intentId,grantId,sessionId,base:'a'.repeat(40),role:'reviewer',task:'review',writePaths:[],artifactId:'66666666-6666-4666-8666-666666666666',outputSchema:{},timeoutMs:900000};
 const physical={jobId,containerId:worker,toolsContainerId:tools,networkId:network,exitCode:1,workerExitCode:1,finishedAt:'2026-01-01T00:00:00Z',toolsFinishedAt:'2026-01-01T00:00:01Z'};
 const keys=generateKeyPairSync('ed25519'),payload={jobId,contextId,intentId,grantId,sessionId,epoch:1,inputDigest:digest(input),executorDigest:executor,physicalDigest:digest(physical),exitCode:1,workerExitCode:1};
 const receipt={payload,signature:sign(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),keys.privateKey).toString('hex')};
 const row={id:jobId,context_id:contextId,intent_id:intentId,grant_id:grantId,session_id:sessionId,role:'reviewer',input_digest:digest(input),executor_digest:executor,key_fingerprint:fingerprint,manager_epoch:1,grant_epoch:1,grant_state:'released',state:'failed',receipt,physical_receipt:physical,worker_id:worker,tools_id:tools,network_id:network,account_id:'account',profile_id:'profile',grant_account:'account',grant_profile:'profile',grant_intent:intentId,grant_context:contextId,grant_role:'reviewer',resource_kind:'model'};
 const labels={'agent-control.job':jobId,'agent-control.launch':digest(input),'agent-control.contract':'native-execution-v1'};
 const containers=new Map([[worker,{Id:worker,Image:'worker',Config:{Labels:labels},State:{Running:false,Status:'exited',FinishedAt:physical.finishedAt,ExitCode:1}}],[tools,{Id:tools,Image:'tools',Config:{Labels:labels},State:{Running:false,Status:'exited',FinishedAt:physical.toolsFinishedAt,ExitCode:0}}]]);
 let canceled=true;
 let net:any={Id:network,Name:'ac-native-exec-'+jobId,Internal:true,Labels:labels,Containers:{}},saved:any,loseAck=true;
 const docker={inspect:async(id:string)=>containers.get(id==='ac-native-worker-'+jobId?worker:id==='ac-native-tools-'+jobId?tools:id),logs:async(id:string)=>Buffer.from(id===worker?'worker log':'tools log'),remove:async(id:string)=>{containers.delete(id);if(loseAck){loseAck=false;throw new Error('lost ack');}},inspectPrivateNetwork:async()=>net,removePrivateNetwork:async()=>{net=undefined;}};
 const client={query:async(sql:string,args:any[])=>{
  if(sql.includes('FROM ac_native_execution_jobs j JOIN'))return {rows:[row]};
  if(sql.startsWith('SELECT 1 FROM ac_plan_cancellations'))return {rowCount:canceled?1:0,rows:[]};
  if(sql.startsWith('SELECT * FROM ac_stage_operations'))return {rows:[]};
  if(sql.startsWith('SELECT * FROM ac_native_terminal_retirements'))return {rows:saved?[saved]:[]};
  if(sql.startsWith('INSERT INTO ac_native_terminal_retirements')){saved={binding:args[1],state:'prepared',proof:null};return {rows:[]};}
  if(sql.startsWith('UPDATE ac_native_terminal_retirements')){saved={...saved,state:'removed',proof:args[1]};return {rows:[]};}
  if(sql.startsWith('INSERT INTO ac_audit'))return {rows:[]};
  throw new Error('unexpected SQL '+sql);
 }};
 const supervisor:any=Object.create(NativeExecutionSupervisor.prototype);
 Object.assign(supervisor,{ledger:{tx:async(fn:any)=>fn(client)},config:{hostRoot:root,providerNetworkId:provider,workerImage:'worker',toolsImage:'tools'},key:keys.privateKey,executorDigest:executor,fingerprint,docker});
 supervisor.scope=async()=>{};supervisor.registeredInput=async()=>input;supervisor.reconcile=async()=>({state:'failed',receipt,output:'',artifact:null});
 try{
  await assert.rejects(supervisor.retireTerminal('owner',{contextId,epoch:1},jobId),/NATIVE_RETIREMENT_EVIDENCE_MISSING/);
  assert.equal(containers.size,2);assert.equal(saved,undefined);canceled=false;
  await assert.rejects(supervisor.retireTerminal('owner',{contextId,epoch:1},jobId),/lost ack/);
  assert.equal(saved.state,'prepared');assert.equal((await readFile(join(root,jobId,'worker-terminal.log'))).toString(),'worker log');
  assert.deepEqual(await supervisor.retireTerminal('owner',{contextId,epoch:2},jobId),{state:'removed'});
  assert.equal(saved.state,'removed');assert.equal(containers.size,0);assert.equal(net,undefined);
  assert.deepEqual(await supervisor.retireTerminal('owner',{contextId,epoch:2},jobId),{state:'removed'});
  saved.proof.signature='0'.repeat(128);await assert.rejects(supervisor.retireTerminal('owner',{contextId,epoch:2},jobId));
 }finally{await rm(root,{recursive:true,force:true});}
});
