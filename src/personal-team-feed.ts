// Personal mode: tells the owner, in the conversation, what each role is doing — manager (planning),
// programmer, QA and reviewer — with the provider, model and effort that ran it, what the programmer
// said and changed, the QA log line and the reviewer's verdict and findings. Read-only over the ledger
// and the private execution-host directory; every message has a stable id, so restarts never repeat one.
import type pg from 'pg';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';

export type TeamFeedOptions={executionHost:string;repo?:string;pool?:pg.Pool};
export type TeamMessage={id:string;text:string};
type Job={id:string;kind:'planning'|'programmer'|'qa'|'reviewer'|'judge'|'specialist';state:string;provider:string|null;model:string|null;effort:string|null;receipt:any;base:string|null;intentId?:string|null};

const ROLE:Record<Job['kind'],string>={planning:'Gerente',programmer:'Programador',qa:'QA',reviewer:'Revisor',judge:'Juiz',specialist:'Especialista'};
const Uuid=z.uuid();

export async function teamJobs(pool:pg.Pool,contextId:string,limit=40):Promise<Job[]>{
 const rows=(await pool.query(`
  SELECT * FROM (
   SELECT j.id::text,'planning' kind,j.state,a.provider,p.model,p.effort,j.receipt,NULL base,NULL::uuid "intentId",j.created_at FROM ac_native_planning_jobs j
    JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_accounts a ON a.id=p.account_id WHERE j.context_id=$1
   UNION ALL
   SELECT j.id::text,j.role,j.state,a.provider,p.model,p.effort,j.receipt,j.base_id,j.intent_id,j.created_at FROM ac_native_execution_jobs j
    JOIN ac_profiles p ON p.id=j.profile_id JOIN ac_accounts a ON a.id=j.account_id WHERE j.context_id=$1
   UNION ALL
   SELECT j.id::text,'qa',j.state,NULL,NULL,NULL,j.receipt,NULL,j.intent_id,j.created_at FROM ac_native_qa_jobs j WHERE j.context_id=$1
  ) x ORDER BY created_at DESC LIMIT $2`,[contextId,limit])).rows;
 return rows.reverse() as Job[];
}

function who(job:Job){return ROLE[job.kind]+(job.model?` (${[job.provider,job.model,job.effort].filter(Boolean).join(' · ')})`:'');}
function clip(text:string,max:number){const t=text.replace(/\r/g,'').trim();return t.length>max?t.slice(0,max).trimEnd()+'…':t;}

async function workerResult(root:string,id:string):Promise<{output:string;failureCode?:string|null}|null>{
 if(!Uuid.safeParse(id).success)return null;
 try{return JSON.parse(await readFile(join(root,id,'output','execution-result.json'),'utf8'));}catch{return null;}
}
// QA logs are stored as Docker's multiplexed stream: 8-byte frame headers before each chunk.
export function dockerLogText(bytes:Buffer){
 const parts:Buffer[]=[];let at=0;
 while(at+8<=bytes.length&&[0,1,2].includes(bytes[at]!)&&bytes[at+1]===0&&bytes[at+2]===0&&bytes[at+3]===0){
  const size=bytes.readUInt32BE(at+4);parts.push(bytes.subarray(at+8,at+8+size));at+=8+size;
 }
 return (at===0?bytes:Buffer.concat(parts)).toString('utf8');
}
async function qaLog(root:string,id:string){
 if(!Uuid.safeParse(id).success)return '';
 try{return dockerLogText(await readFile(join(root,id,'qa-logs.bin')));}catch{return '';}
}
async function intentRepository(pool:pg.Pool,intentId:string){
 if(!Uuid.safeParse(intentId).success)return;
 try{
  const row=(await pool.query(`SELECT r.repo FROM ac_intents i JOIN ac_contexts c ON c.id=i.context_id JOIN ac_project_repositories r ON r.project_id=c.project_id WHERE i.id=$1`,[intentId])).rows[0];
  return typeof row?.repo==='string'&&row.repo?row.repo:undefined;
 }catch{return;}
}
function changedFiles(repo:string,base:string,commit:string):Promise<string>{
 return new Promise(done=>execFile('git',['-C',repo,'diff','--numstat',base,commit],{timeout:10000,maxBuffer:1<<20},(error,stdout)=>{
  if(error)return done('');
  const lines=stdout.trim().split('\n').filter(Boolean).map(line=>{const [added,removed,...name]=line.split('\t');return `${name.join('\t')} (+${added} −${removed})`;});
  done(lines.length?lines.slice(0,15).join(', ')+(lines.length>15?` e mais ${lines.length-15}`:''):'nenhum');
 }));
}

