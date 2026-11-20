import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {estimateTokens,type RepoMapOptions} from './repo-map.ts';

const execFileAsync=promisify(execFile);

/**
 * Manager discipline (T6): the panel manager keeps its context small and deterministic.
 * Everything here is pure or bounded; nothing changes the answer/plan decision.
 */
export type ManagerDiscipline={enabled:boolean;contextTokens:number;measure:boolean;projectId?:string;dataDirectory?:string};
export const DEFAULT_MANAGER_CONTEXT_TOKENS=2500;
export type HistoryMessage={role:'owner'|'manager';text:string};

export type CompactHistoryOptions={
 /** Number of most recent messages kept whole (up to fullChars each). */
 recentFull?:number;fullChars?:number;
 /** Older messages are cut to this many characters, or to pendingChars when they carry a pending decision. */
 olderChars?:number;pendingChars?:number;
 /** Hard cap for the whole block. Oldest lines go first. */
 budgetChars?:number;
};
const PENDING=/(aprov|descart|proposta|pendente|confirm|aguard|\?\s*$)/i;
const oneLine=(text:string)=>text.replace(/\s+/g,' ').trim();
const clip=(text:string,max:number)=>text.length<=max?text:text.slice(0,Math.max(0,max-1)).trimEnd()+'…';

/**
 * Recent messages whole, older ones shortened. A message that looks like a pending
 * decision (proposal, approval, question to the owner) keeps a longer excerpt.
 * The block never exceeds budgetChars; when lines must go, the oldest go first.
 */
export function compactConversation(messages:readonly HistoryMessage[],options:CompactHistoryOptions={}):string{
 const recentFull=options.recentFull??4,fullChars=options.fullChars??1200,olderChars=options.olderChars??160,pendingChars=options.pendingChars??400,budget=options.budgetChars??4000;
 const lines=messages.map((message,index)=>{
  const recent=index>=messages.length-recentFull;
  const text=recent?message.text.trim():oneLine(message.text);
  const limit=recent?fullChars:PENDING.test(text)?pendingChars:olderChars;
  return (message.role==='owner'?'Titular: ':'Gerente: ')+clip(text,limit);
 });
 // The newest message is the one the manager is most likely to answer: never drop it. Drop from the oldest.
 let dropped=0,total=lines.reduce((sum,line)=>sum+line.length+1,0);
 while(lines.length>1&&total>budget){total-=lines[0]!.length+1;lines.shift();dropped++;}
 if(lines.length===1&&lines[0]!.length>budget)lines[0]=clip(lines[0]!,budget);
 return (dropped?`(${dropped} mensagens mais antigas omitidas)\n`:'')+lines.join('\n');
}

/** Messages shown to the manager. The message being decided now is excluded: it is sent whole on its own. */
export function historyBeforeCurrent(page:readonly {id:string;role:'owner'|'manager';text:string}[],current:{localId:string;text:string}):HistoryMessage[]{
 const rows=page.filter(row=>row.text.trim()&&!row.id.endsWith('|'+current.localId));
 const foundById=rows.length<page.filter(row=>row.text.trim()).length;
 // Fallback by text only when the current message was not found by id (stored under another id). Found by id, an earlier
 // message with the same text is a real earlier message and stays.
 const last=rows.at(-1);
 if(!foundById&&last&&last.role==='owner'&&last.text.trim()===current.text.trim())rows.pop();
 return rows.map(row=>({role:row.role,text:row.text}));
}

export type RepoMapChildResult={map:string|null;reason?:string};
export type RepoMapGenerator=(options:RepoMapOptions)=>Promise<RepoMapChildResult>;
/** Upper bound for a cold map build. A slower repository falls back to the legacy listing instead of stalling the manager. */
export const MAP_CHILD_TIMEOUT_MS=10_000;
const MAP_FAILURE_COOLDOWN_MS=60_000;

/**
 * Builds the map in a child process (same worker as native jobs). The map code reads git with execFileSync, which would
 * block the server's event loop (lease heartbeats, HTTP, other projects) for seconds on a cold cache. Never throws.
 */
export async function generateRepoMapInChild(options:RepoMapOptions,timeoutMs=MAP_CHILD_TIMEOUT_MS):Promise<RepoMapChildResult>{
 try{
  const script=fileURLToPath(new URL('./repo-map-worker.ts',import.meta.url));
  const {stdout}=await execFileAsync(process.execPath,['--import','tsx',script,JSON.stringify(options)],{timeout:timeoutMs,maxBuffer:256*1024,cwd:fileURLToPath(new URL('..',import.meta.url))});
  const result=JSON.parse(stdout) as {map?:unknown};
  return typeof result.map==='string'&&result.map?{map:result.map}:{map:null,reason:'EMPTY_MAP'};
 }catch(error){
  return {map:null,reason:(error as {killed?:boolean}).killed?'MAP_TIMEOUT':error instanceof Error?error.message:String(error)};
 }
}

const mapMemo=new Map<string,string>();
const mapFailures=new Map<string,number>();
async function headOf(repo:string):Promise<string|null>{
 try{return (await execFileAsync('git',['-C',repo,'rev-parse','--verify','HEAD'],{timeout:3000,maxBuffer:4096})).stdout.trim()||null;}catch{return null;}
}
/** Test hook: forget the in-memory memo and the failure cool-down. */
export function resetManagerMapMemory():void{mapMemo.clear();mapFailures.clear();}

/**
 * Compact repository context for the manager: README head and the cached repository map within a token budget.
 * The map is built off the event loop (child process with a time limit), remembered per commit in memory, and a
 * failed or slow build is not retried for a minute. Falls back to the caller's raw context when the map is unavailable.
 */
