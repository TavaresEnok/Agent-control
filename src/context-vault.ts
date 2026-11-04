import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,stat,link,unlink} from 'node:fs/promises';
import {isAbsolute,resolve,join,sep} from 'node:path';
import {z} from 'zod';
import {Id,Refusal} from './contracts.ts';
import {ContextKeys,keyFingerprint} from './context-keys.ts';
import type {Ledger} from './ledger.ts';
import type {ManagerKeyRequest} from './managers.ts';

const Request=z.object({principal:z.string().min(1).max(200),contextId:Id,sessionId:z.string().min(1).max(200),
 profileId:z.string().min(1).max(100),keyVersion:z.number().int().positive(),encryptionVariant:z.enum(['legacy','dataKey'])}).strict();
const Header=z.object({schemaVersion:z.literal(1),installationId:Id,contextId:Id,principal:z.string().min(1).max(200),
 version:z.number().int().positive(),variant:z.enum(['legacy','dataKey']),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const Envelope=z.object({header:Header,nonce:z.string().regex(/^[a-f0-9]{24}$/),ciphertext:z.string().regex(/^[a-f0-9]{64}$/),tag:z.string().regex(/^[a-f0-9]{32}$/)}).strict();
const aad=(h:z.infer<typeof Header>)=>Buffer.from(JSON.stringify([h.schemaVersion,h.installationId,h.contextId,h.principal,h.version,h.variant,h.fingerprint]));
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
const masterPaths=(masterFile:string)=>[masterFile,`${masterFile}.new`,`${masterFile}.old`];
const MASTER_AUTH_ATTEMPTS=3;
export type MasterProbe=(path:string,index:number)=>void;

export type CustodyHeader=z.infer<typeof Header>;

async function privateRead(path:string,max:number){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await file.stat();
  if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>max)throw new Refusal('VAULT_FILE_UNSAFE',403);
  const data=await file.readFile();if(data.length>max){data.fill(0);throw new Refusal('VAULT_FILE_UNSAFE',403);}return data;
 }finally{await file.close();}
}

function decryptOne(master:Uint8Array,envelope:z.infer<typeof Envelope>,header:CustodyHeader):Buffer|undefined{
 const key=Buffer.from(master),nonce=Buffer.from(envelope.nonce,'hex'),ciphertext=Buffer.from(envelope.ciphertext,'hex'),tag=Buffer.from(envelope.tag,'hex');
 let partial:Buffer|undefined,tail:Buffer|undefined,plain:Buffer|undefined;
 try{
  if(key.length!==32)throw new Refusal('VAULT_MASTER_INVALID',403);
  const decipher=createDecipheriv('aes-256-gcm',key,nonce);decipher.setAAD(aad(header));decipher.setAuthTag(tag);
  partial=decipher.update(ciphertext);
  try{tail=decipher.final();plain=Buffer.concat([partial,tail]);}catch{return undefined;}
  return Buffer.from(plain);
 }finally{key.fill(0);nonce.fill(0);ciphertext.fill(0);tag.fill(0);partial?.fill(0);tail?.fill(0);plain?.fill(0);}
}

/** First authenticating master wins. `expected` binds the ledger header; without it the file header is the AAD. */
export function unsealCustodyWithMasters(masters:readonly Uint8Array[],stored:Uint8Array,expected?:CustodyHeader):{header:CustodyHeader;plaintext:Buffer}|undefined{
 const envelope=Envelope.parse(JSON.parse(Buffer.from(stored).toString('utf8')));
 if(expected&&JSON.stringify(envelope.header)!==JSON.stringify(expected))throw new Refusal('VAULT_IDENTITY_MISMATCH',403);
 const header=expected??envelope.header;
 for(const master of masters){
  const opened=decryptOne(master,envelope,header);
  if(!opened)continue;
  if(opened.length!==32||keyFingerprint(opened)!==header.fingerprint){opened.fill(0);throw new Refusal('CONTEXT_KEY_UNAUTHORIZED',403);}
  return {header:envelope.header,plaintext:opened};
 }
 return undefined;
}

