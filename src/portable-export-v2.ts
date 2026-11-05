import {createHmac,randomBytes,randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import type pg from 'pg';
import {z} from 'zod';
import {Id,Refusal,canonical,digest} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {CapacityPolicy} from './capacity.ts';
import {QualityPolicy} from './quality-policy.ts';
import {ManagerPlan} from './planning.ts';
import {VerificationReceipt} from './quality.ts';

const MAX_BYTES=32*1024*1024,MAX_ROWS=10000,CHUNK_BYTES=160*1024,MAX_ACTIVE=4;
export const portableSections=['managerPlans','frozenPlans','capacityPolicies','qualityPolicies','artifacts','verification','waivers','integration','approvals','audit'] as const;
type Section=typeof portableSections[number];
type Row=Record<string,any>;
const Cursor=z.object({id:Id,section:z.number().int().min(0).max(9),offset:z.number().int().min(0).max(MAX_BYTES),mac:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const redacted=(value:unknown)=>({redacted:true as const,sourceDigest:digest(value)});
/** Unknown JSON has no trusted property names: both arbitrary keys and strings
 * become digests. Shape, sequence, booleans and finite numeric values survive. */
export function redactPortableJson(value:unknown,depth=0,budget={remaining:MAX_BYTES}):unknown{
 budget.remaining-=typeof value==='string'?120:32;
 if(budget.remaining<0)throw new Refusal('PORTABLE_EXPORT_SIZE_EXCEEDED',409);
 if(depth>64)throw new Refusal('PORTABLE_EXPORT_CORRUPT');
 if(value===null||typeof value==='boolean'||typeof value==='number')return value;
 if(typeof value==='string')return redacted(value);
 if(Array.isArray(value))return value.map(item=>redactPortableJson(item,depth+1,budget));
 if(value&&typeof value==='object')return {entries:Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>{budget.remaining-=100;if(budget.remaining<0)throw new Refusal('PORTABLE_EXPORT_SIZE_EXCEEDED',409);return {keyDigest:digest(key),value:redactPortableJson(v,depth+1,budget)};})};
 throw new Refusal('PORTABLE_EXPORT_CORRUPT');
}
// Only schema-owned workflow/compilation field names remain readable. Dynamic
// map keys (layout, secret names, etc.) still use opaque key digests.
const structuralKeys=new Set(['schemaVersion','version','name','description','steps','graph','source','path','nodes','edges','id','type','from','to','status','max','branches','wait','timeoutMs','pollMs','retryOn','onFail','retry','prompt','skill','model','runner','allowedTools','bashAllowlist','command','secrets','message','question','options','title','body','issue','url','ready','addLabels','reviewers','workflow','budgetUsd','condition','kind','op','value','ref','glob','verdicts','session','continue','review','planDigest','bindings','admission','batches','nodeId','taskId','role','artifactSource','freshSession','reviewIndex','qualityRevision','maxCorrections']);
const structuralEnums=new Set(['start','end','loop','agent','check','gate.human','ask-user','dispatch','git.commit','github.draft-pr','github.wait-ci','github.pr-comment','fork','join','workflow','if','git.push','git.sync-base','github.pr-update','github.issue-comment','notify.webhook','success','failed','all','any','built-in','file','diff-lines','diff-files','paths-changed','output','branch','equals','not-equals','contains','matches','>','>=','<','<=','==','programmer','qa','reviewer','judge','integrator','managed-delivery-adapter-required']);
function definitionDto(value:unknown,key='',depth=0,budget={remaining:MAX_BYTES}):unknown{
 budget.remaining-=typeof value==='string'?120:32;
 if(budget.remaining<0)throw new Refusal('PORTABLE_EXPORT_SIZE_EXCEEDED',409);
 if(depth>64)throw new Refusal('PORTABLE_EXPORT_CORRUPT');
 if(value===null||typeof value==='boolean'||typeof value==='number')return value;
 if(typeof value==='string'){
  if(['type','status','source','kind','op','role','wait','admission'].includes(key)&&structuralEnums.has(value))return value;
  if(key==='from'||key==='ref'){budget.remaining-=120;if(budget.remaining<0)throw new Refusal('PORTABLE_EXPORT_SIZE_EXCEEDED',409);const [node,...port]=value.split('.');return {node:redacted(node),port:port.length?redacted(port.join('.')):null};}
  return redacted(value);
 }
 if(Array.isArray(value))return value.map(item=>definitionDto(item,key,depth+1,budget));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([field,item])=>{budget.remaining-=100;if(budget.remaining<0)throw new Refusal('PORTABLE_EXPORT_SIZE_EXCEEDED',409);return [structuralKeys.has(field)?field:'key_'+digest(field),definitionDto(item,field,depth+1,budget)];}));
 throw new Refusal('PORTABLE_EXPORT_CORRUPT');
}
function planDto(raw:unknown){
 const plan=ManagerPlan.parse(raw);
 return {...plan,objectiveRef:redacted(plan.objectiveRef),sourceMessageRef:redacted(plan.sourceMessageRef),constraintRefs:plan.constraintRefs.map(redacted),tasks:plan.tasks.map(task=>({...task,
  id:redacted(task.id),dependsOn:task.dependsOn.map(redacted),objectiveRef:redacted(task.objectiveRef),acceptanceRefs:task.acceptanceRefs.map(redacted),inputRefs:task.inputRefs.map(redacted),outputRefs:task.outputRefs.map(redacted),
  writePaths:task.writePaths.map(redacted),targetRef:redacted(task.targetRef)}))};
}
function verified(raw:unknown,expected:unknown){if(digest(raw)!==expected)throw new Refusal('PORTABLE_EXPORT_CORRUPT');return raw;}
const date=(value:Date)=>value.toISOString();
async function authorize(c:pg.PoolClient,principal:string,project:string,context:string){
 if(!(await c.query(`SELECT 1 FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id
  WHERE x.id=$1 AND x.project_id=$2 AND m.principal_id=$3 AND m.role='owner'`,[context,project,principal])).rowCount)throw new Refusal('PORTABLE_EXPORT_FORBIDDEN',403);
}
function queries(project:string,context:string):Record<Section,{sql:string;params:unknown[];map:(row:Row)=>unknown}>{return {
 managerPlans:{sql:'SELECT * FROM ac_manager_plans WHERE context_id=$1 ORDER BY revision',params:[context],map:r=>({revision:r.revision,parentRevision:r.parent_revision,managerEpoch:r.manager_epoch,createdAt:date(r.created_at),
  sourceDigest:r.digest,plan:planDto(verified(r.snapshot,r.digest)),compilationSourceDigest:r.compilation_digest,compilation:definitionDto(verified(r.compilation,r.compilation_digest))})},
 frozenPlans:{sql:'SELECT * FROM ac_frozen_plans WHERE context_id=$1 ORDER BY revision',params:[context],map:r=>({revision:r.revision,intentId:r.intent_id,sourceDigest:r.digest,definition:definitionDto(verified(r.snapshot,r.digest))})},
 capacityPolicies:{sql:'SELECT revision,snapshot,digest FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision',params:[project],map:r=>({revision:r.revision,sourceDigest:r.digest,policy:CapacityPolicy.parse(verified(r.snapshot,r.digest))})},
 qualityPolicies:{sql:'SELECT revision,snapshot,digest FROM ac_quality_policies WHERE project_id=$1 ORDER BY revision',params:[project],map:r=>{const policy=QualityPolicy.parse(verified(r.snapshot,r.digest));return {revision:r.revision,sourceDigest:r.digest,policy:{...policy,...(policy.protectedGatePaths?{protectedGatePaths:policy.protectedGatePaths.map(redacted)}:{})}};}},
 artifacts:{sql:'SELECT * FROM ac_artifacts WHERE context_id=$1 AND project_id=$2 ORDER BY id',params:[context,project],map:r=>({id:r.id,intentId:r.intent_id,implementationGrantId:r.implementation_grant_id,implementationSessionId:r.implementation_session_id,policyRevision:r.policy_revision,
  commit:r.commit_id,tree:r.tree_id,base:r.base_id,identityDigest:r.identity_digest,risk:r.risk})},
 verification:{sql:'SELECT v.* FROM ac_verification_evidence v JOIN ac_artifacts a ON a.id=v.artifact_id WHERE a.context_id=$1 AND a.project_id=$2 ORDER BY v.created_at,v.id',params:[context,project],map:r=>{
  verified(r.receipt,r.receipt_digest);const parsed=VerificationReceipt.safeParse(r.receipt);
  return {id:r.id,artifactId:r.artifact_id,kind:r.kind,sessionId:r.session_id,grantId:r.grant_id,policyRevision:r.policy_revision,status:r.status,createdAt:date(r.created_at),sourceDigest:r.receipt_digest,
   receipt:parsed.success?{...parsed.data,verifierVersion:redacted(parsed.data.verifierVersion)}:redactPortableJson(r.receipt),receiptFormat:parsed.success?'verification_receipt_v1':'opaque_redacted_json'};}},
 waivers:{sql:'SELECT w.* FROM ac_qa_waivers w JOIN ac_artifacts a ON a.id=w.artifact_id WHERE a.context_id=$1 AND a.project_id=$2 ORDER BY w.created_at,w.artifact_id',params:[context,project],map:r=>({artifactId:r.artifact_id,principal:redacted(r.principal_id),reasonRef:redacted(r.reason_ref),createdAt:date(r.created_at),sourceDigest:digest({...r,created_at:date(r.created_at)}),record:redactPortableJson({...r,created_at:date(r.created_at)})})},
 integration:{sql:'SELECT t.* FROM ac_integration_intents t JOIN ac_artifacts a ON a.id=t.artifact_id WHERE t.context_id=$1 AND a.context_id=$1 AND a.project_id=$2 ORDER BY t.created_at,t.id',params:[context,project],map:r=>({id:r.id,artifactId:r.artifact_id,managerEpoch:r.manager_epoch,state:r.state,targetRef:redacted(r.target_ref),receiptSourceDigest:digest(r.receipt),receipt:redactPortableJson(r.receipt),createdAt:date(r.created_at)})},
 approvals:{sql:'SELECT p.* FROM ac_integration_approvals p JOIN ac_artifacts a ON a.id=p.artifact_id WHERE a.context_id=$1 AND a.project_id=$2 ORDER BY p.created_at,p.artifact_id,p.target_ref',params:[context,project],map:r=>({artifactId:r.artifact_id,artifactDigest:r.artifact_digest,policyRevision:r.policy_revision,principal:redacted(r.principal_id),targetRef:redacted(r.target_ref),createdAt:date(r.created_at)})},
 audit:{sql:'SELECT id::text,kind,detail,created_at FROM ac_audit WHERE context_id=$1 ORDER BY id',params:[context],map:r=>({id:r.id,kind:redacted(r.kind),detail:redactPortableJson(r.detail),sourceDigest:digest(r.detail),createdAt:date(r.created_at)})},
};}
type Manifest={section:Section;bytes:number;records:number;digest:string}[];
/** Durable immutable repeatable-read cut. Every response and SQL fetch is bounded;
 * exceeding whole-export limits refuses explicitly, never returns a partial cut. */
