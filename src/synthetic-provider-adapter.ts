import {z} from 'zod';
import {ProviderAdapterId,type ProviderAdapter} from './providers.ts';
import {QuotaInput} from './capacity.ts';
/** Explicit fixture protocol. Never decode this as official subscription evidence. */
export const SyntheticQuotaReply=z.object({protocol:z.literal('ac-synthetic-quota-v1'),accountId:z.uuid(),provider:ProviderAdapterId,
 status:QuotaInput.shape.status,remainingPercent:z.number().min(0).max(100).nullable(),resetAt:z.iso.datetime().nullable()}).strict();
export function createSyntheticProviderAdapter(options:{id:string;provider:string;version:string;timeoutMs?:number;
 runner(input:{accountId:string;signal:AbortSignal}):Promise<unknown>}):ProviderAdapter{
 const id=ProviderAdapterId.parse(options.id),provider=ProviderAdapterId.parse(options.provider),version=ProviderAdapterId.parse(options.version);
 return {manifest:{id,provider,version,mode:'synthetic',eligibility:'documented_supported',source:'synthetic://quota/'+id,timeoutMs:options.timeoutMs??1000},
  probe:async input=>{
   const unknown={status:'unknown' as const,ttlSeconds:30,remainingPercent:null,resetAt:null};
   if(input.signal.aborted)return {...unknown,status:'unreachable'};
   let raw:unknown;try{raw=await options.runner(input);}catch{return {...unknown,status:'unreachable'};}
   if(input.signal.aborted)return {...unknown,status:'unreachable'};
   const reply=SyntheticQuotaReply.safeParse(raw);
   if(!reply.success||reply.data.accountId!==input.accountId||reply.data.provider!==provider)return unknown;
   const q=reply.data,reported=['available','exhausted','rate_limited'].includes(q.status);
   return {status:q.status,ttlSeconds:60,remainingPercent:reported?q.remainingPercent:null,resetAt:reported?q.resetAt:null};
  }};
}