/** Seal one context key. Copies and wipes the key buffers it allocates. The caller wipes the returned envelope. */
export function sealCustodyEnvelope(master:Uint8Array,header:unknown,plaintext:Uint8Array):Buffer{
 const parsed=Header.parse(header),key=Buffer.from(plaintext),wrapping=Buffer.from(master),nonce=randomBytes(12);
 let ciphertext:Buffer|undefined,tag:Buffer|undefined;
 try{
  if(key.length!==32||wrapping.length!==32)throw new Refusal('INVALID_CONTEXT_KEY',403);
  const cipher=createCipheriv('aes-256-gcm',wrapping,nonce);cipher.setAAD(aad(parsed));
  ciphertext=Buffer.concat([cipher.update(key),cipher.final()]);tag=cipher.getAuthTag();
  return Buffer.from(JSON.stringify({header:parsed,nonce:nonce.toString('hex'),ciphertext:ciphertext.toString('hex'),tag:tag.toString('hex')}));
 }finally{key.fill(0);wrapping.fill(0);nonce.fill(0);ciphertext?.fill(0);tag?.fill(0);}
}

/** Masters that exist right now, in load order. A missing generation is skipped; an unsafe one is refused. */
export async function readPresentMasterKeys(masterFile:string,afterProbe?:MasterProbe):Promise<Buffer[]>{
 const keys:Buffer[]=[];
 let missingPrimary:unknown;
 try{
  for(const [index,path] of masterPaths(masterFile).entries()){
   let data:Buffer|undefined;
   try{data=await privateRead(path,32);}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT'){if(index===0)missingPrimary=error;continue;}
    throw error;
   }
   if(data.length!==32){data.fill(0);throw new Refusal('VAULT_MASTER_INVALID',403);}
   keys.push(data);
   afterProbe?.(path,index);
  }
  if(!keys.length)throw missingPrimary??new Refusal('VAULT_MASTER_INVALID',403);
  return keys;
 }catch(error){for(const key of keys)key.fill(0);throw error;}
}

/**
 * Read the envelope until one present master authenticates.
 * A miss rereads the master names and the envelope, at most three times: promote can move
 * `masterFile.new` onto `masterFile` between those reads. Permission and path failures are not retried.
 */
async function openCustody(masterFile:string,envelopePath:string,expected?:CustodyHeader,afterProbe?:MasterProbe){
 for(let attempt=0;attempt<MASTER_AUTH_ATTEMPTS;attempt++){
  const masters=await readPresentMasterKeys(masterFile,afterProbe);
  let stored:Buffer|undefined;
  try{
   stored=await privateRead(envelopePath,4096);
   const opened=unsealCustodyWithMasters(masters,stored,expected);
   if(opened)return opened.plaintext;
  }finally{stored?.fill(0);for(const master of masters)master.fill(0);}
 }
 throw new Refusal('VAULT_AUTHENTICATION_FAILED',403);
}

/**
 * Maintenance open used by rotation and by ContextVault.load's crypto path.
 * Tries masterFile, masterFile.new and masterFile.old. The caller wipes the result.
 */
export async function loadCustodyPlaintext(masterFile:string,envelopePath:string,afterProbe?:MasterProbe):Promise<Uint8Array>{
 const plain=await openCustody(masterFile,envelopePath,undefined,afterProbe);
 try{return Uint8Array.from(plain);}finally{plain.fill(0);}
}

