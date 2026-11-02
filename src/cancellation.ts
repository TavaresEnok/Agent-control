import {z} from 'zod';
import {digest,Refusal,type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import type {SandboxClient} from './sandbox-client.ts';
const Source=z.object({base:z.string().regex(/^[a-f0-9]{40}$/),bundle:z.string().min(1).max(1400000)}).strict();
const Execution=z.discriminatedUnion('profile',[
 z.object({profile:z.literal('synthetic-implementation-v1'),source:Source}).strict(),
 z.object({profile:z.literal('synthetic-verification-v1'),source:Source,verification:z.object({artifactId:z.uuid(),operationId:z.uuid(),kind:z.enum(['qa','review','judge'])}).strict()}).strict(),
]);

/** Reconciles signed cancellation requests in the existing controller tick.
 * Native cancellation is only a stop request. PostgreSQL confirms separately. */
export class Cancellations{
 constructor(readonly ledger:Ledger){}
 /** A successor has no live native session to signal. Reuse only the immutable
  * broker job identity; never start a replacement or trust a PID from history. */
 async reconcileSandbox(authority:Authority,client:SandboxClient){
  const jobs=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   return (await c.query(`SELECT j.*,g.intent_id,l.snapshot,l.digest FROM ac_sandbox_jobs j
    JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_plan_cancellations x ON x.intent_id=g.intent_id
    LEFT JOIN LATERAL (SELECT snapshot,digest FROM ac_execution_launches WHERE operation_id=j.id
     UNION ALL SELECT snapshot,digest FROM ac_stage_execution_launches WHERE stage_id=j.id) l ON true
    WHERE x.context_id=$1 AND x.state='requested' ORDER BY j.created_at`,[authority.contextId])).rows;
  });
  for(const job of jobs){
   const execution=job.profile==='synthetic-probe-v1'?undefined:Execution.parse(job.snapshot);
   if(execution&&(execution.profile!==job.profile||digest(execution)!==job.digest))throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
   const result=await client.perform('stop',job.id,job.grant_id,authority,execution);
   const terminal=z.object({jobId:z.uuid(),containerId:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int()}).passthrough().safeParse(result);
   if(!terminal.success)continue;
   await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority,true);
    const physical=(await c.query(`SELECT j.state,j.receipt,g.state grant_state,g.physical_receipt FROM ac_sandbox_jobs j
     JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[job.id,authority.contextId])).rows[0];
    if(!physical||!['completed','failed'].includes(physical.state)||physical.grant_state!=='released'||
       terminal.data.jobId!==job.id||digest(physical.receipt)!==digest(result)||digest(physical.physical_receipt)!==digest(result))
      throw new Refusal('CANCELLATION_PHYSICAL_RECEIPT_UNCONFIRMED');
    const receipt={cancellation:true,physical:physical.receipt};
    await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND state IN ('running','uncertain')",[job.id,receipt]);
    await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1 AND state IN ('running','uncertain')",[job.id,receipt]);
   });
  }
 }
 async reconcile(authority:Authority,cancelNative:(runId:string)=>void){
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   const requests=(await c.query(`SELECT x.intent_id,i.run_id FROM ac_plan_cancellations x JOIN ac_intents i ON i.id=x.intent_id
    WHERE x.context_id=$1 AND x.state='requested' FOR UPDATE OF x`,[authority.contextId])).rows;
   for(const request of requests){
    cancelNative(request.run_id);
    await c.query('DELETE FROM ac_capacity_waits WHERE intent_id=$1',[request.intent_id]);
    // Reserved capacity can be returned only when its owner never persisted
    // launch preparation and no broker/remote job exists. Unknown effects hold it.
    await c.query(`UPDATE ac_capacity_grants g SET state='released',physical_receipt=$2
     WHERE g.intent_id=$1 AND g.state='reserved'
     AND NOT EXISTS(SELECT 1 FROM ac_sandbox_jobs j WHERE j.grant_id=g.id)
     AND NOT EXISTS(SELECT 1 FROM ac_remote_operations r WHERE r.context_id=g.context_id AND r.state NOT IN ('completed','failed','canceled_confirmed'))
     AND ((g.role='programmer' AND EXISTS(SELECT 1 FROM ac_operations o WHERE o.intent_id=$1 AND o.state='registered' AND o.handle IS NULL))
      OR (g.role IN ('qa','reviewer','judge') AND EXISTS(SELECT 1 FROM ac_stage_operations s WHERE s.intent_id=$1 AND s.attempt_id=g.attempt_id AND s.state='registered' AND s.handle IS NULL)))`,
     [request.intent_id,{state:'not_started',source:'cancellation-reconciliation'}]);
    const pending=(await c.query(`SELECT
     EXISTS(SELECT 1 FROM ac_capacity_grants WHERE intent_id=$1 AND state<>'released') OR
     EXISTS(SELECT 1 FROM ac_operations WHERE intent_id=$1 AND state IN ('uncertain','running')) OR
     EXISTS(SELECT 1 FROM ac_stage_operations WHERE intent_id=$1 AND state IN ('uncertain','running')) OR
     EXISTS(SELECT 1 FROM ac_sandbox_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE g.intent_id=$1 AND j.state NOT IN ('completed','failed')) OR
     EXISTS(SELECT 1 FROM ac_remote_operations r WHERE r.context_id=$2 AND r.state NOT IN ('completed','failed','canceled_confirmed'))
     pending`,[request.intent_id,authority.contextId])).rows[0].pending;
    if(pending)continue;
    await c.query("UPDATE ac_plan_cancellations SET state='confirmed',confirmed_at=clock_timestamp() WHERE intent_id=$1",[request.intent_id]);
    await c.query("UPDATE ac_intents SET state='canceled' WHERE id=$1",[request.intent_id]);
    await c.query('DELETE FROM ac_capacity_waits WHERE intent_id=$1',[request.intent_id]);
    await this.ledger.refreshPending(c,authority.contextId);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'plan.cancellation_confirmed',$2)",[authority.contextId,{intentId:request.intent_id}]);
   }
  });
 }
}
