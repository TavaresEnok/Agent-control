import {resolveFrozenWorkflow} from './workflow-versions.ts';
import {verifyLocalWorkflowRuntime,assertLoadedRuntime,registeredProcessAlive,GENERATION_COMPATIBILITY,type LocalWorkflowRuntime} from './local-workflow-runtime.ts';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {Ledger} from './ledger.ts';
import {Authority,digest,Refusal} from './contracts.ts';

const Build=z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const RuntimeIdentity=z.object({instanceId:z.uuid(),buildId:Build}).strict();
export type RuntimeIdentity=z.infer<typeof RuntimeIdentity>;


/** A build declaration is installation-owned, not a workflow-supplied label.
 * Bootstrap must announce the actual process/executable and keep its lease live.
 * No process is launched and no graph is progressed by this registry. */
export class WorkflowGenerations{
 constructor(readonly ledger:Ledger){}
 private async owner(c:PoolClient,principal:string,projectId:string){
  await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR UPDATE',[projectId]);
  const row=(await c.query('SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2',[projectId,principal])).rows[0];
  if(row?.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
 }
 async announce(principal:string,projectId:string,capability:LocalWorkflowRuntime,leaseSeconds=30){
  if(!Number.isInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>60)throw new Refusal('INVALID_RUNTIME_LEASE');
  const evidence=await verifyLocalWorkflowRuntime(capability),input={...evidence.identity,...evidence};
  RuntimeIdentity.parse(input.identity);
  await this.ledger.tx(async c=>{await this.owner(c,principal,projectId);
   const previous=(await c.query('SELECT * FROM ac_workflow_runtime_instances WHERE project_id=$1 AND instance_id=$2 FOR UPDATE',[projectId,input.identity.instanceId])).rows[0];
   if(previous&&(previous.build_id!==input.identity.buildId||previous.executable_digest!==input.executableDigest||previous.runtime_digest!==input.runtimeDigest||previous.process_id!==input.processId||previous.process_start!==input.processStart||digest(previous.workflow_digests)!==digest(input.workflowDigests)))throw new Refusal('RUNTIME_INSTANCE_IDENTITY_CONFLICT');
   await c.query(`INSERT INTO ac_workflow_runtime_instances VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+$10*interval '1 second')
    ON CONFLICT(project_id,instance_id) DO UPDATE SET lease_until=excluded.lease_until`,[projectId,input.identity.instanceId,input.identity.buildId,input.executableDigest,input.runtimeDigest,input.processId,input.processStart,input.protocol,JSON.stringify(input.workflowDigests),leaseSeconds]);
  });
 }
 /** Prepare a retained/new local package for an already frozen dynamic
 * plan. Capability and resolver belong to this loaded package; plain digests
 * and foreign declarations cannot extend the catalog. */
 async approveFrozen(principal:string,projectId:string,capability:LocalWorkflowRuntime,intentId:string){
  const evidence=await verifyLocalWorkflowRuntime(capability);
  await this.ledger.tx(async c=>{await this.owner(c,principal,projectId);
   const row=(await c.query(`SELECT i.id,i.manager_epoch,i.command,f.snapshot,f.digest,x.project_id
    FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id JOIN ac_frozen_plans f ON f.intent_id=i.id WHERE i.id=$1 AND x.project_id=$2`,[intentId,projectId])).rows[0];
   if(!row)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   await approveSnapshot(c,row,evidence.identity);
  });
 }
 async selectForNew(principal:string,projectId:string,buildId:string){
  Build.parse(buildId);await this.ledger.tx(async c=>{await this.owner(c,principal,projectId);
   await requireRuntime(c,projectId,buildId);
   if((await c.query(`SELECT 1 FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id WHERE x.project_id=$1 AND i.parent_intent_id IS NULL AND i.state NOT IN ('completed','done','review','failed','canceled','cancelled') AND NOT EXISTS(SELECT 1 FROM ac_workflow_generations g WHERE g.intent_id=i.id) LIMIT 1`,[projectId])).rowCount)throw new Refusal('WORKFLOW_LEGACY_RETENTION_REQUIRED');
   await c.query('INSERT INTO ac_workflow_runtime_defaults VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET build_id=excluded.build_id',[projectId,buildId]);
  });
 }
 /** Enroll an existing frozen run without changing its immutable workflow pin. */
 async retain(principal:string,authority:Authority,intentId:string,buildId:string){
  Build.parse(buildId);z.uuid().parse(intentId);
  await this.ledger.tx(async c=>{await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const row=(await c.query(`SELECT i.context_id,x.project_id,f.digest FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id
    JOIN ac_frozen_plans f ON f.intent_id=i.id WHERE i.id=$1 AND i.context_id=$2`,[intentId,authority.contextId])).rows[0];
   if(!row)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   await requireRuntime(c,row.project_id,buildId,row.digest);
   const old=(await c.query('SELECT build_id FROM ac_workflow_generations WHERE intent_id=$1 ORDER BY generation DESC LIMIT 1',[intentId])).rows[0];
   if(old){if(old.build_id!==buildId)throw new Refusal('GENERATION_ALREADY_ENROLLED');return;}
   await c.query(`INSERT INTO ac_workflow_generations(intent_id,generation,build_id,state,workflow_digest,continuation)
    VALUES($1,0,$2,'active',$3,$4)`,[intentId,buildId,row.digest,{schemaVersion:1,historyAfterSeq:0}]);
  });
 }
 /** One atomic successor, with unchanged run/intent/message/operation IDs.
 * A lost ACK is replayed before checking the now-fenced predecessor authority. */
 async rollover(principal:string,authority:Authority,raw:{intentId:string;expectedGeneration:number;requestId:string;targetBuild:string;successorManagerInstance:string}){
  const input=z.object({intentId:z.uuid(),expectedGeneration:z.number().int().min(0),requestId:z.uuid(),targetBuild:Build,successorManagerInstance:z.uuid()}).strict().parse(raw);
  const requestDigest=digest({principal,authority,input});
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,82))',[input.requestId]);
   const replay=(await c.query('SELECT * FROM ac_workflow_generations WHERE request_id=$1',[input.requestId])).rows[0];
   if(replay){if(replay.request_digest!==requestDigest)throw new Refusal('GENERATION_REQUEST_CONFLICT');return receipt(authority.contextId,replay);}
   await this.ledger.fence(c,authority,true);
   const row=(await c.query(`SELECT i.*,x.project_id,x.paused,x.pause_revision,f.digest AS workflow_digest
    FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id JOIN ac_frozen_plans f ON f.intent_id=i.id
    WHERE i.id=$1 AND i.context_id=$2`,[input.intentId,authority.contextId])).rows[0];
   if(!row)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   const previous=(await c.query("SELECT * FROM ac_workflow_generations WHERE intent_id=$1 AND state='active' FOR UPDATE",[input.intentId])).rows[0];
   if(!previous||previous.generation!==input.expectedGeneration||previous.workflow_digest!==row.workflow_digest)throw new Refusal('GENERATION_CONFLICT');
   if(['completed','done','review','failed','canceled','cancelled'].includes(row.state))throw new Refusal('GENERATION_TERMINAL');
   await requireRuntime(c,row.project_id,input.targetBuild,row.workflow_digest);
   // Store only stable references/counts/cursors, never a copy of ciphertext,
   // event history, prompts, keys, or an alternative graph state.
   const continuity=(await c.query(`SELECT o.id AS operation_id,o.state AS operation_state,
    (SELECT id FROM ac_outbox WHERE intent_id=i.id) AS outbox_id,
    (SELECT count(*)::integer FROM ac_chat_messages m JOIN ac_session_links s ON s.session_id=m.session_id WHERE s.context_id=i.context_id AND NOT m.sent) AS pending_messages,
    (SELECT count(*)::integer FROM ac_intents p WHERE p.context_id=i.context_id AND p.state NOT IN ('completed','done','review','failed','canceled','cancelled')) AS pending_intents,
    (SELECT COALESCE(max(seq),0)::text FROM ac_events e WHERE e.run_id=i.run_id) AS history_after_seq,
    (SELECT snapshot->>'historyCursor' FROM ac_checkpoints k WHERE k.context_id=i.context_id) AS conversation_after_seq
    FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.id=$1`,[input.intentId])).rows[0];
   if(!continuity)throw new Refusal('OPERATION_MISSING');
   const continuation={schemaVersion:1,predecessor:previous.generation,intentId:row.id,runId:row.run_id,operationId:continuity.operation_id,
    outboxId:continuity.outbox_id,pendingMessages:continuity.pending_messages,pendingIntents:continuity.pending_intents,
    historyAfterSeq:continuity.history_after_seq,conversationAfterSeq:continuity.conversation_after_seq??null,
    paused:row.paused,pauseRevision:row.pause_revision,workflowDigest:row.workflow_digest};
   await c.query("UPDATE ac_workflow_generations SET state='retained' WHERE intent_id=$1 AND generation=$2",[input.intentId,previous.generation]);
   const epoch=authority.epoch+1;
   const next=(await c.query(`INSERT INTO ac_workflow_generations(intent_id,generation,predecessor,build_id,state,request_id,request_digest,workflow_digest,continuation,successor_instance,successor_epoch)
    VALUES($1,$2,$3,$4,'reconciling',$5,$6,$7,$8,$9,$10) RETURNING *`,[input.intentId,previous.generation+1,previous.generation,input.targetBuild,input.requestId,requestDigest,row.workflow_digest,continuation,input.successorManagerInstance,epoch])).rows[0];
   await c.query("UPDATE ac_managers SET instance_id=$2,epoch=$3,lease_until=clock_timestamp()+interval '60 seconds' WHERE context_id=$1",[authority.contextId,input.successorManagerInstance,epoch]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'workflow.generation_transferred',$2)",[authority.contextId,{intentId:input.intentId,from:previous.generation,to:previous.generation+1,requestId:input.requestId}]);
   return receipt(authority.contextId,next);
  });
 }
 /** Clear the dispatch barrier only after existing reconcilers have established
 * no live/uncertain effect. A paused context stays paused after this step. */
 async reconciled(principal:string,authority:Authority,intentId:string){
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const row=(await c.query(`SELECT g.*,x.project_id FROM ac_workflow_generations g JOIN ac_intents i ON i.id=g.intent_id
    JOIN ac_contexts x ON x.id=i.context_id WHERE i.id=$1 AND i.context_id=$2 AND g.state IN ('active','reconciling') FOR UPDATE OF g`,[intentId,authority.contextId])).rows[0];
   if(!row)throw new Refusal('GENERATION_MISSING');
   await assertGenerationIntent(c,intentId,this.ledger.runtimeIdentity);
   await requireRuntime(c,row.project_id,row.build_id,row.workflow_digest);
   await assertContextEffectsQuiescent(c,authority.contextId);
   await c.query("UPDATE ac_workflow_generations SET state='active' WHERE intent_id=$1 AND generation=$2",[intentId,row.generation]);
   return {generation:row.generation,state:'active' as const};
  });
 }
 /** Small routing DTO; definitions, prompts, messages and execution logs stay private. */
 async route(principal:string,intentId:string){
  return this.ledger.tx(async c=>{
   const intent=(await c.query('SELECT context_id FROM ac_intents WHERE id=$1',[intentId])).rows[0];if(!intent)throw new Refusal('INTENT_MISSING');
   await this.ledger.authorize(c,principal,intent.context_id,false);
   const row=(await c.query(`SELECT g.generation,g.build_id,g.state FROM ac_workflow_generations g
    WHERE g.intent_id=COALESCE((SELECT parent_intent_id FROM ac_intents WHERE id=$1),$1) AND g.state IN ('active','reconciling')`,[intentId])).rows[0];
   return row?{generation:Number(row.generation),buildId:String(row.build_id),state:String(row.state)}:null;
  });
 }
 /** Bounded continuation of authoritative status history. The original
 * RunStore transcript remains intact for Cezar recovery and private audit. */
 async historyPage(principal:string,intentId:string,generation:number,afterSeq:string='0',limit=100){
  z.number().int().min(0).parse(generation);z.string().regex(/^\d{1,19}$/).parse(afterSeq);z.number().int().min(1).max(100).parse(limit);
  return this.ledger.tx(async c=>{
   const row=(await c.query(`SELECT i.context_id,i.run_id,g.continuation FROM ac_intents i JOIN ac_workflow_generations g ON g.intent_id=i.id WHERE i.id=$1 AND g.generation=$2`,[intentId,generation])).rows[0];
   if(!row)throw new Refusal('GENERATION_MISSING');await this.ledger.authorize(c,principal,row.context_id,false);
   const rows=(await c.query('SELECT event_id,seq::text,status FROM ac_events WHERE run_id=$1 AND seq>$2::bigint ORDER BY ac_events.seq LIMIT $3',[row.run_id,afterSeq,limit+1])).rows;
   return {generation,runId:row.run_id,continuation:row.continuation,events:rows.slice(0,limit),nextAfterSeq:rows.length>limit?String(rows[limit-1].seq):null};
  });
 }
 async releaseRetained(principal:string,projectId:string,buildId:string){
  return this.ledger.tx(async c=>{await this.owner(c,principal,projectId);
   // A live current generation anywhere still requires the old executable.
   if((await c.query(`SELECT 1 FROM ac_workflow_generations g JOIN ac_intents i ON i.id=g.intent_id JOIN ac_contexts x ON x.id=i.context_id
    WHERE x.project_id=$1 AND g.build_id=$2 AND g.state IN ('active','reconciling') AND i.state NOT IN ('completed','done','review','failed','canceled','cancelled') LIMIT 1`,[projectId,buildId])).rowCount)throw new Refusal('RUNTIME_STILL_REQUIRED');
   const contexts=(await c.query(`SELECT DISTINCT i.context_id FROM ac_workflow_generations g JOIN ac_intents i ON i.id=g.intent_id JOIN ac_contexts x ON x.id=i.context_id WHERE x.project_id=$1 AND g.build_id=$2 AND g.state='retained'`,[projectId,buildId])).rows;
   for(const context of contexts)await assertContextEffectsQuiescent(c,context.context_id);
   const result=await c.query(`UPDATE ac_workflow_generations g SET state='released' FROM ac_intents i,ac_contexts x
    WHERE g.intent_id=i.id AND i.context_id=x.id AND x.project_id=$1 AND g.build_id=$2 AND g.state='retained'`,[projectId,buildId]);
   return {released:result.rowCount??0};
  });
 }
}
function receipt(contextId:string,row:Record<string,any>){return {intentId:String(row.intent_id),generation:Number(row.generation),state:String(row.state),authority:Authority.parse({contextId,instanceId:row.successor_instance,epoch:Number(row.successor_epoch)}),continuation:row.continuation};}
async function requireRuntime(c:PoolClient,projectId:string,buildId:string,workflowDigest?:string){
 const live=(await c.query(`SELECT process_id,process_start FROM ac_workflow_runtime_instances WHERE project_id=$1 AND build_id=$2 AND lease_until>clock_timestamp()
  AND ($3::text IS NULL OR workflow_digests ? $3 OR EXISTS(SELECT 1 FROM ac_workflow_runtime_snapshots s WHERE s.project_id=ac_workflow_runtime_instances.project_id AND s.instance_id=ac_workflow_runtime_instances.instance_id AND s.workflow_digest=$3)) AND protocol='cezar-frozen-graph-generation-v1' FOR SHARE`,[projectId,buildId,workflowDigest??null])).rows;
 for(const candidate of live)if(await registeredProcessAlive(candidate.process_id,candidate.process_start))return;
 throw new Refusal(workflowDigest?'WORKFLOW_RUNTIME_MISSING_OR_INCOMPATIBLE':'WORKFLOW_RUNTIME_UNAVAILABLE');
}
/** Admission routes only new runs; existing generations never follow a changed default. */
export async function enrollWorkflowAdmission(c:PoolClient,intentId:string,identity?:RuntimeIdentity){
 await c.query('SELECT p.id FROM ac_projects p JOIN ac_contexts x ON x.project_id=p.id JOIN ac_intents i ON i.context_id=x.id WHERE i.id=$1 FOR SHARE OF p',[intentId]);
 const row=(await c.query(`SELECT d.build_id,x.project_id,i.id,i.manager_epoch,i.command,f.digest,f.snapshot FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id
  JOIN ac_frozen_plans f ON f.intent_id=i.id JOIN ac_workflow_runtime_defaults d ON d.project_id=x.project_id WHERE i.id=$1`,[intentId])).rows[0];
 if(!row)return;
 if(identity?.buildId===row.build_id)await approveSnapshot(c,row,identity);
 await requireRuntime(c,row.project_id,row.build_id,row.digest);
 await c.query(`INSERT INTO ac_workflow_generations(intent_id,generation,build_id,state,workflow_digest,continuation)
  VALUES($1,0,$2,'active',$3,$4)`,[intentId,row.build_id,row.digest,{schemaVersion:1,historyAfterSeq:0}]);
}
export async function assertGenerationFence(c:PoolClient,contextId:string,allowReconciliation:boolean){
 if(!allowReconciliation&&(await c.query(`SELECT 1 FROM ac_workflow_generations g JOIN ac_intents i ON i.id=g.intent_id
  WHERE i.context_id=$1 AND g.state='reconciling' LIMIT 1`,[contextId])).rowCount)throw new Refusal('WORKFLOW_GENERATION_RECONCILIATION_REQUIRED');
}
export async function assertGenerationIntent(c:PoolClient,intentId:string,identity?:RuntimeIdentity){
 const row=(await c.query(`SELECT g.build_id,g.workflow_digest,x.project_id FROM ac_intents i JOIN ac_contexts x ON x.id=i.context_id
  JOIN ac_workflow_generations g ON g.intent_id=COALESCE(i.parent_intent_id,i.id) WHERE i.id=$1 AND g.state IN ('active','reconciling')`,[intentId])).rows[0];
 if(!row)return;
 if(!identity||identity.buildId!==row.build_id)throw new Refusal('WORKFLOW_RUNTIME_ROUTE_MISMATCH');
 const live=(await c.query(`SELECT process_id,process_start FROM ac_workflow_runtime_instances WHERE project_id=$1 AND instance_id=$2 AND build_id=$3
  AND lease_until>clock_timestamp() AND (workflow_digests ? $4 OR EXISTS(SELECT 1 FROM ac_workflow_runtime_snapshots s WHERE s.project_id=ac_workflow_runtime_instances.project_id AND s.instance_id=ac_workflow_runtime_instances.instance_id AND s.workflow_digest=$4)) AND protocol=$5`,[row.project_id,identity.instanceId,row.build_id,row.workflow_digest,GENERATION_COMPATIBILITY])).rows[0];
 if(!live)throw new Refusal('WORKFLOW_RUNTIME_UNAVAILABLE');
 await assertLoadedRuntime(identity.buildId,live.process_id,live.process_start);
}

