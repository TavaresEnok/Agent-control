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
 private cookie(request:Request){
  const values=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('ac_session='));
  if(values.length!==1)return null;
  const raw=values[0].slice('ac_session='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(raw)?raw:null;
 }
 private idHash(id:string){return createHash('sha256').update(id).digest('hex');}
 private cookieValue(id:string,age:number){return `ac_session=${id}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.options.secure?'; Secure':''}`;}
 async issue(request:Request){
  const origin=request.headers.get('origin');if(origin&&origin!==this.options.origin)throw new Refusal('CROSS_ORIGIN_FORBIDDEN',403);
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer ')||authorization.length>8192)throw new Refusal('AUTH_REQUIRED',401);
  const principal=await this.verifyBearer(request);if(!principal)throw new Refusal('AUTH_REQUIRED',401);
  const id=randomBytes(32).toString('base64url'),idDigest=this.idHash(id),nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',this.key,nonce);cipher.setAAD(Buffer.from(idDigest+'\0'+principal));
  const ciphertext=Buffer.concat([cipher.update(authorization,'utf8'),cipher.final()]);
  await this.ledger.pool.query(`INSERT INTO ac_browser_sessions(id_digest,principal_id,token_ciphertext,nonce,tag,expires_at)
   VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 second')`,
   [idDigest,principal,ciphertext.toString('base64'),nonce.toString('base64'),cipher.getAuthTag().toString('base64'),this.options.maxAgeSeconds]);
  return new Response(JSON.stringify({state:'authenticated'}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':this.cookieValue(id,this.options.maxAgeSeconds)}});
 }
 private async credential(request:Request){
  const id=this.cookie(request);if(!id)return null;
  const row=(await this.ledger.pool.query('SELECT * FROM ac_browser_sessions WHERE id_digest=$1 AND NOT revoked AND expires_at>clock_timestamp()',[this.idHash(id)])).rows[0];
  if(!row)return null;
  try{
   const decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(row.nonce,'base64'));
   decipher.setAAD(Buffer.from(row.id_digest+'\0'+row.principal_id));decipher.setAuthTag(Buffer.from(row.tag,'base64'));
   const authorization=Buffer.concat([decipher.update(Buffer.from(row.token_ciphertext,'base64')),decipher.final()]).toString('utf8');
   return {authorization,principal:row.principal_id as string};
  }catch{return null;}
 }
 async authenticate(request:Request){
  const value=await this.credential(request);if(!value)return null;
  try{const verified=await this.verifyBearer(new Request(this.options.origin+'/',{headers:{authorization:value.authorization}}));
   return verified===value.principal?verified:null;}catch{return null;}
 }
 /** Verify access to an existing encrypted Happier session, without receiving
  * any content key or creating a second conversation. No token is returned. */
 async verifyHappierSession(request:Request,principal:string,sessionId:string,upstreamOrigin:string){
  if(!sessionId||sessionId.length>200)return false;
  try{
   const upstream=new URL(upstreamOrigin);
   if(!['http:','https:'].includes(upstream.protocol)||upstream.origin!==upstreamOrigin||
    (upstream.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(upstream.hostname)))return false;
   const cookie=await this.credential(request);
   const authorization=request.headers.get('authorization')??(cookie?.principal===principal?cookie.authorization:null);
   if(!authorization||await this.verifyBearer(new Request(this.options.origin+'/',{headers:{authorization}}))!==principal)return false;
   const response=await fetch(upstreamOrigin+'/v2/sessions/'+encodeURIComponent(sessionId),{headers:{authorization},redirect:'error',signal:AbortSignal.timeout(5000)});
   if(!response.ok)return false;
   const value:unknown=await response.json();
   return typeof value==='object'&&value!==null&&'session' in value&&typeof value.session==='object'&&value.session!==null&&
    'id' in value.session&&value.session.id===sessionId&&'encryptionMode' in value.session&&value.session.encryptionMode==='e2ee';
  }catch{return false;}
 }
 async revoke(request:Request){
  const origin=request.headers.get('origin');if(origin&&origin!==this.options.origin)throw new Refusal('CROSS_ORIGIN_FORBIDDEN',403);
  const id=this.cookie(request);if(id)await this.ledger.pool.query('UPDATE ac_browser_sessions SET revoked=true WHERE id_digest=$1',[this.idHash(id)]);
  return new Response(JSON.stringify({state:'signed_out'}),{status:200,headers:{'content-type':'application/json','cache-control':'no-store','set-cookie':this.cookieValue('',0)}});
 }
 checkOrigin(request:Request){
  if(['GET','HEAD','OPTIONS'].includes(request.method))return;
  const origin=request.headers.get('origin');if(origin!==this.options.origin)throw new Refusal('CROSS_ORIGIN_FORBIDDEN',403);
 }
}
