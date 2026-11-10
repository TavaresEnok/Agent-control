import type {Ledger} from './ledger.ts';

const LIMIT=/usage.?limit|quota|rate.?limit|exhausted|PROVIDER_USAGE_LIMIT/i;
export function isProviderLimit(code:string|null|undefined){return Boolean(code&&LIMIT.test(code));}

/** Prefer a reset instant carried by the provider observation. Otherwise wait one hour. */
export function resetFromUsage(usage:unknown){
 let reset=Date.now()+60*60*1000;
 const visit=(value:unknown,depth:number)=>{
  if(!value||typeof value!=='object'||depth>6)return;
  for(const [key,item] of Object.entries(value as Record<string,unknown>)){
   if(/reset/i.test(key)&&(typeof item==='number'||typeof item==='string')){
    const parsed=typeof item==='number'?item:Date.parse(item);
    if(Number.isFinite(parsed)){const ms=parsed>1e12?parsed:parsed>1e9?parsed*1000:NaN;if(ms>Date.now())reset=Math.min(reset,ms);}
   }else if(item&&typeof item==='object')visit(item,depth+1);
  }
 };
 visit(usage,0);
 return new Date(reset);
}

export async function noteProviderExhaustion(ledger:Ledger,accountId:string,usage?:unknown){
 const until=resetFromUsage(usage);
 await ledger.pool.query('UPDATE ac_accounts SET exhausted_until=$2 WHERE id=$1 AND (exhausted_until IS NULL OR exhausted_until<$2)',[accountId,until.toISOString()]);
}
