import type {Ledger} from './ledger.ts';
import type {UsageWindowsObservation} from '../upstream/cezar/packages/contract/src/usage-windows.ts';

const LIMIT=/usage.?limit|quota|rate.?limit|exhausted|PROVIDER_USAGE_LIMIT/i;
/** Phrases already recognized by the Claude usage-limit parser. */
const LIMIT_PHRASE=/\b(?:usage|rate|session|weekly|hourly)[\s-]?limit\b|\b\d+[\s-]hours?\s+limit\b|\brate[_-]?limit(?:_error|ed)?\b|\bquota\s+(?:exceeded|reached)\b|\bout\s+of\s+(?:credits|quota)\b/i;
const CLAUDE_MARKER=/claude(?:\s+ai)?\s+usage\s+limit\s+reached\s*\|\s*(\d{9,16})/i;
const RESET_AT=/(?:resets?|reset[s]?\s+at|try\s+again|retry|available\s+again|unlocks?)\b[^\n]{0,24}?\b(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)/i;
const RESET_IN=/(?:try\s+again|retry|resets?|available\s+again)\b[^\n]{0,16}?\b(?:in|after)\s+(\d{1,7})\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
const RETRY_AFTER=/\bretry[-_\s]?after\b\s*[:=]?\s*(\d{1,7})\b/i;
const UNIT_MS:Record<string,number>={s:1000,sec:1000,secs:1000,second:1000,seconds:1000,m:60000,min:60000,mins:60000,minute:60000,minutes:60000,h:3600000,hr:3600000,hrs:3600000,hour:3600000,hours:3600000};
const MAX_WAIT_MS=7*24*60*60*1000;
export function isProviderLimit(code:string|null|undefined){return Boolean(code&&LIMIT.test(code));}

function usableReset(ms:number,now:number){return Number.isFinite(ms)&&ms>now&&ms-now<=MAX_WAIT_MS;}

function readReset(text:string,now:number){
 const marker=CLAUDE_MARKER.exec(text);
 if(marker){const raw=Number(marker[1]);const ms=raw>=1e12?raw:raw*1000;if(usableReset(ms,now))return Math.floor(ms);}
 if(!LIMIT_PHRASE.test(text)&&!/\blimit\b/i.test(text))return null;
 const at=RESET_AT.exec(text);
 if(at){const stamp=at[1]!.includes('T')?at[1]!:at[1]!.replace(' ','T');const parsed=Date.parse(stamp.includes('T')?stamp:`${stamp}T00:00`);if(usableReset(parsed,now))return Math.floor(parsed);}
 const relative=RESET_IN.exec(text);
 if(relative){const unit=UNIT_MS[relative[2]!.toLowerCase()];if(unit!==undefined&&usableReset(now+Number(relative[1])*unit,now))return Math.floor(now+Number(relative[1])*unit);}
 const header=RETRY_AFTER.exec(text);
 if(header&&usableReset(now+Number(header[1])*1000,now))return Math.floor(now+Number(header[1])*1000);
 return null;
}

function isClaudeLimitText(text:string){return CLAUDE_MARKER.test(text)||LIMIT_PHRASE.test(text)||(/\blimit\b/i.test(text)&&RESET_AT.test(text));}
/** Phrases `codex exec` prints when the ChatGPT allowance is spent. */
const CODEX_LIMIT=/you(?:'|’)ve hit your usage limit|\bcodex\b[^\n]{0,48}\busage\s+limit\b|\busage_limit_reached\b/i;
function isCodexLimitText(text:string){return CODEX_LIMIT.test(text)||LIMIT_PHRASE.test(text)||(/\blimit\b/i.test(text)&&RESET_AT.test(text));}

/** Claude CLI limit text from a result, stderr tail, or error event. No reset means wait one hour. */
export function claudeLimitFromText(texts:readonly (string|null|undefined)[],now=Date.now()):{failureCode:'PROVIDER_USAGE_LIMIT';usageWindows:UsageWindowsObservation|null}|null{
 const text=texts.filter((item):item is string=>typeof item==='string'&&item.trim().length>0).join('\n');
 if(!text||!isClaudeLimitText(text))return null;
 const resetsAt=readReset(text,now);
 const usageWindows=resetsAt===null?null:{provider:'claude' as const,source:'claude-stream' as const,observedAt:now,windows:[{id:'terminal-limit',kind:'other' as const,applicability:'all' as const,models:[],resetsAt,durationMinutes:null,usedPercent:100,status:'blocked' as const,observedAt:now}]};
 return {failureCode:'PROVIDER_USAGE_LIMIT',usageWindows};
}

/** Codex CLI limit text from stdout or stderr. No reset means wait one hour. */
export function codexLimitFromText(texts:readonly (string|null|undefined)[],now=Date.now()):{failureCode:'PROVIDER_USAGE_LIMIT';usageWindows:UsageWindowsObservation|null}|null{
 const text=texts.filter((item):item is string=>typeof item==='string'&&item.trim().length>0).join('\n');
 if(!text||!isCodexLimitText(text))return null;
 const resetsAt=readReset(text,now);
 const usageWindows=resetsAt===null?null:{provider:'codex' as const,source:'codex-notification' as const,observedAt:now,windows:[{id:'terminal-limit',kind:'other' as const,applicability:'all' as const,models:[],resetsAt,durationMinutes:null,usedPercent:100,status:'blocked' as const,observedAt:now}]};
 return {failureCode:'PROVIDER_USAGE_LIMIT',usageWindows};
}

/** Keep a stream observation when it already names a future reset. */
export function preferredLimitUsage<T>(existing:T|null,parsed:T|null){return futureResetMs(existing)!==null?existing:parsed;}

export function claudeLimitNotice(until:Date){
 const hour=String(until.getHours()).padStart(2,'0'),minute=String(until.getMinutes()).padStart(2,'0');
 return `Limite do Claude atingido. Retomo sozinho às ${hour}:${minute}.`;
}

/** Earliest future reset instant carried on the observation, in epoch milliseconds. */
export function futureResetMs(usage:unknown,now=Date.now()){
 let found:number|null=null;
 const visit=(value:unknown,depth:number)=>{
  if(!value||typeof value!=='object'||depth>6)return;
  for(const [key,item] of Object.entries(value as Record<string,unknown>)){
   if(/reset/i.test(key)&&(typeof item==='number'||typeof item==='string')){
    const parsed=typeof item==='number'?item:Date.parse(item);
    if(Number.isFinite(parsed)){const ms=parsed>1e12?parsed:parsed>1e9?parsed*1000:NaN;if(usableReset(ms,now))found=found===null?ms:Math.min(found,ms);}
   }else if(item&&typeof item==='object')visit(item,depth+1);
  }
 };
 visit(usage,0);
 return found;
}

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

/** A provider limit waits until the recorded reset, then the same job may run again. */
export async function providerLimitDisposition(ledger:Ledger,accountId:string,failureCode:string|null|undefined,usage:unknown,now=Date.now()):Promise<'seal'|'wait'|'resume'>{
 if(!isProviderLimit(failureCode))return 'seal';
 const row=(await ledger.pool.query('SELECT exhausted_until FROM ac_accounts WHERE id=$1',[accountId])).rows[0];
 const current=row?.exhausted_until?new Date(row.exhausted_until).getTime():0;
 const future=futureResetMs(usage,now);
 if(future!==null&&(!current||current+1000<future)){await noteProviderExhaustion(ledger,accountId,usage);return 'wait';}
 if(!current){await noteProviderExhaustion(ledger,accountId,usage);return 'wait';}
 if(current>now)return 'wait';
 return 'resume';
}
