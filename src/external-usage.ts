/** Parsers accept JSONL contents only; no messages or credentials are returned. */
export type UsageRow={provider:string;model:string;effort:string;role:string;input:number|null;cache:number|null;output:number|null;calls:number|null};
export type Window={from?:string;to?:string};
type Obj=Record<string,any>;
const num=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const lines=(s:string):Obj[]=>s.split(/\r?\n/).flatMap(line=>{try{const v=JSON.parse(line);return v&&typeof v==='object'?[v]:[];}catch{return [];}});
const inWindow=(timestamp:unknown,w:Window)=>{const t=typeof timestamp==='string'?Date.parse(timestamp):NaN;return Number.isFinite(t)&&(!w.from||t>=Date.parse(w.from))&&(!w.to||t<Date.parse(w.to));};
const counters=(o:Obj)=>({input:num(o.input_tokens),cache:num(o.cached_input_tokens),output:num(o.output_tokens)});
/** A bounded window is the difference of the first and last readings inside it. */
export function readCodex(text:string,w:Window={}):UsageRow[]{
 let model='desconhecido',effort='desconhecido';const events:{time:number;model:string;effort:string;v:ReturnType<typeof counters>}[]=[];
 for(const e of lines(text)){
  if(e.type==='turn_context'){model=typeof e.payload?.model==='string'?e.payload.model:model;effort=typeof e.payload?.effort==='string'?e.payload.effort:effort;}
  if(e.type!=='event_msg'||e.payload?.type!=='token_count'||!e.payload.info?.total_token_usage)continue;
  if((w.from||w.to)&&!inWindow(e.timestamp,w))continue;
  events.push({time:Date.parse(e.timestamp)||0,model,effort,v:counters(e.payload.info.total_token_usage)});
 }
 if(!events.length)return [];events.sort((a,b)=>a.time-b.time);const first=events[0]!,last=events.at(-1)!;
 const delta=(k:'input'|'cache'|'output')=>{const a=last.v[k],b=first.v[k];return !w.from&&!w.to?a:a===null||b===null||a<b?null:a-b;};
 return [{provider:'codex',model:events.every(e=>e.model===last.model)?last.model:'desconhecido',effort:events.every(e=>e.effort===last.effort)?last.effort:'desconhecido',role:'desconhecido',input:delta('input'),cache:delta('cache'),output:delta('output'),calls:null}];
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
