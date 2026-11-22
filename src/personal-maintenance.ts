import {isArtifactCommand,runArtifactCommand} from './personal-artifact-commands.ts';
import {runPersonalArtifactRetention} from './personal-artifact-retention.ts';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,readFile,rename,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {Id,Refusal,type Authority} from './contracts.ts';
import {loadInstallation,type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {readonlyDesignExam,type NativeModuleExamRecovery,type ModuleExamWorkRelease,ModuleExamRecoveryPreserved} from './native-execution-supervisor.ts';
import {inventoryJobWork,readRetentionCursor,rotateAfter,writeRetentionCursor} from './native-work-retention.ts';
import {composePersonalExecutionSupervisors} from './personal-runtime.ts';
import {readCurrentVerifyDatabase,refreshVerifyDatabases,runVerifyDatabaseRetention} from './verify-db.ts';

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
 /** Retention of `work/` of terminal jobs. Tests replace it. */
 jobRetention?:(config:Installation,apply:boolean)=>Promise<string[]>;
 /** Retention of old vulnerability database stamps. Tests replace it. */
 verifyDatabaseRetention?:(config:Installation,apply:boolean)=>Promise<string[]>;
 /** Retention of worker worktrees, candidate images and round temporaries. Tests replace it. */
 artifactRetention?:(config:Installation,apply:boolean)=>Promise<string[]>;
 /** The published vulnerability database, or null when none. Used only to show its age. */
 currentDatabase?:(dataDirectory:string)=>Promise<{fetchedAt:string}|null>;
 now?:()=>Date;
};

/** Some retention stage failed. Every stage still ran; `lines` holds what each one reported, failures included. */
export class RetentionIncomplete extends Error {
 constructor(readonly lines:string[],readonly failed:string[]){super('Retention incomplete: '+failed.join(', '));}
}

/** A scheduled maintenance stage failed. Every stage still ran; `lines` holds what each one reported. */
export class MaintenanceIncomplete extends RetentionIncomplete{}

/** The AGENTS.md order: `work/` of terminal jobs first (the largest and most urgent under disk pressure), then old
 * vulnerability database stamps (several GB each), then worktrees, images and temporaries. The stages are independent: a damaged artifact registry, a database outage or any other failure
 * of one stage never keeps the next one from running. A failure is reported after every stage has had its turn. */
export async function runRetentionStages(config:Installation,apply:boolean,deps:Pick<MaintenanceDeps,'jobRetention'|'artifactRetention'|'verifyDatabaseRetention'>={}):Promise<string[]>{
 const stages:[string,string,(config:Installation,apply:boolean)=>Promise<string[]>][]=[
  ['jobs','work/ de jobs',deps.jobRetention??runPersonalJobRetention],
   ['verify-db','bases de vulnerabilidades',deps.verifyDatabaseRetention??((config,apply)=>runVerifyDatabaseRetention(config.dataDirectory,apply))],
  ['artifacts','artefatos (worktrees, imagens e temporários)',deps.artifactRetention??runPersonalArtifactRetention],
 ];
 const lines:string[]=[],failed:string[]=[];
 for(const [name,label,stage] of stages){
  try{lines.push(...await stage(config,apply));}
  catch(error){
   failed.push(name);
   lines.push(`Retenção de ${label} falhou (${error instanceof Refusal?error.code:'erro'}); as demais etapas seguiram.`);
  }
 }
 if(failed.length)throw new RetentionIncomplete(lines,failed);
 return lines;
}

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

type WorkSelection={apply:boolean;projectId?:string;after?:string;jobIds?:string[];limit:number};
const MAX_WORK_BATCH=200;

