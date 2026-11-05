import {createHash} from 'node:crypto';
import {PortableExportV2,portableSections} from './portable-export-v2.ts';
import {canonical,digest,Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
/** Reassemble byte fragments (including oversized individual records), checking
 * all page/chunk/section digests. The durable temporary cut is released on exit. */
export async function collectPortableMetadata(ledger:Ledger,principal:string,projectId:string,contextId:string){
 const service=new PortableExportV2(ledger),buffers=new Map<string,Buffer[]>();let cursor:string|undefined,exportId:string|undefined;
 let manifest:Awaited<ReturnType<PortableExportV2['page']>>['manifest']|undefined,createdAt:string|undefined;
 try{
  for(let index=0;index<220;index++){
   const page=await service.page(principal,projectId,contextId,cursor),{digest:pageDigest,...pageEnvelope}=page;
   if(digest(pageEnvelope)!==pageDigest||page.projectId!==projectId||page.contextId!==contextId)throw new Refusal('PORTABLE_EXPORT_CORRUPT');
   if(exportId&&page.exportId!==exportId)throw new Refusal('PORTABLE_EXPORT_CORRUPT');
   if(manifest&&canonical(manifest)!==canonical(page.manifest))throw new Refusal('PORTABLE_EXPORT_CORRUPT');
   exportId=page.exportId;manifest=page.manifest;createdAt=page.createdAt;
   const bytes=Buffer.from(page.data,'base64'),chunks=buffers.get(page.section)??[];
   if(sha(bytes)!==page.chunkDigest||page.offset!==chunks.reduce((sum,b)=>sum+b.length,0))throw new Refusal('PORTABLE_EXPORT_CORRUPT');
   chunks.push(bytes);buffers.set(page.section,chunks);
   if(page.nextCursor){cursor=page.nextCursor;continue;}
   const sections=Object.fromEntries(portableSections.map(section=>{
    const entry=manifest!.find(item=>item.section===section),data=Buffer.concat(buffers.get(section)??[]);
    if(!entry||data.length!==entry.bytes||sha(data)!==entry.digest)throw new Refusal('PORTABLE_EXPORT_CORRUPT');
    const records=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
    if(!Array.isArray(records)||records.length!==entry.records)throw new Refusal('PORTABLE_EXPORT_CORRUPT');return [section,records];
   }));
   const envelope={schemaVersion:2 as const,kind:'agent_control_portable_metadata_v2' as const,projectId,contextId,createdAt,restorable:false as const,conversationIncluded:false as const,
    redaction:'explicit_digest_tokens_v1' as const,sections,manifest,truncated:false as const};
   return {...envelope,digest:digest(envelope)};
  }
  throw new Refusal('PORTABLE_EXPORT_PAGE_LIMIT');
 }finally{if(exportId)await service.release(principal,projectId,contextId,exportId).catch(()=>{});}
}
