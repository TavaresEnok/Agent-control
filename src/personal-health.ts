import {DISK_BLOCK_PERCENT} from './personal-disk.ts';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

/** One phone notice the watch may send. The same key is not sent again before `repeatMs`. */
export type HealthNotice={key:string;text:string;repeatMs:number};

const hourMs=60*60*1000,dayMs=24*hourMs;
export const ERROR_WINDOW_MINUTES=5;
export const ERROR_THRESHOLD=10;
export const DISK_ALERT_PERCENT=90;
export const LOGIN_WARNING_DAYS=3;

const uuid=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const longHex=/\b[0-9a-f]{12,}\b/gi;
/** Anything that may carry a secret or a private path is masked before it reaches the phone. */
const url=/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const path=/(?:^|(?<=\s))\/[^\s:]+/g;
/** Long runs with a lower-case letter and a digit. Upper-case failure codes stay readable. */
const token=/\b(?=[A-Za-z0-9_+\/=.-]*[a-z])(?=[A-Za-z0-9_+\/=.-]*[0-9])[A-Za-z0-9_+\/=.-]{24,}\b/g;
/** Failure codes and thrown errors. Plain status lines, JSON events and systemd lines are not errors. */
const errorLine=/(?:^|\s)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:FAILED|ERROR|UNAVAILABLE)\b|\b[A-Za-z]*Error\b/;
const systemdLine=/^(?:Started|Stopping|Stopped|Starting)\b|\.service:/;

/** The same error line, ids removed, seen `threshold` or more times in the window. */
export function repeatedErrorNotices(log:string,threshold=ERROR_THRESHOLD):HealthNotice[]{
 const counts=new Map<string,number>();
 for(const raw of log.split('\n')){
  const line=raw.trim();
  if(!line||line.startsWith('{')||systemdLine.test(line)||!errorLine.test(line))continue;
  const signature=line.replace(url,'<url>').replace(uuid,'*').replace(longHex,'#').replace(path,'<caminho>').replace(token,'<…>').slice(0,160);
  counts.set(signature,(counts.get(signature)??0)+1);
 }
 return [...counts].filter(([,count])=>count>=threshold).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([signature,count])=>({
  key:'error:'+signature,
  text:`Erro repetido no Agent Control (${count} vezes em ${ERROR_WINDOW_MINUTES} min): ${signature.slice(0,120)}`,
  repeatMs:hourMs,
 }));
}

export function diskNotice(usedPercent:number):HealthNotice|null{
 if(!Number.isFinite(usedPercent)||usedPercent<DISK_ALERT_PERCENT)return null;
 return {key:'disk',text:`Disco do servidor em ${Math.round(usedPercent)}%. ${usedPercent>=DISK_BLOCK_PERCENT?'Novos exames e trabalhadores estão bloqueados. ':''}Confira a retenção com npm run personal:maintenance -- <instalação.json> --retencao-automatica.`,repeatMs:6*hourMs};
}

const providerName:Record<string,string>={claude:'Claude',grok:'Grok',codex:'Codex'};
const loginFiles:{provider:string;path:string}[]=[
 {provider:'claude',path:'.credentials.json'},
 {provider:'grok',path:'.grok/auth.json'},
 {provider:'codex',path:'.codex/auth.json'},
];

function hasText(value:unknown){return typeof value==='string'&&value.length>0;}

/** What the login file itself says. Null means nothing to warn about. */
export function loginProblem(provider:string,raw:unknown,now:Date):{days:number|null}|null{
 if(!raw||typeof raw!=='object')return {days:null};
 const data=raw as Record<string,any>;
 if(provider==='claude'){
  const oauth=data.claudeAiOauth;
  if(!oauth||!hasText(oauth.refreshToken))return {days:null};
  const until=Number(oauth.refreshTokenExpiresAt);
  if(!Number.isFinite(until)||until<=0)return null;
  const days=(until-now.getTime())/dayMs;
  return days<=LOGIN_WARNING_DAYS?{days:Math.max(0,Math.floor(days))}:null;
 }
 if(provider==='grok'){
  const entries=Object.values(data).filter(item=>item&&typeof item==='object') as Record<string,unknown>[];
  return entries.some(entry=>hasText(entry.refresh_token))?null:{days:null};
 }
 if(provider==='codex'){
  const tokens=data.tokens as Record<string,unknown>|undefined;
  return hasText(data.OPENAI_API_KEY)||hasText(tokens?.refresh_token)?null:{days:null};
 }
 return null;
}

export function loginNoticeText(provider:string,days:number|null,installationFile='<instalação.json>'){
 const name=providerName[provider]??provider;
 const head=days===null?`O ${name} está sem login válido.`:`O login do ${name} ${days===0?'vence hoje':days===1?'vence em 1 dia':`vence em ${days} dias`}.`;
 return `${head} Entre de novo: npm run gateway -- account-add ${installationFile} ${provider} ${name}.`;
}

/** One notice per account whose login file is missing a refresh token, or whose Claude refresh token is close to expiring. */
export async function loginNotices(accountsRoot:string,accounts:readonly {id:string;provider:string}[],now:Date,installationFile?:string,read:(path:string)=>Promise<string>=path=>readFile(path,'utf8')):Promise<HealthNotice[]>{
 const notices:HealthNotice[]=[];
 for(const account of accounts){
  const file=loginFiles.find(item=>item.provider===account.provider);
  if(!file||!/^[0-9a-f-]{36}$/.test(account.id))continue;
  let raw:unknown;
  try{raw=JSON.parse(await read(join(accountsRoot,account.id,file.path)));}
  catch{raw=null;}
  const problem=loginProblem(account.provider,raw,now);
  if(problem)notices.push({key:'login:'+account.id,text:loginNoticeText(account.provider,problem.days,installationFile),repeatMs:dayMs});
 }
 return notices;
}

/** Account login folder: the installation's accountHomesDirectory, else <dataDirectory>/accounts. */
export function personalAccountRoot(config:{accountHomesDirectory?:string|undefined;dataDirectory:string}){
 return config.accountHomesDirectory??join(config.dataDirectory,'accounts');
}

/** Which notices are due, given when each key was last sent. Old keys are dropped after a week.
 * The caller records a key in `sent` only after its notice went out. */
export function dueNotices(notices:readonly HealthNotice[],sent:Record<string,string>,now:Date){
 const due:HealthNotice[]=[];
 const next:Record<string,string>={};
 for(const [key,at] of Object.entries(sent)){
  const then=Date.parse(at);
  if(Number.isFinite(then)&&now.getTime()-then<7*dayMs)next[key]=at;
 }
 for(const notice of notices){
  const then=Date.parse(next[notice.key]??'');
  if(Number.isFinite(then)&&now.getTime()-then<notice.repeatMs)continue;
  due.push(notice);
 }
 return {due,sent:next};
}
