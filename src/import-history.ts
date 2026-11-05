import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {digest,Id,Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';

export const IMPORT_HISTORY_RECORD_BYTES=256*1024,IMPORT_HISTORY_MAX_RECORDS=10000;
const Hash=z.string().regex(/^[a-f0-9]{64}$/),Refs=z.array(Hash).max(256).refine(rows=>new Set(rows).size===rows.length,'IMPORT_HISTORY_DUPLICATE_REFERENCE');
const Provenance=z.object({sourceSystem:z.enum(['paseo','agent-control']),sourceFormat:z.enum(['paseo-historical-v1','agent-control-portable-v2','legacy-opaque-json-v1']),
 sourceSnapshotDigest:Hash,sourceObjectDigest:Hash,sourceVersionDigest:Hash,capturedAt:z.iso.datetime({offset:true})}).strict();
/** Same explicit digest-token encoding as redactPortableJson. No free strings
 * or dynamic property names are admitted; caller assertions are not redaction
 * authority and never prove the claimed pre-redaction source digest. */
function validPayload(value:unknown){
 const pending=[{value,depth:0}];let nodes=0;
 while(pending.length){const next=pending.pop()!;if(++nodes>10000||next.depth>64)return false;
  const v=next.value;if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))continue;
  if(Array.isArray(v)){if(v.length>2048)return false;for(const item of v)pending.push({value:item,depth:next.depth+1});continue;}
  if(!v||typeof v!=='object')return false;const row=v as Record<string,unknown>,keys=Object.keys(row).sort();
  if(keys.join(',')==='redacted,sourceDigest'){if(row.redacted!==true||!Hash.safeParse(row.sourceDigest).success)return false;continue;}
  if(keys.length!==1||keys[0]!=='entries'||!Array.isArray(row.entries)||row.entries.length>2048)return false;
  const seen=new Set<string>();for(const entry of row.entries){if(!entry||typeof entry!=='object'||Array.isArray(entry))return false;const e=entry as Record<string,unknown>;if(Object.keys(e).sort().join(',')!=='keyDigest,value'||!Hash.safeParse(e.keyDigest).success||seen.has(String(e.keyDigest)))return false;seen.add(String(e.keyDigest));pending.push({value:e.value,depth:next.depth+1});}
 }
 return true;
}
const Payload=z.unknown().superRefine((value,c)=>{if(!validPayload(value))c.addIssue({code:'custom',message:'IMPORT_HISTORY_REDACTED_STRUCTURE_REQUIRED'});});
const Task=z.object({idDigest:Hash,dependsOn:Refs,objectiveRefDigest:Hash,inputRefDigests:Refs,outputRefDigests:Refs.refine(rows=>rows.length>0,'IMPORT_HISTORY_OUTPUT_REQUIRED'),acceptanceRefDigests:Refs.refine(rows=>rows.length>0,'IMPORT_HISTORY_ACCEPTANCE_REQUIRED'),
 writePathDigests:Refs.refine(rows=>rows.length>0,'IMPORT_HISTORY_WRITE_SCOPE_REQUIRED'),targetRefDigest:Hash,qualityRevision:z.number().int().positive(),maxCorrections:z.number().int().min(0).max(5),requiresSpecialist:z.boolean()}).strict();
const Port=z.object({nodeIdDigest:Hash,portDigest:Hash.nullable()}).strict();
const Graph=z.object({nodes:z.array(z.object({idDigest:Hash,type:z.enum(['start','end','agent','fork','join','gate','other']),inputPortDigests:Refs,outputPortDigests:Refs}).strict()).min(1).max(1024),edges:z.array(z.object({from:Port,to:Port}).strict()).max(4096)}).strict();
const Contract=z.object({objectiveRefDigest:Hash,sourceMessageRefDigest:Hash,constraintRefDigests:Refs,parallelism:z.number().int().min(1).max(10),tasks:z.array(Task).min(1).max(256),graph:Graph.optional()}).strict();
const PlanBase={id:Hash,revision:z.number().int().positive(),sourceReportedState:z.enum(['completed','failed','paused','unknown']),runIdDigests:Refs,provenance:Provenance,payload:Payload,payloadDigest:Hash};
const StructuredPlan=z.object({...PlanBase,format:z.literal('structured-plan-v1'),contract:Contract}).strict();
const OpaquePlan=z.object({...PlanBase,format:z.literal('opaque-redacted-json-v1')}).strict();
export const HistoricalPlan=z.discriminatedUnion('format',[StructuredPlan,OpaquePlan]);
export const HistoricalEvidence=z.object({id:Hash,revision:z.number().int().positive(),planRef:z.object({id:Hash,revision:z.number().int().positive()}).strict(),
 runIdDigest:Hash,kind:z.enum(['qa','review','judge','test','other']),sourceReportedStatus:z.enum(['passed','failed','canceled','missing_result','stale','unknown']),
 artifact:z.object({commit:Hash.refine(v=>v.length===64).or(z.string().regex(/^[a-f0-9]{40}$/)),tree:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),base:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)}).strict().optional(),
 provenance:Provenance,payload:Payload,payloadDigest:Hash}).strict();