function parseWorkRetirementArgs(installationPath:string,rest:readonly string[]){
 const selection:WorkSelection={apply:false,limit:50};
 const seen=new Set<string>();
 for(let i=0;i<rest.length;i++){
  const flag=rest[i]!;
  if(flag==='--aplicar'&&!seen.has(flag)){seen.add(flag);selection.apply=true;continue;}
  const value=rest[++i];
  if(flag==='--projeto'&&!seen.has(flag)&&Id.safeParse(value).success){seen.add(flag);selection.projectId=value;continue;}
  if(flag==='--job'&&Id.safeParse(value).success){(selection.jobIds??=[]).push(value!);continue;}
  if(flag==='--apos'&&!seen.has(flag)&&Id.safeParse(value).success){seen.add(flag);selection.after=value;continue;}
  if(flag==='--limite'&&!seen.has(flag)&&/^[1-9][0-9]{0,2}$/.test(value??'')&&Number(value)<=MAX_WORK_BATCH){seen.add(flag);selection.limit=Number(value);continue;}
  throw new Refusal('MAINTENANCE_USAGE');
 }
 // Exactly one scope: one project, or an explicit list of ids. Never the whole installation.
 if(Boolean(selection.projectId)===Boolean(selection.jobIds)||(!selection.projectId&&selection.after)||(selection.jobIds&&(selection.jobIds.length>MAX_WORK_BATCH||seen.has('--limite'))))throw new Refusal('MAINTENANCE_USAGE');
 if(selection.jobIds)selection.limit=selection.jobIds.length;
 return {installationPath,releaseExamWork:selection};
}

type ParsedMaintenance={installationPath:string;recoverExamJobId?:string;recoverModuleExamJobId?:string;releaseExamWork?:WorkSelection;jobRetention?:{apply:boolean};artifactArgs?:string[]};
function parseMaintenanceArgs(argv:readonly string[]):ParsedMaintenance{
 const [installationPath,command,jobId]=argv;
 if(!installationPath||installationPath.startsWith('-'))throw new Refusal('MAINTENANCE_USAGE');
 if(argv.length===1)return {installationPath};
 if(isArtifactCommand(argv.slice(1)))return {installationPath,artifactArgs:argv.slice(1)};
 if(command==='--liberar-work-exames')return parseWorkRetirementArgs(installationPath,argv.slice(2));
 if(command==='--retencao-automatica'){
  const rest=argv.slice(2);
  if(rest.length>1||(rest.length===1&&rest[0]!=='--aplicar'))throw new Refusal('MAINTENANCE_USAGE');
  return {installationPath,jobRetention:{apply:rest.length===1}};
 }
 if(argv.length!==3||!Id.safeParse(jobId).success)throw new Refusal('MAINTENANCE_USAGE');
 if(command==='--abandonar-design')return {installationPath,recoverExamJobId:jobId};
 if(command==='--recuperar-exame-passivo')return {installationPath,recoverModuleExamJobId:jobId};
 throw new Refusal('MAINTENANCE_USAGE');
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
  if(authority)await ledger.releaseLease(authority).catch(()=>{/* an unreleased lease expires by itself */});
  await ledger.close();
 }
}

/** Explicit local owner retirement of one passive module-exam attempt (modules 2 to 9) whose first tools container was
 * created but never started after Docker lost the create response. Same lease, owner, supervisor and key proof as the
 * design withdrawal. The supervisor keeps the grant unless Docker, the journal and the spool prove the attempt never ran. */
async function recoverNeverStartedModuleExamFromInstallation(config:Installation,jobId:string):Promise<string[]>{
 const boot=config.nativeBootstrap;
 if(!boot||boot.state!=='active')throw new Refusal('MAINTENANCE_NATIVE_REQUIRED',409);
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 let authority:Authority|undefined;
 try{
  const row=(await ledger.pool.query<{context_id:string;project_id:string;archived:boolean;principal_id:string;account_id:string;executor_digest:string;key_fingerprint:string}>(
   `SELECT j.context_id::text,x.project_id::text,x.archived,i.principal_id,j.account_id::text,j.executor_digest,j.key_fingerprint
    FROM ac_native_execution_jobs j
    JOIN ac_contexts x ON x.id=j.context_id
    JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
    WHERE j.id=$1`,[jobId])).rows[0];
  if(!row||row.archived)throw new Refusal('MAINTENANCE_EXAM_NOT_FOUND',404);
  const project=[config.project,...config.projects].find(item=>item.id===row.project_id);
  if(!project)throw new Refusal('MAINTENANCE_EXAM_NOT_FOUND',404);
  const principal=project.owner;
  if(row.principal_id!==principal||!(await ledger.pool.query(
   "SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[project.id,principal],
  )).rowCount)throw new Refusal('MAINTENANCE_EXAM_PRINCIPAL_MISMATCH',403);
  try{
   authority=await ledger.acquire(principal,row.context_id,randomUUID(),'personal-maintenance',60);
  }catch(error){
   if(error instanceof Refusal&&error.code==='MANAGER_ACTIVE')throw new Refusal('MAINTENANCE_CONTEXT_BUSY',409);
   throw error;
  }
  const supervisor=(await composePersonalExecutionSupervisors(config,ledger)).find(item=>item.supportsAccount(row.account_id)&&
   item.executorDigest===row.executor_digest&&item.keyFingerprint===row.key_fingerprint&&item.keyFingerprint===boot.execution.keyFingerprint);
  if(!supervisor)throw new Refusal('MAINTENANCE_SUPERVISOR_UNAVAILABLE',409);
  const result:NativeModuleExamRecovery=await supervisor.recoverNeverStartedModuleExam(principal,authority,jobId,{projectId:project.id,repository:project.repo});
  if(result.state!=='retired')throw new ModuleExamRecoveryPreserved(result.reason as ConstructorParameters<typeof ModuleExamRecoveryPreserved>[0],result.removed);
  return [result.replayed
   ?`Tentativa de exame ${jobId} já estava retirada sem execução (job: failed, reserva: liberada). Nada foi alterado.`
   :`Tentativa de exame ${jobId} retirada sem execução (job: failed, reserva: liberada, contêiner de ferramentas removido: ${result.removed.join(', ')||'nenhum'}).`];
 }finally{
  if(authority)await ledger.releaseLease(authority).catch(()=>{/* an unreleased lease expires by itself */});
  await ledger.close();
 }
}