export class PortableExportV2{
 constructor(readonly ledger:Ledger){}
 async page(principal:string,projectId:string,contextId:string,cursor?:string){
  Id.parse(projectId);Id.parse(contextId);
  let parsed:z.infer<typeof Cursor>|undefined;
  if(cursor){try{if(cursor.length>1000||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();parsed=Cursor.parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')));}catch{throw new Refusal('PORTABLE_EXPORT_CURSOR_INVALID',400);}}
  if(!parsed)await this.purgeExpired();
  const position=parsed??await this.create(principal,projectId,contextId).catch(error=>{
   if(error&&typeof error==='object'&&'code'in error&&['40001','57014','40P01'].includes(String(error.code)))throw new Refusal('PORTABLE_EXPORT_RETRY',503);
   throw error;
  });
  return this.ledger.tx(async c=>{
   await c.query("SET LOCAL statement_timeout='5s'");await authorize(c,principal,projectId,contextId);
   const row=(await c.query('SELECT *,expires_at>clock_timestamp() valid FROM ac_portable_export_snapshots WHERE id=$1 AND principal_id=$2 AND project_id=$3 AND context_id=$4',[position.id,principal,projectId,contextId])).rows[0];
   if(!row)throw new Refusal('PORTABLE_EXPORT_CURSOR_INVALID',400);
   if(!row.valid)throw new Refusal('PORTABLE_EXPORT_EXPIRED',409);
   const manifest=row.manifest as Manifest,section=manifest[position.section];
   const mac=(part:{id:string;section:number;offset:number})=>createHmac('sha256',row.cursor_key).update(canonical({principal,projectId,contextId,...part})).digest('hex');
   const payload={id:position.id,section:position.section,offset:position.offset};
   if(parsed&&!timingSafeEqual(Buffer.from(parsed.mac,'hex'),Buffer.from(mac(payload),'hex')))throw new Refusal('PORTABLE_EXPORT_CURSOR_INVALID',400);
   if(!section||position.offset>section.bytes||position.offset%CHUNK_BYTES!==0)throw new Refusal('PORTABLE_EXPORT_CURSOR_INVALID',400);
   const bytes=(await c.query('SELECT substring(payload FROM $3 FOR $4) bytes FROM ac_portable_export_sections WHERE export_id=$1 AND ordinal=$2',[position.id,position.section,position.offset+1,CHUNK_BYTES])).rows[0]?.bytes as Buffer|undefined;
   if(!bytes)throw new Refusal('PORTABLE_EXPORT_CORRUPT');
   const nextOffset=position.offset+bytes.length;
   const next=nextOffset<section.bytes?{...payload,offset:nextOffset}:position.section<portableSections.length-1?{...payload,section:position.section+1,offset:0}:null;
   const envelope={schemaVersion:2 as const,kind:'agent_control_portable_metadata_page_v2' as const,exportId:position.id,projectId,contextId,createdAt:date(row.created_at),expiresAt:date(row.expires_at),
    restorable:false as const,conversationIncluded:false as const,redaction:'explicit_digest_tokens_v1' as const,manifest,section:section.section,offset:position.offset,encoding:'base64' as const,data:bytes.toString('base64'),
    chunkDigest:sha(bytes),nextCursor:next?Buffer.from(canonical({...next,mac:mac(next)})).toString('base64url'):null};
   return {...envelope,digest:digest(envelope)};
  });
 }
 private async create(principal:string,projectId:string,contextId:string){
  return this.ledger.tx(async c=>{
   await c.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');await c.query("SET LOCAL statement_timeout='5s'");
   await authorize(c,principal,projectId,contextId);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,83))',[principal]);
   await c.query('DELETE FROM ac_portable_export_snapshots WHERE principal_id=$1 AND expires_at<=clock_timestamp()',[principal]);
   if(Number((await c.query('SELECT count(*) total FROM ac_portable_export_snapshots WHERE principal_id=$1',[principal])).rows[0].total)>=MAX_ACTIVE)throw new Refusal('PORTABLE_EXPORT_ACTIVE_LIMIT',409);
   const buffers:Buffer[]=[],manifest:Manifest=[];let total=0;
   const defs=queries(projectId,contextId);
   for(const section of portableSections){const q=defs[section];
    const size=(await c.query(`SELECT count(*)::integer records,coalesce(sum(octet_length(row_to_json(t)::text)),0)::text bytes FROM (${q.sql} LIMIT ${MAX_ROWS+1}) t`,q.params)).rows[0];
    if(size.records>MAX_ROWS||Number(size.bytes)>MAX_BYTES-total)throw new Refusal('PORTABLE_EXPORT_SIZE_EXCEEDED',409);
    const rows=(await c.query(q.sql,q.params)).rows,chunks=[Buffer.from('[')];let sectionBytes=2;
    for(const [index,row] of rows.entries()){
     const bytes=Buffer.from(canonical(q.map(row)));sectionBytes+=bytes.length+(index?1:0);
     if(total+sectionBytes>MAX_BYTES)throw new Refusal('PORTABLE_EXPORT_SIZE_EXCEEDED',409);
     if(index)chunks.push(Buffer.from(','));chunks.push(bytes);
    }
    chunks.push(Buffer.from(']'));const bytes=Buffer.concat(chunks);total+=bytes.length;
    buffers.push(bytes);manifest.push({section,bytes:bytes.length,records:rows.length,digest:sha(bytes)});
   }
   const id=randomUUID(),key=randomBytes(32);
   await c.query('INSERT INTO ac_portable_export_snapshots(id,principal_id,project_id,context_id,cursor_key,manifest) VALUES($1,$2,$3,$4,$5,$6)',[id,principal,projectId,contextId,key,JSON.stringify(manifest)]);
   for(const [ordinal,bytes] of buffers.entries())await c.query('INSERT INTO ac_portable_export_sections VALUES($1,$2,$3)',[id,ordinal,bytes]);
   return {id,section:0,offset:0};
  });
 }
 /** Bounded expiration maintenance; expired cuts are already unreadable. */
 async purgeExpired(){
  return this.ledger.tx(async c=>{await c.query("SET LOCAL statement_timeout='5s'");const result=await c.query(`DELETE FROM ac_portable_export_snapshots WHERE id IN
   (SELECT id FROM ac_portable_export_snapshots WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);return {deleted:result.rowCount};});
 }
 /** Explicit owner-scoped release also lets the CLI remove its temporary copy. */
 async release(principal:string,projectId:string,contextId:string,exportId:string){
  Id.parse(exportId);return this.ledger.tx(async c=>{await authorize(c,principal,projectId,contextId);await c.query('DELETE FROM ac_portable_export_snapshots WHERE id=$1 AND principal_id=$2 AND project_id=$3 AND context_id=$4',[exportId,principal,projectId,contextId]);return {released:true};});
 }
}
