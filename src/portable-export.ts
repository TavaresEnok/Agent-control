import {z} from 'zod';
import {Id,digest,Refusal} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {CapacityPolicy} from './capacity.ts';
import {QualityPolicy} from './quality-policy.ts';

const PER_SECTION=100,MAX_BYTES=256*1024;
const Hash=z.string().regex(/^[a-f0-9]{64}$/),GitId=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const TaskId=z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const Task=z.object({id:TaskId,dependsOn:z.array(TaskId).max(63),qualityRevision:z.number().int().positive(),maxCorrections:z.number().int().min(0).max(5)}).strict();
const names=['managerPlans','frozenPlans','capacityPolicies','qualityPolicies','artifacts','verification','waivers','integration','approvals','audit'] as const;
type Section=typeof names[number];
type Row=Record<string,unknown>;
const toTime=(v:unknown)=>{if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw new Refusal('PORTABLE_EXPORT_CORRUPT');return v.toISOString();};
const stringId=(v:unknown)=>Id.parse(v);
const integer=(v:unknown)=>z.number().int().nonnegative().parse(v);
const decimal=(v:unknown)=>z.string().regex(/^\d+$/).parse(v);
const identifier=(v:unknown)=>Hash.parse(v);

/** Bounded, redacted context metadata. This is not a conversation export,
 * restorable backup, or a declaration of complete product portability. */