/** Owner-run retention of the `work` copy of finished passive exams (see NativeExecutionSupervisor.releaseModuleExamWork).
 * Scope is one configured project or an explicit id list, never the installation. Without `apply` nothing is removed.
 * Every job is judged again under its context lease and row lock, so a repeat run, a busy context or a bad id only changes that line. */
export async function releaseExamWorkFromInstallation(config:Installation,selection:WorkSelection):Promise<string[]>{
 if(typeof selection.apply!=='boolean'||!Number.isInteger(selection.limit)||selection.limit<1||selection.limit>MAX_WORK_BATCH||
    Boolean(selection.projectId)===Boolean(selection.jobIds)||selection.projectId&&!Id.safeParse(selection.projectId).success||
    selection.after&&(!selection.projectId||!Id.safeParse(selection.after).success)||
    selection.jobIds&&(!Array.isArray(selection.jobIds)||!selection.jobIds.length||selection.jobIds.length>Math.min(selection.limit,MAX_WORK_BATCH)||selection.jobIds.some(id=>!Id.safeParse(id).success)))
  throw new Refusal('MAINTENANCE_USAGE');
 const boot=config.nativeBootstrap;
 if(!boot||boot.state!=='active')throw new Refusal('MAINTENANCE_NATIVE_REQUIRED',409);
 const projects=[config.project,...config.projects];
 if(selection.projectId&&!projects.some(item=>item.id===selection.projectId))throw new Refusal('MAINTENANCE_EXAM_NOT_FOUND',404);
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 const lines:string[]=[];
 const totals={eligible:0,released:0,absent:0,refused:0,busy:0,failed:0,bytes:0};
 try{
  const columns="j.id::text,j.context_id::text,x.project_id::text,j.account_id::text,j.key_fingerprint,i.command->'payload'->>'workflow' AS workflow";
  type Candidate={id:string;context_id:string;project_id:string;account_id:string;key_fingerprint:string;workflow:string|null};
  const found=selection.projectId
   ?(await ledger.pool.query<Candidate>(`SELECT ${columns} FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id
      JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
      JOIN ac_native_terminal_retirements r ON r.job_id=j.id AND r.state='removed'
      WHERE x.project_id=$1 AND j.state='completed' AND j.role='specialist' AND ($2::uuid IS NULL OR j.id>$2) ORDER BY j.id LIMIT $3`,[selection.projectId,selection.after??null,MAX_WORK_BATCH])).rows
   :(await ledger.pool.query<Candidate>(`SELECT ${columns} FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id WHERE j.id=ANY($1::uuid[])`,[selection.jobIds])).rows;
  for(const id of selection.jobIds??[])if(!found.some(row=>row.id===id)){lines.push(`${id}: recusado (not_found).`);totals.refused++;}
  const supervisors=await composePersonalExecutionSupervisors(config,ledger);
  const owners=new Map<string,string|undefined>();
  let handled=0,lastId:string|undefined;
  for(const row of found){
   if(selection.projectId&&handled>=selection.limit)break;
   lastId=row.id;
   const project=projects.find(item=>item.id===row.project_id);
   if(!project){lines.push(`${row.id}: recusado (project).`);totals.refused++;continue;}
   // The limit counts jobs actually freed (or eligible), so refusals never starve a repeated batch. Jobs without `work` (and `review-artifact`) are skipped without a lease.
   if(selection.projectId){
    const statChild=(name:string)=>lstat(join(boot.execution.hostRoot,row.id,name)).then(()=>true,(e:NodeJS.ErrnoException)=>e.code==='ENOENT'?false:null);
    const workPresent=await statChild('work');
    const reviewPresent=workPresent===false&&!readonlyDesignExam(row.workflow,'specialist')?await statChild('review-artifact'):false;
    if(workPresent===null||reviewPresent===null){totals.failed++;lines.push(row.id+': não foi possível inspecionar work.');continue;}
    const present=workPresent||reviewPresent;
    if(!present && !(await ledger.pool.query("SELECT 1 FROM ac_audit p WHERE p.context_id=$1 AND p.detail->>'jobId'=$2 AND p.kind='native.exam_work_release_planned' AND NOT EXISTS(SELECT 1 FROM ac_audit q WHERE q.context_id=p.context_id AND q.detail->>'jobId'=p.detail->>'jobId' AND q.kind IN ('native.exam_work_released','native.exam_work_absent_after_plan') AND q.id>p.id) LIMIT 1",[row.context_id,row.id])).rowCount){totals.absent++;continue;}
   }
   const principal=project.owner;
   if(!owners.has(project.id))owners.set(project.id,(await ledger.pool.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[project.id,principal])).rowCount?principal:undefined);
   if(!owners.get(project.id)){lines.push(`${row.id}: recusado (owner).`);totals.refused++;continue;}
   const supervisor=supervisors.find(item=>item.supportsAccount(row.account_id)&&item.keyFingerprint===row.key_fingerprint&&item.keyFingerprint===boot.execution.keyFingerprint);
   if(!supervisor){lines.push(`${row.id}: recusado (supervisor_identity).`);totals.refused++;continue;}
   let authority:Authority|undefined;
   try{
    authority=await ledger.acquire(principal,row.context_id,randomUUID(),'personal-maintenance',60);
    const result:ModuleExamWorkRelease=await supervisor.releaseModuleExamWork(principal,authority,row.id,selection.apply);
    if(result.state==='refused'){totals.refused++;lines.push(`${row.id}: recusado (${result.reason}).`);}
    else{totals[result.state]++;totals.bytes+=result.bytes??0;if(result.state!=='absent'){handled++;lines.push(`${row.id}: ${result.state==='released'?'work apagado':'elegível'} (${result.bytes??0} bytes).`);}}
   }catch(error){
    if(error instanceof Refusal&&error.code==='MANAGER_ACTIVE'){totals.busy++;lines.push(`${row.id}: contexto ocupado; repita depois.`);}
    else{totals.failed++;lines.push(`${row.id}: falhou (${error instanceof Refusal?error.code:'erro'}); repita depois.`);}
   }finally{if(authority)await ledger.releaseLease(authority).catch(()=>{/* an unreleased lease expires by itself */});}
  }
  if(selection.projectId&&lastId&&(found.length===MAX_WORK_BATCH||lastId!==found.at(-1)?.id))lines.push('Continue com --apos '+lastId+'.');
  const mb=Math.round(totals.bytes/1048576);
  lines.push(selection.apply
   ?`Retirada de work/: ${totals.released} apagado(s) (${mb} MB), ${totals.absent} já sem work, ${totals.refused} recusado(s), ${totals.busy} ocupado(s), ${totals.failed} com falha. Repita até não restar nenhum.`
   :`Prévia, nada foi apagado: ${totals.eligible} elegível(is) (${mb} MB), ${totals.absent} já sem work, ${totals.refused} recusado(s). Use --aplicar para apagar.`);
  return lines;
 }finally{await ledger.close();}
}

