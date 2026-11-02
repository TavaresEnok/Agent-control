import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Authority,Id,Refusal,digest} from './contracts.ts';
import {ContextKeys,keyFingerprint,type EncryptionVariant} from './context-keys.ts';
import {Ledger} from './ledger.ts';
import {HappierEndpoint,type HappierBoundary} from './happier.ts';
import type {CezarRuntime} from './cezar.ts';

const Start=z.object({principal:z.string().min(1).max(200),contextId:Id,sessionId:z.string().min(1).max(200),
 profileId:z.string().min(1).max(100),keyVersion:z.number().int().positive(),encryptionVariant:z.enum(['legacy','dataKey']),
 key:z.instanceof(Uint8Array).refine(value=>value.byteLength===32,'INVALID_CONTEXT_KEY')}).strict();
export type ManagerStart=z.input<typeof Start>;
export type ManagedEndpoint={start():Promise<void>;close():void|Promise<void>;lastError?:string;connectionState?(): 'connected'|'disconnected'};
export type ManagerEndpointInput=Omit<z.infer<typeof Start>,'key'> & {authority:Authority;key:Uint8Array};
export type ManagerEndpointFactory=(input:ManagerEndpointInput)=>ManagedEndpoint|Promise<ManagedEndpoint>;
type Entry={input:z.infer<typeof Start>;signature:string;key:Uint8Array;state:'starting'|'running'|'stopping';
 authority?:Authority;endpoint?:ManagedEndpoint;cancelled:boolean;released:boolean;abort:AbortController};
const invalidAuthorityErrors=new Set(['STALE_MANAGER','CONTEXT_KEY_UNAUTHORIZED','SESSION_CONTEXT_MISMATCH','CONTEXT_FORBIDDEN','PROJECT_RUNTIME_MISMATCH']);

/** Owns endpoint lifetime, not plans, DAG dispatch or provider capacity. PG
 * fencing remains mandatory at every effect, including a cached authority. */