/** Context-wide barrier is intentionally conservative: manager epoch changes
 * affect every child and effect in the context, not only the root operation. */
async function assertContextEffectsQuiescent(c:PoolClient,contextId:string){
 const active=(await c.query(`SELECT 1 FROM ac_operations o JOIN ac_intents i ON i.id=o.intent_id WHERE i.context_id=$1 AND (o.state IN ('running','uncertain') OR (o.handle IS NOT NULL AND o.receipt IS NULL) OR (o.state<>'completed' AND EXISTS(SELECT 1 FROM ac_execution_launches l WHERE l.operation_id=o.id)))
  UNION ALL SELECT 1 FROM ac_stage_operations s JOIN ac_intents i ON i.id=s.intent_id WHERE i.context_id=$1 AND (s.state IN ('running','uncertain') OR (s.handle IS NOT NULL AND s.receipt IS NULL) OR (s.state<>'completed' AND EXISTS(SELECT 1 FROM ac_stage_execution_launches l WHERE l.stage_id=s.id)))
  UNION ALL SELECT 1 FROM ac_capacity_grants WHERE context_id=$1 AND state<>'released'
  UNION ALL SELECT 1 FROM ac_native_execution_jobs WHERE context_id=$1 AND state NOT IN ('completed','failed')
  UNION ALL SELECT 1 FROM ac_native_planning_jobs WHERE context_id=$1 AND state NOT IN ('completed','failed')
  UNION ALL SELECT 1 FROM ac_native_qa_jobs WHERE context_id=$1 AND state NOT IN ('completed','failed')
  UNION ALL SELECT 1 FROM ac_remote_operations WHERE context_id=$1 AND state NOT IN ('completed','failed','canceled_confirmed')
  UNION ALL SELECT 1 FROM ac_administrative_operations WHERE context_id=$1 AND state IN ('running','uncertain')
  UNION ALL SELECT 1 FROM ac_sandbox_jobs WHERE context_id=$1 AND state IN ('running','uncertain')
  UNION ALL SELECT 1 FROM ac_specialist_advice a WHERE a.context_id=$1 AND (a.state IN ('running','uncertain') OR (a.state<>'completed' AND EXISTS(SELECT 1 FROM ac_specialist_execution_launches l WHERE l.advice_id=a.id)))
  UNION ALL SELECT 1 FROM ac_semantic_planning_calls WHERE context_id=$1 AND state='uncertain'
  UNION ALL SELECT 1 FROM ac_native_terminal_retirements r JOIN ac_native_execution_jobs j ON j.id=r.job_id WHERE j.context_id=$1 AND r.state='prepared'
  UNION ALL SELECT 1 FROM ac_native_qa_retirements r JOIN ac_native_qa_jobs j ON j.id=r.job_id WHERE j.context_id=$1 AND r.state='prepared'
  UNION ALL SELECT 1 FROM ac_worktree_writers w JOIN ac_intents i ON i.id=w.parent_intent_id WHERE i.context_id=$1 AND w.state='held'
  LIMIT 1`,[contextId])).rowCount;
 if(active)throw new Refusal('GENERATION_EFFECT_RECONCILIATION_REQUIRED');
 // 081 is an independently delivered optional resource journal. Absence in
 // earlier installations is not permission to ignore it when installed.
 if((await c.query("SELECT to_regclass('ac_native_resource_admissions') AS name")).rows[0].name){
  const admissions=(await c.query(`SELECT r.job_id,r.grant_id,g.state AS grant_state,g.physical_receipt,
   e.state AS execution_state,e.receipt AS execution_receipt,e.worker_id,e.tools_id,e.network_id,
   er.state AS execution_retirement,wr.state AS writer_retirement,
   q.state AS qa_state,q.receipt AS qa_receipt,qr.state AS qa_retirement,
   p.state AS planning_state,p.receipt AS planning_receipt
   FROM ac_native_resource_admissions r LEFT JOIN ac_capacity_grants g ON g.id=r.grant_id AND g.context_id=r.context_id
   LEFT JOIN ac_native_execution_jobs e ON e.id=r.job_id AND e.grant_id=r.grant_id AND e.context_id=r.context_id
   LEFT JOIN ac_native_terminal_retirements er ON er.job_id=e.id
   LEFT JOIN ac_native_writer_retirements wr ON wr.job_id=e.id
   LEFT JOIN ac_native_qa_jobs q ON q.id=r.job_id AND q.grant_id=r.grant_id AND q.context_id=r.context_id
   LEFT JOIN ac_native_qa_retirements qr ON qr.job_id=q.id
   LEFT JOIN ac_native_planning_jobs p ON p.id=r.job_id AND p.grant_id=r.grant_id AND p.context_id=r.context_id
   WHERE r.context_id=$1 AND r.state<>'canceled'`,[contextId])).rows;
  for(const row of admissions){
   const physical=row.physical_receipt;
   const terminal=(value:unknown)=>value==='completed'||value==='failed';
   const execution=terminal(row.execution_state)&&row.execution_receipt?.payload?.physicalDigest===digest(physical)&&
    physical?.jobId===row.job_id&&physical?.containerId===row.worker_id&&physical?.toolsContainerId===row.tools_id&&physical?.networkId===row.network_id&&
    (row.execution_retirement==='removed'||row.writer_retirement==='revoked');
   const qa=terminal(row.qa_state)&&row.qa_receipt&&physical&&digest(row.qa_receipt)===digest(physical)&&row.qa_retirement==='removed';
   // Existing supervisor authenticated the terminal journal. This is exited
   // process evidence, not a new claim that its retained group was removed.
   const planning=terminal(row.planning_state)&&physical?.jobId===row.job_id&&row.planning_receipt?.payload?.physicalDigest===digest(physical);
   if(row.grant_state!=='released'||!physical||!(execution||qa||planning))throw new Refusal('GENERATION_EFFECT_RECONCILIATION_REQUIRED');
  }
 }
}