/** Hook for retention of other artifacts (owner-managed). It runs inside the same single-flight run as the job copies,
 * receives the open ledger, and returns report lines. A failing extension never stops the others or the job retention. */
export type JobRetentionExtension={name:string;run:(context:{config:Installation;apply:boolean;ledger:Ledger})=>Promise<string[]>};
export type JobRetentionOptions={
 /** Most jobs freed (or, in a preview, found eligible) or failed in one run. Refusals and jobs already without work never count. */
 limit?:number;
 /** The run stops starting new jobs after this long; the cursor lets the next run continue where this one stopped. */
 deadlineMs?:number;
 extensions?:readonly JobRetentionExtension[];
};
const JOB_RETENTION_LOCK='agent-control:job-work-retention';
const RETENTION_PAGE=100;

/** Automatic retention of `work/` of every terminal, reconciled and proven native job (passive exams, read-only evaluators, registered programmer artifacts).
 * It needs no exclusive window and no stopped gateway: it takes no context lease (see NativeExecutionSupervisor.retireTerminalWork) and serializes
 * on one advisory lock for the whole run plus one per job, so overlapping watch ticks and manual runs only skip each other.
 * The inventory is one readdir of the job root plus one lstat per job; a persistent cursor makes consecutive runs walk the whole inventory
 * round-robin, so jobs that never become eligible cannot hold back the ones behind them. Without `apply` nothing is removed.
 * Receipts, results, reports, programmer and design review artifacts, logs and the database are never touched. */
