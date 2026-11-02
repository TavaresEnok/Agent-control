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

/** Explicit local custody. The caller owns/zeros the plaintext returned by load. */
export class ContextVault{
 constructor(private readonly ledger:Ledger,private readonly installationId:string,private readonly root:string,
  private readonly masterFile:string,private readonly protectedRepositories:readonly string[]){Id.parse(installationId);}
 private async paths(){
  for(const path of [this.root,this.masterFile,...this.protectedRepositories])if(!isAbsolute(path)||resolve(path)!==path||await realpath(path)!==path)throw new Refusal('VAULT_PATH_UNSAFE',403);
  if(this.protectedRepositories.some(repo=>overlaps(repo,this.root)||overlaps(repo,this.masterFile)))throw new Refusal('VAULT_PATH_UNSAFE',403);
  const root=await stat(this.root);if(!root.isDirectory()||root.uid!==process.getuid?.()||(root.mode&0o777)!==0o700)throw new Refusal('VAULT_ROOT_UNSAFE',403);
 }
 private async privateRead(path:string,max:number){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const info=await file.stat();if(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.size>max)throw new Refusal('VAULT_FILE_UNSAFE',403);
   const data=await file.readFile();if(data.length>max){data.fill(0);throw new Refusal('VAULT_FILE_UNSAFE',403);}return data;
  }finally{await file.close();}
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
  const input=Request.parse(raw),key=Buffer.from(source);let master:Buffer|undefined,temp:string|undefined;
  try{
   if(key.length!==32)throw new Refusal('INVALID_CONTEXT_KEY',403);
   await this.paths();const header=await this.authorized(input);await new ContextKeys(this.ledger).validate(input.contextId,input.keyVersion,input.encryptionVariant,key);
   master=await this.privateRead(this.masterFile,32);if(master.length!==32)throw new Refusal('VAULT_MASTER_INVALID',403);
   const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',master,nonce);cipher.setAAD(aad(header));
   const ciphertext=Buffer.concat([cipher.update(key),cipher.final()]);
   const envelope=Buffer.from(JSON.stringify({header,nonce:nonce.toString('hex'),ciphertext:ciphertext.toString('hex'),tag:cipher.getAuthTag().toString('hex')}));
   temp=join(this.root,`.vault-${randomUUID()}`);const file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(envelope);await file.sync();}finally{await file.close();envelope.fill(0);ciphertext.fill(0);}
   const current=await this.authorized(input);await new ContextKeys(this.ledger).validate(input.contextId,input.keyVersion,input.encryptionVariant,key);
   if(JSON.stringify(current)!==JSON.stringify(header))throw new Refusal('CONTEXT_KEY_UNAUTHORIZED',403);
   try{await link(temp,this.path(input));}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Refusal('VAULT_ENTRY_EXISTS');throw error;}
   await unlink(temp);temp=undefined;
   const directory=await open(this.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
   try{await directory.sync();}finally{await directory.close();}
  }finally{key.fill(0);master?.fill(0);if(temp)await unlink(temp).catch(()=>{});}
 }
 async load(raw:ManagerKeyRequest):Promise<Uint8Array>{
  const input=Request.parse(raw);let master:Buffer|undefined,stored:Buffer|undefined,plain:Buffer|undefined;
  try{
   await this.paths();const expected=await this.authorized(input);
   master=await this.privateRead(this.masterFile,32);if(master.length!==32)throw new Refusal('VAULT_MASTER_INVALID',403);
   stored=await this.privateRead(this.path(input),4096);
   const envelope=Envelope.parse(JSON.parse(stored.toString('utf8')));
   if(JSON.stringify(envelope.header)!==JSON.stringify(expected))throw new Refusal('VAULT_IDENTITY_MISMATCH',403);
   const decipher=createDecipheriv('aes-256-gcm',master,Buffer.from(envelope.nonce,'hex'));decipher.setAAD(aad(expected));decipher.setAuthTag(Buffer.from(envelope.tag,'hex'));
   const partial=decipher.update(Buffer.from(envelope.ciphertext,'hex'));
   try{const tail=decipher.final();try{plain=Buffer.concat([partial,tail]);}finally{tail.fill(0);}}
   catch{throw new Refusal('VAULT_AUTHENTICATION_FAILED',403);}finally{partial.fill(0);}
   if(plain.length!==32||keyFingerprint(plain)!==expected.fingerprint)throw new Refusal('CONTEXT_KEY_UNAUTHORIZED',403);
   await new ContextKeys(this.ledger).validate(input.contextId,input.keyVersion,input.encryptionVariant,plain);
   const after=await this.authorized(input);if(JSON.stringify(after)!==JSON.stringify(expected))throw new Refusal('CONTEXT_KEY_UNAUTHORIZED',403);
   const result=Uint8Array.from(plain);return result;
  }finally{master?.fill(0);stored?.fill(0);plain?.fill(0);}
 }
}
