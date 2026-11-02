import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
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

/** Gates only: Cezar remains the sole owner of sequencing and correction loops. */
export class Quality {
  constructor(readonly ledger:Ledger,private readonly verifierKey:Uint8Array,private readonly git:Pick<GitArtifacts,'identity'>){
    if(verifierKey.byteLength<32)throw Error('VERIFIER_KEY_TOO_SHORT');
  }
  private async owner(c:pg.PoolClient,principal:string,projectId:string){
    if(!(await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[projectId,principal])).rowCount)
      throw new Refusal('PROJECT_OWNER_REQUIRED',403);
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
      if(digest(policy)!==recordedPolicy.digest||!policy.verifierDigest||policy.verifierDigest!==receipt.verifierDigest)
        throw new Refusal('VERIFIER_VERSION_MISMATCH');
      if(receipt.sessionId===artifact.implementation_session_id||receipt.grantId===artifact.implementation_grant_id)
        throw new Refusal('VERIFICATION_NOT_INDEPENDENT');
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
  async waiveQa(principal:string,artifactId:string,reasonRef:string){
    const reason=z.string().min(1).max(200).parse(reasonRef);
    await this.ledger.tx(async c=>{
      const row=(await c.query(`SELECT a.*,p.snapshot FROM ac_artifacts a JOIN ac_quality_policies p
        ON p.project_id=a.project_id AND p.revision=a.policy_revision WHERE a.id=$1`,[Id.parse(artifactId)])).rows[0];
      if(!row)throw new Refusal('ARTIFACT_FORBIDDEN',403);
      await this.owner(c,principal,row.project_id);
      if(row.risk!=='low'||!QualityPolicy.parse(row.snapshot).allowLowRiskQaWaiver)throw new Refusal('QA_WAIVER_FORBIDDEN',403);
      await c.query('INSERT INTO ac_qa_waivers VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[artifactId,principal,reason]);
      await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'qa.waived',$2)",[row.context_id,{artifactId,reasonRef:reason}]);
    });
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