const key=(value:{id:string;revision:number})=>value.id+':'+value.revision;
export const HistoricalSnapshot=z.object({redaction:z.literal('explicit_digest_tokens_v1'),plans:z.array(HistoricalPlan).max(2000),evidence:z.array(HistoricalEvidence).max(4000)}).strict().superRefine((snapshot,c)=>{
 const plans=new Map<string,z.infer<typeof HistoricalPlan>>();for(const plan of snapshot.plans){if(plans.has(key(plan)))c.addIssue({code:'custom',message:'IMPORT_HISTORY_DUPLICATE_PLAN'});plans.set(key(plan),plan);
  if(plan.format==='structured-plan-v1'){
   const tasks=new Map(plan.contract.tasks.map(task=>[task.idDigest,task]));if(tasks.size!==plan.contract.tasks.length)c.addIssue({code:'custom',message:'IMPORT_HISTORY_DUPLICATE_TASK'});
   for(const task of plan.contract.tasks){if(task.dependsOn.some(id=>id===task.idDigest||!tasks.has(id))||new Set(task.dependsOn).size!==task.dependsOn.length)c.addIssue({code:'custom',message:'IMPORT_HISTORY_INVALID_TASK_REFERENCE'});}
   const pending=new Set(tasks.keys()),done=new Set<string>();for(let round=0;round<tasks.size&&pending.size;round++){const ready=[...pending].filter(id=>tasks.get(id)!.dependsOn.every(ref=>done.has(ref)));if(!ready.length)break;for(const id of ready){pending.delete(id);done.add(id);}}if(pending.size)c.addIssue({code:'custom',message:'IMPORT_HISTORY_DEPENDENCY_CYCLE'});
   const graph=plan.contract.graph;if(graph){const nodes=new Map(graph.nodes.map(node=>[node.idDigest,node]));if(nodes.size!==graph.nodes.length)c.addIssue({code:'custom',message:'IMPORT_HISTORY_DUPLICATE_NODE'});
    for(const edge of graph.edges){const from=nodes.get(edge.from.nodeIdDigest),to=nodes.get(edge.to.nodeIdDigest);if(!from||!to||edge.from.portDigest!==null&&!from.outputPortDigests.includes(edge.from.portDigest)||edge.to.portDigest!==null&&!to.inputPortDigests.includes(edge.to.portDigest))c.addIssue({code:'custom',message:'IMPORT_HISTORY_INVALID_GRAPH_REFERENCE'});}
   }
  }
 }
 const evidence=new Set<string>();for(const row of snapshot.evidence){if(evidence.has(key(row)))c.addIssue({code:'custom',message:'IMPORT_HISTORY_DUPLICATE_EVIDENCE'});evidence.add(key(row));const plan=plans.get(key(row.planRef));if(!plan)c.addIssue({code:'custom',message:'IMPORT_HISTORY_PLAN_REFERENCE_REQUIRED'});else if(!plan.runIdDigests.includes(row.runIdDigest))c.addIssue({code:'custom',message:'IMPORT_HISTORY_EVIDENCE_RUN_MISMATCH'});}
 for(const row of [...snapshot.plans,...snapshot.evidence]){
  if(!validPayload(row.payload))continue;
  if(digest(row.payload)!==row.payloadDigest)c.addIssue({code:'custom',message:'IMPORT_HISTORY_PAYLOAD_DIGEST_MISMATCH'});
  if((!('format' in row)||row.format!=='opaque-redacted-json-v1')&&(!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload)||!Array.isArray((row.payload as any).entries)||(row.payload as any).entries.length===0))c.addIssue({code:'custom',message:'IMPORT_HISTORY_FULL_SOURCE_REQUIRED'});
  if(Buffer.byteLength(JSON.stringify(row))>IMPORT_HISTORY_RECORD_BYTES)c.addIssue({code:'custom',message:'IMPORT_HISTORY_RECORD_TOO_LARGE'});
 }
});
export type HistoricalSnapshot=z.infer<typeof HistoricalSnapshot>;
export function checkHistoricalRuns(history:HistoricalSnapshot,runs:{id:string}[],c:z.RefinementCtx){const ids=new Set(runs.map(run=>digest(run.id)));for(const plan of history.plans)if(plan.runIdDigests.some(id=>!ids.has(id)))c.addIssue({code:'custom',message:'IMPORT_HISTORY_RUN_REFERENCE_REQUIRED'});for(const evidence of history.evidence)if(!ids.has(evidence.runIdDigest))c.addIssue({code:'custom',message:'IMPORT_HISTORY_RUN_REFERENCE_REQUIRED'});}
const ImportedRun=z.object({id:Hash,sourceReportedState:z.enum(['completed','failed','paused','unknown']),artifactRefDigest:Hash.nullable(),importedRecordDigest:Hash}).strict();
export async function stageHistoricalRecords(c:pg.PoolClient,entry:string,position:number,context:unknown,history:HistoricalSnapshot,runs:{id:string;state:'completed'|'failed'|'paused'|'unknown';artifactRefDigest?:string}[]){
 await c.query('INSERT INTO ac_imported_history_contexts(entry_id,source_position,context_digest,history_digest) VALUES($1,$2,$3,$4)',[entry,position,digest(context),digest(history)]);
 for(const [recordPosition,row] of [...runs.map(run=>({kind:'run',record:ImportedRun.parse({id:digest(run.id),sourceReportedState:run.state,artifactRefDigest:run.artifactRefDigest??null,importedRecordDigest:digest(run)})})),...history.plans.map(record=>({kind:'plan',record})),...history.evidence.map(record=>({kind:'evidence',record}))].entries())await c.query('INSERT INTO ac_imported_history_records(entry_id,position,kind,external_id,revision,record,record_digest) VALUES($1,$2,$3,$4,$5,$6,$7)',[entry,recordPosition,row.kind,row.record.id,'revision' in row.record?row.record.revision:1,row.record,digest(row.record)]);
}
const Cursor=z.object({importId:Id,mac:Hash,offset:z.number().int().min(0).max(IMPORT_HISTORY_MAX_RECORDS)}).strict();
/** Owner-only complete archive projection. Source claims remain untrusted;
 * hashes of the stored redacted payload are independently checked locally. */
