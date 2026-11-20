/** Parsers accept JSONL contents only; no messages or credentials are returned. */
export type UsageRow={provider:string;model:string;effort:string;role:string;input:number|null;cache:number|null;output:number|null;calls:number|null;
 /** Present only when the numbers cannot be trusted: the window has no known starting counter. */
 state?:'medição insuficiente'};
export type Window={from?:string;to?:string};
type Obj=Record<string,any>;
const num=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const lines=(s:string):Obj[]=>s.split(/\r?\n/).flatMap(line=>{try{const v=JSON.parse(line);return v&&typeof v==='object'?[v]:[];}catch{return [];}});
const inWindow=(timestamp:unknown,w:Window)=>{const t=typeof timestamp==='string'?Date.parse(timestamp):NaN;return Number.isFinite(t)&&(!w.from||t>=Date.parse(w.from))&&(!w.to||t<Date.parse(w.to));};
const counters=(o:Obj)=>({input:num(o.input_tokens),cache:num(o.cached_input_tokens),output:num(o.output_tokens)});
/**
 * Codex counters are cumulative per session, so a window is the sum of the increments between consecutive readings, taking as
 * its base the last reading BEFORE the window. A counter that goes down is a restart: the new value counts in full.
 * With no earlier reading the base is zero only when the file itself proves the session began (a `session_meta` line at or
 * before the first reading) or when the window has no start; otherwise the row says `medição insuficiente` and carries no numbers.
 */
export function readCodex(text:string,w:Window={}):UsageRow[]{
 const lo=w.from?Date.parse(w.from):-Infinity,hi=w.to?Date.parse(w.to):Infinity;
 if(Number.isNaN(lo)||Number.isNaN(hi))return [];
 const windowed=Boolean(w.from||w.to);
 let model='desconhecido',effort='desconhecido',sessionStart:number|null=null;
 const readings:{time:number;model:string;effort:string;v:ReturnType<typeof counters>}[]=[];
 for(const e of lines(text)){
  if(e.type==='session_meta'&&sessionStart===null){const t=Date.parse(typeof e.payload?.timestamp==='string'?e.payload.timestamp:e.timestamp);sessionStart=Number.isFinite(t)?t:-Infinity;}
  if(e.type==='turn_context'){model=typeof e.payload?.model==='string'?e.payload.model:model;effort=typeof e.payload?.effort==='string'?e.payload.effort:effort;}
  if(e.type!=='event_msg'||e.payload?.type!=='token_count'||!e.payload.info?.total_token_usage)continue;
  const time=Date.parse(e.timestamp);
  if(windowed&&!Number.isFinite(time))continue;
  readings.push({time:Number.isFinite(time)?time:0,model,effort,v:counters(e.payload.info.total_token_usage)});
 }
 readings.sort((a,b)=>a.time-b.time);
 const inside=readings.filter(r=>r.time>=lo&&r.time<hi);
 if(!inside.length)return [];
 const before=readings.filter(r=>r.time<lo).at(-1);
 const last=inside.at(-1)!;
 // Without a window start the counter began at the session start, which is zero. With one, only a proven start gives a zero base.
 const provenStart=!Number.isFinite(lo)||(sessionStart!==null&&sessionStart<=inside[0]!.time);
 let insufficient=false;
 const sum=(k:'input'|'cache'|'output'):number|null=>{
  let prev:number|null=before?before.v[k]:provenStart?0:null;
  if(prev===null){insufficient=true;return null;}
  let total=0;
  for(const r of inside){const cur=r.v[k];if(cur===null)return null;total+=cur>=prev?cur-prev:cur;prev=cur;}
  return total;
 };
 const row:UsageRow={provider:'codex',model:inside.every(e=>e.model===last.model)?last.model:'desconhecido',effort:inside.every(e=>e.effort===last.effort)?last.effort:'desconhecido',role:'desconhecido',input:sum('input'),cache:sum('cache'),output:sum('output'),calls:null};
 if(insufficient)row.state='medição insuficiente';
 return [row];
}
/** Deduplicate Claude stream records by message ID, using the final record. */
export function readClaude(text:string,w:Window={}):UsageRow[]{
 const messages=new Map<string,Obj>();let index=0;
 for(const e of lines(text)){if(e.type!=='assistant'||!e.message?.usage||e.message.model==='<synthetic>'||((w.from||w.to)&&!inWindow(e.timestamp,w)))continue;
  messages.set(typeof e.message.id==='string'?e.message.id:`anonymous-${index++}`,e.message);}
 const grouped=new Map<string,UsageRow>();
 for(const m of messages.values()){
  const model=typeof m.model==='string'?m.model:'desconhecido';let row=grouped.get(model);if(!row){row={provider:'claude',model,effort:'desconhecido',role:'desconhecido',input:0,cache:0,output:0,calls:0};grouped.set(model,row);}
  const u=m.usage;const add=(old:number|null,value:number|null)=>old===null||value===null?null:old+value;
  row.input=add(row.input,num(u.input_tokens));row.output=add(row.output,num(u.output_tokens));
  const read=num(u.cache_read_input_tokens),creation=num(u.cache_creation_input_tokens);
  row.cache=add(row.cache,read===null||creation===null?null:read+creation);row.calls=(row.calls??0)+1;
 }
 return [...grouped.values()];
}
/** No documented, verified token accounting format has been identified for agy. */
export function readAntigravity():UsageRow[]{return [{provider:'antigravity',model:'desconhecido',effort:'desconhecido',role:'desconhecido',input:null,cache:null,output:null,calls:null}];}