export async function runPersonalJobRetention(config:Installation,apply:boolean,options:JobRetentionOptions={}):Promise<string[]>{
 if(typeof apply!=='boolean')throw new Refusal('MAINTENANCE_USAGE');
 const limit=options.limit??100,deadlineMs=options.deadlineMs??15*60*1000;
 if(!Number.isInteger(limit)||limit<1||!Number.isFinite(deadlineMs)||deadlineMs<1)throw new Refusal('MAINTENANCE_USAGE');
 const boot=config.nativeBootstrap;
 if(!boot||boot.state!=='active')return ['Sem runtime nativo ativo: nenhuma cópia de job a retirar.'];
 const projects=[config.project,...config.projects];
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 const guard=await ledger.pool.connect();
 let guardBroken=false;
 guard.on('error',()=>{guardBroken=true;});
 try{
  if(!(await guard.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[JOB_RETENTION_LOCK])).rows[0].ok)
   return ['Retenção de jobs já em execução em outro processo; nada a fazer agora.'];
  const started=Date.now();
  const cursorFile=join(config.dataDirectory,'job-work-retention.cursor');
  const {ids:withWork,scanned}=await inventoryJobWork(boot.execution.hostRoot);
  const candidates=new Set(withWork);
  // A plan whose release never reached the journal only needs its audit row closed; its work is already gone.
  if(apply)for(const row of (await ledger.pool.query<{id:string}>(
   `SELECT DISTINCT p.detail->>'jobId' id FROM ac_audit p WHERE p.kind='native.exam_work_release_planned' AND NOT EXISTS(
     SELECT 1 FROM ac_audit q WHERE q.context_id=p.context_id AND q.kind IN ('native.exam_work_released','native.exam_work_absent_after_plan') AND q.detail->>'jobId'=p.detail->>'jobId' AND q.id>p.id) LIMIT 200`)).rows)
   if(Id.safeParse(row.id).success)candidates.add(row.id);
  const order=rotateAfter([...candidates].sort(),await readRetentionCursor(cursorFile));
  const supervisors=await composePersonalExecutionSupervisors(config,ledger);
  const owners=new Map<string,string|undefined>();
  const lines:string[]=[];
  const refused=new Map<string,number>();
  const totals={eligible:0,released:0,absent:0,busy:0,failed:0,unknown:0,bytes:0};
  const byCategory=new Map<string,number>();
  let spent=0,examined=0,lastId:string|undefined,stopped=false;
  for(let from=0;from<order.length&&!stopped;from+=RETENTION_PAGE){
   const page=order.slice(from,from+RETENTION_PAGE);
   const rows=new Map((await ledger.pool.query<{id:string;context_id:string;project_id:string;account_id:string;key_fingerprint:string}>(
    `SELECT j.id::text,j.context_id::text,x.project_id::text,j.account_id::text,j.key_fingerprint FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id WHERE j.id=ANY($1::uuid[])`,[page])).rows.map(row=>[row.id,row]));
   for(const id of page){
    if(spent>=limit||Date.now()-started>=deadlineMs){stopped=true;break;}
    lastId=id;examined++;
    const row=rows.get(id);
    if(!row){totals.unknown++;continue;}
    const refuse=(reason:string)=>refused.set(reason,(refused.get(reason)??0)+1);
    const project=projects.find(item=>item.id===row.project_id);
    if(!project){refuse('project');continue;}
    if(!owners.has(project.id))owners.set(project.id,(await ledger.pool.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[project.id,project.owner])).rowCount?project.owner:undefined);
    const principal=owners.get(project.id);
    if(!principal){refuse('owner');continue;}
    const supervisor=supervisors.find(item=>item.supportsAccount(row.account_id)&&item.keyFingerprint===row.key_fingerprint&&item.keyFingerprint===boot.execution.keyFingerprint);
    if(!supervisor){refuse('supervisor_identity');continue;}
    try{
     const result=await supervisor.retireTerminalWork(principal,id,apply,{contextId:row.context_id,projectId:project.id,repository:project.repo});
     if(result.state==='refused'){
      if(result.reason==='busy')totals.busy++;else refuse(result.reason);
      if(result.reason==='output_missing')lines.push(`${id}: work preservado (output_missing); resultado ausente, requer análise.`);
     }else if(result.state==='absent')totals.absent++;
     else{
      totals[result.state]++;totals.bytes+=result.bytes??0;spent++;
      byCategory.set(result.category??'?',(byCategory.get(result.category??'?')??0)+1);
      lines.push(`${id}: ${result.state==='released'?'work apagado':'work elegível'} (${result.bytes??0} bytes, ${result.category}).`);
     }
    }catch(error){
     totals.failed++;spent++;
     lines.push(`${id}: falhou (${error instanceof Refusal?error.code:'erro'}); repete na próxima rodada.`);
    }
   }
  }
  // Stopped early: continue after the last job looked at. A full pass starts over from the beginning.
  if(apply)await writeRetentionCursor(cursorFile,stopped?lastId:undefined).catch(()=>undefined/* without a cursor the next pass starts from the beginning */);
  const mb=Math.round(totals.bytes/1048576);
  const why=[...refused].sort(([a],[b])=>a<b?-1:1).map(([reason,n])=>`${reason}=${n}`).join(', ');
  const kinds=[...byCategory].sort(([a],[b])=>a<b?-1:1).map(([kind,n])=>`${kind}=${n}`).join(', ');
  const rest=stopped?` Parou no limite; ${order.length-examined} candidato(s) ficam para a próxima rodada.`:'';
  lines.push(apply
   ?`Retenção de work/ de jobs: ${totals.released} apagado(s) (${mb} MB${kinds?`; ${kinds}`:''}), ${totals.absent} já sem work, ${totals.busy} ocupado(s), ${totals.failed} com falha, ${totals.unknown} sem registro, recusados: ${why||'nenhum'}. Inventário: ${withWork.length} com work em ${scanned} job(s).${rest}`
   :`Prévia de retenção, nada foi apagado: ${totals.eligible} elegível(is) (${mb} MB${kinds?`; ${kinds}`:''}), ${totals.busy} ocupado(s), ${totals.unknown} sem registro, recusados: ${why||'nenhum'}. Inventário: ${withWork.length} com work em ${scanned} job(s). Use --aplicar para apagar.${rest}`);
  for(const extension of options.extensions??[]){
   try{lines.push(...await extension.run({config,apply,ledger}));}
   catch{lines.push(`Extensão de retenção ${extension.name} falhou; as demais seguem.`);}
  }
  return lines;
 }finally{
  if(!guardBroken)await guard.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[JOB_RETENTION_LOCK]).catch(()=>{guardBroken=true;});
  guard.release(guardBroken);
  await ledger.close();
 }
}

