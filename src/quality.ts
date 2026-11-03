import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { Authority, Id, digest, canonical, Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';
import type { GitArtifacts } from './git.ts';
import { QualityPolicy,QualityPolicies } from './quality-policy.ts';
import {ManagedRecipe} from './managed-plan.ts';
export { QualityPolicy } from './quality-policy.ts';
const GitId=z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const ArtifactInput=z.object({id:Id,contextId:Id,intentId:Id,implementationGrantId:Id,implementationSessionId:Id,
  policyRevision:z.number().int().positive(),commit:GitId,tree:GitId,base:GitId,risk:z.enum(['low','medium','high'])}).strict();
export const VerificationReceipt=z.object({schemaVersion:z.literal(1),id:Id,artifactId:Id,kind:z.enum(['qa','review','judge']),
  sessionId:Id,grantId:Id,policyRevision:z.number().int().positive(),commit:GitId,tree:GitId,base:GitId,
  status:z.enum(['passed','failed','canceled','missing_result','stale']),exitCode:z.number().int(),
  verifierDigest:z.string().regex(/^[a-f0-9]{64}$/),logSha256:z.string().regex(/^[a-f0-9]{64}$/),commandDigest:z.string().regex(/^[a-f0-9]{64}$/),
  verifierVersion:z.string().min(1).max(100)}).strict();
export type VerificationReceipt=z.infer<typeof VerificationReceipt>;
export type ArtifactRow={id:string;context_id:string;intent_id:string;implementation_grant_id:string;implementation_session_id:string;
  project_id:string;policy_revision:number;commit_id:string;tree_id:string;base_id:string;identity_digest:string;risk:string};

/** Invoke only within the authenticated control transaction. The waiver does
 * not create a QA receipt, remove failed evidence or approve integration. */
export async function waiveQaInTransaction(c:pg.PoolClient,principal:string,contextId:string,artifactId:string,reasonRef:string){
  const context=Id.parse(contextId),artifact=Id.parse(artifactId),reason=z.string().min(1).max(200).parse(reasonRef);
  const row=(await c.query(`SELECT a.*,p.snapshot,p.digest policy_digest FROM ac_artifacts a JOIN ac_quality_policies p
    ON p.project_id=a.project_id AND p.revision=a.policy_revision WHERE a.id=$1 AND a.context_id=$2`,[artifact,context])).rows[0];
  if(!row)throw new Refusal('ARTIFACT_FORBIDDEN',403);
  if(!(await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[row.project_id,principal])).rowCount)
    throw new Refusal('PROJECT_OWNER_REQUIRED',403);
  const policy=QualityPolicy.parse(row.snapshot);
  if(digest(policy)!==row.policy_digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
  if(row.risk!=='low'||!policy.allowLowRiskQaWaiver)throw new Refusal('QA_WAIVER_FORBIDDEN',403);
  const inserted=await c.query('INSERT INTO ac_qa_waivers(artifact_id,principal_id,reason_ref) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING artifact_id',
    [artifact,principal,reason]);
  if(!inserted.rowCount){
    const prior=(await c.query('SELECT principal_id,reason_ref FROM ac_qa_waivers WHERE artifact_id=$1',[artifact])).rows[0];
    if(!prior||prior.principal_id!==principal||prior.reason_ref!==reason)throw new Refusal('QA_WAIVER_CONFLICT');
  }else await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'qa.waived',$2)",[context,{artifactId:artifact,reasonRef:reason}]);
  return {artifactId:artifact,waived:true as const};
}

