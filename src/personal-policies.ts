import type {Ledger} from './ledger.ts';
import {Capacity} from './capacity.ts';
import {Refusal} from './contracts.ts';
import {QualityPolicies, QualityPolicy} from './quality-policy.ts';
import {Templates} from './templates.ts';
import {nativeReviewVerifierDigest} from './native-review-contract.ts';
import {applyPersonalCombo} from './personal-combos.ts';
import {containFailure} from './failure-log.ts';

/** Gives the target project access to the accounts the owner already uses on the source project. */
export async function shareProjectAccounts(ledger:Ledger, owner:string, sourceProjectId:string, targetProjectId:string){
 if(sourceProjectId===targetProjectId)return;
 const accounts=(await ledger.pool.query('SELECT a.id FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1 AND a.owner_id=$2 ORDER BY a.id',[sourceProjectId,owner])).rows;
 const capacity=new Capacity(ledger);
 for(const row of accounts)await capacity.shareAccount(owner,String(row.id),targetProjectId);
}

/**
 * Publishes the first capacity and quality revisions when the project has none.
 * A project with no capacity revision is born on the intermediário combo. Missing Claude
 * or Codex accounts leave that revision unpublished. An existing revision is left alone.
 * Quality is still copied from the source project when that revision exists.
 */
export async function publishFirstPersonalPolicies(ledger:Ledger, owner:string, projectId:string, sourceProjectId:string, fallback?:{qaVerifierDigest?:string}, dataDirectory?:string){
 if(!(await ledger.pool.query('SELECT 1 FROM ac_policy_revisions WHERE project_id=$1 LIMIT 1',[projectId])).rowCount&&dataDirectory){
  try{await applyPersonalCombo(ledger,owner,projectId,'intermediário',dataDirectory);}
  catch(error){if(!(error instanceof Refusal)||!String(error.code).endsWith('_ACCOUNT_REQUIRED'))throw error;}
 }
 if(!(await ledger.pool.query('SELECT 1 FROM ac_quality_policies WHERE project_id=$1 LIMIT 1',[projectId])).rowCount){
  const source=(await ledger.pool.query('SELECT snapshot FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',[sourceProjectId])).rows[0];
  const policies=new QualityPolicies(ledger);
  if(source)await policies.publish(owner,projectId,0,QualityPolicy.parse(source.snapshot));
  else if(fallback)await policies.publish(owner,projectId,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:nativeReviewVerifierDigest,...(fallback.qaVerifierDigest?{qaVerifierDigest:fallback.qaVerifierDigest}:{})});
 }
}

/** Moves each live conversation template onto the project's latest quality revision.
 * One failed template does not block the others; it is logged and counted in the result. */
export async function refreshPersonalTemplates(ledger:Ledger, projectId:string):Promise<{refreshed:number;failed:number}>{
 const qualityNow=Number((await ledger.pool.query('SELECT max(revision) r FROM ac_quality_policies WHERE project_id=$1',[projectId])).rows[0].r);
 if(!qualityNow)return {refreshed:0,failed:0};
 const stale=(await ledger.pool.query(`SELECT t.context_id,t.revision,t.snapshot,t.published_by FROM ac_context_templates t JOIN ac_contexts x ON x.id=t.context_id
  WHERE x.project_id=$1 AND NOT x.archived AND t.revision=(SELECT max(revision) FROM ac_context_templates WHERE context_id=t.context_id) AND (t.snapshot->>'qualityRevision')::int<>$2`,[projectId,qualityNow])).rows;
 let refreshed=0,failed=0;
 for(const row of stale){
  const ok=await new Templates(ledger).publish(String(row.published_by),String(row.context_id),Number(row.revision),{...row.snapshot,qualityRevision:qualityNow}).then(()=>true,containFailure('PERSONAL_TEMPLATE_REFRESH_FAILED',false));
  if(ok)refreshed++;else failed++;
 }
 return {refreshed,failed};
}