const runtimeParkingReasons=new Set(['WORKFLOW_GENERATION_RECONCILIATION_REQUIRED','WORKFLOW_RUNTIME_ROUTE_MISMATCH','WORKFLOW_RUNTIME_UNAVAILABLE','WORKFLOW_RUNTIME_PROCESS_MISMATCH','CEZAR_RUNTIME_PACKAGE_MISMATCH','WORKFLOW_RUNTIME_MISSING_OR_INCOMPATIBLE']);
/** Package-local Refusal classes may differ across retained loaded builds.
 * Only these closed, non-authorizing reasons are adapted for per-intent waits. */
export function workflowRuntimeParkingReason(error:unknown):string|undefined{
 if(!error||typeof error!=='object'||!('code' in error)||typeof error.code!=='string')return;
 return runtimeParkingReasons.has(error.code)?error.code:undefined;
}

async function approveSnapshot(c:PoolClient,row:Record<string,any>,identity:RuntimeIdentity){
 const live=(await c.query(`SELECT process_id,process_start FROM ac_workflow_runtime_instances WHERE project_id=$1 AND instance_id=$2 AND build_id=$3 AND lease_until>clock_timestamp() AND protocol=$4 FOR SHARE`,[row.project_id,identity.instanceId,identity.buildId,GENERATION_COMPATIBILITY])).rows[0];
 if(!live)throw new Refusal('WORKFLOW_RUNTIME_UNAVAILABLE');
 await assertLoadedRuntime(identity.buildId,live.process_id,live.process_start);
 const decision=resolveFrozenWorkflow({commandWorkflow:row.command.payload.workflow,snapshot:row.snapshot,storedDigest:row.digest,pin:null,intentEpoch:Number(row.manager_epoch)});
 if(!decision.ok)throw new Refusal('RUNTIME_SNAPSHOT_INCOMPATIBLE');
 await c.query(`INSERT INTO ac_workflow_runtime_snapshots(project_id,instance_id,workflow_digest,source_intent_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[row.project_id,identity.instanceId,decision.digest,row.id]);
}
