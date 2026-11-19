import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,copyFile,readFile,rename,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {Id,Refusal,type Authority} from './contracts.ts';
import {loadInstallation,type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {readonlyDesignExam} from './native-execution-supervisor.ts';
import {composePersonalExecutionSupervisors} from './personal-runtime.ts';
import {refreshVerifyDatabases} from './verify-db.ts';

const imageId=/^sha256:[a-f0-9]{64}$/;
type Pair={workerImage:string;toolsImage:string};

export type MaintenanceDeps={
 /** Runs a fixed docker command and returns its exit code. */
 docker?:(args:string[])=>Promise<number>;
 /** Whether Docker still has this image. */
 imageExists?:(image:string)=>Promise<boolean>;
 /** Execution jobs of one executor that may still need their old supervisor. */
 openExecutionJobs?:(executorDigest:string)=>Promise<number>;
 /** Planning calls not yet finished. Planning rows do not name their image, so any open call keeps every retired planning image. */
 openPlanningJobs?:()=>Promise<number>;
 /** Publishes a new vulnerability database. Failure must leave the previous stamp in place. */
 refreshDatabases?:(dataDirectory:string)=>Promise<void>;
};

/** A retired execution pair is kept while any job under it is unfinished, or a reviewer, judge or QA job has not had its containers removed. */
export const OPEN_EXECUTION_JOBS_SQL=`SELECT count(*)::int n FROM ac_native_execution_jobs j WHERE j.executor_digest=$1 AND (j.state NOT IN ('completed','failed')
 OR (j.role IN ('reviewer','judge','qa') AND NOT EXISTS(SELECT 1 FROM ac_native_terminal_retirements t WHERE t.job_id=j.id AND t.state='removed')))`;
export const OPEN_PLANNING_JOBS_SQL=`SELECT count(*)::int n FROM ac_native_planning_jobs WHERE state NOT IN ('completed','failed')`;

function run(command:string,args:string[],timeout:number){
 return new Promise<number>(resolvePromise=>{
  const child=spawn(command,args,{stdio:'ignore'});
  const timer=setTimeout(()=>child.kill(),timeout);
  child.on('error',()=>{clearTimeout(timer);resolvePromise(1);});
  child.on('close',code=>{clearTimeout(timer);resolvePromise(code??1);});
 });
}

/** Which retired images can go. Pure: the caller supplies the job counts. */
export function retiredPlan(boot:{planning:{imageId:string;retiredImageIds?:string[]};execution:{workerImage:string;toolsImage:string;retiredImages?:Pair[]};qa?:{image?:string}},
 openExecution:Map<string,number>,openPlanning:number){
 const keepPairs:Pair[]=[],dropPairs:Pair[]=[];
 for(const pair of boot.execution.retiredImages??[]){
  ((openExecution.get(nativeExecutionExecutorDigest(pair.workerImage,pair.toolsImage))??1)>0?keepPairs:dropPairs).push(pair);
 }
 const retiredPlanning=boot.planning.retiredImageIds??[];
 const keepPlanning=openPlanning>0?retiredPlanning:[];
 const dropPlanning=openPlanning>0?[]:retiredPlanning;
 const inUse=new Set([boot.planning.imageId,boot.execution.workerImage,boot.execution.toolsImage,boot.qa?.image,...keepPlanning,...keepPairs.flatMap(p=>[p.workerImage,p.toolsImage])].filter(Boolean));
 const removable=[...new Set([...dropPlanning,...dropPairs.flatMap(p=>[p.workerImage,p.toolsImage])])].filter(id=>imageId.test(id)&&!inUse.has(id));
 return {keepPairs,dropPairs,keepPlanning,dropPlanning,removable};
}

async function writeInstallationAtomically(file:string,raw:unknown){
 const temporary=`${file}.${randomUUID()}.tmp`;
 await writeFile(temporary,JSON.stringify(raw,null,2)+'\n',{mode:0o600,flag:'wx'});
 await chmod(temporary,0o600);
 await rename(temporary,file);
}

function parseMaintenanceArgs(argv:readonly string[]){
 const [installationPath,command,jobId]=argv;
 if(!installationPath||installationPath.startsWith('-'))throw new Refusal('MAINTENANCE_USAGE');
 if(argv.length===1)return {installationPath};
 if(command!=='--abandonar-design'||!Id.safeParse(jobId).success||argv.length!==3)
  throw new Refusal('MAINTENANCE_USAGE');
 return {installationPath,recoverExamJobId:jobId};
}

/** Explicit local owner withdrawal of a single unstarted personal design attempt.
 * Uses only the installation's configured project owner, context, product lease/fence, and supervisor absence proof. */
async function recoverInterruptedExamFromInstallation(config:Installation,jobId:string,explicitDesignWithdrawal:boolean):Promise<string[]>{
 const boot=config.nativeBootstrap;
 if(!boot||boot.state!=='active')throw new Refusal('MAINTENANCE_NATIVE_REQUIRED',409);
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 let authority:Authority|undefined;
 try{
  const row=(await ledger.pool.query<{
   id:string;context_id:string;project_id:string;archived:boolean;principal_id:string;
   parent_intent_id:string|null;workflow:unknown;role:string;account_id:string;
   executor_digest:string;key_fingerprint:string;grant_project_id:string;grant_context_id:string;
  }>(`SELECT j.id::text,j.context_id::text,x.project_id::text,x.archived,i.principal_id,
    i.parent_intent_id::text,i.command->'payload'->>'workflow' AS workflow,j.role,j.account_id::text,
    j.executor_digest,j.key_fingerprint,g.project_id::text AS grant_project_id,g.context_id::text AS grant_context_id
    FROM ac_native_execution_jobs j
    JOIN ac_contexts x ON x.id=j.context_id
    JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
    JOIN ac_capacity_grants g ON g.id=j.grant_id
    WHERE j.id=$1`,[jobId])).rows[0];
  if(!row||row.archived)throw new Refusal('MAINTENANCE_EXAM_NOT_FOUND',404);
  const project=[config.project,...config.projects].find(item=>item.id===row.project_id);
  if(!project)throw new Refusal('MAINTENANCE_EXAM_NOT_FOUND',404);
  const principal=project.owner;
  if(row.principal_id!==principal||!(await ledger.pool.query(
   "SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[project.id,principal],
  )).rowCount)throw new Refusal('MAINTENANCE_EXAM_PRINCIPAL_MISMATCH',403);
  if(row.parent_intent_id!==null||!readonlyDesignExam(row.workflow,row.role)){
   throw new Refusal('MAINTENANCE_EXAM_NOT_ELIGIBLE',409);
  }
  if(row.grant_project_id!==project.id||row.grant_context_id!==row.context_id){
   throw new Refusal('NATIVE_EXECUTION_GRANT_MISMATCH',409);
  }
  try{
   authority=await ledger.acquire(principal,row.context_id,randomUUID(),'personal-maintenance',60);
  }catch(error){
   if(error instanceof Refusal&&error.code==='MANAGER_ACTIVE')throw new Refusal('MAINTENANCE_CONTEXT_BUSY',409);
   throw error;
  }
  const supervisors=await composePersonalExecutionSupervisors(config,ledger);
  const supervisor=supervisors.find(item=>item.supportsAccount(row.account_id)&&item.executorDigest===row.executor_digest&&item.keyFingerprint===row.key_fingerprint&&item.keyFingerprint===boot.execution.keyFingerprint);
  const scope={projectId:project.id,repository:project.repo,explicitDesignWithdrawal};
  if(supervisor)await supervisor.recoverUnstartedExam(principal,authority,jobId,scope);
  else{
   const verifier=supervisors.find(item=>item.supportsAccount(row.account_id)&&item.keyFingerprint===row.key_fingerprint&&item.keyFingerprint===boot.execution.keyFingerprint);
   if(!verifier)throw new Refusal('MAINTENANCE_SUPERVISOR_UNAVAILABLE',409);
   await verifier.confirmRetiredUnstartedDesign(principal,authority,jobId,scope);
  }
  return [`Tentativa de design ${jobId} retirada sem execução (estado: failed, retirada: removed, intenção: failed).`];
 }finally{
  if(authority)await ledger.releaseLease(authority).catch(()=>{});
  await ledger.close();
 }
}

/** Weekly: old Docker build cache goes, and retired images no job still needs leave the installation and Docker.
 * Volumes, containers and images of other projects are never touched. The gateway keeps running. */
export async function runPersonalMaintenance(argv:string[],deps:MaintenanceDeps={}){
 const parsed=parseMaintenanceArgs(argv);
 const file=resolve(parsed.installationPath);
 const config=await loadInstallation(file);
 if(config.activation!=='personal')throw new Refusal('MAINTENANCE_PERSONAL_REQUIRED');
 if(parsed.recoverExamJobId)return recoverInterruptedExamFromInstallation(config,parsed.recoverExamJobId,true);
 const docker=deps.docker??(args=>run('docker',args,30*60*1000));
 const imageExists=deps.imageExists??(async image=>imageId.test(image)&&await run('docker',['image','inspect',image],30_000)===0);
 const lines:string[]=[];
 const refresh=deps.refreshDatabases??(()=>refreshVerifyDatabases({dataDirectory:config.dataDirectory}).then(()=>undefined));
 try{
  await refresh(config.dataDirectory);
  lines.push('Bases de vulnerabilidade atualizadas.');
 }catch{
  lines.push('Bases de vulnerabilidade não atualizadas. A base anterior permanece.');
 }
 const cache=await docker(['builder','prune','-f','--filter','until=168h']);
 lines.push(cache===0?'Cache de build com mais de 7 dias apagado.':'Cache de build não pôde ser limpo.');
 const boot=config.nativeBootstrap;
 if(!boot||boot.state==='disabled'||boot.state==='bench'){lines.push('Sem runtime nativo: nenhuma imagem aposentada.');return lines;}
 let pool:pg.Pool|undefined;
 const query=async(sql:string,params:unknown[])=>{
  pool??=new pg.Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:5000});
  return Number((await pool.query(sql,params)).rows[0]?.n??1);
 };
 try{
  const openExecution=new Map<string,number>();
  for(const pair of boot.execution.retiredImages??[]){
   const executor=nativeExecutionExecutorDigest(pair.workerImage,pair.toolsImage);
   openExecution.set(executor,await (deps.openExecutionJobs??(digest=>query(OPEN_EXECUTION_JOBS_SQL,[digest])))(executor));
  }
  const openPlanning=(boot.planning.retiredImageIds??[]).length?await (deps.openPlanningJobs??(()=>query(OPEN_PLANNING_JOBS_SQL,[])))():0;
  const plan=retiredPlan(boot,openExecution,openPlanning);
  if(plan.dropPairs.length||plan.dropPlanning.length){
   const raw=JSON.parse(await readFile(file,'utf8')) as {nativeBootstrap:{planning:Record<string,unknown>;execution:Record<string,unknown>}};
   const planning=raw.nativeBootstrap.planning,execution=raw.nativeBootstrap.execution;
   if(plan.keepPlanning.length)planning.retiredImageIds=plan.keepPlanning;else delete planning.retiredImageIds;
   if(plan.keepPairs.length)execution.retiredImages=plan.keepPairs;else delete execution.retiredImages;
   await copyFile(file,`${file}.before-maintenance`);
   await chmod(`${file}.before-maintenance`,0o600);
   await writeInstallationAtomically(file,raw);
   lines.push(`Imagens aposentadas retiradas da instalação: ${plan.dropPairs.length} par(es) de execução e ${plan.dropPlanning.length} de planejamento. Cópia anterior em installation.json.before-maintenance.`);
  }else lines.push('Nenhuma imagem aposentada pôde sair: ainda há jobs abertos ou não há imagens aposentadas.');
  let removed=0;
  for(const image of plan.removable){
   if(!await imageExists(image))continue;
   if(await docker(['image','rm',image])===0)removed++;
  }
  if(removed)lines.push(`${removed} imagem(ns) aposentada(s) apagada(s) do Docker.`);
 }finally{await pool?.end();}
 return lines;
}