export class ImportedHistory{
 constructor(readonly ledger:Ledger){}
 async page(principal:string,projectId:string,importId:string,rawCursor?:string,limit=20){Id.parse(projectId);Id.parse(importId);z.number().int().min(1).max(100).parse(limit);
  return this.ledger.tx(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='5000ms'");
   const batch=(await c.query(`SELECT b.*,k.cursor_key FROM ac_import_batches b LEFT JOIN ac_import_v2_batches k ON k.batch_id=b.id JOIN ac_memberships m ON m.project_id=b.project_id WHERE b.id=$1 AND b.project_id=$2 AND b.principal_id=$3 AND m.principal_id=$3 AND m.role='owner'`,[importId,projectId,principal])).rows[0];if(!batch)throw new Refusal('IMPORT_FORBIDDEN',403);
   const mac=(offset:number)=>createHmac('sha256',batch.cursor_key).update(JSON.stringify({importId,inputDigest:batch.input_digest,projectId,principal,offset})).digest('hex');
   let offset=0;if(rawCursor){if(rawCursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(rawCursor)||!Buffer.isBuffer(batch.cursor_key))throw new Refusal('IMPORT_HISTORY_CURSOR_INVALID',400);let cursor:z.infer<typeof Cursor>;try{cursor=Cursor.parse(JSON.parse(Buffer.from(rawCursor,'base64url').toString('utf8')));}catch{throw new Refusal('IMPORT_HISTORY_CURSOR_INVALID',400);}if(cursor.importId!==importId||!timingSafeEqual(Buffer.from(cursor.mac,'hex'),Buffer.from(mac(cursor.offset),'hex')))throw new Refusal('IMPORT_HISTORY_CURSOR_INVALID',400);offset=cursor.offset;}

   const rows=(await c.query(`WITH entries AS (
    SELECT e.id,e.external_context_id,e.context_id,h.source_position FROM ac_import_entries e JOIN ac_imported_history_contexts h ON h.entry_id=e.id WHERE e.batch_id=$1
    UNION ALL SELECT e.id,e.external_context_id,e.context_id,a.position FROM ac_import_v2_entry_aliases a JOIN ac_import_entries e ON e.id=a.entry_id WHERE a.batch_id=$1
   ) SELECT e.*,r.position,r.kind,r.record,r.record_digest,count(*) OVER()::int total FROM entries e JOIN ac_imported_history_records r ON r.entry_id=e.id ORDER BY e.source_position,e.id,r.position LIMIT $2 OFFSET $3`,[importId,limit+1,offset])).rows;
   const output:unknown[]=[];let bytes=0;for(const row of rows.slice(0,limit)){if(digest(row.record)!==row.record_digest)throw new Refusal('IMPORT_HISTORY_CORRUPT');const checked=row.kind==='plan'?HistoricalPlan.parse(row.record):row.kind==='evidence'?HistoricalEvidence.parse(row.record):ImportedRun.parse(row.record);if('payload' in checked&&(!validPayload(checked.payload)||digest(checked.payload)!==checked.payloadDigest))throw new Refusal('IMPORT_HISTORY_CORRUPT');
    const item={sourceContextId:row.external_context_id,contextId:row.context_id,kind:row.kind,record:checked,recordDigest:row.record_digest,trust:'historical_untrusted' as const,executable:false as const};const size=Buffer.byteLength(JSON.stringify(item));if(output.length&&bytes+size>512*1024-8192)break;bytes+=size;output.push(item);}
   const total=rows[0]?.total??offset,next=offset+output.length,hasMore=next<total;const envelope={schemaVersion:2 as const,kind:'agent_control_imported_history_page_v2' as const,importId,projectId,state:batch.state,
    historicalOnly:true as const,executable:false as const,sourceClaimsVerified:false as const,payloadIntegrityVerified:true as const,records:output,total,offset,nextCursor:hasMore?Buffer.from(JSON.stringify({importId,mac:mac(next),offset:next})).toString('base64url'):null};return {...envelope,digest:digest(envelope)};
  });
 }
}
