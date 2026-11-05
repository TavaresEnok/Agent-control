import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {digest} from '../../src/contracts.ts';
import {redactPortableJson} from '../../src/portable-export-v2.ts';
import type {HappierBoundary} from '../../src/happier.ts';
import {keyFingerprint} from '../../src/context-keys.ts';

/** Offline synthetic Paseo-shaped source; no installed Paseo/service is read. */
export async function historicalBundle(projectId:string,sessionId:string,key:Uint8Array,boundary:HappierBoundary){
 const source=JSON.parse(await readFile(new URL('./import-v2/paseo-offline.json',import.meta.url),'utf8'));
 const snapshotDigest=digest(source),provenance=(object:unknown)=>({sourceSystem:'paseo',sourceFormat:'paseo-historical-v1',sourceSnapshotDigest:snapshotDigest,sourceObjectDigest:digest(object),sourceVersionDigest:digest(source.sourceVersion),capturedAt:source.capturedAt});
 const plans=source.plans.map((plan:any)=>{const payload=redactPortableJson(plan);return {id:digest(plan.id),revision:plan.revision,format:'structured-plan-v1',sourceReportedState:'completed',runIdDigests:source.runs.map((run:any)=>digest(run.id)),provenance:provenance(plan),payload,payloadDigest:digest(payload),
  contract:{objectiveRefDigest:digest(plan.objectiveRef),sourceMessageRefDigest:digest(plan.sourceMessageRef),constraintRefDigests:plan.constraintRefs.map(digest),parallelism:plan.parallelism,
   tasks:plan.tasks.map((task:any)=>({idDigest:digest(task.id),dependsOn:task.dependsOn.map(digest),objectiveRefDigest:digest(task.objectiveRef),inputRefDigests:task.inputRefs.map(digest),outputRefDigests:task.outputRefs.map(digest),acceptanceRefDigests:task.acceptanceRefs.map(digest),writePathDigests:task.writePaths.map(digest),targetRefDigest:digest(task.targetRef),qualityRevision:task.qualityRevision,maxCorrections:task.maxCorrections,requiresSpecialist:task.requiresSpecialist})),
   graph:{nodes:plan.graph.nodes.map((node:any)=>({idDigest:digest(node.id),type:node.type,inputPortDigests:node.inputs.map(digest),outputPortDigests:node.outputs.map(digest)})),edges:plan.graph.edges.map((edge:any)=>({from:{nodeIdDigest:digest(edge.from.node),portDigest:digest(edge.from.port)},to:{nodeIdDigest:digest(edge.to.node),portDigest:digest(edge.to.port)}}))}}};});
 const evidence=source.evidence.map((item:any)=>{const payload=redactPortableJson(item);return {id:digest(item.id),revision:item.revision,planRef:{id:digest(item.plan),revision:item.planRevision},runIdDigest:digest(item.run),kind:item.kind,sourceReportedStatus:item.status,provenance:provenance(item),payload,payloadDigest:digest(payload)};});
 const text='Synthetic historical conversation, kept encrypted.';
 return {schemaVersion:2 as const,importId:randomUUID(),projectId,sourceNamespace:'offline-paseo-'+randomUUID(),contexts:[{id:'context-original-1',sessionId,sourcePaused:false,keyVariant:'legacy' as const,keyFingerprint:keyFingerprint(key),
  messages:[{id:'message-original-1',ciphertext:boundary.encodeBase64(boundary.encrypt(key,'legacy',{role:'user',content:{type:'text',text}}))}],
  runs:source.runs.map((run:any)=>({id:run.id,state:run.state,artifactRefDigest:digest(run.artifactRef)})),history:{redaction:'explicit_digest_tokens_v1',plans,evidence}}]};
}
