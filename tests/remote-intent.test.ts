import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {RemoteOperations,type RemoteTransport} from '../src/remote.ts';
import {Cancellations} from '../src/cancellation.ts';

test('SSH admission binds each operation to its plan; cancellation does not block a sibling plan',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const principal='remote-intent-'+randomUUID(),project=randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Remote plan fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const command=()=>({schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
   action:'plan.start' as const,payload:{workflow:'baseline-synthetic-v1' as const,messageRef:'encrypted:remote-plan-fixture'}});
  const first=await db.accept(principal,command(),authority,'api'),second=await db.accept(principal,command(),authority,'api'),third=await db.accept(principal,command(),authority,'api');
  const pending=new Map<string,Record<string,unknown>>();let completed=false,starts=0;
  const transport:RemoteTransport={async exchange(_host,raw){
   const request=raw as {action:string;operationId:string;projectId:string;taskId:string;epoch:number};
   if(request.action==='start'){starts++;pending.set(request.operationId,{schemaVersion:1,operationId:request.operationId,projectId:request.projectId,taskId:request.taskId,epoch:request.epoch});}
   return {...pending.get(request.operationId),state:completed?'completed':'running',...(completed?{exitCode:0,logSha256:'a'.repeat(64)}:{})};
  }};
  const remote=new RemoteOperations(db,transport),hostId=randomUUID();
  // Boundary stub only; actual host-key validation remains in the two-host SSH proofs.
  await remote.registerHost(principal,project,{id:hostId,label:'No-network contract fixture',hostname:'fixture.invalid',port:2222,username:'fixture',
   publicKey:'ssh-ed25519 '+'A'.repeat(64),fingerprint:'SHA256:'+'A'.repeat(43),credentialRef:randomUUID(),remoteRoot:'/isolated/fixture',allowedTasks:['fixture'],maxConcurrent:4});
  const request={operationId:randomUUID(),intentId:first.id,contextId:context,hostId,taskId:'fixture'};
  await remote.start(principal,request,authority);
  await assert.rejects(remote.cancel(principal,request.operationId,authority),/SIGNED_PLAN_CANCELLATION_REQUIRED/);
  await assert.rejects(db.pool.query('UPDATE ac_remote_operations SET intent_id=$2 WHERE id=$1',[request.operationId,second.id]),/REMOTE_INTENT_IMMUTABLE/);
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[first.id,context,principal,first.plan_revision]);
  await assert.rejects(remote.start(principal,{...request,operationId:randomUUID()},authority),/PLAN_CANCELLATION_REQUESTED/);
  await remote.start(principal,{...request,operationId:randomUUID(),intentId:second.id},authority);
  await remote.reconcileCancellationRequests(principal,authority);
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[third.id,context,principal,third.plan_revision]);
  const cancellations=new Cancellations(db);await cancellations.reconcile(authority,()=>{});
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[first.id])).rows[0].state,'requested');
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[third.id])).rows[0].state,'confirmed','another plan remote operation must not block confirmation');
  completed=true;await remote.reconcileCancellationRequests(principal,authority);await cancellations.reconcile(authority,()=>{});
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[first.id])).rows[0].state,'confirmed');assert.equal(starts,2);
  await assert.rejects(db.pool.query(`INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state)
   VALUES($1,$2,$3,'fixture','unbound-fixture',1,'registered')`,[randomUUID(),context,hostId]),/REMOTE_INTENT_REQUIRED/);
 }finally{await db.close();}
});
