import {z} from 'zod';
import {Refusal} from './contracts.ts';
import type {BrowserSessions} from './sessions.ts';
const PublicKey=z.string().max(60).refine(value=>{
 const bytes=Buffer.from(value,'base64');return bytes.length===32&&bytes.toString('base64')===value;
});
const Secret=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Begin=z.object({publicKey:PublicKey,claimSecretHash:Secret}).strict();
const Claim=z.object({publicKey:PublicKey,claimSecret:Secret}).strict();
const Pending=z.object({state:z.literal('requested'),expiresAt:z.number().int().positive().optional()}).strict();
const Answer=z.object({state:z.literal('authorized'),token:z.string().min(1).max(8192),response:z.string().min(1).max(8192),serverIdentityId:z.string().max(200).optional()}).strict();
async function boundedJson(request:Request|Response,limit:number){
 const reader=request.body?.getReader();if(!reader)throw new Refusal('PAIRING_INVALID_JSON',400);
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;
  if(size>limit){await reader.cancel();throw new Refusal('PAIRING_MESSAGE_TOO_LARGE',400);}chunks.push(item.value);}}
 finally{reader.releaseLock();}
 const bytes=Buffer.concat(chunks);
 try{return JSON.parse(bytes.toString('utf8')) as unknown;}catch{throw new Refusal('PAIRING_INVALID_JSON',400);}
}
function url(raw:string){
 const value=new URL(raw);
 if(!['https:','http:'].includes(value.protocol)||value.username||value.password||value.search||value.hash||value.pathname!=='/'||
  (value.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(value.hostname)))throw Error('UNSAFE_HAPPIER_AUTH_ORIGIN');
 return value.origin;
}
/** Fixed-origin relay for the existing Happier pairing protocol. Private box
 * keys and pairing authentication secrets never enter this server. */
export class HappierAuthRelay{
 private readonly upstream:string;
 readonly config:{enabled:true;webUrl:string;serverUrl:string};
 constructor(private readonly sessions:BrowserSessions,options:{upstreamUrl:string;webUrl:string;publicServerUrl:string},private readonly request:typeof fetch=fetch){
  this.upstream=url(options.upstreamUrl);
  this.config={enabled:true,webUrl:url(options.webUrl),serverUrl:url(options.publicServerUrl)};
 }
 async forward(request:Request,action:'begin'|'claim'){
  this.sessions.checkOrigin(request);
  if(request.headers.has('authorization'))throw new Refusal('PAIRING_BEARER_NOT_ACCEPTED',403);
  const input=await boundedJson(request,512);
  const body=action==='begin'?{...Begin.parse(input),supportsV2:true,supportsTokenOnly:false}:Claim.parse(input);
  let response:Response;
  try{response=await this.request(this.upstream+(action==='begin'?'/v1/auth/request':'/v1/auth/request/claim'),{
   method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(8000),cache:'no-store'});}
  catch{throw new Refusal('HAPPIER_PAIRING_UNAVAILABLE');}
  if(!response.ok)throw new Refusal(response.status===410?'PAIRING_EXPIRED':'HAPPIER_PAIRING_REFUSED',response.status===401?401:409);
  const value=await boundedJson(response,20000);
  const parsed=action==='begin'?Pending.parse(value):z.union([Pending,Answer]).parse(value);
  return new Response(JSON.stringify(parsed),{headers:{'content-type':'application/json','cache-control':'no-store','referrer-policy':'no-referrer'}});
 }
}