/** Explicit local custody. The caller owns/zeros the plaintext returned by load. */
export class ContextVault{
 constructor(private readonly ledger:Ledger,private readonly installationId:string,private readonly root:string,
  private readonly masterFile:string,private readonly protectedRepositories:readonly string[]){Id.parse(installationId);}
 private async existingMasters(){
  const found:string[]=[];
  for(const path of masterPaths(this.masterFile)){
   if(!isAbsolute(path)||resolve(path)!==path)throw new Refusal('VAULT_PATH_UNSAFE',403);
   try{if(await realpath(path)!==path)throw new Refusal('VAULT_PATH_UNSAFE',403);found.push(path);}
   catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  }
  return found;
 }
 private async paths(){
  const masters=await this.existingMasters();
  if(!masters.length&&(!isAbsolute(this.masterFile)||resolve(this.masterFile)!==this.masterFile||await realpath(this.masterFile)!==this.masterFile))throw new Refusal('VAULT_PATH_UNSAFE',403);
  for(const path of [this.root,...masters,...this.protectedRepositories])if(!isAbsolute(path)||resolve(path)!==path||await realpath(path)!==path)throw new Refusal('VAULT_PATH_UNSAFE',403);
  if(this.protectedRepositories.some(repo=>overlaps(repo,this.root)||overlaps(repo,this.masterFile)))throw new Refusal('VAULT_PATH_UNSAFE',403);
  const root=await stat(this.root);if(!root.isDirectory()||root.uid!==process.getuid?.()||(root.mode&0o777)!==0o700)throw new Refusal('VAULT_ROOT_UNSAFE',403);
 }
 private async authorized(input:z.infer<typeof Request>){
  return this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,input.principal,input.contextId);
   if(context.role!=='owner')throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const installation=(await c.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0];
   if(installation?.id!==this.installationId)throw new Refusal('VAULT_INSTALLATION_MISMATCH',403);
   const session=(await c.query('SELECT principal_id,session_id FROM ac_session_links WHERE context_id=$1',[input.contextId])).rows[0];
   if(session?.principal_id!==input.principal||session?.session_id!==input.sessionId)throw new Refusal('SESSION_CONTEXT_MISMATCH',403);
   const row=(await c.query("SELECT fingerprint FROM ac_context_keys WHERE context_id=$1 AND version=$2 AND variant=$3 AND state='active'",[input.contextId,input.keyVersion,input.encryptionVariant])).rows[0];
   if(!row)throw new Refusal('CONTEXT_KEY_UNAUTHORIZED',403);
   return Header.parse({schemaVersion:1,installationId:this.installationId,contextId:input.contextId,principal:input.principal,version:input.keyVersion,variant:input.encryptionVariant,fingerprint:row.fingerprint});
  });
 }
 private path(input:z.infer<typeof Request>){return join(this.root,`${input.contextId}-${input.keyVersion}.vault`);}
 async importKey(raw:ManagerKeyRequest,source:Uint8Array){
  const input=Request.parse(raw),key=Buffer.from(source);let master:Buffer|undefined,temp:string|undefined,envelope:Buffer|undefined;
  try{
   if(key.length!==32)throw new Refusal('INVALID_CONTEXT_KEY',403);
   await this.paths();const header=await this.authorized(input);await new ContextKeys(this.ledger).validate(input.contextId,input.keyVersion,input.encryptionVariant,key);
   master=await privateRead(this.masterFile,32);if(master.length!==32)throw new Refusal('VAULT_MASTER_INVALID',403);
   envelope=sealCustodyEnvelope(master,header,key);
   temp=join(this.root,`.vault-${randomUUID()}`);const file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(envelope);await file.sync();}finally{await file.close();}
   const current=await this.authorized(input);await new ContextKeys(this.ledger).validate(input.contextId,input.keyVersion,input.encryptionVariant,key);
   if(JSON.stringify(current)!==JSON.stringify(header))throw new Refusal('CONTEXT_KEY_UNAUTHORIZED',403);
   try{await link(temp,this.path(input));}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Refusal('VAULT_ENTRY_EXISTS');throw error;}
   await unlink(temp);temp=undefined;
   const directory=await open(this.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
   try{await directory.sync();}finally{await directory.close();}
  }finally{key.fill(0);master?.fill(0);envelope?.fill(0);if(temp)await unlink(temp).catch(()=>{});}
 }
 async load(raw:ManagerKeyRequest):Promise<Uint8Array>{
  const input=Request.parse(raw);let plain:Buffer|undefined;
  try{
   await this.paths();const expected=await this.authorized(input);
   plain=await openCustody(this.masterFile,this.path(input),expected);
   await new ContextKeys(this.ledger).validate(input.contextId,input.keyVersion,input.encryptionVariant,plain);
   const after=await this.authorized(input);if(JSON.stringify(after)!==JSON.stringify(expected))throw new Refusal('CONTEXT_KEY_UNAUTHORIZED',403);
   return Uint8Array.from(plain);
  }finally{plain?.fill(0);}
 }
}
