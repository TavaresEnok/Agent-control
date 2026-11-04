import {constants} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import {isAbsolute,resolve,sep} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {planRetention,type RetentionPlan} from './retention-plan.ts';

/** Offline dry-run. Reads one supplied descriptor and prints `planRetention`.
 * The inventory and the disk figures are data in that file. Nothing is discovered,
 * attested, or deleted. */

export const RETENTION_DESCRIPTOR_MAX_BYTES=2*1024*1024;
const CLOSED=new Set(['RETENTION_COMMAND_INVALID','RETENTION_DESCRIPTOR_INVALID','RETENTION_INVENTORY_INVALID','RETENTION_POLICY_INVALID','RETENTION_DUPLICATE_ID','RETENTION_BYTES_UNSAFE','RETENTION_PLAN_INVALID']);
const Descriptor=z.object({schemaVersion:z.literal(1),inventory:z.unknown(),policy:z.unknown()}).strict();
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const leafFlags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
export type RetentionPlanCommandResult=
 |{exitCode:0|3;plan:RetentionPlan}
 |{exitCode:1;code:string};
type NodeId={dev:number;ino:number};
type Chain={directories:NodeId[];leaf:NodeId};

function invalid(code='RETENTION_DESCRIPTOR_INVALID'):never{
 throw new Refusal(code,400);
}
function closed(code:string){
 return CLOSED.has(code)?code:'RETENTION_DESCRIPTOR_INVALID';
}
function nodeId(info:{dev:number;ino:number}):NodeId{
 return {dev:info.dev,ino:info.ino};
}
function sameNode(left:NodeId,right:NodeId|undefined){
 return right!==undefined&&left.dev===right.dev&&left.ino===right.ino;
}
function privateFile(info:{isFile():boolean;nlink:number;uid:number;mode:number;size:number},uid:number){
 return info.isFile()&&info.nlink===1&&info.uid===uid&&(info.mode&0o077)===0&&info.size<=RETENTION_DESCRIPTOR_MAX_BYTES;
}

/** Next path component from an already opened directory. `O_NOFOLLOW` applies to that component. */
async function openChild(parent:FileHandle,name:string,flags:number){
 if(name.length===0||name==='.'||name==='..'||name.includes('\0')||name.includes('/'))invalid();
 try{return await open(`/proc/self/fd/${parent.fd}/${name}`,flags);}catch{invalid();}
}

/** Walk from `/` by directory fd. A symlink ancestor fails this walk and is not opened. */
async function walkChain(parts:readonly string[],uid:number,expected?:Chain):Promise<{parent:FileHandle;file:FileHandle;chain:Chain}>{
 let parent:FileHandle|undefined;
 let file:FileHandle|undefined;
 try{
  parent=await open(sep,directoryFlags);
  const directories:NodeId[]=[];
  for(let index=0;index<parts.length-1;index+=1){
   const next=await openChild(parent,parts[index]!,directoryFlags);
   let info;
   try{info=await next.stat();}catch{await next.close();invalid();}
   const id=nodeId(info);
   if(!info.isDirectory()||(expected!==undefined&&!sameNode(id,expected.directories[index]))){await next.close();invalid();}
   directories.push(id);
   await parent.close();
   parent=next;
  }
  file=await openChild(parent,parts[parts.length-1]!,leafFlags);
  let leaf;
  try{leaf=await file.stat();}catch{invalid();}
  const id=nodeId(leaf);
  if(!privateFile(leaf,uid)||(expected!==undefined&&!sameNode(id,expected.leaf)))invalid();
  const opened=file;
  file=undefined;
  const chain={directories,leaf:id};
  return {parent,file:opened,chain};
 }catch(error){
  await file?.close();
  await parent?.close();
  if(error instanceof Refusal)throw error;
  invalid();
 }
}

async function readDescriptor(descriptorPath:string):Promise<unknown>{
 if(!isAbsolute(descriptorPath)||resolve(descriptorPath)!==descriptorPath||descriptorPath.includes('\0'))invalid();
 const uid=process.getuid?.();
 if(uid===undefined)invalid();
 const parts=descriptorPath.split(sep).filter(Boolean);
 if(parts.length===0||parts.some(part=>part==='.'||part==='..'))invalid();
 const inspected=await walkChain(parts,uid);
 await inspected.file.close();
 await inspected.parent.close();
 const opened=await walkChain(parts,uid,inspected.chain);
 await opened.parent.close();
 const file=opened.file;
 const chunks:Buffer[]=[];
 const buf=Buffer.alloc(64*1024);
 try{
  const info=await file.stat();
  if(!privateFile(info,uid)||!sameNode(nodeId(info),inspected.chain.leaf))invalid();
  let total=0;
  while(true){
   let bytesRead=0;
   try{({bytesRead}=await file.read(buf,0,buf.length,null));}catch{invalid();}
   if(bytesRead===0)break;
   total+=bytesRead;
   if(total>RETENTION_DESCRIPTOR_MAX_BYTES)invalid();
   chunks.push(Buffer.from(buf.subarray(0,bytesRead)));
   let again;
   try{again=await file.stat();}catch{invalid();}
   if(!again.isFile()||again.nlink!==1||again.dev!==info.dev||again.ino!==info.ino||again.size>RETENTION_DESCRIPTOR_MAX_BYTES)invalid();
  }
  const end=await file.stat();
  if(end.size!==total||end.size>RETENTION_DESCRIPTOR_MAX_BYTES)invalid();
  const bytes=Buffer.concat(chunks,total);
  try{return JSON.parse(bytes.toString('utf8')) as unknown;}catch{invalid();}
  finally{bytes.fill(0);}
 }finally{
  buf.fill(0);
  for(const chunk of chunks)chunk.fill(0);
  await file.close();
 }
}

/** Exit 0 when the supplied inventory admits work, 3 for `STORAGE_LOW_SPACE`, 1 otherwise.
 * Extra arguments, including `--apply`, are refused. stdout is produced only for 0 and 3. */
export async function executeRetentionPlan(descriptorPath:string|undefined,extra:readonly string[]=[]):Promise<RetentionPlanCommandResult>{
 try{
  if(!descriptorPath||extra.length!==0||descriptorPath.startsWith('-'))throw new Refusal('RETENTION_COMMAND_INVALID',400);
  const raw=await readDescriptor(descriptorPath);
  const parsed=Descriptor.safeParse(raw);
  if(!parsed.success)throw new Refusal('RETENTION_DESCRIPTOR_INVALID',400);
  const plan=planRetention(parsed.data.inventory,parsed.data.policy);
  if(plan.mode!=='dry-run'||plan.deletesNothing!==true)throw new Refusal('RETENTION_PLAN_INVALID',400);
  if(plan.admission.admitted&&plan.admission.code==='ADMITTED')return {exitCode:0,plan};
  if(!plan.admission.admitted&&plan.admission.code==='STORAGE_LOW_SPACE')return {exitCode:3,plan};
  throw new Refusal('RETENTION_PLAN_INVALID',400);
 }catch(error){
  if(error instanceof Refusal)return {exitCode:1,code:closed(error.code)};
  return {exitCode:1,code:'RETENTION_DESCRIPTOR_INVALID'};
 }
}