// ---- Weekly maintenance: three separate stages ----------------------------------------------------------------
// bases (vulnerability databases), retention (work copies, worktrees, images, temporaries) and a build cache that is cleaned ONLY
// on a builder dedicated to this installation. The Docker daemon is shared with other projects: its own cache is never pruned.

type StageKey='bases'|'retention'|'cache';
type StageStatus={lastRun?:string;lastSuccess?:string;outcome?:'ok'|'failed'|'skipped'};
type MaintenanceStatus={schemaVersion:1;stages:Partial<Record<StageKey,StageStatus>>};
const STATUS_FILE='maintenance-status.json';
const DATABASE_STALE_DAYS=14;
const iso=(value:unknown)=>typeof value==='string'&&!Number.isNaN(Date.parse(value))?value:undefined;

async function readMaintenanceStatus(dataDirectory:string):Promise<MaintenanceStatus>{
 const status:MaintenanceStatus={schemaVersion:1,stages:{}};
 try{
  const raw=JSON.parse(await readFile(join(dataDirectory,STATUS_FILE),'utf8')) as {stages?:Record<string,Record<string,unknown>>};
  for(const key of ['bases','retention','cache'] as const){
   const entry=raw.stages?.[key];
   if(!entry)continue;
   const outcome=entry.outcome==='ok'||entry.outcome==='failed'||entry.outcome==='skipped'?entry.outcome:undefined;
   status.stages[key]={lastRun:iso(entry.lastRun),lastSuccess:iso(entry.lastSuccess),outcome};
  }
 }catch{/* absent or damaged: the state starts again */}
 return status;
}
async function writeMaintenanceStatus(dataDirectory:string,status:MaintenanceStatus){
 const file=join(dataDirectory,STATUS_FILE),temporary=`${file}.${randomUUID()}.tmp`;
 try{
  await writeFile(temporary,JSON.stringify(status,null,1)+'\n',{mode:0o600,flag:'wx'});
  await chmod(temporary,0o600);
  await rename(temporary,file);
 }catch{/* a full disk must not hide the report of the stages themselves */}
}

