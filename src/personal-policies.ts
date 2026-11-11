import type {Ledger} from './ledger.ts';
import {Capacity, type CapacityPolicy} from './capacity.ts';
import {QualityPolicies, QualityPolicy} from './quality-policy.ts';
import {Templates} from './templates.ts';
import {nativeReviewVerifierDigest} from './native-review-contract.ts';

/** Gives the target project access to the accounts the owner already uses on the source project. */
export async function shareProjectAccounts(ledger:Ledger, owner:string, sourceProjectId:string, targetProjectId:string){
 if(sourceProjectId===targetProjectId)return;
 const accounts=(await ledger.pool.query('SELECT a.id FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id WHERE x.project_id=$1 AND a.owner_id=$2 ORDER BY a.id',[sourceProjectId,owner])).rows;
 const capacity=new Capacity(ledger);
 for(const row of accounts)await capacity.shareAccount(owner,String(row.id),targetProjectId);
}

/**
 * Publishes revision 1 of capacity and quality when the project has none.
 * Capacity is copied from the source project when that revision exists; otherwise it is built
 * from the profiles already shared into this project. An existing revision is left alone.
 */
export async function publishFirstPersonalPolicies(ledger:Ledger, owner:string, projectId:string, sourceProjectId:string, fallback?:{qaVerifierDigest?:string}){
 const capacity=new Capacity(ledger);
 if(!(await ledger.pool.query('SELECT 1 FROM ac_policy_revisions WHERE project_id=$1 LIMIT 1',[projectId])).rowCount){
  const source=(await ledger.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',[sourceProjectId])).rows[0];
  if(source)await capacity.publish(owner,projectId,0,source.snapshot as CapacityPolicy);
  else{
   const profiles=(await ledger.pool.query(`SELECT p.id,p.role FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id WHERE x.project_id=$1 AND p.enabled ORDER BY p.role,p.id`,[projectId])).rows;
   const roles:CapacityPolicy['roles']={};
   for(const profile of profiles){
    const role=String(profile.role) as keyof CapacityPolicy['roles'];
    (roles[role]??={regular:[],emergency:[]}).regular.push(String(profile.id));
   }
   if(roles.manager&&roles.programmer)await capacity.publish(owner,projectId,0,{schemaVersion:1,roles,maxEvaluatorsPerContext:2,maxProgrammersPerContext:2});
  }
 }
 if(!(await ledger.pool.query('SELECT 1 FROM ac_quality_policies WHERE project_id=$1 LIMIT 1',[projectId])).rowCount){
  const source=(await ledger.pool.query('SELECT snapshot FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',[sourceProjectId])).rows[0];
  const policies=new QualityPolicies(ledger);
  if(source)await policies.publish(owner,projectId,0,QualityPolicy.parse(source.snapshot));
  else if(fallback)await policies.publish(owner,projectId,0,{schemaVersion:1,requiredReviews:1,allowLowRiskQaWaiver:false,requireHumanIntegration:false,verifierDigest:nativeReviewVerifierDigest,...(fallback.qaVerifierDigest?{qaVerifierDigest:fallback.qaVerifierDigest}:{})});
 }
}

/** Moves each live conversation template onto the project's latest quality revision. */
export async function refreshPersonalTemplates(ledger:Ledger, projectId:string){
 const qualityNow=Number((await ledger.pool.query('SELECT max(revision) r FROM ac_quality_policies WHERE project_id=$1',[projectId])).rows[0].r);
 if(!qualityNow)return;
 const stale=(await ledger.pool.query(`SELECT t.context_id,t.revision,t.snapshot,t.published_by FROM ac_context_templates t JOIN ac_contexts x ON x.id=t.context_id
  WHERE x.project_id=$1 AND NOT x.archived AND t.revision=(SELECT max(revision) FROM ac_context_templates WHERE context_id=t.context_id) AND (t.snapshot->>'qualityRevision')::int<>$2`,[projectId,qualityNow])).rows;
 for(const row of stale)await new Templates(ledger).publish(String(row.published_by),String(row.context_id),Number(row.revision),{...row.snapshot,qualityRevision:qualityNow}).catch(()=>{});
}
