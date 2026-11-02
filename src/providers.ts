import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {Capacity,QuotaInput} from './capacity.ts';
import {Id,digest,Refusal} from './contracts.ts';
import {Ledger} from './ledger.ts';

export const ProviderAdapterId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/);
const Text=ProviderAdapterId;
export const ProviderBinding=z.object({accountId:Id,adapterId:Text,expectedRevision:z.number().int().nonnegative(),minimumIntervalSeconds:z.number().int().min(1).max(3600)}).strict();
const ProbeResult=z.object({status:QuotaInput.shape.status,ttlSeconds:z.number().int().min(1).max(3600),
 remainingPercent:z.number().min(0).max(100).nullable(),resetAt:z.iso.datetime().nullable()}).strict();
export type ProviderProbeResult=z.infer<typeof ProbeResult>;
const AdapterManifest=z.object({id:Text,version:Text,provider:Text,mode:z.literal('synthetic'),
 eligibility:z.literal('documented_supported'),source:z.string().regex(/^synthetic:\/\/[a-zA-Z0-9/._:-]+$/).max(300),
 timeoutMs:z.number().int().min(10).max(30000)}).strict();
export type ProviderAdapter={manifest:z.input<typeof AdapterManifest>;
 /** Read-only probe. No model generation, refresh, login or subprocess launch.
  * Real collectors need separate eligibility, credential custody and activation. */
 probe:(input:{accountId:string;signal:AbortSignal})=>Promise<ProviderProbeResult>};
const Stored=z.object({schemaVersion:z.literal(1),status:QuotaInput.shape.status,source:z.string().regex(/^synthetic:\/\/[a-zA-Z0-9/._:-]+$/).max(300),
 remainingPercent:z.number().min(0).max(100).nullable(),resetAt:z.iso.datetime().nullable(),
 failure:z.enum(['none','transport','invalid_response']),subscriptionBalance:z.enum(['reported','unknown'])}).strict();
type Stored=z.infer<typeof Stored>;
/** A receipt proves a past observation, not current subscription availability. */
export function projectProviderSnapshot(raw:unknown,expectedDigest:string,fresh:boolean):Stored{
 const parsed=Stored.safeParse(raw);
 if(!parsed.success||digest(parsed.data)!==expectedDigest)throw new Refusal('PROVIDER_OBSERVATION_CORRUPT');
 return fresh?parsed.data:{...parsed.data,status:'unknown',remainingPercent:null,subscriptionBalance:'unknown'};
}

/** Read-only collector frontier. Capacity remains the only admission authority,
 * Cezar remains the only workflow scheduler. Callers cannot submit CLI commands,
 * URLs, credential paths or raw observations through this interface. */