/** Gates only: Cezar remains the sole owner of sequencing and correction loops. */
export class Quality {
  constructor(readonly ledger:Ledger,private readonly verifierKey:Uint8Array,private readonly git:Pick<GitArtifacts,'identity'>){
    if(verifierKey.byteLength<32)throw Error('VERIFIER_KEY_TOO_SHORT');
  }
  async publish(principal:string,projectId:string,expectedRevision:number,raw:z.input<typeof QualityPolicy>){
    return new QualityPolicies(this.ledger).publish(principal,projectId,expectedRevision,raw);
  }
  async register(principal:string,raw:z.input<typeof ArtifactInput>,authority:Authority){
    const value=ArtifactInput.parse(raw);
    const gitIdentity=await this.git.identity(value.commit,value.base);
    if(gitIdentity.tree!==value.tree)throw new Refusal('ARTIFACT_TREE_MISMATCH');
    return this.ledger.tx(async c=>{
      const context=await this.ledger.authorize(c,principal,value.contextId);
      if(value.contextId!==authority.contextId)throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
      await this.ledger.fence(c,authority,true);
      const implementation=await c.query(`SELECT g.id,g.resource_kind,g.account_id,g.profile_id,g.attempt_id,g.manager_epoch grant_epoch,
        g.physical_receipt,i.parent_intent_id,i.parent_unit_id,i.run_id,i.operation_id,o.execution_attempt_id,o.manager_epoch operation_epoch,
        o.native_session_id,o.handle,o.receipt operation_receipt,m.recipe,m.recipe_digest FROM ac_capacity_grants g JOIN ac_intents i ON i.id=g.intent_id
        JOIN ac_operations o ON o.grant_id=g.id AND o.intent_id=i.id AND o.id=i.operation_id
        LEFT JOIN ac_managed_executions m ON m.parent_intent_id=i.parent_intent_id
        WHERE g.id=$1 AND g.context_id=$2 AND i.context_id=g.context_id AND g.project_id=$7 AND g.intent_id=$3 AND g.role='programmer' AND g.state='released'
        AND g.physical_receipt IS NOT NULL AND o.state='completed'
        AND o.receipt->>'commit'=$4 AND o.receipt->>'tree'=$5 AND o.receipt->>'base'=$6`,
        [value.implementationGrantId,value.contextId,value.intentId,value.commit,value.tree,value.base,context.project_id]);
      if(!implementation.rowCount)throw new Refusal('IMPLEMENTATION_EVIDENCE_MISSING');
      const grant=implementation.rows[0];
      if(grant.resource_kind==='local_compositor'){
        const recipe=ManagedRecipe.parse(grant.recipe),unit=recipe.units.find(item=>item.id===grant.parent_unit_id);
        if(grant.account_id!==null||grant.profile_id!==null||recipe.parentIntentId!==grant.parent_intent_id||digest(recipe)!==grant.recipe_digest||
           !unit||unit.kind!=='composition'||unit.intentId!==value.intentId||unit.runId!==grant.run_id||unit.operationId!==grant.operation_id||
           unit.attemptId!==grant.attempt_id||grant.execution_attempt_id!==grant.attempt_id||Number(grant.grant_epoch)!==Number(grant.operation_epoch)||
           Number(grant.grant_epoch)>authority.epoch||grant.native_session_id!==value.implementationSessionId||
           grant.operation_receipt?.operationId!==grant.operation_id||grant.operation_receipt?.exitCode!==0||grant.operation_receipt?.synthetic!==true||
           !Number.isInteger(grant.handle?.pid)||grant.handle.pid<=0||grant.handle?.operationId!==grant.operation_id||
           Number(grant.handle?.epoch)!==Number(grant.operation_epoch)||
           grant.physical_receipt?.state!=='exited'||grant.physical_receipt?.exitCode!==0||
           grant.physical_receipt?.source!=='managed-git-compositor'||grant.physical_receipt?.processId!==String(grant.handle?.pid))
          throw new Refusal('IMPLEMENTATION_EVIDENCE_MISSING');
      }else if(grant.resource_kind!=='model'||!grant.account_id||!grant.profile_id)throw new Refusal('IMPLEMENTATION_EVIDENCE_MISSING');
      await this.assertFreshCorrectionSession(c,value.intentId,value.implementationSessionId,value.implementationGrantId,authority);
      if(!(await c.query('SELECT 1 FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[context.project_id,value.policyRevision])).rowCount)
        throw new Refusal('QUALITY_POLICY_REQUIRED');
      const identity=digest({commit:value.commit,tree:value.tree,base:value.base});
      const row=(await c.query<ArtifactRow>(`INSERT INTO ac_artifacts VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(id) DO NOTHING RETURNING *`,[value.id,value.contextId,value.intentId,value.implementationGrantId,
        value.implementationSessionId,context.project_id,value.policyRevision,value.commit,value.tree,value.base,identity,value.risk])).rows[0];
      if(row)return row;
      const prior=(await c.query<ArtifactRow>('SELECT * FROM ac_artifacts WHERE id=$1',[value.id])).rows[0];
      if(!prior||prior.context_id!==value.contextId||prior.intent_id!==value.intentId||prior.identity_digest!==identity||prior.policy_revision!==value.policyRevision||
        prior.implementation_grant_id!==value.implementationGrantId||prior.implementation_session_id!==value.implementationSessionId||prior.risk!==value.risk)
        throw new Refusal('ARTIFACT_ID_CONFLICT');
      return prior;
    });
  }
  async record(principal:string,raw:VerificationReceipt,signature:string,authority:Authority){
    const receipt=VerificationReceipt.parse(raw);
    const expected=createHmac('sha256',this.verifierKey).update(canonical(receipt)).digest();
    if(!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(expected,Buffer.from(signature,'hex')))
      throw new Refusal('UNTRUSTED_VERIFICATION',403);
    return this.ledger.tx(async c=>{
      await this.ledger.authorize(c,principal,authority.contextId);
      await this.ledger.fence(c,authority,true);
      const artifact=(await c.query<ArtifactRow>('SELECT * FROM ac_artifacts WHERE id=$1 AND context_id=$2',[receipt.artifactId,authority.contextId])).rows[0];
      if(!artifact)throw new Refusal('ARTIFACT_FORBIDDEN',403);
      if(receipt.commit!==artifact.commit_id||receipt.tree!==artifact.tree_id||receipt.base!==artifact.base_id||receipt.policyRevision!==artifact.policy_revision)
        throw new Refusal('VERIFICATION_ARTIFACT_MISMATCH');
      const recordedPolicy=(await c.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
        [artifact.project_id,artifact.policy_revision])).rows[0];
      const policy=QualityPolicy.parse(recordedPolicy?.snapshot);
      const expectedVerifier=receipt.kind==='qa'?(policy.qaVerifierDigest??policy.verifierDigest):policy.verifierDigest;
      if(digest(policy)!==recordedPolicy.digest||!expectedVerifier||expectedVerifier!==receipt.verifierDigest)
        throw new Refusal('VERIFIER_VERSION_MISMATCH');
      if(receipt.sessionId===artifact.implementation_session_id||receipt.grantId===artifact.implementation_grant_id)
        throw new Refusal('VERIFICATION_NOT_INDEPENDENT');
      await this.assertFreshCorrectionSession(c,artifact.intent_id,receipt.sessionId,receipt.grantId,authority);
      const role=receipt.kind==='qa'?'qa':receipt.kind==='judge'?'judge':'reviewer';
      if(receipt.kind==='judge')await this.assertReady(c,artifact.id,authority,{ignoreJudge:true});
      const grant=await c.query(`SELECT 1 FROM ac_capacity_grants WHERE id=$1 AND context_id=$2 AND intent_id=$3
        AND role=$4 AND resource_kind='model' AND state='released' AND physical_receipt IS NOT NULL`,[receipt.grantId,artifact.context_id,artifact.intent_id,role]);
      if(!grant.rowCount)throw new Refusal('VERIFIER_EXECUTION_UNCONFIRMED');
      if(receipt.status==='passed'&&receipt.exitCode!==0)throw new Refusal('VERIFICATION_EXIT_FAILED');
      const hash=digest(receipt);
      const prior=(await c.query('SELECT id,receipt_digest FROM ac_verification_evidence WHERE id=$1 OR (artifact_id=$2 AND kind=$3 AND session_id=$4)',
        [receipt.id,receipt.artifactId,receipt.kind,receipt.sessionId])).rows[0];
      if(prior){if(prior.id!==receipt.id||prior.receipt_digest!==hash)throw new Refusal('VERIFICATION_ID_CONFLICT');return prior.id;}
      await c.query('INSERT INTO ac_verification_evidence(id,artifact_id,kind,session_id,grant_id,policy_revision,status,receipt,receipt_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [receipt.id,receipt.artifactId,receipt.kind,receipt.sessionId,receipt.grantId,receipt.policyRevision,receipt.status,receipt,hash]);
      return receipt.id;
    });
  }
  /** A correction may follow only authenticated verifier failure with a
   * matching terminal physical receipt. Infrastructure loss and cancellation
   * are not review verdicts. Called inside the decision transaction. */
  async assertCorrectionFailures(c:pg.PoolClient,artifactId:string,evidenceIds:readonly string[],authority:Authority){
    const ids=z.array(Id).min(1).max(32).parse(evidenceIds);
    if(new Set(ids).size!==ids.length)throw new Refusal('CORRECTION_EVIDENCE_INVALID');
    await this.ledger.fence(c,authority,true);
    const artifact=(await c.query<ArtifactRow>('SELECT * FROM ac_artifacts WHERE id=$1 AND context_id=$2',[Id.parse(artifactId),authority.contextId])).rows[0];
    if(!artifact)throw new Refusal('ARTIFACT_FORBIDDEN',403);
    await this.ledger.assertIntentActive(c,authority.contextId,artifact.intent_id);
    const rows=(await c.query(`SELECT e.*,s.id stage_id,s.intent_id stage_intent,s.node_id,s.session_id stage_session,s.grant_id stage_grant,
      s.manager_epoch stage_epoch,s.state stage_state,s.handle,s.receipt stage_receipt,g.state grant_state,g.role grant_role,
      g.resource_kind,g.intent_id grant_intent,g.context_id grant_context,g.manager_epoch grant_epoch,g.physical_receipt,
      j.state job_state,j.receipt job_receipt,nq.state native_qa_state,nq.receipt native_qa_receipt,nq.contract_digest native_qa_contract,i.operation_id FROM ac_verification_evidence e
      JOIN ac_stage_operations s ON s.grant_id=e.grant_id AND s.session_id=e.session_id
      JOIN ac_capacity_grants g ON g.id=e.grant_id JOIN ac_intents i ON i.id=s.intent_id LEFT JOIN ac_sandbox_jobs j ON j.id=s.id LEFT JOIN ac_native_qa_jobs nq ON nq.id=s.id
      WHERE e.id=ANY($1::uuid[]) AND e.artifact_id=$2`,[ids,artifact.id])).rows;
    if(rows.length!==ids.length)throw new Refusal('CORRECTION_EVIDENCE_INVALID');
    for(const row of rows){
      const parsed=VerificationReceipt.safeParse(row.receipt),signature=row.stage_receipt?.signature;
      if(!parsed.success||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))throw new Refusal('CORRECTION_EVIDENCE_INVALID');
      const r=parsed.data,mac=createHmac('sha256',this.verifierKey).update(canonical(r)).digest();
      if(!timingSafeEqual(mac,Buffer.from(signature,'hex'))||digest(r)!==row.receipt_digest||!row.stage_receipt?.verification||digest(row.stage_receipt.verification)!==digest(r)||
       r.id!==row.id||r.artifactId!==artifact.id||row.kind!==r.kind||r.status!=='failed'||row.status!=='failed'||r.exitCode<=0||
       r.commit!==artifact.commit_id||r.tree!==artifact.tree_id||r.base!==artifact.base_id||r.policyRevision!==artifact.policy_revision||
       r.sessionId===artifact.implementation_session_id||r.grantId===artifact.implementation_grant_id||
       r.sessionId!==row.stage_session||r.grantId!==row.stage_grant||row.stage_intent!==artifact.intent_id||row.grant_intent!==artifact.intent_id||
       row.grant_context!==artifact.context_id||row.stage_state!=='completed'||row.grant_state!=='released'||row.resource_kind!=='model'||
       row.node_id!==(r.kind==='review'?'review':r.kind)||row.grant_role!==(r.kind==='review'?'reviewer':r.kind)||
       Number(row.stage_epoch)!==Number(row.grant_epoch)||Number(row.stage_epoch)>authority.epoch)throw new Refusal('CORRECTION_EVIDENCE_INVALID');
      const physical=row.physical_receipt;
      const local=physical?.source==='synthetic-verifier-parent'&&physical?.state==='exited'&&physical?.exitCode===r.exitCode&&
       Number.isInteger(row.handle?.pid)&&physical.processId===String(row.handle.pid);
      const isolated=row.job_state==='failed'&&row.job_receipt&&physical&&digest(row.job_receipt)===digest(physical)&&physical?.jobId===row.stage_id&&
       physical?.exitCode===r.exitCode&&physical?.verification?.artifactId===artifact.id&&physical?.verification?.operationId===row.operation_id&&physical?.verification?.commit===r.commit&&
       physical?.verification?.tree===r.tree&&physical?.verification?.base===r.base&&physical?.verification?.kind===r.kind&&physical?.verification?.verifierDigest===r.verifierDigest&&
       typeof physical?.verification?.output==='string'&&createHash('sha256').update(physical.verification.output).digest('hex')===r.logSha256;
      const nativeQa=r.kind==='qa'&&row.native_qa_state==='failed'&&row.native_qa_receipt&&physical&&row.stage_receipt?.nativeQa&&
       digest(row.native_qa_receipt)===digest(physical)&&digest(row.stage_receipt.nativeQa)===digest(physical)&&
       row.native_qa_contract===r.verifierDigest&&physical.contractDigest===r.verifierDigest&&physical.jobId===row.stage_id&&
       physical.artifactId===artifact.id&&physical.grantId===r.grantId&&physical.sessionId===r.sessionId&&physical.status==='failed'&&physical.exitCode===r.exitCode&&
       physical.logSha256===r.logSha256&&physical.logsAvailable===true&&physical.synthetic===false&&physical.modelInference===false&&
       /^[a-f0-9]{64}$/.test(physical.containerId??'')&&Number.isFinite(Date.parse(physical.finishedAt))&&!String(physical.finishedAt).startsWith('0001-');
      if(!local&&!isolated&&!nativeQa)throw new Refusal('CORRECTION_EVIDENCE_INVALID');
    }
    return artifact;
  }
  /** Do not reuse implementation or verifier sessions across correction revisions. */
  private async assertFreshCorrectionSession(c:pg.PoolClient,intentId:string,sessionId:string,grantId:string,authority:Authority){
    const current=(await c.query(`SELECT i.parent_intent_id,i.parent_unit_id,m.recipe,m.recipe_digest FROM ac_intents i
      LEFT JOIN ac_managed_executions m ON m.parent_intent_id=i.parent_intent_id WHERE i.id=$1 AND i.context_id=$2`,[intentId,authority.contextId])).rows[0];
    if(!current?.parent_intent_id)return;
    const recipe=ManagedRecipe.parse(current.recipe);
    if(digest(recipe)!==current.recipe_digest||recipe.parentIntentId!==current.parent_intent_id)throw new Refusal('MANAGED_RECIPE_MISMATCH');
    if(recipe.schemaVersion===1)return;
    let unit=recipe.units.find(value=>value.id===current.parent_unit_id&&value.intentId===intentId);
    if(!unit)throw new Refusal('MANAGED_CORRECTION_MISMATCH');
    let revision=unit.correctionRevision??0;
    if(revision===0)return;
    const taskId=unit.taskId,visited=new Set<string>([intentId]);let nextIntentId=intentId;
    for(let depth=0;revision>0;depth++,revision--){
      if(depth>=5||!taskId)throw new Refusal('MANAGED_CORRECTION_MISMATCH');
      const decision=(await c.query('SELECT * FROM ac_managed_correction_decisions WHERE next_intent_id=$1 AND parent_intent_id=$2 AND task_id=$3 AND revision=$4',
        [nextIntentId,current.parent_intent_id,taskId,revision])).rows[0];
      if(!decision||decision.context_id!==authority.contextId||Number(decision.manager_epoch)>authority.epoch||visited.has(decision.prior_intent_id)||decision.decision_digest!==digest({
        parentIntentId:decision.parent_intent_id,contextId:decision.context_id,taskId:decision.task_id,revision:decision.revision,
        priorIntentId:decision.prior_intent_id,priorArtifactId:decision.prior_artifact_id,failedEvidenceIds:decision.failed_evidence_ids,
        priorCommit:decision.prior_commit,priorTree:decision.prior_tree,baseId:decision.base_id,nextIntentId:decision.next_intent_id,
        managerEpoch:Number(decision.manager_epoch)}))throw new Refusal('MANAGED_CORRECTION_MISMATCH');
      unit=recipe.units.find(value=>value.intentId===decision.prior_intent_id&&value.taskId===taskId&&value.kind==='task'&&(value.correctionRevision??0)===revision-1);
      if(!unit)throw new Refusal('MANAGED_CORRECTION_MISMATCH');
      const prior=await this.assertCorrectionFailures(c,decision.prior_artifact_id,decision.failed_evidence_ids,authority);
      if(prior.intent_id!==decision.prior_intent_id||prior.commit_id!==decision.prior_commit||prior.tree_id!==decision.prior_tree||prior.base_id!==decision.base_id)
        throw new Refusal('MANAGED_CORRECTION_MISMATCH');
      if(prior.implementation_session_id===sessionId||prior.implementation_grant_id===grantId||
       (await c.query('SELECT 1 FROM ac_verification_evidence WHERE artifact_id=$1 AND (session_id=$2 OR grant_id=$3)',[prior.id,sessionId,grantId])).rowCount)
        throw new Refusal('VERIFICATION_NOT_INDEPENDENT');
      visited.add(decision.prior_intent_id);nextIntentId=decision.prior_intent_id;
    }
  }
  async assertReady(c:pg.PoolClient,artifactId:string,authority:Authority,options:{ignoreJudge?:boolean}={}):Promise<ArtifactRow>{
    await this.ledger.fence(c,authority,true);
    const artifact=(await c.query<ArtifactRow>('SELECT * FROM ac_artifacts WHERE id=$1 AND context_id=$2',[artifactId,authority.contextId])).rows[0];
    if(!artifact)throw new Refusal('ARTIFACT_FORBIDDEN',403);
    const row=(await c.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[artifact.project_id,artifact.policy_revision])).rows[0];
    const policy=QualityPolicy.parse(row?.snapshot);
    if(digest(policy)!==row.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
    const evidence=(await c.query('SELECT kind,status,session_id,grant_id FROM ac_verification_evidence WHERE artifact_id=$1',[artifactId])).rows;
    if(evidence.some(e=>e.status!=='passed'))throw new Refusal('VERIFICATION_NOT_PASSED');
    if(new Set(evidence.map(e=>e.session_id)).size!==evidence.length||new Set(evidence.map(e=>e.grant_id)).size!==evidence.length)
      throw new Refusal('VERIFICATION_NOT_INDEPENDENT');
    const qa=evidence.filter(e=>e.kind==='qa');
    const waived=(await c.query('SELECT 1 FROM ac_qa_waivers WHERE artifact_id=$1',[artifactId])).rowCount;
    if(!qa.length&&!(waived&&artifact.risk==='low'&&policy.allowLowRiskQaWaiver))throw new Refusal('QA_MISSING');
    if(evidence.filter(e=>e.kind==='review').length<policy.requiredReviews)throw new Refusal('REVIEWS_MISSING');
    if(policy.requireJudge&&!options.ignoreJudge&&evidence.filter(e=>e.kind==='judge').length!==1)throw new Refusal('JUDGMENT_MISSING');
    return artifact;
  }
  async prepareIntegration(principal:string,artifactId:string,authority:Authority,targetRef:string){
    const ref=z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/).parse(targetRef);
    return this.ledger.tx(async c=>{
      await this.ledger.authorize(c,principal,authority.contextId);
      await this.ledger.fence(c,authority);
      const artifact=await this.assertReady(c,artifactId,authority);
      await this.ledger.assertIntentActive(c,authority.contextId,artifact.intent_id);
      await this.assertHumanApproval(c,artifact,ref);
      const prior=(await c.query('SELECT * FROM ac_integration_intents WHERE artifact_id=$1',[artifactId])).rows[0];
      if(prior){if(prior.target_ref!==ref)throw new Refusal('INTEGRATION_TARGET_CONFLICT');return prior;}
      return (await c.query(`INSERT INTO ac_integration_intents(id,artifact_id,context_id,manager_epoch,target_ref,state)
        VALUES($1,$2,$3,$4,$5,'registered') RETURNING *`,[randomUUID(),artifact.id,artifact.context_id,authority.epoch,ref])).rows[0];
    });
  }
  async assertHumanApproval(c:pg.PoolClient,artifact:ArtifactRow,targetRef:string){
    const row=(await c.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',[artifact.project_id,artifact.policy_revision])).rows[0];
    const policy=QualityPolicy.parse(row?.snapshot);if(digest(policy)!==row.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
    if(policy.requireHumanIntegration&&!(await c.query('SELECT 1 FROM ac_integration_approvals WHERE artifact_id=$1 AND target_ref=$2 AND artifact_digest=$3 AND policy_revision=$4',
      [artifact.id,targetRef,artifact.identity_digest,artifact.policy_revision])).rowCount)throw new Refusal('INTEGRATION_APPROVAL_REQUIRED');
  }
}
