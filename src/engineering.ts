import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { Authority, canonical, digest, Refusal } from './contracts.ts';
import { Ledger, type Intent } from './ledger.ts';
import { Capacity } from './capacity.ts';
import { GitArtifacts } from './git.ts';
import { Quality,QualityPolicy, type VerificationReceipt,type ArtifactRow } from './quality.ts';
import { Integrator } from './integration.ts';
import {IsolatedVerification,type IsolatedVerificationResult} from './isolated-verification.ts';
import {IsolatedAdvice} from './isolated-advice.ts';
import {assertPreimplementationAdvice,signPreimplementationAdvice,PreimplementationAdviceReceipt} from './preimplementation-advice.ts';
import {managedId,readManagedInput,readManagedUnit,type ManagedUnit} from './managed-plan.ts';
import type { AgentRunSpec, AgentSession, AgentEvent } from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
export type EngineeringOptions={quality:Quality;git:GitArtifacts;qualityRevision?:number;targetRef?:string;allowedTargets?:readonly string[];verifierKey:Uint8Array;isolatedVerification?:IsolatedVerification;isolatedAdvice?:IsolatedAdvice;
 onAdmissionWait?:(runId:string,key:string,reason:string|null)=>void;syntheticVerifierPath?:string};
const nodeSchema=z.enum(['qa','review','judge','integrate']);
function artifactId(intentId:string,commit:string){const h=digest({domain:'artifact-v1',intentId,commit});return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function reviewSession(parent:string,index:number){const h=digest({domain:'review-session-v1',parent,index});return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function stop(child:ChildProcess|undefined){if(!child||child.exitCode!==null||child.signalCode!==null)return;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}

/** Fixed engineering template adapter. Every invocation comes from an existing Cezar node.
 * Verifiers are synthetic; the isolated runtime uses broker containers for each session. */
export class EngineeringStages{
 private readonly key:Buffer;
 private running=true;
 private readonly children=new Set<ChildProcess>();
 constructor(readonly ledger:Ledger,readonly projectId:string,readonly options:EngineeringOptions){
  if(options.isolatedVerification&&options.isolatedVerification.ledger!==ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
  if(options.isolatedAdvice&&options.isolatedAdvice.ledger!==ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
  this.key=Buffer.from(options.verifierKey);if(this.key.length<32)throw Error('VERIFIER_KEY_TOO_SHORT');
 }
 async assertSpecialistApproved(c:import('pg').PoolClient,intentId:string,authority:Authority,writer?:{sessionId:string;grantId:string}){
  return assertPreimplementationAdvice(c,this.key,intentId,authority,writer);
 }
 startSpecialist(intent:Intent,authority:Authority,unit:ManagedUnit,spec:AgentRunSpec,onEvent?:((event:AgentEvent)=>void)):AgentSession{
  let open=true,canceled=false;const sessionId=z.uuid().parse(spec.sessionId);
  const wait=(reason:string|null)=>{const runId=spec.env?.CEZ_TASK_ID;if(runId)this.options.onAdmissionWait?.(runId,`specialist:${intent.operation_id}`,reason);};
  const result=(async()=>{
   if(!this.running||!this.options.isolatedAdvice)throw new Refusal('SPECIALIST_EXECUTOR_UNAVAILABLE');
   const bound=await readManagedUnit(this.ledger,intent),input=await readManagedInput(this.ledger,intent.id);
   if(!bound||bound.recipe.schemaVersion!==3||!unit.requiresSpecialist||digest(bound.unit)!==digest(unit)||unit.kind!=='task')throw new Refusal('SPECIALIST_INPUT_MISMATCH');
   const adviceId=managedId(bound.parentIntentId,unit.id,'specialist-operation'),attemptId=managedId(bound.parentIntentId,unit.id,'specialist-attempt');
   const inputDigest=digest(input),scopeDigest=digest({writePaths:input.writePaths,acceptanceRefs:input.acceptanceRefs});
   const assertWriterNotStarted=async(c:import('pg').PoolClient)=>{
    const op=(await c.query('SELECT state,grant_id,handle,receipt,native_session_id FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[intent.operation_id,intent.id])).rows[0];
    if(!op||op.state!=='registered'||op.grant_id||op.handle||op.receipt||op.native_session_id||
      (await c.query('SELECT 1 FROM ac_execution_launches WHERE operation_id=$1 UNION ALL SELECT 1 FROM ac_artifacts WHERE intent_id=$2 LIMIT 1',[intent.operation_id,intent.id])).rowCount)
      throw new Refusal('SPECIALIST_WRITER_ALREADY_STARTED');
   };
   const setup=await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
    await assertWriterNotStarted(c);
    const owner=(await c.query(`SELECT i.principal_id,p.snapshot,p.digest FROM ac_intents i JOIN ac_execution_contracts x ON x.intent_id=i.id
      JOIN ac_quality_policies p ON p.project_id=x.project_id AND p.revision=x.quality_revision
      WHERE i.id=$1 AND i.context_id=$2 AND x.project_id=$3 AND x.quality_revision=$4`,[intent.id,authority.contextId,this.projectId,unit.qualityRevision])).rows[0];
    if(!owner)throw new Refusal('SPECIALIST_INPUT_MISMATCH');await this.ledger.authorize(c,owner.principal_id,authority.contextId);
    const policy=QualityPolicy.parse(owner.snapshot);if(digest(policy)!==owner.digest||!policy.requireSpecialistBeforeImplementation||!policy.specialistVerifierDigest)throw new Refusal('SPECIALIST_POLICY_MISMATCH');
    await c.query(`INSERT INTO ac_specialist_advice(id,intent_id,context_id,unit_id,operation_id,policy_revision,base_id,scope_digest,input_digest,policy_digest,session_id,attempt_id,manager_epoch,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'registered') ON CONFLICT(intent_id) DO NOTHING`,
      [adviceId,intent.id,authority.contextId,unit.id,intent.operation_id,unit.qualityRevision,input.base,scopeDigest,inputDigest,owner.digest,sessionId,attemptId,authority.epoch]);
    const row=(await c.query('SELECT * FROM ac_specialist_advice WHERE intent_id=$1 FOR UPDATE',[intent.id])).rows[0];
    if(!row||row.id!==adviceId||row.context_id!==authority.contextId||row.unit_id!==unit.id||row.operation_id!==intent.operation_id||
      row.policy_revision!==unit.qualityRevision||row.base_id!==input.base||row.scope_digest!==scopeDigest||row.input_digest!==inputDigest||
      row.policy_digest!==owner.digest||row.session_id!==sessionId||row.attempt_id!==attemptId||Number(row.manager_epoch)>authority.epoch||
      (row.state!=='completed'&&Number(row.manager_epoch)!==authority.epoch))
      throw new Refusal('SPECIALIST_RECONCILIATION_REQUIRED');
    return {principal:owner.principal_id,policyDigest:owner.digest,verifierDigest:policy.specialistVerifierDigest,state:row.state};
   });
   if(setup.state==='completed'){
    await this.ledger.tx(async c=>{await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
     await this.assertSpecialistApproved(c,intent.id,authority);});
    const text='Authenticated specialist advice replayed.';onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
   }
   if(setup.state!=='registered')throw new Refusal('SPECIALIST_RECONCILIATION_REQUIRED');
   const capacity=new Capacity(this.ledger);let grant:Awaited<ReturnType<Capacity['reserve']>>;
   try{for(;;){
    if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
    await this.ledger.tx(async c=>{await this.ledger.fence(c,authority,true);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);});
    try{grant=await capacity.reserve(setup.principal,{attemptId,intentId:intent.id,contextId:authority.contextId,role:'specialist'},authority);break;}
    catch(error){if(!(error instanceof Refusal)||!['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
     wait(error.code);await new Promise(resolve=>setTimeout(resolve,250));}
   }}finally{wait(null);}
   await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
    const updated=await c.query("UPDATE ac_specialist_advice SET grant_id=$2 WHERE id=$1 AND state='registered' AND manager_epoch=$3 AND (grant_id IS NULL OR grant_id=$2)",[adviceId,grant.id,authority.epoch]);
    if(!updated.rowCount)throw new Refusal('SPECIALIST_RECONCILIATION_REQUIRED');
   });
   const physical=await this.options.isolatedAdvice.run(setup.principal,adviceId,grant.id,authority,spec.cwd,
    {intentId:intent.id,unitId:unit.id,policyRevision:unit.qualityRevision,scopeDigest,inputDigest,policyDigest:setup.policyDigest,base:input.base},()=>canceled||!this.running);
   if(physical.advice.verifierDigest!==setup.verifierDigest)throw new Refusal('SPECIALIST_POLICY_MISMATCH');
   const receipt=PreimplementationAdviceReceipt.parse({schemaVersion:1,kind:'preimplementation_advice',adviceId,contextId:authority.contextId,
    intentId:intent.id,operationId:intent.operation_id,unitId:unit.id,policyRevision:unit.qualityRevision,policyDigest:setup.policyDigest,
    sourceBase:input.base,scopeDigest,inputDigest,sessionId,grantId:grant.id,status:physical.advice.verdict==='proceed'?'approved':'rejected',
    exitCode:physical.exitCode,verifierDigest:physical.advice.verifierDigest});
   const signature=signPreimplementationAdvice(this.key,receipt);
   await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
    await assertWriterNotStarted(c);
    const updated=await c.query("UPDATE ac_specialist_advice SET state='completed',receipt=$2,signature=$3 WHERE id=$1 AND state IN ('uncertain','running') AND manager_epoch=$4",
     [adviceId,receipt,signature,authority.epoch]);
    if(!updated.rowCount)throw new Refusal('SPECIALIST_RECONCILIATION_REQUIRED');
    await assertPreimplementationAdvice(c,this.key,intent.id,authority,undefined,'record');
   });
   if(receipt.status!=='approved')throw new Refusal('SPECIALIST_REJECTED');
   const text='Independent specialist advice approved.';onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
  })().finally(()=>{open=false;wait(null);});
  return {result,get open(){return open;},sendMessage(){return false;},end(){},interrupt(){canceled=true;},hardStop(){canceled=true;}};
 }
 private async verifierBytes(){
  if(!this.options.syntheticVerifierPath)return readFile(new URL('../scripts/synthetic-verifier.mjs',import.meta.url));
  const path=resolve(this.options.syntheticVerifierPath),info=await lstat(path);
  if(path!==this.options.syntheticVerifierPath||info.isSymbolicLink()||!info.isFile()||info.size>1024*1024||await realpath(path)!==path)
   throw new Refusal('VERIFIER_PATH_FORBIDDEN');
  return readFile(path);
 }
 /** Persist a correction only for an authenticated, physically completed rejection. */
 async recordManagedCorrection(principal:string,intent:Intent,authority:Authority,next:ManagedUnit,artifactId:string,evidenceIds:readonly string[]){
  const bound=await readManagedUnit(this.ledger,intent);
  if(!bound||bound.recipe.schemaVersion<2||bound.unit.kind!=='task'||next.kind!=='task'||!bound.unit.taskId||
    next.taskId!==bound.unit.taskId||next.correctionRevision!==(bound.unit.correctionRevision??0)+1||
    next.qualityRevision!==bound.unit.qualityRevision||next.targetRef!==bound.unit.targetRef||
    digest(next.writePaths)!==digest(bound.unit.writePaths)||digest(next.acceptanceRefs)!==digest(bound.unit.acceptanceRefs)||
    !bound.recipe.units.some(unit=>digest(unit)===digest(next)))throw new Refusal('MANAGED_CORRECTION_MISMATCH');
  const input=await readManagedInput(this.ledger,intent.id);
  const ids=[...evidenceIds].sort();if(new Set(ids).size!==ids.length||!ids.length||ids.length>16)throw new Refusal('CORRECTION_EVIDENCE_INVALID');
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);
   await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
   if((await c.query("SELECT 1 FROM ac_capacity_grants WHERE intent_id=$1 AND state<>'released' LIMIT 1",[intent.id])).rowCount)
    throw new Refusal('CORRECTION_EVIDENCE_UNCERTAIN');
   const nextRow=(await c.query('SELECT * FROM ac_intents WHERE id=$1 AND parent_intent_id=$2 AND context_id=$3 FOR UPDATE',
    [next.intentId,bound.parentIntentId,authority.contextId])).rows[0];
   if(!nextRow||nextRow.parent_unit_id!==next.id||nextRow.run_id!==next.runId||nextRow.operation_id!==next.operationId)
    throw new Refusal('MANAGED_CORRECTION_MISMATCH');
   const artifact=await this.options.quality.assertCorrectionFailures(c,artifactId,ids,authority);
   if(artifact.intent_id!==intent.id||artifact.project_id!==this.projectId||artifact.policy_revision!==next.qualityRevision||artifact.base_id!==input.base)
    throw new Refusal('MANAGED_CORRECTION_MISMATCH');
   const existing=(await c.query('SELECT * FROM ac_managed_correction_decisions WHERE parent_intent_id=$1 AND task_id=$2 AND revision=$3',
    [bound.parentIntentId,bound.unit.taskId,next.correctionRevision])).rows[0];
   const epoch=existing?Number(existing.manager_epoch):authority.epoch;
   const snapshot={parentIntentId:bound.parentIntentId,contextId:authority.contextId,taskId:bound.unit.taskId,revision:next.correctionRevision!,
    priorIntentId:intent.id,priorArtifactId:artifact.id,failedEvidenceIds:ids,priorCommit:artifact.commit_id,priorTree:artifact.tree_id,
    baseId:artifact.base_id,nextIntentId:next.intentId,managerEpoch:epoch};
   const hash=digest(snapshot);
   if(existing){if(existing.decision_digest!==hash||epoch>authority.epoch)throw new Refusal('MANAGED_CORRECTION_MISMATCH');return {decisionDigest:hash,...snapshot};}
   await c.query(`INSERT INTO ac_managed_correction_decisions(parent_intent_id,context_id,task_id,revision,prior_intent_id,prior_artifact_id,
    failed_evidence_ids,prior_commit,prior_tree,base_id,next_intent_id,manager_epoch,decision_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [snapshot.parentIntentId,snapshot.contextId,snapshot.taskId,snapshot.revision,snapshot.priorIntentId,snapshot.priorArtifactId,
     ids,snapshot.priorCommit,snapshot.priorTree,snapshot.baseId,snapshot.nextIntentId,epoch,hash]);
   return {decisionDigest:hash,...snapshot};
  });
 }
 async selectManagedTask(principal:string,intent:Intent,authority:Authority,artifactId:string){
  const bound=await readManagedUnit(this.ledger,intent);
  if(!bound||bound.recipe.schemaVersion<2||bound.unit.kind!=='task'||!bound.unit.taskId)throw new Refusal('MANAGED_SELECTION_MISMATCH');
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
   const artifact=await this.options.quality.assertReady(c,artifactId,authority);
   if(artifact.intent_id!==intent.id||artifact.project_id!==this.projectId)throw new Refusal('MANAGED_SELECTION_MISMATCH');
   const existing=(await c.query('SELECT * FROM ac_managed_task_selections WHERE parent_intent_id=$1 AND task_id=$2',
    [bound.parentIntentId,bound.unit.taskId])).rows[0];
   const epoch=existing?Number(existing.manager_epoch):authority.epoch;
   const hash=digest({parentIntentId:bound.parentIntentId,contextId:authority.contextId,taskId:bound.unit.taskId,
    selectedIntentId:intent.id,artifactId:artifact.id,managerEpoch:epoch});
   if(existing){if(existing.selection_digest!==hash||epoch>authority.epoch)throw new Refusal('MANAGED_SELECTION_MISMATCH');return hash;}
   await c.query(`INSERT INTO ac_managed_task_selections(parent_intent_id,context_id,task_id,selected_intent_id,artifact_id,selection_digest,manager_epoch)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[bound.parentIntentId,authority.contextId,bound.unit.taskId,intent.id,artifact.id,hash,epoch]);return hash;
  });
 }
 async replayManagedComposition(intent:Intent,authority:Authority,unit:ManagedUnit):Promise<boolean>{
  const bound=await readManagedUnit(this.ledger,intent),input=await readManagedInput(this.ledger,intent.id);
  if(!bound||unit.kind!=='composition'||digest(bound.unit)!==digest(unit))throw new Refusal('MANAGED_UNIT_MISMATCH');
  const saved=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   const row=(await c.query(`SELECT i.principal_id,o.state,o.manager_epoch,o.receipt,o.handle,o.native_session_id,
    g.state grant_state,g.role,g.resource_kind,g.account_id,g.profile_id,g.attempt_id,g.intent_id grant_intent,g.context_id grant_context,g.manager_epoch grant_epoch,g.physical_receipt,s.snapshot,s.digest
    FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id LEFT JOIN ac_capacity_grants g ON g.id=o.grant_id
    LEFT JOIN ac_managed_composition_sources s ON s.intent_id=i.id WHERE i.id=$1 AND i.context_id=$2 AND o.id=$3 FOR UPDATE OF o`,
    [intent.id,authority.contextId,intent.operation_id])).rows[0];
   if(!row)throw new Refusal('MANAGED_RECEIPT_MISMATCH');await this.ledger.authorize(c,row.principal_id,authority.contextId);
   if(row.state!=='completed'||row.grant_state!=='released')return null;
   if(row.role!=='programmer'||row.attempt_id!==unit.attemptId||row.grant_intent!==intent.id||row.grant_context!==authority.contextId||
      !((row.resource_kind==='local_compositor'&&row.account_id===null&&row.profile_id===null)||
        (row.resource_kind==='model'&&row.account_id!==null&&row.profile_id!==null))||
      Number(row.manager_epoch)!==Number(row.grant_epoch)||Number(row.manager_epoch)>authority.epoch||!row.native_session_id||
      row.receipt?.operationId!==intent.operation_id||row.receipt?.base!==input.base||row.receipt?.exitCode!==0||row.receipt?.synthetic!==true||
      row.physical_receipt?.state!=='exited'||row.physical_receipt?.exitCode!==0||row.physical_receipt?.source!=='managed-git-compositor'||
      !Number.isInteger(row.handle?.pid)||row.handle.pid<=0||row.handle?.operationId!==intent.operation_id||Number(row.handle?.epoch)!==Number(row.manager_epoch)||
      row.physical_receipt?.processId!==String(row.handle?.pid)||!row.snapshot||digest(row.snapshot)!==row.digest)
    throw new Refusal('MANAGED_RECEIPT_MISMATCH');
   const schema=z.array(z.object({unitId:z.string(),artifactId:z.uuid(),commit:z.string().regex(/^[a-f0-9]{40}$/),tree:z.string().regex(/^[a-f0-9]{40}$/),base:z.string().regex(/^[a-f0-9]{40}$/),writePaths:z.array(z.string())}).strict()).min(2).max(4);
   const sources=schema.parse(row.snapshot);
   if(digest(sources.map(s=>s.unitId))!==digest(input.sources))throw new Refusal('MANAGED_RECEIPT_MISMATCH');
   for(const source of sources){
    const frozen=bound.recipe.units.find(u=>u.id===source.unitId),artifact=await this.options.quality.assertReady(c,source.artifactId,authority);
    if(!frozen||frozen.kind!=='task'||artifact.intent_id!==frozen.intentId||artifact.project_id!==this.projectId||artifact.base_id!==input.base||
      artifact.commit_id!==source.commit||artifact.tree_id!==source.tree||source.base!==input.base||digest(source.writePaths)!==digest(frozen.writePaths))
     throw new Refusal('MANAGED_RECEIPT_MISMATCH');
    const evidence=(await c.query(`SELECT o.state,o.receipt,g.state grant_state,g.physical_receipt,j.state job_state,j.receipt job_receipt
     FROM ac_operations o JOIN ac_capacity_grants g ON g.id=o.grant_id JOIN ac_sandbox_jobs j ON j.id=o.id
     WHERE o.id=$1 AND o.intent_id=$2`,[frozen.operationId,frozen.intentId])).rows[0];
    if(evidence?.state!=='completed'||evidence.grant_state!=='released'||evidence.job_state!=='completed'||
      evidence.receipt?.commit!==source.commit||evidence.receipt?.tree!==source.tree||evidence.receipt?.base!==source.base||
      digest(evidence.physical_receipt)!==digest(evidence.job_receipt)||digest(evidence.receipt)!==digest(evidence.job_receipt?.implementation))
     throw new Refusal('MANAGED_RECEIPT_MISMATCH');
   }
   return {receipt:row.receipt,sources};
  });
  if(!saved)return false;
  for(const source of saved.sources){const frozen=bound.recipe.units.find(u=>u.id===source.unitId)!;
   const cwd=await this.options.git.managedPath(bound.parentIntentId,frozen.runId),identity=await this.options.git.identityAt(cwd,source.commit,source.base);
   if(identity.tree!==source.tree)throw new Refusal('MANAGED_RECEIPT_MISMATCH');}
  const cwd=await this.options.git.managedPath(bound.parentIntentId,unit.runId);
  const identity=await this.options.git.verifyComposition(cwd,saved.receipt.commit,saved.receipt.base,saved.sources.map(s=>s.commit));
  const registered=await this.options.git.identity(saved.receipt.commit,saved.receipt.base);
  if(identity.tree!==saved.receipt.tree||registered.tree!==saved.receipt.tree)throw new Refusal('MANAGED_RECEIPT_MISMATCH');
  return true;
 }
 async composeManaged(intent:Intent,authority:Authority,unit:ManagedUnit,sessionId:string,destination:string,
  sources:readonly {unitId:string;artifactId:string;cwd:string}[],runId?:string){
  z.uuid().parse(sessionId);
  const bound=await readManagedUnit(this.ledger,intent),input=await readManagedInput(this.ledger,intent.id);
  if(!bound||digest(bound.unit)!==digest(unit)||unit.kind!=='composition'||digest(sources.map(s=>s.unitId))!==digest(input.sources))
   throw new Refusal('MANAGED_UNIT_MISMATCH');
  await this.options.git.assertManagedPath(bound.parentIntentId,unit.runId,destination,false);
  const principal=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[intent.id,authority.contextId])).rows[0]?.principal_id;
  if(!principal)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
  const identities=await this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
   const items=[];
   for(const source of sources){
    const frozen=bound.recipe.units.find(u=>u.id===source.unitId);
    if(!frozen||frozen.kind!=='task')throw new Refusal('MANAGED_SOURCE_MISMATCH');
    const artifact=await this.options.quality.assertReady(c,source.artifactId,authority);
    if(artifact.intent_id!==frozen.intentId||artifact.context_id!==intent.context_id||artifact.base_id!==input.base)throw new Refusal('MANAGED_SOURCE_MISMATCH');
    items.push({commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,writePaths:frozen.writePaths});
   }
   return items;
  });
  for(const source of sources){const frozen=bound.recipe.units.find(u=>u.id===source.unitId)!;
   await this.options.git.assertManagedPath(bound.parentIntentId,frozen.runId,source.cwd,true);}
  const capacity=new Capacity(this.ledger);let grant:Awaited<ReturnType<Capacity['reserveLocalCompositor']>>;
  const admissionWait=(reason:string|null)=>{if(runId)this.options.onAdmissionWait?.(runId,`composition:${intent.operation_id}`,reason);};
  try{
   for(;;){
    if(!this.running)throw new Refusal('RUNTIME_NOT_AUTHORIZED');
    // Pausing admission must not hide a cancellation or an expired fence.
    await this.ledger.tx(async c=>{await this.ledger.fence(c,authority,true);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);});
    try{grant=await capacity.reserveLocalCompositor(principal,{attemptId:unit.attemptId,intentId:intent.id,contextId:intent.context_id},authority);break;}
    catch(error){
     if(!(error instanceof Refusal)||!['CAPACITY_BUSY','CAPACITY_QUEUED','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
     admissionWait(error.code);await new Promise(resolve=>setTimeout(resolve,250));
    }
   }
  }finally{admissionWait(null);}
  await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
   const snapshot=identities.map((value,index)=>({unitId:sources[index]!.unitId,artifactId:sources[index]!.artifactId,...value}));
   await c.query('INSERT INTO ac_managed_composition_sources(intent_id,snapshot,digest) VALUES($1,$2,$3) ON CONFLICT(intent_id) DO NOTHING',[intent.id,JSON.stringify(snapshot),digest(snapshot)]);
   const stored=(await c.query('SELECT snapshot,digest FROM ac_managed_composition_sources WHERE intent_id=$1',[intent.id])).rows[0];
   if(!stored||stored.digest!==digest(snapshot)||digest(stored.snapshot)!==stored.digest)throw new Refusal('MANAGED_SOURCE_MISMATCH');
   const changed=await c.query("UPDATE ac_operations SET state='uncertain',grant_id=$2 WHERE id=$1 AND intent_id=$3 AND state='registered' AND manager_epoch=$4 AND (grant_id IS NULL OR grant_id=$2)",[intent.operation_id,grant.id,intent.id,authority.epoch]);
   if(!changed.rowCount)throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
  });
  let child:ChildProcess|undefined,monitor:ReturnType<typeof setInterval>|undefined;
  try{
   const result=await this.options.git.composeSupervised(input.base,identities.map((value,index)=>({...value,sourceRepo:sources[index]!.cwd})),destination,async processChild=>{
    child=processChild;this.children.add(processChild);processChild.once('exit',()=>this.children.delete(processChild));
    await new Promise<void>((ok,fail)=>{processChild.once('spawn',ok);processChild.once('error',fail);});
    const stat=await readFile(`/proc/${processChild.pid}/stat`,'utf8'),startTime=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
    const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    if(!/^\d+$/.test(startTime??''))throw new Refusal('PROCESS_IDENTITY_UNAVAILABLE');
    await this.ledger.tx(async c=>{
     await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
     for(const source of sources)await this.options.quality.assertReady(c,source.artifactId,authority);
     const eligible=await c.query(`SELECT g.id FROM ac_capacity_grants g JOIN ac_operations o ON o.grant_id=g.id JOIN ac_intents i ON i.id=o.intent_id
      WHERE g.id=$1 AND g.context_id=$2 AND g.manager_epoch=$3 AND g.state='reserved' AND g.intent_id=$4 AND g.attempt_id=$5
      AND g.project_id=$6 AND g.role='programmer' AND g.resource_kind='local_compositor' AND g.account_id IS NULL AND g.profile_id IS NULL
      AND o.id=$7 AND o.intent_id=$4 AND o.manager_epoch=$3 AND o.execution_attempt_id=$5 AND o.state='uncertain'
      AND i.parent_intent_id=$8 AND i.parent_unit_id=$9 AND i.run_id=$10 FOR UPDATE OF g,o`,
      [grant.id,authority.contextId,authority.epoch,intent.id,unit.attemptId,this.projectId,intent.operation_id,bound.parentIntentId,unit.id,unit.runId]);
     if(!eligible.rowCount)throw new Refusal('GRANT_NOT_ELIGIBLE');
     await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[grant.id]);
     const changed=await c.query("UPDATE ac_operations SET state='running',native_session_id=$2,handle=$3 WHERE id=$1 AND state='uncertain' AND manager_epoch=$4",[intent.operation_id,sessionId,{pid:processChild.pid,startTime,bootId,operationId:intent.operation_id,epoch:authority.epoch,synthetic:true},authority.epoch]);
     if(!changed.rowCount)throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
    });
    let checking=false;monitor=setInterval(()=>{if(checking)return;checking=true;void this.ledger.tx(async c=>{await this.ledger.fence(c,authority,true);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);}).catch(()=>stop(child)).finally(()=>{checking=false;});},500);
   });
   const identity=await this.options.git.identity(result.commit,result.base);
   if(identity.tree!==result.tree)throw new Refusal('MANAGED_COMPOSITION_MISMATCH');
   const receipt={operationId:intent.operation_id,commit:result.commit,tree:result.tree,base:result.base,exitCode:0,synthetic:true};
   await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority,true);
    const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND manager_epoch=$3 AND state='running' AND resource_kind='local_compositor' AND intent_id=$4 AND attempt_id=$5 AND context_id=$6 AND role='programmer' AND account_id IS NULL AND profile_id IS NULL",[grant.id,{state:'exited',processId:String(child?.pid),exitCode:0,source:'managed-git-compositor'},authority.epoch,intent.id,unit.attemptId,authority.contextId]);
    const completed=await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND intent_id=$4 AND grant_id=$5 AND state='running' AND manager_epoch=$3",[intent.operation_id,receipt,authority.epoch,intent.id,grant.id]);
    if(!released.rowCount||!completed.rowCount)throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
   });
   return receipt;
  }finally{if(monitor)clearInterval(monitor);stop(child);}
 }
 /** Reattach a completed node after controller loss. Only saved, authenticated
  * results are replayable here; uncertain or absent effects are never relaunched. */
 async canReplayCompleted(intent:Intent,authority:Authority,nodeId:string,sessionId:string){
  const parsed=nodeSchema.safeParse(nodeId);if(!parsed.success||!z.uuid().safeParse(sessionId).success)return false;
  const node=parsed.data;
  const saved=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
   const bound=(await c.query(`SELECT i.principal_id,x.quality_revision,x.target_ref,x.digest,p.snapshot,p.digest policy_digest
    FROM ac_intents i JOIN ac_execution_contracts x ON x.intent_id=i.id
    JOIN ac_quality_policies p ON p.project_id=x.project_id AND p.revision=x.quality_revision
    WHERE i.id=$1 AND i.run_id=$2 AND i.context_id=$3 AND x.project_id=$4`,[intent.id,intent.run_id,authority.contextId,this.projectId])).rows[0];
   if(!bound)return null;
   await this.ledger.authorize(c,bound.principal_id,authority.contextId);
   if(bound.digest!==digest({qualityRevision:bound.quality_revision,targetRef:bound.target_ref})||digest(bound.snapshot)!==bound.policy_digest)
    throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
   const allowed=this.options.allowedTargets??(this.options.targetRef?[this.options.targetRef]:[]);
   if(!allowed.includes(bound.target_ref))throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
   const policy=QualityPolicy.parse(bound.snapshot);
   if((await c.query("SELECT 1 FROM ac_capacity_grants WHERE intent_id=$1 AND state<>'released' LIMIT 1",[intent.id])).rowCount)return null;
   const sessions=node==='review'&&policy.requiredReviews>1?Array.from({length:policy.requiredReviews},(_,index)=>reviewSession(sessionId,index)):[sessionId];
   const stages=(await c.query(`SELECT s.*,g.state grant_state,g.physical_receipt,j.state job_state FROM ac_stage_operations s
    LEFT JOIN ac_capacity_grants g ON g.id=s.grant_id LEFT JOIN ac_sandbox_jobs j ON j.id=s.id
    WHERE s.intent_id=$1 AND s.node_id=$2 AND s.session_id=ANY($3::uuid[])`,[intent.id,node,sessions])).rows;
   if(node==='judge'&&!policy.requireJudge)return {principal:bound.principal_id,stages:[],skip:true};
   if(stages.length!==sessions.length||stages.some(s=>s.state!=='completed'||Number(s.manager_epoch)>authority.epoch))return null;
   for(const stage of stages){
    if(node==='integrate'){
     const applied=(await c.query(`SELECT x.receipt FROM ac_integration_intents x JOIN ac_artifacts a ON a.id=x.artifact_id
      WHERE a.intent_id=$1 AND x.target_ref=$2 AND x.state IN ('integrated','rejected')`,[intent.id,bound.target_ref])).rows[0];
     if(!applied||!stage.receipt?.integration||digest(applied.receipt)!==digest(stage.receipt.integration))return null;
    }else if(stage.grant_state!=='released'||!stage.physical_receipt||
      (stage.job_state!==null&&!['completed','failed'].includes(stage.job_state))||
      stage.receipt?.verification?.sessionId!==stage.session_id||stage.receipt?.verification?.grantId!==stage.grant_id||
      stage.receipt?.verification?.policyRevision!==bound.quality_revision||
      stage.receipt?.verification?.kind!==(node==='review'?'review':node))return null;
   }
   return {principal:bound.principal_id,stages,skip:false};
  });
  if(!saved)return false;
  for(const stage of saved.stages){
   if(node==='integrate')continue;
   await this.options.quality.record(saved.principal,stage.receipt.verification,stage.receipt.signature,authority);
  }
  return true;
 }
 /** Adopt only preparations whose durable state proves no executor launched.
  * Running/uncertain effects remain owned by physical reconciliation. */
 async prepareUnstartedNode(intent:Intent,authority:Authority,nodeId:string,sessionId:string){
  const parsed=nodeSchema.safeParse(nodeId);if(!parsed.success||!z.uuid().safeParse(sessionId).success)return false;
  const node=parsed.data;
  const saved=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
   const bound=(await c.query(`SELECT i.principal_id,x.quality_revision,x.target_ref,x.digest,p.snapshot,p.digest policy_digest
    FROM ac_intents i JOIN ac_execution_contracts x ON x.intent_id=i.id
    JOIN ac_quality_policies p ON p.project_id=x.project_id AND p.revision=x.quality_revision
    WHERE i.id=$1 AND i.run_id=$2 AND i.context_id=$3 AND x.project_id=$4`,[intent.id,intent.run_id,authority.contextId,this.projectId])).rows[0];
   if(!bound)return null;
   await this.ledger.authorize(c,bound.principal_id,authority.contextId);
   if(bound.digest!==digest({qualityRevision:bound.quality_revision,targetRef:bound.target_ref})||digest(bound.snapshot)!==bound.policy_digest)throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
   const allowed=this.options.allowedTargets??(this.options.targetRef?[this.options.targetRef]:[]);
   if(!allowed.includes(bound.target_ref))throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
   const policy=QualityPolicy.parse(bound.snapshot);
   const sessions=node==='review'&&policy.requiredReviews>1?Array.from({length:policy.requiredReviews},(_,index)=>reviewSession(sessionId,index)):[sessionId];
   const stages=(await c.query(`SELECT s.*,g.id old_grant,g.state grant_state,g.physical_receipt,
    EXISTS(SELECT 1 FROM ac_stage_execution_launches l WHERE l.stage_id=s.id) launched,
    EXISTS(SELECT 1 FROM ac_sandbox_jobs j WHERE j.id=s.id) has_job
    FROM ac_stage_operations s LEFT JOIN ac_capacity_grants g ON g.attempt_id=s.attempt_id
    WHERE s.intent_id=$1 AND s.node_id=$2 FOR UPDATE OF s`,[intent.id,node])).rows;
   if(stages.some(s=>!sessions.includes(s.session_id)||Number(s.manager_epoch)>authority.epoch))return null;
   const integration=node==='integrate'?(await c.query(`SELECT t.* FROM ac_integration_intents t JOIN ac_artifacts a ON a.id=t.artifact_id
    WHERE a.intent_id=$1`,[intent.id])).rows[0]:null;
   if(integration&&(integration.state!=='registered'||Number(integration.manager_epoch)>authority.epoch))return null;
   const preparations=stages.filter(s=>s.state!=='completed');
   for(const stage of preparations){
    const beforeCas=node==='integrate'&&integration?.state==='registered';
    if((stage.state!=='registered'&&!beforeCas)||stage.handle||stage.started_at||stage.launched||stage.has_job)return null;
    if(stage.old_grant&&(stage.grant_state!=='reserved'&&!(stage.grant_state==='released'&&stage.physical_receipt?.state==='not_started')))return null;
    if(stage.grant_state==='reserved'&&stage.physical_receipt)return null;
   }
   const safeGrants=preparations.filter(s=>s.old_grant).map(s=>s.old_grant);
   if((await c.query("SELECT 1 FROM ac_capacity_grants WHERE intent_id=$1 AND state<>'released' AND NOT(id=ANY($2::uuid[])) LIMIT 1",[intent.id,safeGrants])).rowCount)return null;
   if((await c.query(`SELECT 1 FROM ac_sandbox_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    WHERE g.intent_id=$1 AND j.state NOT IN ('completed','failed') LIMIT 1`,[intent.id])).rowCount)return null;
   if((await c.query(`SELECT 1 FROM ac_remote_operations WHERE intent_id=$1 AND state NOT IN ('completed','failed','canceled_confirmed') LIMIT 1`,[intent.id])).rowCount)return null;
   const completed=stages.filter(s=>s.state==='completed');
   if(node==='integrate'&&completed.length)return null; // terminal path belongs to canReplayCompleted
   for(const stage of completed){
    if(stage.grant_state!=='released'||!stage.physical_receipt||stage.receipt?.verification?.sessionId!==stage.session_id||
     stage.receipt?.verification?.grantId!==stage.old_grant||stage.receipt?.verification?.policyRevision!==bound.quality_revision||
     stage.receipt?.verification?.kind!==(node==='review'?'review':node))return null;
   }
   for(const stage of preparations){
    if(Number(stage.manager_epoch)===authority.epoch&&stage.state==='registered'&&!stage.old_grant)continue;
    if(stage.grant_state==='reserved')await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state='reserved'",
     [stage.old_grant,{state:'not_started',source:'fenced-stage-adoption',stageId:stage.id}]);
    const nextAttempt=randomUUID();
    await c.query('DELETE FROM ac_capacity_waits WHERE attempt_id=$1',[stage.attempt_id]);
    await c.query("UPDATE ac_stage_operations SET manager_epoch=$2,attempt_id=$3,grant_id=NULL,state='registered' WHERE id=$1",[stage.id,authority.epoch,nextAttempt]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'stage.adopted_before_launch',$2)",
     [authority.contextId,{stageId:stage.id,oldEpoch:Number(stage.manager_epoch),oldAttemptId:stage.attempt_id,attemptId:nextAttempt}]);
   }
   if(integration&&Number(integration.manager_epoch)<authority.epoch)await c.query("UPDATE ac_integration_intents SET manager_epoch=$2 WHERE id=$1 AND state='registered'",[integration.id,authority.epoch]);
   return {principal:bound.principal_id,completed};
  });
  if(!saved)return false;
  for(const stage of saved.completed)await this.options.quality.record(saved.principal,stage.receipt.verification,stage.receipt.signature,authority);
  return true;
 }
 start(intent:Intent,authority:Authority,nodeId:string,spec:AgentRunSpec,onEvent?:((event:AgentEvent)=>void),internalReview=false,qualityVerdict=false):AgentSession{
  const node=nodeSchema.parse(nodeId),sessionId=z.uuid().parse(spec.sessionId);
  const notify=onEvent;
  if(qualityVerdict)onEvent=event=>{if(event.type!=='done')notify?.(event);};
  let child:ChildProcess|undefined,open=true,canceled=false;
  const nested=new Set<AgentSession>();
  const admissionWait=(reason:string|null)=>{const runId=spec.env?.CEZ_TASK_ID;if(runId)this.options.onAdmissionWait?.(runId,`stage:${node}:${sessionId}`,reason);};
  const result=(async()=>{
   if(!this.running)throw new Refusal('RUNTIME_NOT_AUTHORIZED');
   const contract=await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority,true);
    const row=(await c.query('SELECT * FROM ac_execution_contracts WHERE intent_id=$1 AND project_id=$2',[intent.id,this.projectId])).rows[0];
    if(!row||row.digest!==digest({qualityRevision:row.quality_revision,targetRef:row.target_ref}))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
    const allowed=this.options.allowedTargets??(this.options.targetRef?[this.options.targetRef]:[]);
    if(!allowed.includes(row.target_ref))throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
    return row;
   });
   if(node==='judge'){
    const row=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
      [this.projectId,contract.quality_revision])).rows[0];
    const policy=QualityPolicy.parse(row?.snapshot);
    if(digest(policy)!==row.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
    if(!policy.requireJudge){const text='Synthetic judge not required by the frozen policy.';onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};}
   }
   if(node==='review'&&!internalReview){
    const stored=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
      [this.projectId,contract.quality_revision])).rows[0];
    if(!stored)throw new Refusal('QUALITY_POLICY_REQUIRED');
    const policy=QualityPolicy.parse(stored.snapshot);
    if(digest(policy)!==stored.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
    if(policy.requiredReviews>1){
     let next=0;
     const worker=async()=>{
      for(;;){
       const index=next++;if(index>=policy.requiredReviews)return;
       let announced=false;
       for(;;){
        if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
        const reviewer=this.start(intent,authority,'review',{...spec,sessionId:reviewSession(sessionId,index)},undefined,true);
        nested.add(reviewer);
        try{await reviewer.result;onEvent?.({type:'text',text:`Synthetic reviewer ${index+1}/${policy.requiredReviews} completed.`});break;}
        catch(error){
         if(!(error instanceof Refusal)||!['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
         if(!announced){onEvent?.({type:'text',text:`Synthetic reviewer ${index+1} waiting for an authorized slot.`});announced=true;}
         await new Promise(resolve=>setTimeout(resolve,2000));
        }finally{nested.delete(reviewer);}
       }
      }
     };
     try{await Promise.all(Array.from({length:policy.requiredReviews},()=>worker()));}
     finally{for(const reviewer of nested)reviewer.hardStop?.();}
     const text=`Synthetic review council completed: ${policy.requiredReviews} independent sessions.`;
     onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
    }
   }
   const principal=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[intent.id,authority.contextId])).rows[0]?.principal_id;
   if(!principal)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   const stage=await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
    const frozen=(await c.query('SELECT digest FROM ac_execution_contracts WHERE intent_id=$1 AND project_id=$2',[intent.id,this.projectId])).rows[0];
    if(!frozen||frozen.digest!==contract.digest)throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
    const inserted=await c.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state)
     VALUES($1,$2,$3,$4,$5,$6,'registered') ON CONFLICT(intent_id,node_id,session_id) DO NOTHING RETURNING *`,
     [randomUUID(),intent.id,node,sessionId,randomUUID(),authority.epoch]);
    return inserted.rows[0]??(await c.query('SELECT * FROM ac_stage_operations WHERE intent_id=$1 AND node_id=$2 AND session_id=$3',[intent.id,node,sessionId])).rows[0];
   });
   if(Number(stage.manager_epoch)>authority.epoch||(stage.state!=='completed'&&Number(stage.manager_epoch)!==authority.epoch))throw new Refusal('STAGE_RECONCILIATION_REQUIRED');
   if(stage.state==='completed'){
    if(node==='integrate'){
     if(stage.receipt?.integration?.status!=='integrated')throw new Refusal('INTEGRATION_REJECTED');
    }else{
     const expected=node==='review'?'review':node;
     if(stage.receipt?.verification?.kind!==expected)throw new Refusal('VERIFICATION_RECEIPT_MISSING');
     await this.options.quality.record(principal,stage.receipt.verification,stage.receipt.signature,authority);
     if(stage.receipt.verification.status!=='passed'||stage.receipt.verification.exitCode!==0)throw new Refusal('VERIFICATION_FAILED');
    }
    return {text:`Recorded ${node} result ${stage.id}`,toolCalls:[],tokensUsed:0};
   }
   if(stage.state!=='registered')throw new Refusal('STAGE_RECONCILIATION_REQUIRED');
   const implementation=(await this.ledger.pool.query('SELECT * FROM ac_operations WHERE intent_id=$1',[intent.id])).rows[0];
   if(implementation?.state!=='completed'||!implementation.receipt?.commit||!implementation.native_session_id)throw new Refusal('IMPLEMENTATION_EVIDENCE_MISSING');
   const source=implementation.receipt;
   const managed=await readManagedUnit(this.ledger,intent);
   if(managed?.unit.kind==='task'){
    await this.options.git.assertManagedPath(managed.parentIntentId,managed.unit.runId,spec.cwd,true);
    await this.ledger.tx(async c=>{
     await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
     const operation=(await c.query("SELECT receipt,state FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE",[intent.operation_id,intent.id])).rows[0];
     if(operation?.state!=='completed'||digest(operation.receipt)!==digest(source))throw new Refusal('IMPLEMENTATION_EVIDENCE_MISSING');
     const imported=await this.options.git.import(spec.cwd,source.commit,source.base);
     if(imported.tree!==source.tree)throw new Refusal('MANAGED_SOURCE_MISMATCH');
    });
   }
   const artifact=await this.options.quality.register(principal,{id:artifactId(intent.id,source.commit),contextId:intent.context_id,intentId:intent.id,
    implementationGrantId:implementation.grant_id,implementationSessionId:implementation.native_session_id,policyRevision:contract.quality_revision,
    commit:source.commit,tree:source.tree,base:source.base,risk:'high'},authority);
   if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
   if(node==='judge')await this.ledger.tx(c=>this.options.quality.assertReady(c,artifact.id,authority,{ignoreJudge:true}));
   if(node==='integrate'){
    const prepare=()=>this.options.quality.prepareIntegration(principal,artifact.id,authority,contract.target_ref);
    let integration:Awaited<ReturnType<typeof prepare>>,announced=false;
    for(;;){
     if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
     try{integration=await prepare();admissionWait(null);break;}
     catch(error){
      if(!(error instanceof Refusal)||!['INTEGRATION_APPROVAL_REQUIRED','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
      admissionWait(error.code);
      if(!announced){onEvent?.({type:'text',text:'Integration is waiting for an authorized approval or admission. No Git effect started.'});announced=true;}
      await new Promise(resolve=>setTimeout(resolve,1000));
     }
    }
    await this.ledger.tx(async c=>{await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
     await c.query("UPDATE ac_stage_operations SET state='uncertain' WHERE id=$1 AND state='registered'",[stage.id]);});
    const receipt=await new Integrator(this.ledger,this.options.quality,this.options.git,this.projectId,contract.target_ref).integrate(principal,integration.id,authority);
    await this.ledger.tx(async c=>{await this.ledger.fence(c,authority,true);
     await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1",[stage.id,{integration:receipt}]);});
    if(receipt.status!=='integrated')throw new Refusal('INTEGRATION_REJECTED');
   }else{
    const reserve=()=>new Capacity(this.ledger).reserve(principal,{attemptId:stage.attempt_id,intentId:intent.id,contextId:intent.context_id,
     role:node==='qa'?'qa':node==='judge'?'judge':'reviewer'},authority);
    // Capacity exhaustion is an admission wait in this same native session,
    // not failed verification. Reuse the persisted stage/attempt on every poll.
    let grant:Awaited<ReturnType<typeof reserve>>;let waitReason:string|undefined;
    for(;;){
     if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
     try{grant=await reserve();admissionWait(null);break;}
     catch(error){
      if(!(error instanceof Refusal)||!['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
      admissionWait(error.code);
      if(waitReason!==error.code){onEvent?.({type:'text',text:`Stage ${node} waiting: ${error.code}. No verifier launched.`});waitReason=error.code;}
      await new Promise(resolve=>setTimeout(resolve,1000));
     }
    }
    if(Number(grant.manager_epoch)!==authority.epoch||grant.state!=='reserved')throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
    if(this.options.isolatedVerification){
     const qualityRow=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
      [this.projectId,contract.quality_revision])).rows[0];
     const policy=QualityPolicy.parse(qualityRow?.snapshot);
     const verifierDigest=createHash('sha256').update(await this.verifierBytes()).digest('hex');
     if(digest(policy)!==qualityRow.digest||policy.verifierDigest!==verifierDigest)throw new Refusal('VERIFIER_VERSION_MISMATCH');
     const verified=await this.options.isolatedVerification.run(principal,stage.id,grant.id,authority,spec.cwd,
      {id:artifact.id,commit:source.commit,tree:source.tree,base:source.base},intent.operation_id,node,verifierDigest,()=>canceled||!this.running);
     await this.saveIsolatedResult(principal,intent,authority,stage,grant.id,artifact,node,verified);
     if(verified.exitCode!==0)throw new Refusal('VERIFICATION_FAILED');
    }else{
    const parent=resolve('.state/verifier-workspaces');await mkdir(parent,{recursive:true,mode:0o700});
    const temporary=await mkdtemp(join(parent,'stage-'));let monitor:ReturnType<typeof setInterval>|undefined;
    try{
     const script=await this.verifierBytes();
     const verifierDigest=createHash('sha256').update(script).digest('hex');
     const qualityRow=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
       [this.projectId,contract.quality_revision])).rows[0];
     const policy=QualityPolicy.parse(qualityRow?.snapshot);
     if(digest(policy)!==qualityRow.digest||policy.verifierDigest!==verifierDigest)throw new Refusal('VERIFIER_VERSION_MISMATCH');
     const verifierPath=join(temporary,'verifier.mjs');await writeFile(verifierPath,script,{mode:0o500});
     const snapshot=await this.options.git.snapshot(source.commit,source.base,join(temporary,'snapshot'));
     if(snapshot.tree!==source.tree)throw new Refusal('ARTIFACT_TREE_MISMATCH');
     await this.ledger.tx(async c=>{await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
      await c.query("UPDATE ac_stage_operations SET state='uncertain',grant_id=$2 WHERE id=$1 AND state='registered'",[stage.id,grant.id]);});
     let completion:Promise<number|null>|undefined;
     let output='',overLimit=false;
     await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
      if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
      const eligible=await c.query(`SELECT g.id FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id JOIN ac_profiles p ON p.id=g.profile_id
       JOIN ac_quota_observations q ON q.account_id=a.id WHERE g.id=$1 AND g.context_id=$2 AND g.manager_epoch=$3 AND g.state='reserved'
       AND a.enabled AND p.enabled AND a.eligibility='documented_supported' AND q.status='available' AND q.expires_at>clock_timestamp() FOR UPDATE OF g`,
       [grant.id,authority.contextId,authority.epoch]);
      if(!eligible.rowCount)throw new Refusal('GRANT_NOT_ELIGIBLE');
      child=spawn(process.execPath,[verifierPath,snapshot.snapshot,intent.operation_id,node],
       {cwd:snapshot.snapshot,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:temporary},stdio:['ignore','pipe','pipe'],detached:true});
      this.children.add(child);child.once('exit',()=>this.children.delete(child!));
      completion=new Promise((ok,fail)=>{child!.once('exit',ok);child!.once('error',fail);});void completion.catch(()=>{});
      const append=(chunk:Buffer)=>{output+=chunk.toString();if(output.length>65536){overLimit=true;stop(child);}};
      child.stdout!.on('data',append);child.stderr!.on('data',append);
      await new Promise<void>((ok,fail)=>{child!.once('spawn',ok);child!.once('error',fail);});
      const stat=await readFile(`/proc/${child.pid}/stat`,'utf8');const startTime=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
      if(!/^\d+$/.test(startTime??''))throw new Refusal('PROCESS_IDENTITY_UNAVAILABLE');
      const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
      await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[grant.id]);
      await c.query("UPDATE ac_stage_operations SET state='running',handle=$2,started_at=clock_timestamp() WHERE id=$1",[stage.id,{pid:child.pid,startTime,bootId,sessionId}]);
     });
     let checking=false;
     monitor=setInterval(()=>{if(checking)return;checking=true;void this.ledger.tx(c=>this.ledger.fence(c,authority,true)).catch(()=>stop(child)).finally(()=>{checking=false;});},500);
     if(!completion)throw new Refusal('PROCESS_COMPLETION_MISSING');
     const code=await completion;
     if(overLimit)throw new Refusal('VERIFIER_OUTPUT_LIMIT');
     const logs=resolve('.state/verification-logs');await mkdir(logs,{recursive:true,mode:0o700});
     await writeFile(join(logs,stage.id+'.log'),output,{mode:0o600});
     const receipt:VerificationReceipt={schemaVersion:1,id:randomUUID(),artifactId:artifact.id,kind:node==='qa'?'qa':node==='judge'?'judge':'review',sessionId,
      grantId:grant.id,policyRevision:contract.quality_revision,commit:source.commit,tree:source.tree,base:source.base,
      status:code===0?'passed':'failed',exitCode:code??-1,verifierDigest,logSha256:createHash('sha256').update(output).digest('hex'),
      commandDigest:digest({executor:'fixed-verifier-v1',verifierDigest,node,commit:source.commit,tree:source.tree,base:source.base}),verifierVersion:'synthetic-fixed-verifier-v1/'+process.version};
     const signature=createHmac('sha256',this.key).update(canonical(receipt)).digest('hex');
     await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority,true);
      const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND manager_epoch=$3 AND state='running'",
       [grant.id,{state:'exited',processId:String(child?.pid),exitCode:code,source:'synthetic-verifier-parent'},authority.epoch]);
      if(!released.rowCount)throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
      await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1",[stage.id,{verification:receipt,signature}]);
     });
     await this.options.quality.record(principal,receipt,signature,authority);
     if(code!==0)throw new Refusal('VERIFICATION_FAILED');
    }finally{if(monitor)clearInterval(monitor);stop(child);await rm(temporary,{recursive:true,force:true});}
    }
   }
   const text=`Synthetic ${node} completed for artifact ${artifact.id}`;onEvent?.({type:'text',text});onEvent?.({type:'done'});
   return {text,toolCalls:[],tokensUsed:0};
  })();
  const finalResult=qualityVerdict?result.then(value=>{
   const text=`${value.text}\nCEZ:VERDICT pass`;notify?.({type:'text',text:'\nCEZ:VERDICT pass'});notify?.({type:'turn-end'});notify?.({type:'done'});return {...value,text};
  },async error=>{
   if(!(error instanceof Refusal)||error.code!=='VERIFICATION_FAILED'||(node!=='qa'&&node!=='review'))throw error;
   const bound=await readManagedUnit(this.ledger,intent);
   if(!bound||bound.recipe.schemaVersion<2||!bound.unit.taskId)throw error;
   const failed=await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
    const rows=(await c.query(`SELECT e.id,e.artifact_id FROM ac_verification_evidence e JOIN ac_artifacts a ON a.id=e.artifact_id
      WHERE a.intent_id=$1 AND e.kind=$2 AND e.status='failed' ORDER BY e.id`,[intent.id,node])).rows;
    if(!rows.length||new Set(rows.map(row=>row.artifact_id)).size!==1)throw new Refusal('CORRECTION_EVIDENCE_INVALID');
    const ids=rows.map(row=>row.id);await this.options.quality.assertCorrectionFailures(c,rows[0].artifact_id,ids,authority);
    return {artifactId:rows[0].artifact_id,ids};
   });
   const next=bound.recipe.units.find(unit=>unit.kind==='task'&&unit.taskId===bound.unit.taskId&&unit.correctionRevision===(bound.unit.correctionRevision??0)+1);
   if(next){const principal=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1',[intent.id])).rows[0]?.principal_id;
    if(!principal)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
    await this.recordManagedCorrection(principal,intent,authority,next,failed.artifactId,failed.ids);}
   const text='CEZ:VERDICT reject';notify?.({type:'text',text});notify?.({type:'turn-end'});notify?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
  }):result;
  const settled=finalResult.finally(()=>{open=false;admissionWait(null);});
  return {result:settled,get open(){return open;},get pid(){return child?.pid;},sendMessage(){return false;},end(){},interrupt(){canceled=true;stop(child);for(const reviewer of nested)reviewer.interrupt();},hardStop(){canceled=true;stop(child);for(const reviewer of nested)reviewer.hardStop?.();}};
 }
 private async saveIsolatedResult(principal:string,intent:Intent,authority:Authority,stage:{id:string;session_id:string},grantId:string,
  artifact:ArtifactRow,node:'qa'|'review'|'judge',verified:IsolatedVerificationResult){
  if(verified.artifactId!==artifact.id||verified.operationId!==intent.operation_id||verified.kind!==node||verified.commit!==artifact.commit_id||
   verified.tree!==artifact.tree_id||verified.base!==artifact.base_id)throw new Refusal('SANDBOX_VERIFICATION_INVALID');
  const logs=resolve('.state/verification-logs');await mkdir(logs,{recursive:true,mode:0o700});
  await writeFile(join(logs,stage.id+'.log'),verified.output,{mode:0o600});
  const receipt:VerificationReceipt={schemaVersion:1,id:randomUUID(),artifactId:artifact.id,kind:node,sessionId:stage.session_id,
   grantId,policyRevision:artifact.policy_revision,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,
   status:verified.exitCode===0?'passed':'failed',exitCode:verified.exitCode,verifierDigest:verified.verifierDigest,
   logSha256:createHash('sha256').update(verified.output).digest('hex'),
   commandDigest:digest({executor:'isolated-fixed-verifier-v1',verifierDigest:verified.verifierDigest,node,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id}),
   verifierVersion:'synthetic-isolated-verifier-v1/'+verified.nodeVersion};
  const signature=createHmac('sha256',this.key).update(canonical(receipt)).digest('hex');
  await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
   const physical=(await c.query(`SELECT g.state,g.physical_receipt,j.state job_state,j.receipt job_receipt,s.session_id,s.node_id,s.grant_id,
    x.quality_revision FROM ac_capacity_grants g JOIN ac_sandbox_jobs j ON j.id=$2 JOIN ac_stage_operations s ON s.id=j.id
    JOIN ac_execution_contracts x ON x.intent_id=s.intent_id WHERE g.id=$1 AND s.intent_id=$3 FOR UPDATE OF g,j,s`,[grantId,stage.id,intent.id])).rows[0];
   if(physical?.state!=='released'||!['completed','failed'].includes(physical.job_state)||digest(physical.physical_receipt)!==digest(physical.job_receipt)||
    physical.session_id!==stage.session_id||physical.node_id!==node||physical.grant_id!==grantId||physical.quality_revision!==artifact.policy_revision||
    physical.physical_receipt?.jobId!==stage.id||physical.physical_receipt?.containerId!==verified.containerId||
    physical.physical_receipt?.exitCode!==verified.exitCode||digest(physical.physical_receipt?.verification)!==digest({artifactId:verified.artifactId,operationId:verified.operationId,
      kind:verified.kind,commit:verified.commit,tree:verified.tree,base:verified.base,verifierDigest:verified.verifierDigest,output:verified.output,nodeVersion:verified.nodeVersion}))
    throw new Refusal('VERIFIER_EXECUTION_UNCONFIRMED');
   const updated=await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1 AND intent_id=$3 AND manager_epoch<=$4 AND state IN ('uncertain','running') RETURNING id",
    [stage.id,{verification:receipt,signature},intent.id,authority.epoch]);
   if(!updated.rowCount)throw new Refusal('STAGE_RESULT_CONFLICT');
  });
  await this.options.quality.record(principal,receipt,signature,authority);
  try{await this.options.isolatedVerification!.cleanup(stage.id,grantId,authority);}
  catch(error){
   await this.ledger.tx(async c=>{await this.ledger.fence(c,authority,true);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'sandbox.cleanup_pending',$2)",[authority.contextId,{stageId:stage.id,reason:error instanceof Refusal?error.code:'TRANSPORT_UNCERTAIN'}]);});
  }
 }
 async reconcileVerifierResults(intent:Intent,authority:Authority,nodeId:string,sessionId:string){
  if(!this.options.isolatedVerification||(nodeId!=='qa'&&nodeId!=='review'&&nodeId!=='judge'))return;
  const node=nodeId;
  const saved=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
   const bound=(await c.query(`SELECT i.principal_id,p.snapshot,p.digest FROM ac_intents i JOIN ac_execution_contracts x ON x.intent_id=i.id
    JOIN ac_quality_policies p ON p.project_id=x.project_id AND p.revision=x.quality_revision
    WHERE i.id=$1 AND i.context_id=$2 AND x.project_id=$3`,[intent.id,authority.contextId,this.projectId])).rows[0];
   if(!bound)return null;
   await this.ledger.authorize(c,bound.principal_id,authority.contextId);
   const policy=QualityPolicy.parse(bound.snapshot);if(digest(policy)!==bound.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
   const sessions=node==='review'&&policy.requiredReviews>1?Array.from({length:policy.requiredReviews},(_,index)=>reviewSession(sessionId,index)):[sessionId];
   const stages=(await c.query(`SELECT s.* FROM ac_stage_operations s JOIN ac_stage_execution_launches l ON l.stage_id=s.id
    WHERE s.intent_id=$1 AND s.node_id=$2 AND s.session_id=ANY($3::uuid[]) AND s.state IN ('uncertain','running') AND s.manager_epoch<$4`,
    [intent.id,node,sessions,authority.epoch])).rows;
   const artifact=(await c.query<ArtifactRow>(`SELECT a.* FROM ac_artifacts a JOIN ac_operations o ON o.intent_id=a.intent_id
    WHERE a.intent_id=$1 AND a.commit_id=o.receipt->>'commit' AND a.tree_id=o.receipt->>'tree'`,[intent.id])).rows[0];
   if(!artifact)return null;
   return {principal:bound.principal_id,stages,artifact,verifierDigest:policy.verifierDigest};
  });
  if(!saved?.verifierDigest)return;
  for(const stage of saved.stages){
   const result=await this.options.isolatedVerification.reconcile(saved.principal,stage.id,stage.grant_id,authority,
    {id:saved.artifact.id,commit:saved.artifact.commit_id,tree:saved.artifact.tree_id,base:saved.artifact.base_id},intent.operation_id,node,saved.verifierDigest);
   if(result)await this.saveIsolatedResult(saved.principal,intent,authority,stage,stage.grant_id,saved.artifact,node,result);
  }
 }
 async reconcileIntegrationResult(intent:Intent,authority:Authority){
  const saved=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   const bound=(await c.query<{principal_id:string;quality_revision:number;target_ref:string;digest:string;stage_id:string;integration_id:string}>(`SELECT i.principal_id,x.quality_revision,x.target_ref,x.digest,s.id stage_id,t.id integration_id
    FROM ac_intents i JOIN ac_execution_contracts x ON x.intent_id=i.id
    JOIN ac_stage_operations s ON s.intent_id=i.id AND s.node_id='integrate'
    JOIN ac_operations o ON o.intent_id=i.id
    JOIN ac_artifacts a ON a.intent_id=i.id AND a.commit_id=o.receipt->>'commit' AND a.tree_id=o.receipt->>'tree'
    JOIN ac_integration_intents t ON t.artifact_id=a.id AND t.target_ref=x.target_ref
    WHERE i.id=$1 AND i.context_id=$2 AND x.project_id=$3 AND s.state IN ('uncertain','running') AND s.manager_epoch<=$4`,
    [intent.id,authority.contextId,this.projectId,authority.epoch])).rows[0];
   if(!bound)return null;
   await this.ledger.authorize(c,bound.principal_id,authority.contextId);
   if(bound.digest!==digest({qualityRevision:bound.quality_revision,targetRef:bound.target_ref}))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
   const allowed=this.options.allowedTargets??(this.options.targetRef?[this.options.targetRef]:[]);
   if(!allowed.includes(bound.target_ref))throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
   return bound;
  });
  if(!saved)return;
  const receipt=await new Integrator(this.ledger,this.options.quality,this.options.git,this.projectId,saved.target_ref)
   .reconcile(saved.principal_id,saved.integration_id,authority);
  if(!receipt)return;
  await this.ledger.tx(async c=>{await this.ledger.fence(c,authority,true);
   await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1 AND state IN ('uncertain','running') AND manager_epoch<=$3",
    [saved.stage_id,{integration:receipt},authority.epoch]);
  });
 }
 close(){this.running=false;for(const child of this.children)stop(child);this.options.isolatedVerification?.close();}
}
