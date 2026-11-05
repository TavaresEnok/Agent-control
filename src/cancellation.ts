import {z} from 'zod';
import {digest,Refusal,type Authority} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import type {SandboxClient} from './sandbox-client.ts';
import {CorrectionSource,SpecialistRequest} from './sandbox-broker.ts';
const Source=z.object({base:z.string().regex(/^[a-f0-9]{40}$/),bundle:z.string().min(1).max(1400000),outputPath:z.string().optional(),composition:z.array(z.object({unitId:z.string(),artifactId:z.uuid(),commit:z.string(),tree:z.string(),base:z.string(),writePaths:z.array(z.string())}).strict()).optional(),correction:CorrectionSource.optional()}).strict();
const Execution=z.discriminatedUnion('profile',[
 z.object({profile:z.literal('synthetic-implementation-v1'),source:Source}).strict(),
 z.object({profile:z.literal('synthetic-verification-v1'),source:Source,verification:z.object({artifactId:z.uuid(),operationId:z.uuid(),kind:z.enum(['qa','review','judge']),verifierDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()}).strict(),
 z.object({profile:z.literal('synthetic-specialist-v1'),source:Source,advice:SpecialistRequest}).strict(),
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
     UNION ALL SELECT snapshot,digest FROM ac_stage_execution_launches WHERE stage_id=j.id
     UNION ALL SELECT snapshot,digest FROM ac_specialist_execution_launches WHERE advice_id=j.id) l ON true
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
    if(job.profile==='synthetic-implementation-v1'||job.profile==='synthetic-probe-v1')await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND intent_id=$3 AND state IN ('running','uncertain')",[job.id,receipt,job.intent_id]);
    if(job.profile==='synthetic-verification-v1')await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1 AND intent_id=$3 AND state IN ('running','uncertain')",[job.id,receipt,job.intent_id]);
    if(job.profile==='synthetic-specialist-v1')await c.query("UPDATE ac_specialist_advice SET state='completed',receipt=$2 WHERE id=$1 AND intent_id=$3 AND state IN ('running','uncertain')",[job.id,receipt,job.intent_id]);
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
     AND NOT EXISTS(SELECT 1 FROM ac_native_execution_jobs j WHERE j.grant_id=g.id)
     AND NOT EXISTS(SELECT 1 FROM ac_native_qa_jobs j WHERE j.grant_id=g.id)
     AND NOT EXISTS(SELECT 1 FROM ac_remote_operations r WHERE (r.intent_id=$1 OR (r.intent_id IS NULL AND r.context_id=g.context_id)) AND r.state NOT IN ('completed','failed','canceled_confirmed'))
     AND ((g.role='programmer' AND EXISTS(SELECT 1 FROM ac_operations o WHERE o.intent_id=$1 AND o.grant_id=g.id AND o.state='registered' AND o.handle IS NULL
       AND NOT EXISTS(SELECT 1 FROM ac_execution_launches l WHERE l.operation_id=o.id)))
      OR (g.role IN ('qa','reviewer','judge') AND EXISTS(SELECT 1 FROM ac_stage_operations s WHERE s.intent_id=$1 AND s.attempt_id=g.attempt_id AND s.state='registered' AND s.handle IS NULL
       AND NOT EXISTS(SELECT 1 FROM ac_stage_execution_launches l WHERE l.stage_id=s.id)))
      OR (g.role='specialist' AND EXISTS(SELECT 1 FROM ac_specialist_advice a WHERE a.intent_id=$1 AND a.attempt_id=g.attempt_id
       AND a.grant_id=g.id AND a.state='registered' AND NOT EXISTS(SELECT 1 FROM ac_specialist_execution_launches l WHERE l.advice_id=a.id))))`,
     [request.intent_id,{state:'not_started',source:'cancellation-reconciliation'}]);
    // A registered semantic call never handed control to an executor. Its
    // reserved grant can be returned only while no physical job was recorded.
    // Uncertain calls remain occupied even if a grant happens to look released.
    await c.query(`UPDATE ac_capacity_grants g SET state='released',physical_receipt=$2
      WHERE g.intent_id=$1 AND g.role='manager' AND g.state='reserved'
      AND EXISTS(SELECT 1 FROM ac_semantic_planning_calls s WHERE s.intent_id=$1 AND s.attempt_id=g.attempt_id AND s.state='registered' AND s.grant_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM ac_native_planning_jobs j WHERE j.grant_id=g.id)
      AND NOT EXISTS(SELECT 1 FROM ac_sandbox_jobs j WHERE j.grant_id=g.id)
     AND NOT EXISTS(SELECT 1 FROM ac_native_execution_jobs j WHERE j.grant_id=g.id)
     AND NOT EXISTS(SELECT 1 FROM ac_native_qa_jobs j WHERE j.grant_id=g.id)`,[request.intent_id,{state:'not_started',source:'semantic-cancellation'}]);
    await c.query(`UPDATE ac_semantic_planning_calls s SET state='rejected',failure_code='PLANNING_CANCELED'
      WHERE s.intent_id=$1 AND ((s.state='registered' AND NOT EXISTS(SELECT 1 FROM ac_capacity_grants g WHERE g.attempt_id=s.attempt_id AND g.state<>'released')
       AND NOT EXISTS(SELECT 1 FROM ac_capacity_grants g JOIN ac_native_planning_jobs j ON j.grant_id=g.id WHERE g.attempt_id=s.attempt_id)
       AND NOT EXISTS(SELECT 1 FROM ac_capacity_grants g JOIN ac_sandbox_jobs j ON j.grant_id=g.id WHERE g.attempt_id=s.attempt_id))
      OR (s.state='ready' AND s.receipt IS NOT NULL AND EXISTS(SELECT 1 FROM ac_capacity_grants g WHERE g.id=s.grant_id AND g.state='released' AND g.physical_receipt IS NOT NULL)
       AND NOT EXISTS(SELECT 1 FROM ac_native_planning_jobs j WHERE j.grant_id=s.grant_id AND j.state NOT IN ('completed','failed'))))`,[request.intent_id]);
    const pending=(await c.query(`SELECT
     EXISTS(SELECT 1 FROM ac_capacity_grants WHERE intent_id=$1 AND state<>'released') OR
     EXISTS(SELECT 1 FROM ac_semantic_planning_calls WHERE intent_id=$1 AND state IN ('registered','uncertain','ready')) OR
     EXISTS(SELECT 1 FROM ac_native_execution_jobs WHERE intent_id=$1 AND state NOT IN ('completed','failed')) OR
     EXISTS(SELECT 1 FROM ac_intents i JOIN ac_worktree_writers w ON w.parent_intent_id=i.parent_intent_id AND w.run_id=i.run_id
       JOIN ac_native_execution_jobs j ON j.intent_id=i.id AND j.role='programmer' WHERE i.id=$1 AND w.state='held') OR
     EXISTS(SELECT 1 FROM ac_native_qa_jobs WHERE intent_id=$1 AND state NOT IN ('completed','failed')) OR
     EXISTS(SELECT 1 FROM ac_intents child LEFT JOIN ac_plan_cancellations cc ON cc.intent_id=child.id
       WHERE child.parent_intent_id=$1 AND (cc.intent_id IS NULL OR cc.state<>'confirmed')) OR
     EXISTS(SELECT 1 FROM ac_operations WHERE intent_id=$1 AND state IN ('uncertain','running')) OR
     EXISTS(SELECT 1 FROM ac_stage_operations WHERE intent_id=$1 AND state IN ('uncertain','running')) OR
     EXISTS(SELECT 1 FROM ac_specialist_advice WHERE intent_id=$1 AND state IN ('uncertain','running')) OR
     EXISTS(SELECT 1 FROM ac_integration_intents t JOIN ac_artifacts a ON a.id=t.artifact_id WHERE a.intent_id=$1 AND t.state='uncertain') OR
     EXISTS(SELECT 1 FROM ac_sandbox_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE g.intent_id=$1 AND j.state NOT IN ('completed','failed')) OR
     EXISTS(SELECT 1 FROM ac_remote_operations r WHERE (r.intent_id=$1 OR (r.intent_id IS NULL AND r.context_id=$2)) AND r.state NOT IN ('completed','failed','canceled_confirmed'))
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
