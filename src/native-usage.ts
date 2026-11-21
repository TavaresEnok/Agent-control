import type {z} from 'zod';
import type {UsageCounters} from './usage.ts';

export type UsageCountersValue = z.infer<typeof UsageCounters>;
/** Separate invocations have independent counters; unknown components remain unknown. */
export function sumUsageAttempts(a:UsageCountersValue|null,b:UsageCountersValue|null):UsageCountersValue {
 const sum=(x:number|null|undefined,y:number|null|undefined)=>x==null||y==null||!Number.isSafeInteger(x+y)?null:x+y;
 const split=(key:'cacheRead'|'cacheWrite')=>a?.[key]===undefined&&b?.[key]===undefined?{}:{[key]:sum(a?.[key]??null,b?.[key]??null)};
 return {input:sum(a?.input,b?.input),output:sum(a?.output,b?.output),cache:sum(a?.cache,b?.cache),reasoning:sum(a?.reasoning,b?.reasoning),...split('cacheRead'),...split('cacheWrite')};
}
/** The UI event carries cumulative provider counters; cache and reasoning overlap other fields. */
export function usageCountersFromEvent(usage:{input:number;output:number;cacheRead?:number;cacheWrite?:number;reasoning?:number},cacheReadOnly=false):UsageCountersValue {
 const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:null;
 // Both cache counters must be known before combining them; a partial sum is misleading.
 const read=count(usage.cacheRead),write=count(usage.cacheWrite);
 return {input:count(usage.input),output:count(usage.output),cache:read!==null&&write!==null&&Number.isSafeInteger(read+write)?read+write:cacheReadOnly?read:null,reasoning:count(usage.reasoning),
  ...(cacheReadOnly?{}:{cacheRead:read,cacheWrite:write})};
}