export async function teamMessage(job:Job,options:TeamFeedOptions):Promise<TeamMessage|null>{
 const id='team-'+job.id+'-'+job.state,name=who(job);
 if(job.state==='running'||job.state==='prepared'){
  const doing={planning:'está montando o plano',programmer:'começou a programar',qa:'está verificando o resultado',reviewer:'está revisando o código',judge:'está avaliando',specialist:'começou'}[job.kind];
  return {id:'team-'+job.id+'-running',text:`${name} ${doing}.`};
 }
 if(job.state==='uncertain')return {id,text:`${name}: resultado incerto; o gerente vai reconciliar.`};
 if(!['completed','failed'].includes(job.state))return null;
 const ok=job.state==='completed';
 if(job.kind==='planning')return {id,text:ok?`${name} terminou o plano.`:`${name} não conseguiu montar o plano.`};
 if(job.kind==='qa'){
  const lines=(await qaLog(options.executionHost,job.id)).trim().split('\n').filter(Boolean);
  const passed=job.receipt?.status==='passed';
  return {id,text:`QA ${passed?'passou':'reprovou'}${lines.length?': '+clip(lines.slice(passed?-1:-8).join('\n'),900):job.receipt?.failureCode?' ('+job.receipt.failureCode+')':''}.`};
 }
 const result=await workerResult(options.executionHost,job.id);
 if(job.kind==='programmer'){
  const artifact=job.receipt?.payload?.artifact;
  const repo=job.intentId&&options.pool?await intentRepository(options.pool,job.intentId):undefined;
  const files=artifact?.base&&artifact?.commit&&repo?await changedFiles(repo,artifact.base,artifact.commit):'';
  const said=result?.output?clip(result.output,900):'';
  return {id,text:ok
   ?`${name} terminou.${said?'\n«'+said+'»':''}${artifact?.commit?`\nCommit ${String(artifact.commit).slice(0,7)}${files?' — arquivos: '+files:''}.`:''}`
   :`${name} falhou${result?.failureCode?' ('+result.failureCode+')':''}.${said?'\n«'+said+'»':''}`};
 }
 let verdict:{verdict?:string;findings?:{severity:string;summary:string}[]}|null=null;
 try{verdict=result?.output?JSON.parse(result.output):null;}catch{}
 if(!ok||!verdict?.verdict)return {id,text:`${name} não concluiu a revisão${result?.failureCode?' ('+result.failureCode+')':''}.`};
 const findings=(verdict.findings??[]).slice(0,10).map(f=>`• [${f.severity}] ${clip(f.summary,300)}`).join('\n');
 return {id,text:`${name} ${verdict.verdict==='pass'?'aprovou':'rejeitou'}${findings?':\n'+findings:' sem apontamentos'}.`};
}

// The "equipe" command: who is configured for each role and the latest thing each one did.
export async function teamStatus(pool:pg.Pool,contextId:string,options:TeamFeedOptions){
 const profiles=(await pool.query(`SELECT p.role,a.provider,p.model,p.effort FROM ac_profiles p JOIN ac_accounts a ON a.id=p.account_id
  WHERE p.enabled AND p.role IN ('manager','programmer','reviewer') ORDER BY array_position(ARRAY['manager','programmer','reviewer'],p.role),a.provider`)).rows;
 const names:Record<string,string>={manager:'Gerente',programmer:'Programador',qa:'QA',reviewer:'Revisor'};
 const team=profiles.map(p=>`• ${names[p.role]}: ${p.provider} · ${p.model} · ${p.effort}`).join('\n');
 const recent=await teamJobs(pool,contextId,6);
 const feed={...options,pool};
 const last=(await Promise.all(recent.map(job=>teamMessage(job,feed)))).filter(Boolean).map(m=>'• '+m!.text.split('\n')[0]).join('\n');
 return `Equipe:\n${team||'• nenhuma conta ativa'}\n• QA: script automático do projeto (sem modelo)\n\nÚltimas atividades:\n${last||'• nada ainda'}`;
}

// The app's model picker reads `sessionModelsV1` from the session metadata. A Claude-flavored session
// would otherwise list Claude's own catalog, which this conversation ignores; show the real team instead.
export const TEAM_MODEL_ID='agent-control-team';
export async function teamModelsMetadata(pool:pg.Pool,metadata:Record<string,unknown>,now=Date.now()){
 const profiles=(await pool.query(`SELECT p.role,p.model,p.effort FROM ac_profiles p WHERE p.enabled AND p.role IN ('manager','programmer','reviewer')
  ORDER BY array_position(ARRAY['manager','programmer','reviewer'],p.role)`)).rows;
 const names:Record<string,string>={manager:'Gerente',programmer:'Programador',reviewer:'Revisor'};
 const description=profiles.map(p=>`${names[p.role]} ${p.model} ${p.effort}`).join(' · ')||'sem contas ativas';
 const state={v:1,provider:'claude',updatedAt:now,currentModelId:TEAM_MODEL_ID,availableModels:[{id:TEAM_MODEL_ID,name:'Equipe Agent Control',description}]};
 const current=metadata.sessionModelsV1 as {availableModels?:{description?:string}[];currentModelId?:string}|undefined;
 if(current?.currentModelId===TEAM_MODEL_ID&&current.availableModels?.[0]?.description===description)return null;
 return {...metadata,sessionModelsV1:state,acpSessionModelsV1:state};
}

// The Cezar cockpit shows one text per step. In personal mode that text becomes the role's own report
// (who ran it, what it said or found) instead of a generic marker. Set once by the personal gateway.
let stageReporter:((intentId:string,node:string)=>Promise<string|null>)|undefined;
export function registerStageReporter(pool:pg.Pool,options:TeamFeedOptions){
 stageReporter=async(intentId,node)=>{
  const row=node==='qa'
   ?(await pool.query(`SELECT j.id::text,'qa' kind,j.state,NULL provider,NULL model,NULL effort,j.receipt,NULL base FROM ac_native_qa_jobs j WHERE j.intent_id=$1 ORDER BY j.created_at DESC LIMIT 1`,[intentId])).rows[0]
   :(await pool.query(`SELECT j.id::text,j.role kind,j.state,a.provider,p.model,p.effort,j.receipt,j.base_id base FROM ac_native_execution_jobs j
      JOIN ac_profiles p ON p.id=j.profile_id JOIN ac_accounts a ON a.id=j.account_id WHERE j.intent_id=$1 AND j.role=$2 ORDER BY j.created_at DESC LIMIT 1`,
      [intentId,node==='implement'?'programmer':node==='review'?'reviewer':node])).rows[0];
  return row?(await teamMessage({...(row as Job),intentId},{...options,pool}))?.text??null:null;
 };
}
export async function stageReport(intentId:string,node:string){
 if(!stageReporter)return null;
 return stageReporter(intentId,node).catch(()=>null);
}