export class ProviderCollectors{
 private readonly adapters=new Map<string,{manifest:z.infer<typeof AdapterManifest>;hash:string;probe:ProviderAdapter['probe']}>();
 constructor(readonly ledger:Ledger,adapters:readonly ProviderAdapter[],private readonly client?:pg.PoolClient){
  for(const adapter of adapters){const manifest=AdapterManifest.parse(adapter.manifest);
   if(this.adapters.has(manifest.id))throw new Refusal('PROVIDER_ADAPTER_DUPLICATE');
   this.adapters.set(manifest.id,{manifest,hash:digest(manifest),probe:adapter.probe});}
 }
 private tx<T>(fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{return this.client?fn(this.client):this.ledger.tx(fn);}
 private async owner(c:import('pg').PoolClient,principal:string,projectId:string,accountId:string){
  const row=(await c.query(`SELECT a.* FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id
   JOIN ac_memberships m ON m.project_id=x.project_id WHERE a.id=$1 AND a.owner_id=$2 AND x.project_id=$3
   AND m.principal_id=$2 AND m.role='owner' FOR UPDATE OF a`,[accountId,principal,projectId])).rows[0];
  if(!row)throw new Refusal('ACCOUNT_FORBIDDEN',403);return row;
 }
 async bind(principal:string,projectId:string,raw:{accountId:string;adapterId:string;expectedRevision:number;minimumIntervalSeconds:number}){
  const input=ProviderBinding.parse(raw);
  Id.parse(projectId);const adapter=this.adapters.get(input.adapterId);if(!adapter)throw new Refusal('PROVIDER_ADAPTER_UNKNOWN');
  return this.tx(async c=>{
   const account=await this.owner(c,principal,projectId,input.accountId);
   if(account.provider!==adapter.manifest.provider||account.mode!==adapter.manifest.mode||
    account.eligibility!=='documented_supported')throw new Refusal('PROVIDER_MODE_INELIGIBLE');
   const old=(await c.query('SELECT * FROM ac_provider_bindings WHERE account_id=$1 FOR UPDATE',[input.accountId])).rows[0];
   if((old?.revision??0)!==input.expectedRevision)throw new Refusal('PROVIDER_BINDING_CONFLICT');
   if(old?.lease_id)throw new Refusal('PROVIDER_PROBE_IN_PROGRESS');
   const revision=input.expectedRevision+1;
   await c.query(`INSERT INTO ac_provider_bindings(account_id,adapter_id,adapter_version,adapter_digest,revision,minimum_interval_seconds)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id) DO UPDATE SET adapter_id=$2,adapter_version=$3,
    adapter_digest=$4,revision=$5,minimum_interval_seconds=$6`,
    [input.accountId,adapter.manifest.id,adapter.manifest.version,adapter.hash,revision,input.minimumIntervalSeconds]);
   // A changed collector never inherits a previous collector's optimistic quota.
   await new Capacity(this.ledger,c).observeQuota(principal,input.accountId,{status:'unknown',source:'collector:binding_changed',ttlSeconds:1});
   return {revision};
  });
 }
 async collect(principal:string,projectId:string,accountId:string,observationId:string){
  if(this.client)throw new Refusal('PROVIDER_COLLECTION_TRANSACTION_FORBIDDEN');
  Id.parse(projectId);Id.parse(accountId);Id.parse(observationId);
  const admitted=await this.ledger.tx(async c=>{
   const account=await this.owner(c,principal,projectId,accountId);
   const binding=(await c.query('SELECT *,lease_until>clock_timestamp() live,last_started_at+minimum_interval_seconds*interval \'1 second\'>clock_timestamp() throttled FROM ac_provider_bindings WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
   if(!binding)throw new Refusal('PROVIDER_BINDING_REQUIRED');
   const adapter=this.adapters.get(binding.adapter_id);
   if(!adapter||adapter.hash!==binding.adapter_digest||adapter.manifest.version!==binding.adapter_version)throw new Refusal('PROVIDER_ADAPTER_VERSION_CHANGED');
   if(account.provider!==adapter.manifest.provider||account.mode!==adapter.manifest.mode||
    account.eligibility!=='documented_supported'||!account.enabled)throw new Refusal('PROVIDER_MODE_INELIGIBLE');
   const prior=(await c.query('SELECT *,expires_at>clock_timestamp() fresh FROM ac_provider_observations WHERE id=$1',[observationId])).rows[0];
   if(prior){
    if(prior.account_id!==accountId||prior.adapter_digest!==adapter.hash||prior.binding_revision!==binding.revision)throw new Refusal('PROVIDER_OBSERVATION_CONFLICT');
    if(prior.state!=='completed')throw new Refusal('PROVIDER_PROBE_UNCERTAIN');
    const snapshot=projectProviderSnapshot(prior.snapshot,prior.digest,prior.fresh===true);
    return {duplicate:true as const,snapshot,expiresAt:prior.expires_at};
   }
   if(binding.probe_uncertain||binding.lease_id&&!binding.live)throw new Refusal('PROVIDER_PROBE_UNCERTAIN');
   if(binding.live)throw new Refusal('PROVIDER_PROBE_IN_PROGRESS');
   if(binding.throttled)throw new Refusal('PROVIDER_PROBE_THROTTLED');
   // A crashed collector may still have an external request in flight. An
   // expired lease therefore requires trusted reconciliation, never a new probe.
   const leaseId=randomUUID();
   await c.query(`UPDATE ac_provider_bindings SET lease_id=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',last_started_at=clock_timestamp() WHERE account_id=$1`,[accountId,leaseId,adapter.manifest.timeoutMs+1000]);
   await c.query(`INSERT INTO ac_provider_observations(id,account_id,adapter_digest,binding_revision,state,lease_id) VALUES($1,$2,$3,$4,'collecting',$5)`,[observationId,accountId,adapter.hash,binding.revision,leaseId]);
   return {duplicate:false as const,adapter,leaseId,revision:binding.revision as number};
  });
  if(admitted.duplicate)return admitted;
  const controller=new AbortController();let timeout:ReturnType<typeof setTimeout>|undefined;
  let outcome:ProviderProbeResult,failure:Stored['failure']='none',timedOut=false;
  try{
   const raw=await Promise.race([Promise.resolve().then(()=>admitted.adapter.probe({accountId,signal:controller.signal})),
    new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{timedOut=true;controller.abort();reject(new Error('timeout'));},admitted.adapter.manifest.timeoutMs);})]);
   const parsed=ProbeResult.safeParse(raw);
   if(!parsed.success){failure='invalid_response';outcome={status:'configuration_error',ttlSeconds:30,remainingPercent:null,resetAt:null};}
   else outcome=parsed.data;
  }catch{failure='transport';outcome={status:'unreachable',ttlSeconds:30,remainingPercent:null,resetAt:null};}
  finally{if(timeout)clearTimeout(timeout);controller.abort();}
  // Unavailable/unknown results do not display a stale reported percentage.
  const remainingPercent=['available','exhausted','rate_limited'].includes(outcome.status)?outcome.remainingPercent:null;
  const snapshot:Stored={schemaVersion:1,status:outcome.status,source:admitted.adapter.manifest.source,
   remainingPercent,resetAt:outcome.resetAt,failure,subscriptionBalance:remainingPercent===null?'unknown':'reported'};
  return this.tx(async c=>{
   const account=await this.owner(c,principal,projectId,accountId);
   const binding=(await c.query('SELECT *,lease_until>clock_timestamp() live FROM ac_provider_bindings WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
   if(!binding||binding.lease_id!==admitted.leaseId||binding.revision!==admitted.revision||!binding.live)throw new Refusal('PROVIDER_PROBE_SUPERSEDED');
   if(!account.enabled||account.eligibility!=='documented_supported')throw new Refusal('PROVIDER_MODE_INELIGIBLE');
   await new Capacity(this.ledger,c).observeQuota(principal,accountId,{status:outcome.status,source:`collector:${admitted.adapter.manifest.id}`,ttlSeconds:outcome.ttlSeconds});
   const row=(await c.query(`UPDATE ac_provider_observations SET state='completed',snapshot=$2,digest=$3,
    completed_at=clock_timestamp(),expires_at=clock_timestamp()+$4*interval '1 second' WHERE id=$1 AND state='collecting' RETURNING expires_at`,
    [observationId,snapshot,digest(snapshot),outcome.ttlSeconds])).rows[0];
   if(!row)throw new Refusal('PROVIDER_PROBE_SUPERSEDED');
   // An AbortSignal is a request, not proof the collector stopped. Keep the
   // binding quarantined after timeout rather than creating a probe storm.
   if(timedOut)await c.query('UPDATE ac_provider_bindings SET probe_uncertain=true WHERE account_id=$1',[accountId]);
   else await c.query('UPDATE ac_provider_bindings SET lease_id=NULL,lease_until=NULL,probe_uncertain=false WHERE account_id=$1',[accountId]);
   return {duplicate:false,snapshot,expiresAt:row.expires_at};
  });
 }
 async latest(principal:string,projectId:string,accountId:string){
  Id.parse(projectId);Id.parse(accountId);
  return this.tx(async c=>{
   await this.owner(c,principal,projectId,accountId);
   const row=(await c.query(`SELECT o.*,o.expires_at>clock_timestamp() fresh FROM ac_provider_observations o
    JOIN ac_provider_bindings b ON b.account_id=o.account_id AND b.revision=o.binding_revision AND b.adapter_digest=o.adapter_digest
    WHERE o.account_id=$1 AND o.state='completed' ORDER BY o.completed_at DESC LIMIT 1`,[accountId])).rows[0];
   if(!row)return {status:'unknown',remainingPercent:null,subscriptionBalance:'unknown',fresh:false,observedAt:null,expiresAt:null};
   const snapshot=projectProviderSnapshot(row.snapshot,row.digest,row.fresh===true);
   return {...snapshot,status:row.fresh?snapshot.status:'unknown',remainingPercent:row.fresh?snapshot.remainingPercent:null,
    subscriptionBalance:row.fresh?snapshot.subscriptionBalance:'unknown',fresh:row.fresh as boolean,observedAt:row.completed_at,expiresAt:row.expires_at};
  });
 }
}
