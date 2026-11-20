import type {z} from 'zod';
import type {UsageCounters} from './usage.ts';

export type UsageCountersValue = z.infer<typeof UsageCounters>;
/** The UI event carries cumulative provider counters; cache and reasoning overlap other fields. */
export function usageCountersFromEvent(usage:{input:number;output:number;cacheRead?:number;cacheWrite?:number;reasoning?:number},cacheReadOnly=false):UsageCountersValue {
 const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:null;
 // Both cache counters must be known before combining them; a partial sum is misleading.
 const read=count(usage.cacheRead),write=count(usage.cacheWrite);
 return {input:count(usage.input),output:count(usage.output),cache:read!==null&&write!==null&&Number.isSafeInteger(read+write)?read+write:cacheReadOnly?read:null,reasoning:count(usage.reasoning)};
}
