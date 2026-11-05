import {open,realpath,stat,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,isAbsolute,resolve,sep} from 'node:path';
import {z} from 'zod';
import {Id,Refusal,digest,canonical} from './contracts.ts';
import {readPrivateFile,type Installation} from './installation.ts';
import {collectPortableMetadata} from './portable-export-collect.ts';
import type {Ledger} from './ledger.ts';
const Descriptor=z.object({contextId:Id,tokenFile:z.string().min(1),outputFile:z.string().min(1)}).strict();
const Envelope=z.object({t:z.literal('encrypted'),c:z.string().min(1).max(1024*1024).regex(/^[A-Za-z0-9+/=_-]+$/)}).strict();
const Page=z.object({messages:z.array(z.object({seq:z.number().int().positive(),localId:z.string().max(200).nullable().optional(),content:z.unknown()}).passthrough()).max(150),
 hasMore:z.boolean(),nextBeforeSeq:z.number().int().positive().nullable()}).passthrough();
const MAX_BYTES=32*1024*1024,MAX_MESSAGES=10000;
async function jsonResponse(response:Response){
 if(!response.ok)throw new Refusal('CONTEXT_EXPORT_SOURCE_UNAVAILABLE');
 const reader=response.body?.getReader();if(!reader)throw new Refusal('CONTEXT_EXPORT_INVALID_RESPONSE');
 const chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;
  if(total>MAX_BYTES){await reader.cancel();throw new Refusal('CONTEXT_EXPORT_TOO_LARGE');}chunks.push(item.value);}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 }finally{reader.releaseLock();}
}
/** Read-only canonical conversation export. No decryption, CLI inference, import or execution. */
export async function exportContext(config:Installation,ledger:Ledger,descriptorPath:string){
 const repos=[config.project.repo,...config.projects.map(p=>p.repo),...(await ledger.pool.query('SELECT repo FROM ac_project_repositories')).rows.map(r=>String(r.repo))];
 const validatePath=async(path:string,exists=true)=>{
  if(!isAbsolute(path)||resolve(path)!==path||repos.some(repo=>path===repo||path.startsWith(repo+sep)))throw new Refusal('UNSAFE_PRIVATE_FILE',403);
  if(await realpath(exists?path:dirname(path))!==(exists?path:dirname(path)))throw new Refusal('UNSAFE_PRIVATE_FILE',403);
 };
 await validatePath(descriptorPath);const bytes=await readPrivateFile(descriptorPath,4096);let tokenBytes:Buffer|undefined;
 try{
  const descriptor=Descriptor.parse(JSON.parse(bytes.toString('utf8')));
  await validatePath(descriptor.tokenFile);await validatePath(descriptor.outputFile,false);
  const parent=await stat(dirname(descriptor.outputFile));
  if(!parent.isDirectory()||(parent.mode&0o077)!==0||parent.uid!==process.getuid?.())throw new Refusal('UNSAFE_PRIVATE_DIRECTORY',403);
  const authorize=async()=>{
   const row=(await ledger.pool.query(`SELECT s.session_id FROM ac_contexts x JOIN ac_memberships m ON m.project_id=x.project_id
    JOIN ac_session_links s ON s.context_id=x.id WHERE x.id=$1 AND x.project_id=$2 AND m.principal_id=$3 AND m.role='owner'
    AND s.principal_id=$3 AND NOT x.archived`,[descriptor.contextId,config.project.id,config.project.owner])).rows[0];
   if(!row)throw new Refusal('CONTEXT_EXPORT_FORBIDDEN',403);return String(row.session_id);
  };
  const sessionId=await authorize();tokenBytes=await readPrivateFile(descriptor.tokenFile,16384);
  const token=tokenBytes.toString('utf8').trim();if(!token||/[\s\x00-\x1f\x7f]/.test(token))throw new Refusal('IMPORT_TOKEN_INVALID',400);
  const request=async(path:string)=>jsonResponse(await fetch(new URL(path,config.happier.upstreamOrigin),{
   headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)}));
  const profile=z.object({id:z.string()}).passthrough().parse(await request('/v1/account/profile'));
  if(profile.id!==config.project.owner)throw new Refusal('CONTEXT_EXPORT_FORBIDDEN',403);
  const session=z.object({session:z.object({id:z.string()}).passthrough()}).passthrough().parse(await request('/v2/sessions/'+encodeURIComponent(sessionId)));
  if(session.session.id!==sessionId)throw new Refusal('CONTEXT_EXPORT_FORBIDDEN',403);
  const metadata=await collectPortableMetadata(ledger,config.project.owner,config.project.id,descriptor.contextId);
  const messages:{seq:number;localId:string|null;ciphertext:string}[]=[];let before:number|undefined,head:number|null=null,total=0,finished=false;
  for(let i=0;i<100;i++){
   if(await authorize()!==sessionId)throw new Refusal('SESSION_CONTEXT_MISMATCH',403);
   const page=Page.parse(await request(`/v1/sessions/${encodeURIComponent(sessionId)}/messages?scope=main&limit=150${before===undefined?'':`&beforeSeq=${before}`}`));
   let previous=before??Infinity;
   for(const message of page.messages){
    if(message.seq>=previous)throw new Refusal('HISTORY_ORDER_INVALID');previous=message.seq;
    const envelope=Envelope.parse(typeof message.content==='string'?JSON.parse(message.content):message.content);
    if(head===null)head=message.seq;
    total+=Buffer.byteLength(envelope.c);if(total>MAX_BYTES||messages.length>=MAX_MESSAGES)throw new Refusal('CONTEXT_EXPORT_TOO_LARGE');
    messages.push({seq:message.seq,localId:message.localId??null,ciphertext:envelope.c});
   }
   if(!page.hasMore){if(page.nextBeforeSeq!==null)throw new Refusal('HISTORY_CURSOR_INVALID');finished=true;break;}
   if(!page.messages.length||page.nextBeforeSeq!==previous)throw new Refusal('HISTORY_CURSOR_INVALID');before=page.nextBeforeSeq;
  }
  if(!finished)throw new Refusal('HISTORY_PAGE_LIMIT_EXCEEDED');
  if(await authorize()!==sessionId)throw new Refusal('SESSION_CONTEXT_MISMATCH',403);
  const envelope={schemaVersion:2,kind:'agent_control_context_export_v2',projectId:config.project.id,contextId:descriptor.contextId,sessionId,
   canonicalHistory:'happier',encrypted:true,keysIncluded:false,restorable:false,headSequence:head,metadata,messages:messages.reverse()};
  const serialized=Buffer.from(canonical({...envelope,digest:digest(envelope)}));
  if(serialized.length>MAX_BYTES)throw new Refusal('CONTEXT_EXPORT_TOO_LARGE');
  const file=await open(descriptor.outputFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let complete=false;
  try{await file.writeFile(serialized);await file.sync();complete=true;}finally{await file.close();if(!complete)await unlink(descriptor.outputFile).catch(()=>{});}
  return {state:'exported',contextId:descriptor.contextId,messageCount:messages.length,metadataTruncated:metadata.truncated,keysIncluded:false,restorable:false};
 }finally{bytes.fill(0);tokenBytes?.fill(0);}
}
