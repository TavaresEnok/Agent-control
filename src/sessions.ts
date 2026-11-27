import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import { Ledger } from './ledger.ts';
import {Refusal} from './contracts.ts';
export type BearerVerifier=(request:Request)=>Promise<string|null>;
/** Browser cookie contains an opaque ID. The upstream token stays encrypted server-side. */
export class BrowserSessions{
 private readonly key:Buffer;
 constructor(readonly ledger:Ledger,key:Uint8Array,private readonly verifyBearer:BearerVerifier,
  private readonly options:{origin:string;secure:boolean;maxAgeSeconds:number}){
  this.key=Buffer.from(key);
  if(this.key.length!==32||options.maxAgeSeconds<60||options.maxAgeSeconds>2592000)throw Error('INVALID_BROWSER_SESSION_CONFIG');
  const origin=new URL(options.origin);if(origin.origin!==options.origin||(options.secure&&origin.protocol!=='https:')||(!options.secure&&(origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname))))throw Error('UNSAFE_BROWSER_ORIGIN');
 }
 private credentialEpoch?:()=>Promise<{changedAt:number;legacy:boolean}>;
 /** Personal sessions are bound to the credential generation present when they were issued. */
 bindCredentialEpoch(epoch:NonNullable<BrowserSessions['credentialEpoch']>){this.credentialEpoch=epoch;}
 private cookie(request:Request){
  const values=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('ac_session='));
  if(values.length!==1)return null;
  const raw=values[0].slice('ac_session='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(raw)?raw:null;
 }
 private idHash(id:string,epoch=0){return createHash('sha256').update(epoch===0?id:epoch+'\0'+id).digest('hex');}
 private async epoch(){
  return this.credentialEpoch?await this.credentialEpoch():{changedAt:0,legacy:false};
 }
 private cookieValue(id:string,age:number){return `ac_session=${id}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.options.secure?'; Secure':''}`;}
 async issue(request:Request,maxAgeSeconds=this.options.maxAgeSeconds){
  if(!Number.isInteger(maxAgeSeconds)||maxAgeSeconds<60||maxAgeSeconds>2592000)throw Error('INVALID_BROWSER_SESSION_CONFIG');
  const origin=request.headers.get('origin');if(origin&&origin!==this.options.origin)throw new Refusal('CROSS_ORIGIN_FORBIDDEN',403);
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer ')||authorization.length>8192)throw new Refusal('AUTH_REQUIRED',401);
  const {changedAt}=await this.epoch();
  if(!Number.isFinite(changedAt))throw new Refusal('AUTH_REQUIRED',401);
  const principal=await this.verifyBearer(request);if(!principal)throw new Refusal('AUTH_REQUIRED',401);
  const id=randomBytes(32).toString('base64url'),idDigest=this.idHash(id,changedAt),nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from(idDigest+'\0'+principal));
  const ciphertext=Buffer.concat([cipher.update(authorization,'utf8'),cipher.final()]);
  await this.ledger.pool.query(`INSERT INTO ac_browser_sessions(id_digest,principal_id,token_ciphertext,nonce,tag,expires_at)
   VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 second')`,
   [idDigest,principal,ciphertext.toString('base64'),nonce.toString('base64'),cipher.getAuthTag().toString('base64'),maxAgeSeconds]);
  return new Response(JSON.stringify({state:'authenticated'}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':this.cookieValue(id,maxAgeSeconds)}});
 }
 /** Personal login with no bearer. The cookie names the principal; nothing is sent upstream. */
 async issuePrincipal(request:Request,principal:string,maxAgeSeconds=this.options.maxAgeSeconds,credentialEpoch?:number){
  if(!Number.isInteger(maxAgeSeconds)||maxAgeSeconds<60||maxAgeSeconds>2592000)throw Error('INVALID_BROWSER_SESSION_CONFIG');
  const origin=request.headers.get('origin');if(origin&&origin!==this.options.origin)throw new Refusal('CROSS_ORIGIN_FORBIDDEN',403);
  if(!principal||principal.length>200)throw new Refusal('AUTH_REQUIRED',401);
  const epoch=credentialEpoch??(await this.epoch()).changedAt;
  if(!Number.isFinite(epoch))throw new Refusal('AUTH_REQUIRED',401);
  const id=randomBytes(32).toString('base64url');
  await this.ledger.pool.query(`INSERT INTO ac_browser_sessions(id_digest,principal_id,token_ciphertext,nonce,tag,expires_at)
   VALUES($1,$2,NULL,NULL,NULL,clock_timestamp()+$3*interval '1 second')`,[this.idHash(id,epoch),principal,maxAgeSeconds]);
  return new Response(JSON.stringify({state:'authenticated'}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':this.cookieValue(id,maxAgeSeconds)}});
 }
 private async credential(request:Request){
  const id=this.cookie(request);if(!id)return null;
  const {changedAt,legacy}=await this.epoch();
  if(!Number.isFinite(changedAt))return null;
  const digests=[this.idHash(id,changedAt)];
  if(legacy&&changedAt>0)digests.push(this.idHash(id));
  const row=(await this.ledger.pool.query('SELECT * FROM ac_browser_sessions WHERE id_digest=ANY($1) AND NOT revoked AND expires_at>clock_timestamp()',[digests])).rows[0];
  if(!row||await this.epoch().then(epoch=>epoch.changedAt)!==changedAt)return null;
  if(row.id_digest!==digests[0]&&!(new Date(row.created_at).getTime()>changedAt))return null;
  if(row.token_ciphertext==null||row.nonce==null||row.tag==null){
   if(row.token_ciphertext==null&&row.nonce==null&&row.tag==null)return {authorization:null,principal:row.principal_id as string};
   return null;
  }
  try{
   const decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(row.nonce,'base64'));
   decipher.setAAD(Buffer.from(row.id_digest+'\0'+row.principal_id));decipher.setAuthTag(Buffer.from(row.tag,'base64'));
   const authorization=Buffer.concat([decipher.update(Buffer.from(row.token_ciphertext,'base64')),decipher.final()]).toString('utf8');
   return {authorization:authorization as string,principal:row.principal_id as string};
  }catch{return null;}
 }
 async authenticate(request:Request){
  const value=await this.credential(request);if(!value)return null;
  if(value.authorization==null)return value.principal;
  try{const verified=await this.verifyBearer(new Request(this.options.origin+'/',{headers:{authorization:value.authorization}}));
   return verified===value.principal?verified:null;}catch{return null;}
 }
 async revoke(request:Request){
  const origin=request.headers.get('origin');if(origin&&origin!==this.options.origin)throw new Refusal('CROSS_ORIGIN_FORBIDDEN',403);
  const id=this.cookie(request);
  if(id){
   const {changedAt,legacy}=await this.epoch();
   const digests=[this.idHash(id,changedAt)];
   if(legacy&&changedAt>0)digests.push(this.idHash(id));
   await this.ledger.pool.query('UPDATE ac_browser_sessions SET revoked=true WHERE id_digest=ANY($1)',[digests]);
  }
  return new Response(JSON.stringify({state:'signed_out'}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':this.cookieValue('',0)}});
 }
 checkOrigin(request:Request){
  if(['GET','HEAD','OPTIONS'].includes(request.method))return;
  const origin=request.headers.get('origin');if(origin!==this.options.origin)throw new Refusal('CROSS_ORIGIN_FORBIDDEN',403);
 }
}