/** Builder name reserved for one installation: `agent-control-<directory name>`. Same sanitising as the service name. */
const dedicatedBuilder=(installationFile:string)=>'agent-control-'+(basename(dirname(resolve(installationFile))).replace(/[^A-Za-z0-9_-]/g,'-')||'installation');

async function describeStatus(config:Installation,status:MaintenanceStatus,deps:MaintenanceDeps,now:Date,mode:string):Promise<string[]>{
 const stage=(key:StageKey)=>`última execução ${status.stages[key]?.lastRun??'nunca'}, último sucesso ${status.stages[key]?.lastSuccess??'nunca'}`;
 let age:string,stale=false;
 try{
  const current=await (deps.currentDatabase??readCurrentVerifyDatabase)(config.dataDirectory);
  if(!current)age='nenhuma base publicada';
  else{
   const days=Math.max(0,Math.floor((now.getTime()-Date.parse(current.fetchedAt))/86_400_000));
   age=`idade da base publicada ${days} dia(s) (de ${current.fetchedAt})`;
   stale=days>DATABASE_STALE_DAYS;
  }
 }catch{age='idade da base publicada indisponível';}
 const lines=[`Bases: ${stage('bases')}, ${age}.`,`Retenção: modo ${mode}, ${stage('retention')}.`,`Cache de build dedicado: ${stage('cache')}.`];
 if(stale)lines.push(`ATENÇÃO: base de vulnerabilidades com mais de ${DATABASE_STALE_DAYS} dias; os exames de segurança usam dados antigos.`);
 return lines;
}

async function runMaintenanceStages(config:Installation,file:string,deps:MaintenanceDeps,options:{retention:boolean}):Promise<string[]>{
 const now=(deps.now??(()=>new Date()))();
 const status=await readMaintenanceStatus(config.dataDirectory);
 const docker=deps.docker??(args=>run('docker',args,30*60*1000));
 const mode=config.retention?.automatic??'preview';
 const lines:string[]=[],failed:string[]=[];
 const stage=async(key:StageKey,action:()=>Promise<{outcome:'ok'|'failed'|'skipped';lines:string[]}>)=>{
  const at=now.toISOString();
  const entry=status.stages[key]={...status.stages[key],lastRun:at};
  let result:{outcome:'ok'|'failed'|'skipped';lines:string[]};
  try{result=await action();}
  catch(error){
   result={outcome:'failed',lines:error instanceof RetentionIncomplete?error.lines:[`Etapa ${key} falhou (${error instanceof Refusal?error.code:'erro'}).`]};
  }
  entry.outcome=result.outcome;
  if(result.outcome==='ok')entry.lastSuccess=at;
  if(result.outcome==='failed')failed.push(key);
  lines.push(...result.lines);
 };
 await stage('bases',async()=>{
  try{
   await (deps.refreshDatabases??(()=>refreshVerifyDatabases({dataDirectory:config.dataDirectory}).then(()=>undefined)))(config.dataDirectory);
   return {outcome:'ok',lines:['Bases de vulnerabilidade atualizadas.']};
  }catch{return {outcome:'failed',lines:['Bases de vulnerabilidade não atualizadas. A base anterior permanece.']};}
 });
 if(options.retention)await stage('retention',async()=>{
  if(mode==='off')return {outcome:'skipped',lines:['Retenção automática desligada (modo off).']};
  const out=await runRetentionStages(config,mode==='apply',deps);
  return {outcome:'ok',lines:mode==='apply'?out:[...out,'Retenção em modo prévia: nada é apagado. Use retention.automatic=apply para liberar espaço.']};
 });
 await stage('cache',async()=>{
  const builder=dedicatedBuilder(file);
  // Only a builder that belongs to this installation is ever pruned. Without one, the daemon's shared cache is left alone.
  if(await docker(['buildx','inspect',builder])!==0)return {outcome:'skipped',lines:['Cache de build dedicado: sem builder dedicado desta instalação; o cache do daemon não foi tocado.']};
  const code=await docker(['buildx','prune','--builder',builder,'-f','--filter','until=168h']);
  return code===0?{outcome:'ok',lines:[`Cache de build dedicado: cache com mais de 7 dias apagado no builder ${builder}.`]}:{outcome:'failed',lines:[`Cache de build dedicado: o builder ${builder} não pôde ser limpo.`]};
 });
 await writeMaintenanceStatus(config.dataDirectory,status);
 lines.push(...await describeStatus(config,status,deps,now,mode));
 if(failed.length)throw new MaintenanceIncomplete(lines,failed);
 return lines;
}