export class PortableExport{
 constructor(readonly ledger:Ledger){}
 async export(principal:string,projectId:string,contextId:string){
  Id.parse(projectId);Id.parse(contextId);
  return this.ledger.tx(async c=>{
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await c.query("SET LOCAL statement_timeout = '5000ms'");
   if(!(await c.query(`SELECT 1 FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id
     WHERE x.id=$1 AND x.project_id=$2 AND m.principal_id=$3 AND m.role='owner'`,[contextId,projectId,principal])).rowCount)
    throw new Refusal('PORTABLE_EXPORT_FORBIDDEN',403);
   const queries:Record<Section,{sql:string;params:unknown[];map:(r:Row)=>unknown}>={
    managerPlans:{params:[contextId],sql:`SELECT revision,parent_revision,digest,compilation_digest,created_at,count(*) OVER()::text total,
     (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',left(t.value->>'id',48),'dependsOn',
       (SELECT COALESCE(jsonb_agg(left(d.value,48)),'[]'::jsonb) FROM
        (SELECT value FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.value->'dependsOn')='array' THEN t.value->'dependsOn' ELSE '[]'::jsonb END) LIMIT 63) d),
       'qualityRevision',t.value->'qualityRevision','maxCorrections',t.value->'maxCorrections')),'[]'::jsonb)
      FROM (SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.snapshot->'tasks')='array' THEN p.snapshot->'tasks' ELSE '[]'::jsonb END) LIMIT 64) t) tasks
     FROM ac_manager_plans p WHERE context_id=$1 ORDER BY revision LIMIT 101`,map:r=>({revision:integer(r.revision),parentRevision:r.parent_revision===null?null:integer(r.parent_revision),
      digest:identifier(r.digest),compilationDigest:identifier(r.compilation_digest),createdAt:toTime(r.created_at),tasks:z.array(Task).max(64).parse(r.tasks)})},
    frozenPlans:{params:[contextId],sql:'SELECT revision,intent_id,digest,count(*) OVER()::text total FROM ac_frozen_plans WHERE context_id=$1 ORDER BY revision LIMIT 101',
     map:r=>({revision:integer(r.revision),intentId:stringId(r.intent_id),digest:identifier(r.digest)})},
    capacityPolicies:{params:[projectId],sql:'SELECT revision,digest,snapshot,count(*) OVER()::text total FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision LIMIT 101',
     map:r=>{const p=CapacityPolicy.parse(r.snapshot);if(digest(p)!==identifier(r.digest))throw new Refusal('PORTABLE_EXPORT_CORRUPT');
      return {revision:integer(r.revision),digest:r.digest,maxProgrammersPerContext:p.maxProgrammersPerContext,maxEvaluatorsPerContext:p.maxEvaluatorsPerContext,configuredRoles:Object.keys(p.roles).sort()};}},
    qualityPolicies:{params:[projectId],sql:'SELECT revision,digest,snapshot,count(*) OVER()::text total FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision LIMIT 101',
     map:r=>{const p=QualityPolicy.parse(r.snapshot);if(digest(p)!==identifier(r.digest))throw new Refusal('PORTABLE_EXPORT_CORRUPT');return {revision:integer(r.revision),digest:r.digest,policy:p};}},
    artifacts:{params:[contextId,projectId],sql:`SELECT id,intent_id,policy_revision,commit_id,tree_id,base_id,identity_digest,risk,count(*) OVER()::text total
     FROM ac_artifacts WHERE context_id=$1 AND project_id=$2 ORDER BY id LIMIT 101`,map:r=>({id:stringId(r.id),intentId:stringId(r.intent_id),policyRevision:integer(r.policy_revision),
      commit:GitId.parse(r.commit_id),tree:GitId.parse(r.tree_id),base:GitId.parse(r.base_id),identityDigest:identifier(r.identity_digest),risk:z.enum(['low','medium','high']).parse(r.risk)})},
    verification:{params:[contextId,projectId],sql:`SELECT v.id,v.artifact_id,v.kind,v.policy_revision,v.status,v.receipt_digest,v.created_at,count(*) OVER()::text total
     FROM ac_verification_evidence v JOIN ac_artifacts a ON a.id=v.artifact_id WHERE a.context_id=$1 AND a.project_id=$2 ORDER BY v.created_at,v.id LIMIT 101`,
     map:r=>({id:stringId(r.id),artifactId:stringId(r.artifact_id),kind:z.enum(['qa','review','judge']).parse(r.kind),policyRevision:integer(r.policy_revision),
      status:z.enum(['passed','failed','canceled','missing_result','stale']).parse(r.status),receiptDigest:identifier(r.receipt_digest),createdAt:toTime(r.created_at)})},
    waivers:{params:[contextId,projectId],sql:`SELECT w.artifact_id,w.created_at,count(*) OVER()::text total FROM ac_qa_waivers w JOIN ac_artifacts a ON a.id=w.artifact_id
     WHERE a.context_id=$1 AND a.project_id=$2 ORDER BY w.created_at,w.artifact_id LIMIT 101`,map:r=>({artifactId:stringId(r.artifact_id),createdAt:toTime(r.created_at)})},
    integration:{params:[contextId,projectId],sql:`SELECT t.id,t.artifact_id,t.state,t.target_ref,t.created_at,count(*) OVER()::text total FROM ac_integration_intents t
     JOIN ac_artifacts a ON a.id=t.artifact_id WHERE t.context_id=$1 AND a.context_id=$1 AND a.project_id=$2 ORDER BY t.created_at,t.id LIMIT 101`,
     map:r=>({id:stringId(r.id),artifactId:stringId(r.artifact_id),state:z.enum(['registered','uncertain','integrated','rejected']).parse(r.state),
      targetRefDigest:digest(z.string().max(240).parse(r.target_ref)),createdAt:toTime(r.created_at)})},
    approvals:{params:[contextId,projectId],sql:`SELECT p.artifact_id,p.artifact_digest,p.policy_revision,p.target_ref,p.created_at,count(*) OVER()::text total
     FROM ac_integration_approvals p JOIN ac_artifacts a ON a.id=p.artifact_id WHERE a.context_id=$1 AND a.project_id=$2 ORDER BY p.created_at,p.artifact_id LIMIT 101`,
     map:r=>({artifactId:stringId(r.artifact_id),artifactDigest:identifier(r.artifact_digest),policyRevision:integer(r.policy_revision),
      targetRefDigest:digest(z.string().max(240).parse(r.target_ref)),createdAt:toTime(r.created_at)})},
    audit:{params:[contextId],sql:`SELECT id::text,CASE WHEN kind IN ('manager.acquired','context.pause','intent.accepted','manager.plan.proposed','integration.result','integration.reconciled','qa.waived')
      THEN kind ELSE 'other' END kind,created_at,count(*) OVER()::text total FROM ac_audit WHERE context_id=$1 ORDER BY id LIMIT 101`,
     map:r=>({id:decimal(r.id),kind:z.enum(['manager.acquired','context.pause','intent.accepted','manager.plan.proposed','integration.result','integration.reconciled','qa.waived','other']).parse(r.kind),createdAt:toTime(r.created_at)})},
   };
   const sections=Object.fromEntries(names.map(name=>[name,[] as unknown[]])) as Record<Section,unknown[]>;
   const counts=Object.fromEntries(names.map(name=>[name,{total:'0',exported:0,truncated:false}])) as Record<Section,{total:string;exported:number;truncated:boolean}>;
   const rowsByName={} as Record<Section,unknown[]>;
   for(const name of names){const q=queries[name],rows=(await c.query(q.sql,q.params)).rows;
    counts[name].total=rows.length?decimal(rows[0].total):'0';counts[name].truncated=rows.length>PER_SECTION;
    rowsByName[name]=rows.slice(0,PER_SECTION).map(q.map);
   }
   const envelope={schemaVersion:1 as const,kind:'agent_control_portable_metadata_v1' as const,projectId,contextId,
    restorable:false as const,conversationIncluded:false as const,sections,counts,truncated:false};
   let full=false;
   for(const name of names)for(const row of rowsByName[name]){
    if(full){counts[name].truncated=true;continue;}
    sections[name].push(row);counts[name].exported++;
    if(Buffer.byteLength(JSON.stringify({...envelope,digest:'0'.repeat(64)}),'utf8')>MAX_BYTES){
     sections[name].pop();counts[name].exported--;counts[name].truncated=true;full=true;
    }
   }
   envelope.truncated=names.some(name=>counts[name].truncated);
   const result={...envelope,digest:digest(envelope)};
   if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_BYTES)throw new Refusal('PORTABLE_EXPORT_SIZE_EXCEEDED');
   return result;
  });
 }
}
