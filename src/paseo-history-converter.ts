import {z} from 'zod';
import {digest,Refusal} from './contracts.ts';
import {HistoricalSnapshot} from './import-history.ts';
import {redactPortableJson} from './portable-export-v2.ts';

const Text=z.string().min(1).max(4096),Refs=z.array(Text).max(256);
const State=z.enum(['completed','failed','paused','unknown']);
const Task=z.object({id:Text,dependsOn:Refs,objectiveRef:Text,inputRefs:Refs,outputRefs:Refs.min(1),acceptanceRefs:Refs.min(1),writePaths:Refs.min(1),targetRef:Text,qualityRevision:z.number().int().positive(),maxCorrections:z.number().int().min(0).max(5),requiresSpecialist:z.boolean()}).strict();
const Endpoint=z.object({node:Text,port:Text.nullable()}).strict();
const Graph=z.object({nodes:z.array(z.object({id:Text,type:z.enum(['start','end','agent','fork','join','gate','other']),inputs:Refs,outputs:Refs}).strict()).min(1).max(1024),edges:z.array(z.object({from:Endpoint,to:Endpoint}).strict()).max(4096)}).strict();
/** Explicit offline interchange contract, not an installed Paseo database reader.
 * Extra historical fields survive only in the digest-token payload. Unknown
 * versions are refused rather than guessed; no source assertion grants authority. */
export const PaseoOfflineHistory=z.object({sourceSystem:z.literal('paseo'),sourceVersion:z.literal('offline-archive-fixture-v1'),capturedAt:z.iso.datetime({offset:true}),
 plans:z.array(z.object({id:Text,revision:z.number().int().positive(),objectiveRef:Text,sourceMessageRef:Text,constraintRefs:Refs,parallelism:z.number().int().min(1).max(10),tasks:z.array(Task).min(1).max(256),graph:Graph.optional(),state:State.optional(),runIds:Refs.optional()}).passthrough()).max(2000),
 evidence:z.array(z.object({id:Text,revision:z.number().int().positive(),plan:Text,planRevision:z.number().int().positive(),run:Text,kind:z.enum(['qa','review','judge','test','other']),status:z.enum(['passed','failed','canceled','missing_result','stale','unknown'])}).passthrough()).max(4000),
 runs:z.array(z.object({id:Text,state:State,artifactRef:Text.optional()}).passthrough()).max(10000)}).strict();

export function convertPaseoOfflineHistory(raw:unknown){
 let bytes:string;try{bytes=JSON.stringify(raw);}catch{throw new Refusal('PASEO_OFFLINE_INVALID',400);}
 if(typeof bytes!=='string'||Buffer.byteLength(bytes)>16*1024*1024)throw new Refusal('PASEO_OFFLINE_SIZE_LIMIT',400);
 const source=PaseoOfflineHistory.parse(raw),snapshotDigest=digest(raw);
 if(new Set(source.runs.map(r=>r.id)).size!==source.runs.length)throw new Refusal('PASEO_OFFLINE_DUPLICATE_RUN',400);
 const runIds=new Set(source.runs.map(r=>r.id));
 const provenance=(object:unknown)=>({sourceSystem:'paseo' as const,sourceFormat:'paseo-historical-v1' as const,sourceSnapshotDigest:snapshotDigest,sourceObjectDigest:digest(object),sourceVersionDigest:digest(source.sourceVersion),capturedAt:source.capturedAt});
 const plans=source.plans.map((plan,index)=>{
  // A global run list is ambiguous once more than one plan is present.
  const linked=plan.runIds??(source.plans.length===1?source.runs.map(r=>r.id):undefined);
  if(!linked||linked.some(id=>!runIds.has(id)))throw new Refusal('PASEO_OFFLINE_RUN_BINDING_REQUIRED',400);
  const payload=redactPortableJson((raw as z.infer<typeof PaseoOfflineHistory>).plans[index]);
  return {id:digest(plan.id),revision:plan.revision,format:'structured-plan-v1' as const,sourceReportedState:plan.state??'unknown',runIdDigests:linked.map(digest),provenance:provenance((raw as z.infer<typeof PaseoOfflineHistory>).plans[index]),payload,payloadDigest:digest(payload),
   contract:{objectiveRefDigest:digest(plan.objectiveRef),sourceMessageRefDigest:digest(plan.sourceMessageRef),constraintRefDigests:plan.constraintRefs.map(digest),parallelism:plan.parallelism,
    tasks:plan.tasks.map(t=>({idDigest:digest(t.id),dependsOn:t.dependsOn.map(digest),objectiveRefDigest:digest(t.objectiveRef),inputRefDigests:t.inputRefs.map(digest),outputRefDigests:t.outputRefs.map(digest),acceptanceRefDigests:t.acceptanceRefs.map(digest),writePathDigests:t.writePaths.map(digest),targetRefDigest:digest(t.targetRef),qualityRevision:t.qualityRevision,maxCorrections:t.maxCorrections,requiresSpecialist:t.requiresSpecialist})),
    ...(plan.graph?{graph:{nodes:plan.graph.nodes.map(n=>({idDigest:digest(n.id),type:n.type,inputPortDigests:n.inputs.map(digest),outputPortDigests:n.outputs.map(digest)})),edges:plan.graph.edges.map(e=>({from:{nodeIdDigest:digest(e.from.node),portDigest:e.from.port===null?null:digest(e.from.port)},to:{nodeIdDigest:digest(e.to.node),portDigest:e.to.port===null?null:digest(e.to.port)}}))}}:{})}};
 });
 const evidence=source.evidence.map((e,index)=>{const original=(raw as z.infer<typeof PaseoOfflineHistory>).evidence[index],payload=redactPortableJson(original);return {id:digest(e.id),revision:e.revision,planRef:{id:digest(e.plan),revision:e.planRevision},runIdDigest:digest(e.run),kind:e.kind,sourceReportedStatus:e.status,provenance:provenance(original),payload,payloadDigest:digest(payload)};});
 const history=HistoricalSnapshot.parse({redaction:'explicit_digest_tokens_v1',plans,evidence});
 return {history,runs:source.runs.map(r=>({id:r.id,state:r.state,...(r.artifactRef?{artifactRefDigest:digest(r.artifactRef)}:{})})),sourceSnapshotDigest:snapshotDigest,sourceClaimsVerified:false as const,executable:false as const};
}