/** Weekly: the vulnerability databases, the retention of the installation and the dedicated build cache, each as its own stage.
 * Volumes, containers and images of other projects are never touched, and the shared daemon's cache is never pruned. The gateway keeps running. */
export async function runPersonalMaintenance(argv:string[],deps:MaintenanceDeps={}){
 if(argv.length===2&&argv[1]==='--retencao-agendada'){
  const scheduled=await loadInstallation(resolve(argv[0]!));
  if(scheduled.activation!=='personal')throw new Refusal('MAINTENANCE_PERSONAL_REQUIRED');
  const mode=scheduled.retention?.automatic??'preview';
  return mode==='off'?['Retenção automática desligada.']:runRetentionStages(scheduled,mode==='apply',deps);
 }
 if(argv.length===2&&(argv[1]==='--manutencao-agendada'||argv[1]==='--estado-manutencao')){
  const scheduled=await loadInstallation(resolve(argv[0]!));
  if(scheduled.activation!=='personal')throw new Refusal('MAINTENANCE_PERSONAL_REQUIRED');
  if(argv[1]==='--manutencao-agendada')return runMaintenanceStages(scheduled,resolve(argv[0]!),deps,{retention:true});
  return describeStatus(scheduled,await readMaintenanceStatus(scheduled.dataDirectory),deps,(deps.now??(()=>new Date()))(),scheduled.retention?.automatic??'preview');
 }
 const parsed=parseMaintenanceArgs(argv);
 const file=resolve(parsed.installationPath);
 const config=await loadInstallation(file);
 if(config.activation!=='personal')throw new Refusal('MAINTENANCE_PERSONAL_REQUIRED');
 if(parsed.artifactArgs)return runArtifactCommand(config,parsed.artifactArgs);
 if(parsed.recoverExamJobId)return recoverInterruptedExamFromInstallation(config,parsed.recoverExamJobId,true);
 if(parsed.releaseExamWork)return releaseExamWorkFromInstallation(config,parsed.releaseExamWork);
 if(parsed.jobRetention)return runRetentionStages(config,parsed.jobRetention.apply,deps);
 if(parsed.recoverModuleExamJobId)return recoverNeverStartedModuleExamFromInstallation(config,parsed.recoverModuleExamJobId);
 // Manual run without a flag: databases and the dedicated cache. Retention keeps its own commands and the watch.
 const lines=await runMaintenanceStages(config,file,deps,{retention:false}).catch(error=>{
  if(error instanceof MaintenanceIncomplete)return error.lines;// a manual run reports a failed stage and still finishes
  throw error;
 });
 const boot=config.nativeBootstrap;
 if(!boot||boot.state==='disabled'||boot.state==='bench'){lines.push('Sem runtime nativo: nenhuma imagem aposentada.');return lines;}
 // Retired image records and images remain until pins across the shared daemon can be proved.
 lines.push('Imagens aposentadas e seus registros preservados; só uma imagem registrada como candidata é removida, por id, pela retenção de artefatos, e só se nenhuma instalação do daemon a fixar.');
 return lines;
}