export async function managerRepositoryContext(repo:string,discipline:ManagerDiscipline,fallback:()=>Promise<string>,deps:{generate?:RepoMapGenerator;now?:()=>number}={}):Promise<string>{
 if(!discipline.enabled)return fallback();
 const generate=deps.generate??generateRepoMapInChild,now=deps.now??Date.now;
 const budget=Math.max(500,discipline.contextTokens);
 let readme='';
 try{readme=(await readFile(join(repo,'README.md'),'utf8')).slice(0,1200).trim();}catch{readme='';}
 const mapBudget=Math.max(300,budget-estimateTokens(readme)-40);
 const head=await headOf(repo);
 const key=head?[repo,head,mapBudget,discipline.projectId??''].join('\0'):null;
 let map=key?mapMemo.get(key)??null:null;
 if(!map){
  const failedAt=mapFailures.get(repo);
  if(failedAt!==undefined&&now()-failedAt<MAP_FAILURE_COOLDOWN_MS)return fallback();
  const result=await generate({repoPath:repo,projectId:discipline.projectId,dataDirectory:discipline.dataDirectory,budgetTokens:mapBudget,useCache:true});
  if(!result.map){mapFailures.set(repo,now());return fallback();}
  mapFailures.delete(repo);
  map=result.map;
  if(key){if(mapMemo.size>=16)mapMemo.delete(mapMemo.keys().next().value as string);mapMemo.set(key,map);}
 }
 return 'Mapa compacto do repositório (assinaturas e arquivos mais referenciados; peça um arquivo específico se precisar do conteúdo):\n'+map+(readme?'\n\nREADME (início):\n'+readme:'');
}

/** Resolves with the promise, or with `fallback` after `ms`. The slow promise is left to finish on its own. */
export async function withinMs<T>(promise:Promise<T>,ms:number,fallback:T):Promise<T>{
 let timer:NodeJS.Timeout|undefined;
 try{return await Promise.race([promise.catch(()=>fallback),new Promise<T>(resolve=>{timer=setTimeout(()=>resolve(fallback),ms);timer.unref?.();})]);}
 finally{if(timer)clearTimeout(timer);}
}
/** Longest wait for the panel history before the manager decides without it. */
export const HISTORY_READ_TIMEOUT_MS=2500;

/** Tokens the CLI reported, if its text output says so. Total only: the split is not exposed. */
export function parseReportedTokens(provider:string,stdout:string,stderr:string):number|null{
 if(provider!=='codex')return null;
 const found=/tokens used[:\s]+([\d.,]+)/i.exec(stderr+'\n'+stdout);
 if(!found)return null;
 const value=Number(found[1]!.replace(/[.,]/g,''));
 return Number.isSafeInteger(value)&&value>=0?value:null;
}

export type ManagerUsage={input:number|null;output:number|null;total:number|null;estimated:boolean};
/** Reported total when the CLI gave one; otherwise a size-based estimate, marked as estimated. */
export function managerUsage(provider:string,prompt:string,stdout:string,stderr:string):ManagerUsage{
 const reported=parseReportedTokens(provider,stdout,stderr);
 if(reported!==null)return {input:null,output:null,total:reported,estimated:false};
 return {input:estimateTokens(prompt),output:estimateTokens(stdout),total:null,estimated:true};
}

/**
 * Wait that grows from baseMs by `factor` up to maxMs. attempt starts at 0.
 * Detection delay never exceeds maxMs, which callers choose to keep their deadline.
 */
export function backoffMs(attempt:number,baseMs:number,maxMs:number,factor=1.5):number{
 return Math.min(maxMs,Math.round(baseMs*Math.pow(factor,Math.max(0,attempt))));
}

/** Last lines of a log for a model, with a pointer to the complete file. */
export function tailForModel(text:string,fileHint:string,maxLines=40,maxChars=4000):string{
 const lines=text.split(/\r?\n/);
 while(lines.length&&!lines.at(-1))lines.pop();
 let kept=lines.slice(-maxLines),cut=lines.length-kept.length;
 let body=kept.join('\n');
 if(body.length>maxChars){body=body.slice(-maxChars);cut=Math.max(cut,1);}
 return cut>0?`(últimas ${body.split('\n').length} linhas; saída completa em ${fileHint})\n${body}`:body;
}

/**
 * Poll schedule for a long job. Legacy: a fixed wait. Backoff: the wait grows to maxMs.
 * Both give the same total deadline, so a timeout is detected as late as before.
 */
export function pollSchedule(options:{backoff:boolean;baseMs:number;maxMs:number;deadlineMs:number;factor?:number}):{attempts:number;waitMs:(attempt:number)=>number}{
 const {backoff,baseMs,maxMs,deadlineMs,factor=1.5}=options;
 if(!backoff)return {attempts:Math.floor(deadlineMs/baseMs)+1,waitMs:()=>baseMs};
 let elapsed=0,attempts=1;
 while(elapsed<deadlineMs){elapsed+=backoffMs(attempts-1,baseMs,maxMs,factor);attempts++;}
 return {attempts,waitMs:attempt=>backoffMs(attempt,baseMs,maxMs,factor)};
}

/** Per-project switches (installation `economy`). Missing options mean on. */
export type ManagerEconomy={discipline:boolean;contextTokens:number;measurement:boolean};
export function managerEconomyOf(economy?:{managerDiscipline?:boolean;managerContextTokens?:number;measurement?:boolean}):ManagerEconomy{
 return {discipline:economy?.managerDiscipline!==false,contextTokens:economy?.managerContextTokens??DEFAULT_MANAGER_CONTEXT_TOKENS,measurement:economy?.measurement!==false};
}