export class ManagerRegistry{
 private readonly entries=new Map<string,Entry>();
 private readonly starts=new Map<string,{signature:string;promise:Promise<Authority>}>();
 private readonly restarts=new Map<string,AbortController>();
 private closed=false;
 constructor(readonly ledger:Ledger,readonly projectId:string,private readonly factory:ManagerEndpointFactory,private readonly options:{startupTimeoutMs?:number;closeTimeoutMs?:number}={}){Id.parse(projectId);}
 private bounded<T>(work:Promise<T>,ms:number,signal?:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
   const finish=(fn:()=>void)=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);fn();};
   const aborted=()=>finish(()=>reject(new Refusal('MANAGER_STOPPED')));
   const timer=setTimeout(()=>finish(()=>reject(new Refusal('MANAGER_START_TIMEOUT'))),ms);
   if(signal?.aborted){aborted();return;}signal?.addEventListener('abort',aborted,{once:true});
   work.then(value=>finish(()=>resolve(value)),error=>finish(()=>reject(error)));
  });
 }
 private async validate(entry:Entry,authority?:Authority){
  await this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,entry.input.principal,entry.input.contextId);
   if(context.project_id!==this.projectId)throw new Refusal('PROJECT_RUNTIME_MISMATCH',403);
   const link=(await c.query('SELECT session_id,principal_id FROM ac_session_links WHERE context_id=$1',[entry.input.contextId])).rows[0];
   if(link?.session_id!==entry.input.sessionId||link?.principal_id!==entry.input.principal)throw new Refusal('SESSION_CONTEXT_MISMATCH',403);
   if(authority)await this.ledger.fence(c,authority,true);
  });
  await new ContextKeys(this.ledger).validate(entry.input.contextId,entry.input.keyVersion,entry.input.encryptionVariant,entry.key);
 }
 private async release(entry:Entry){
  if(!entry.authority||entry.released)return;
  const a=entry.authority;
  await this.ledger.pool.query('UPDATE ac_managers SET lease_until=clock_timestamp() WHERE context_id=$1 AND instance_id=$2 AND epoch=$3',[a.contextId,a.instanceId,a.epoch]);
  entry.released=true;
 }
 private async dispose(entry:Entry){
  entry.cancelled=true;entry.state='stopping';entry.abort.abort();
  entry.key.fill(0);
  let failure:unknown;
  try{await this.release(entry);}catch(error){failure=error;}
  try{if(entry.endpoint)await this.bounded(Promise.resolve().then(()=>entry.endpoint!.close()),this.options.closeTimeoutMs??10000);}catch(error){failure??=error;}
  finally{if(this.entries.get(entry.input.contextId)===entry)this.entries.delete(entry.input.contextId);}
  if(failure)throw new Refusal('MANAGER_ENDPOINT_CLOSE_FAILED');
 }
 start(raw:ManagerStart):Promise<Authority>{
  if(this.closed)return Promise.reject(new Refusal('MANAGER_REGISTRY_CLOSED'));
  if(this.restarts.has(raw.contextId))return Promise.reject(new Refusal('MANAGER_RESTART_IN_PROGRESS'));
  const input=Start.parse(raw),key=Uint8Array.from(input.key);
  const signature=digest({projectId:this.projectId,principal:input.principal,contextId:input.contextId,sessionId:input.sessionId,
   profileId:input.profileId,keyVersion:input.keyVersion,encryptionVariant:input.encryptionVariant,keyFingerprint:keyFingerprint(key)});
  const inFlight=this.starts.get(input.contextId);
  if(inFlight){key.fill(0);return inFlight.signature===signature?inFlight.promise:Promise.reject(new Refusal('MANAGER_CONFIGURATION_CONFLICT'));}
  const existing=this.entries.get(input.contextId);
  if(existing&&existing.signature!==signature){key.fill(0);return Promise.reject(new Refusal('MANAGER_CONFIGURATION_CONFLICT'));}
  const entry:Entry=existing??{input:{...input,key},signature,key,state:'starting',cancelled:false,released:false,abort:new AbortController()};
  if(existing)key.fill(0);else this.entries.set(input.contextId,entry);
  const promise=this.activate(entry).finally(()=>{if(this.starts.get(input.contextId)?.promise===promise)this.starts.delete(input.contextId);});
  this.starts.set(input.contextId,{signature,promise});return promise;
 }
 /** Explicit caller-supplied credentials only; no retry or credential retention. */
 async restart(raw:ManagerStart):Promise<Authority>{
  if(this.closed)throw new Refusal('MANAGER_REGISTRY_CLOSED');
  const input=Start.parse(raw),key=Uint8Array.from(input.key),contextId=input.contextId;
  const guard=new AbortController();
  try{
   if(this.restarts.has(contextId)||this.starts.has(contextId))throw new Refusal('MANAGER_RESTART_IN_PROGRESS');
   const current=this.entries.get(contextId);
   if(current&&current.input.principal!==input.principal)throw new Refusal('MANAGER_OWNER_MISMATCH',403);
   this.restarts.set(contextId,guard);
   const candidate:Entry={input:{...input,key},signature:'',key,state:'starting',cancelled:false,released:false,abort:guard};
   await this.validate(candidate);
   if(guard.signal.aborted||this.closed||this.entries.get(contextId)!==current)throw new Refusal('MANAGER_STOPPED');
   if(current)await this.dispose(current);
   if(guard.signal.aborted||this.closed)throw new Refusal('MANAGER_STOPPED');
   this.restarts.delete(contextId);
   return await this.start({...input,key});
  }finally{
   key.fill(0);
   if(this.restarts.get(contextId)===guard)this.restarts.delete(contextId);
  }
 }
 private async activate(entry:Entry):Promise<Authority>{
  try{
   if(entry.cancelled||this.closed)throw new Refusal('MANAGER_STOPPED');
   if(entry.state==='running'){
    await this.validate(entry,entry.authority);
    if(entry.cancelled||this.closed||entry.state!=='running'||this.entries.get(entry.input.contextId)!==entry)throw new Refusal('MANAGER_STOPPED');
    return {...entry.authority!};
   }
   await this.validate(entry);
   if(entry.cancelled||this.closed)throw new Refusal('MANAGER_STOPPED');
   entry.authority=Object.freeze(await this.ledger.acquire(entry.input.principal,entry.input.contextId,randomUUID(),entry.input.profileId));
   if(entry.cancelled||this.closed)throw new Refusal('MANAGER_STOPPED');
   const creating=Promise.resolve().then(()=>this.factory({...entry.input,key:entry.key,authority:{...entry.authority!}}));
   void creating.then(endpoint=>{if(entry.cancelled)void Promise.resolve().then(()=>endpoint.close()).catch(()=>{});},()=>{});
   entry.endpoint=await this.bounded(creating,this.options.startupTimeoutMs??15000,entry.abort.signal);
   if(entry.cancelled||this.closed)throw new Refusal('MANAGER_STOPPED');
   const starting=entry.endpoint.start();
   void starting.then(()=>{if(entry.cancelled)void Promise.resolve().then(()=>entry.endpoint?.close()).catch(()=>{});},()=>{});
   await this.bounded(starting,this.options.startupTimeoutMs??15000,entry.abort.signal);
   await this.validate(entry,entry.authority);
   if(entry.cancelled||this.closed)throw new Refusal('MANAGER_STOPPED');
   entry.state='running';return {...entry.authority};
  }catch(error){
   try{await this.dispose(entry);}catch{throw new Refusal('MANAGER_START_CLEANUP_REQUIRED');}
   if(error instanceof Refusal)throw error;
   throw new Refusal('MANAGER_ENDPOINT_START_FAILED');
  }
 }
 /** Synchronous API routing hint only. Never substitutes for Ledger.fence. */
 authority(contextId:string):Authority|undefined{
  const entry=this.entries.get(contextId);
  if(!entry||entry.state!=='running'||entry.cancelled||this.closed||invalidAuthorityErrors.has(entry.endpoint?.lastError??''))return undefined;
  return entry.authority?{...entry.authority}:undefined;
 }
 async status(contextId:string){
  Id.parse(contextId);const entry=this.entries.get(contextId);
  if(!entry)return {contextId,state:'stopped' as const};
  if(entry.state!=='running')return {contextId,state:entry.state};
  try{await this.validate(entry,entry.authority);
   if(entry.cancelled||this.closed||entry.state!=='running'||this.entries.get(contextId)!==entry)return {contextId,state:'stopped' as const};
   if(invalidAuthorityErrors.has(entry.endpoint?.lastError??''))throw new Refusal('MANAGER_ENDPOINT_REVOKED');
   if(entry.endpoint?.connectionState?.()==='disconnected')return {contextId,state:'disconnected' as const,profileId:entry.input.profileId,epoch:entry.authority!.epoch};
   return {contextId,state:'running' as const,profileId:entry.input.profileId,epoch:entry.authority!.epoch};
  }catch{
   try{await this.dispose(entry);}catch{throw new Refusal('MANAGER_STOP_CLEANUP_REQUIRED');}
   return {contextId,state:'revoked' as const};
  }
 }
 async stop(contextId:string){
  Id.parse(contextId);this.restarts.get(contextId)?.abort();const entry=this.entries.get(contextId);if(!entry)return {contextId,state:'stopped' as const};
  // A delayed start still checks canceled before exposing authority, and closes
  // its endpoint again when it eventually settles. Old fencing is revoked now.
  await this.dispose(entry);return {contextId,state:'stopped' as const};
 }
 async close(){
  this.closed=true;for(const guard of this.restarts.values())guard.abort();const results=await Promise.allSettled([...this.entries.values()].map(entry=>this.dispose(entry)));
  if(results.some(result=>result.status==='rejected'))throw new Refusal('MANAGER_SHUTDOWN_CLEANUP_REQUIRED');
 }
}

/** Reuses the existing native Happier endpoint. Credentials stay in this trusted
 * factory closure; only a private per-endpoint content-key copy reaches it. */
export function happierEndpointFactory(ledger:Ledger,runtime:CezarRuntime,boundary:HappierBoundary,
 options:{baseUrl:string;token:string;machineId:string}):ManagerEndpointFactory{
 return input=>new HappierEndpoint(ledger,runtime,boundary,{...options,principal:input.principal,sessionId:input.sessionId,
  authority:input.authority,key:input.key,keyVersion:input.keyVersion,encryptionVariant:input.encryptionVariant as EncryptionVariant});
}
