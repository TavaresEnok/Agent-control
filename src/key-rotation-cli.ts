import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {describeKeyRotationPlan,KEY_ROTATION_MAX_ENTRIES,type KeyRotationDryRunPlan} from './key-rotation-plan.ts';

/** Product dry-run. Reads one inventory descriptor and prints a plan. Never applies it. */

const MAX_DESCRIPTOR_BYTES=4*1024*1024;
const VERSION_FIELDS=new Set(['keyVersion','currentKeyVersion','nextKeyVersion']);
const SECRET_FIELDS=new Set(['plaintext','secret','privatekey','masterkey','ciphertext','nonce','passphrase','seed','mnemonic','material','token','password','credential']);
const version=z.number().int().positive().max(2_147_483_647);
const Entry=z.object({
 id:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
 keyVersion:version,
 state:z.enum(['sealed','uncertain','corrupted']),
}).strict();
const Descriptor=z.object({
 schemaVersion:z.literal(1),
 currentKeyVersion:version,
 nextKeyVersion:version,
 batchSize:z.number().int().min(1).max(256).optional(),
 entries:z.array(Entry).min(1).max(KEY_ROTATION_MAX_ENTRIES),
}).strict();

export type KeyRotationPlanCommandResult=
 |{exitCode:0|3;plan:KeyRotationDryRunPlan}
 |{exitCode:1;code:string};

function rejectKeyFields(value:unknown){
 const walk=(node:unknown)=>{
  if(Array.isArray(node)){for(const item of node)walk(item);return;}
  if(node===null||typeof node!=='object')return;
  for(const [key,child] of Object.entries(node)){
   const folded=key.toLowerCase();
   if(!VERSION_FIELDS.has(key)&&(folded.includes('key')||SECRET_FIELDS.has(folded)))throw new Refusal('KEY_ROTATION_MATERIAL_REJECTED',409);
   walk(child);
  }
 };
 walk(value);
}

async function readDescriptor(descriptorPath:string):Promise<unknown>{
 if(!isAbsolute(descriptorPath)||resolve(descriptorPath)!==descriptorPath)throw new Refusal('KEY_ROTATION_DESCRIPTOR_INVALID',400);
 if(await realpath(descriptorPath)!==descriptorPath)throw new Refusal('KEY_ROTATION_DESCRIPTOR_INVALID',400);
 const file=await open(descriptorPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bytes:Buffer|undefined;
 try{
  const info=await file.stat();
  if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||info.size>MAX_DESCRIPTOR_BYTES)throw new Refusal('KEY_ROTATION_DESCRIPTOR_INVALID',400);
  bytes=await file.readFile();
  if(bytes.length>MAX_DESCRIPTOR_BYTES)throw new Refusal('KEY_ROTATION_DESCRIPTOR_INVALID',400);
  try{return JSON.parse(bytes.toString('utf8')) as unknown;}
  catch{throw new Refusal('KEY_ROTATION_DESCRIPTOR_INVALID',400);}
 }finally{bytes?.fill(0);await file.close();}
}

/** Read the descriptor and return the dry-run plan. Exit 0 planned, 3 blocked, 1 refused. */
export async function executeKeyRotationPlan(descriptorPath:string):Promise<KeyRotationPlanCommandResult>{
 try{
  const raw=await readDescriptor(descriptorPath);
  rejectKeyFields(raw);
  const parsed=Descriptor.safeParse(raw);
  if(!parsed.success)throw new Refusal('KEY_ROTATION_DESCRIPTOR_INVALID',400);
  const plan=describeKeyRotationPlan(parsed.data);
  return {exitCode:plan.blockedReason?3:0,plan};
 }catch(error){
  if(error instanceof Refusal)return {exitCode:1,code:error.code};
  const code=(error as NodeJS.ErrnoException).code;
  if(code)return {exitCode:1,code:'KEY_ROTATION_DESCRIPTOR_INVALID'};
  throw error;
 }
}
