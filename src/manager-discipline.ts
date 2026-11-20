import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {estimateTokens,generateRepoMapSafe} from './repo-map.ts';

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
 const recentFull=options.recentFull??4,fullChars=options.fullChars??1200,olderChars=options.olderChars??160,pendingChars=options.pendingChars??400,budget=options.budgetChars??6000;
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
 const last=rows.at(-1);
 if(last&&last.role==='owner'&&last.text.trim()===current.text.trim())rows.pop();
 return rows.map(row=>({role:row.role,text:row.text}));
}

/**
 * Compact repository context for the manager: README head and the cached repository map within a token budget.
 * Falls back to the caller's raw context when the map is unavailable.
 */
export async function managerRepositoryContext(repo:string,discipline:ManagerDiscipline,fallback:()=>Promise<string>):Promise<string>{
 if(!discipline.enabled)return fallback();
 const budget=Math.max(500,discipline.contextTokens);
 let readme='';
 try{readme=(await readFile(join(repo,'README.md'),'utf8')).slice(0,1200).trim();}catch{readme='';}
 const mapBudget=Math.max(300,budget-estimateTokens(readme)-40);
 const result=await generateRepoMapSafe({repoPath:repo,projectId:discipline.projectId,dataDirectory:discipline.dataDirectory,budgetTokens:mapBudget,useCache:true});
 if(!result.map)return fallback();
 return 'Mapa compacto do repositório (assinaturas e arquivos mais referenciados; peça um arquivo específico se precisar do conteúdo):\n'+result.map+(readme?'\n\nREADME (início):\n'+readme:'');
}

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
