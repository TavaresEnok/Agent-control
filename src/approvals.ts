import {z} from 'zod';
import type pg from 'pg';
import {Id,Refusal,digest} from './contracts.ts';
import type {Ledger} from './ledger.ts';

export const IntegrationApproval=z.object({artifactId:Id,artifactDigest:z.string().regex(/^[a-f0-9]{64}$/),
 policyRevision:z.number().int().positive(),targetRef:z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/)}).strict();
/** The signed Control transaction owns human approval. It does not waive QA,
 * authorize a different target, or turn a stale digest into current evidence. */
export async function approveIntegration(ledger:Ledger,c:pg.PoolClient,principal:string,contextId:string,raw:z.input<typeof IntegrationApproval>){
 const value=IntegrationApproval.parse(raw),context=await ledger.authorize(c,principal,contextId);
 if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
 const artifact=(await c.query(`SELECT a.*,x.target_ref,x.digest contract_digest,x.quality_revision FROM ac_artifacts a
  JOIN ac_execution_contracts x ON x.intent_id=a.intent_id WHERE a.id=$1 AND a.context_id=$2`,[value.artifactId,contextId])).rows[0];
 if(!artifact)throw new Refusal('ARTIFACT_FORBIDDEN',403);
 await ledger.assertIntentActive(c,contextId,artifact.intent_id);
 if(artifact.contract_digest!==digest({qualityRevision:artifact.quality_revision,targetRef:artifact.target_ref}))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
 if(value.artifactDigest!==artifact.identity_digest||value.policyRevision!==artifact.policy_revision)throw new Refusal('APPROVAL_ARTIFACT_MISMATCH');
 if(value.targetRef!==artifact.target_ref)throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
 await c.query('INSERT INTO ac_integration_approvals(artifact_id,target_ref,principal_id,artifact_digest,policy_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
  [artifact.id,value.targetRef,principal,artifact.identity_digest,artifact.policy_revision]);
 await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'integration.approved',$2)",[contextId,{artifactId:artifact.id,targetRef:value.targetRef,principal}]);
 return {artifactId:artifact.id,approved:true};
}
