import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod,lstat,mkdir,readFile,readdir,readlink,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import type pg from 'pg';
import {Id,Refusal} from './contracts.ts';
import {Installation,loadInstallation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {mountedInside,protectedDigests,releaseProjectArtifacts,type CommandResult,type RetentionDeps} from './personal-artifact-retention.ts';
import {examStatusRow,processStartedAt} from './personal-status-cli.ts';
import {releaseIdleSharedWorktrees} from './simple-worktree.ts';
import {readVerificationProgress} from './verify-command.ts';
import {processAlive} from './verify-modules-status.ts';

/**
 * Removal of one secondary project from a personal installation, by the product path.
 *
 * Without `apply` it only reports what would change, with sizes. With `apply` it refuses while the project has an active job,
 * a held capacity grant or an exam in progress; then it backs up installation.json, takes the project out of `projects[]`,
 * archives the project and its contexts in the ledger (receipts and history stay) and revokes its account access. With
 * `deleteData` it also removes what the product created for the project: native job directories, qa-cache/<id>,
 * verificacoes/<id>, the registered worktrees, images, temporaries and rounds, the shared detached checkouts and the Docker
 * containers, volumes and images labelled `com.agent-control.project=<id>`. The project repository belongs to the owner and is
 * never removed; nothing inside or above it is touched. A project already out of installation.json but still in the ledger is
 * found by its id. The installation's primary project is refused.
 *
 * Stale activity does not hold the removal: a native or QA job still `uncertain`/`running` whose context has no live manager
 * lease, created more than {@link STALE_JOB_HOURS} h ago, with no running container of its own and no process inside its job
 * directory, is closed in the archiving transaction (job `failed`, grant released with a `project-removal-stale` receipt, intent
 * `failed` once nothing else uses it, one audit row each). A `.running` marker whose exam is not in progress by the liveness of
 * `personal:status` (terminal, or its PID dead or reused) is dropped after the commit. Anything not proven stale still refuses.
 */

export const PROJECT_LABEL='com.agent-control.project';
const USAGE='Uso: npm run personal:project -- --remover <instalação.json> <id-ou-rótulo-do-projeto> [--apagar-dados] [--sim]';

export type ProjectRemoveDeps=RetentionDeps&{
 /** Every path some live process has as cwd, root or open file. Throwing means "cannot prove": nothing on disk is removed. */
 processPaths?:()=>Promise<string[]>;
 /** Test hook: runs after the first activity check and before the archiving transaction judges the activity again. */
 beforeArchive?:()=>Promise<void>;
 /** Liveness of the PID in an exam progress file, as in personal:status. Test hooks. */
 alive?:(pid:number)=>boolean;
 startedAt?:(pid:number)=>number|null;
};
export type ProjectRemoveResult={projectId:string;label:string;applied:boolean;lines:string[];backupPath?:string;reportPath?:string;restart:string};

const messages:Record<string,string>={
 PROJECT_REMOVE_USAGE:USAGE,
 PERSONAL_ACTIVATION_REQUIRED:'A remoção de projeto só roda numa instalação pessoal.',
 NOT_FOUND:'Projeto não encontrado no installation.json nem no banco.',
 PROJECT_AMBIGUOUS:'Há mais de um projeto com esse rótulo. Informe o UUID do projeto.',
 PRIMARY_PROJECT_FORBIDDEN:'O projeto principal da instalação não pode ser removido.',
 PROJECT_REMOVE_ACTIVE:'O projeto tem job ativo, vaga ou reserva presa, ou exame em andamento. Espere terminar (ou encerre) e repita.',
 PROJECT_ARCHIVE_MIGRATION_REQUIRED:'O banco ainda não tem a migração 124 (ac_projects.archived_at). Rode antes: npm run gateway -- initialize <instalação.json>',
 INVALID_INSTALLATION:'O arquivo de instalação ficaria inválido sem o projeto.',
};
export function personalProjectRemoveFailureText(error:unknown):string{
 const code=error instanceof Refusal?error.code:error instanceof Error?error.message:'';
 const base=messages[code]??(code||'Não foi possível remover o projeto.');
 return error instanceof ActiveProject?`${base} ${error.detail}`:base;
}
class ActiveProject extends Refusal{constructor(readonly detail:string){super('PROJECT_REMOVE_ACTIVE',409);}}

const errno=(error:unknown,code:string)=>(error as NodeJS.ErrnoException)?.code===code;
const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
const gb=(bytes:number)=>bytes>=1e8?`${(bytes/1e9).toFixed(2)} GB`:`${(bytes/1e6).toFixed(1)} MB`;
function stampOf(now:Date){
 const pad=(value:number,width=2)=>value.toString().padStart(width,'0');
 return `${pad(now.getUTCFullYear(),4)}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}
function run(command:string,args:string[],cwd?:string){
 return new Promise<CommandResult>(done=>{
  execFile(command,args,{cwd,encoding:'utf8',maxBuffer:64*1024*1024,timeout:10*60*1000,env:command==='git'?{PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',LC_ALL:'C'}:process.env},(error,stdout,stderr)=>{
   const code=error?(typeof (error as {code?:unknown}).code==='number'?(error as unknown as {code:number}).code:1):0;
   done({code,stdout:stdout??'',stderr:(stderr??'').slice(0,4000)});
  });
 });
}
const defaultDocker=(args:string[])=>run('docker',args);
const defaultGit=(cwd:string,args:string[])=>run('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],cwd);

/** One pass over /proc: the cwd, root and open files of every process this user may inspect. Processes of other uids that /proc
 * does not let us read are skipped; a containerised job's processes are covered by the running-container check instead. */
async function defaultProcessPaths(){
 const paths:string[]=[];
 for(const name of await readdir('/proc')){
  if(!/^[1-9][0-9]*$/.test(name))continue;
  const base='/proc/'+name;
  try{
   for(const link of ['cwd','root'])paths.push(await readlink(join(base,link)));
   for(const fd of await readdir(join(base,'fd')))paths.push(await readlink(join(base,'fd',fd)).catch(()=>''));
  }catch(error){
   if(errno(error,'ENOENT')||errno(error,'ESRCH')||errno(error,'EACCES')||errno(error,'EPERM'))continue;
   throw error;
  }
 }
 return paths.filter(path=>path.startsWith('/'));
}

/** Bytes on disk of a tree, without following links or crossing into other file systems. Hard links count once. */
async function diskUsage(path:string):Promise<number>{
 const top=await lstat(path).catch(()=>undefined/* absent path uses no disk */);
 if(!top)return 0;
 const seen=new Set<string>();
 let bytes=0;
 const stack=[path];
 while(stack.length){
  const current=stack.pop()!;
  const info=await lstat(current).catch(()=>undefined/* gone while measuring: counts nothing */);
  if(!info||info.dev!==top.dev)continue;
  const key=info.dev+':'+info.ino;
  if(seen.has(key))continue;
  seen.add(key);
  bytes+=info.blocks*512;
  if(info.isDirectory())for(const name of await readdir(current).catch(()=>[] as string[]))stack.push(join(current,name));
 }
 return bytes;
}

type Target={projectId:string;label:string;inFile:boolean;repo?:string};

async function findTarget(config:Installation,ledger:Ledger,token:string):Promise<Target>{
 if(token===config.project.id||token===config.project.label)throw new Refusal('PRIMARY_PROJECT_FORBIDDEN',403);
 const listed=config.projects.filter(item=>item.id===token||item.label===token);
 if(listed.length>1)throw new Refusal('PROJECT_AMBIGUOUS',409);
 const archivedColumn=await hasArchiveColumn(ledger);
 const rows=(await ledger.pool.query<{id:string;label:string;repo:string|null}>(
  `SELECT p.id::text AS id,p.label,r.repo FROM ac_projects p LEFT JOIN ac_project_repositories r ON r.project_id=p.id
   WHERE ${Id.safeParse(token).success?'p.id=$1::uuid':'p.label=$1'+(archivedColumn?' AND p.archived_at IS NULL':'')}`,[token])).rows;
 const hit=listed[0];
 if(hit){
  const row=rows.find(item=>item.id===hit.id);
  return {projectId:hit.id,label:hit.label,inFile:true,repo:hit.repo??row?.repo??undefined};
 }
 if(rows.length>1)throw new Refusal('PROJECT_AMBIGUOUS',409);
 const row=rows[0];
 if(!row)throw new Refusal('NOT_FOUND',404);
 if(row.id===config.project.id)throw new Refusal('PRIMARY_PROJECT_FORBIDDEN',403);
 return {projectId:row.id,label:row.label,inFile:false,repo:row.repo??undefined};
}
async function hasArchiveColumn(ledger:Ledger){
 return Boolean((await ledger.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='ac_projects' AND column_name='archived_at' AND table_schema=current_schema()")).rowCount);
}

const activeSql=`SELECT
 (SELECT count(*)::int FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id WHERE x.project_id=$1 AND j.state IN ('uncertain','running')) AS jobs,
 (SELECT count(*)::int FROM ac_native_qa_jobs j JOIN ac_contexts x ON x.id=j.context_id WHERE x.project_id=$1 AND j.state IN ('uncertain','running')) AS qa,
 (SELECT count(*)::int FROM ac_capacity_grants WHERE project_id=$1 AND state<>'released') AS grants,
 (SELECT count(*)::int FROM ac_verify_runs WHERE project_id=$1 AND status='running') AS exams`;
type Activity={jobs:number;qa:number;grants:number;exams:number;marker:boolean};

/** Hours a job must exist before the absence of its process can close it: longer than any job timeout. */
export const STALE_JOB_HOURS=24;
const STALE_SOURCE='project-removal-stale';
const EXECUTION_FINGERPRINT=(t:string)=>`jsonb_build_array(${t}.state,${t}.worker_id,${t}.tools_id,${t}.launch_digest,${t}.network_id)::text`;
const QA_FINGERPRINT=(t:string)=>`jsonb_build_array(${t}.state,${t}.container_id,${t}.stop_reason)::text`;
const staleCandidatesSql=`SELECT j.kind,j.id::text AS id,j.context_id::text AS context_id,j.intent_id::text AS intent_id,j.grant_id::text AS grant_id,
  g.state AS grant_state,j.containers,j.created_at<clock_timestamp()-($2::int*interval '1 hour') AS old,
  EXISTS(SELECT 1 FROM ac_managers m WHERE m.context_id=j.context_id AND m.lease_until>clock_timestamp()) AS lease,j.fingerprint
 FROM (SELECT 'execution' AS kind,e.id,e.context_id,e.intent_id,e.grant_id,e.created_at,array_remove(ARRAY[e.worker_id,e.tools_id],NULL) AS containers,${EXECUTION_FINGERPRINT('e')} AS fingerprint
   FROM ac_native_execution_jobs e WHERE e.state IN ('uncertain','running')
  UNION ALL SELECT 'qa',q.id,q.context_id,q.intent_id,q.grant_id,q.created_at,array_remove(ARRAY[q.container_id],NULL),${QA_FINGERPRINT('q')}
   FROM ac_native_qa_jobs q WHERE q.state IN ('uncertain','running')) j
 JOIN ac_contexts x ON x.id=j.context_id JOIN ac_capacity_grants g ON g.id=j.grant_id
 WHERE x.project_id=$1 ORDER BY j.created_at,j.id`;
/** Everything that moves while a job lives: judged once outside the transaction, compared again under the row lock. */
type JobVerdict={kind:'execution'|'qa';id:string;contextId:string;grantId:string;grantState:string;fingerprint:string;stale:boolean;reason:string};

/** Each active job of the project, and whether it is provably without a live process (empty `reason`). */
async function judgeActiveJobs(ledger:Ledger,projectId:string,hostRoot:string,docker:NonNullable<RetentionDeps['docker']>,processPaths:()=>Promise<string[]>):Promise<JobVerdict[]>{
 const rows=(await ledger.pool.query<{kind:'execution'|'qa';id:string;context_id:string;grant_id:string;grant_state:string;containers:string[];old:boolean;lease:boolean;fingerprint:string}>(
  staleCandidatesSql,[projectId,STALE_JOB_HOURS])).rows;
 if(!rows.length)return [];
 // Running containers only: a stopped one runs no process. Docker or /proc unreadable proves nothing.
 const listed=await docker(['container','ls','--no-trunc','--format','{{.ID}} {{.Names}}']);
 const running=listed.code===0?listed.stdout.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
  const [id='',names='']=line.split(/\s+/);
  return {id,names:names.split(',')};
 }):undefined;
 let open:string[]|undefined;
 try{open=await processPaths();}catch{open=undefined;}
 return rows.map(row=>{
  const path=join(hostRoot,row.id);
  const reason=row.lease?'o contexto tem gerente com licença válida'
   :!row.old?`criado há menos de ${STALE_JOB_HOURS} h`
   :!running?'o Docker não respondeu sobre os contêineres em execução'
   :running.some(item=>row.containers.includes(item.id)||item.names.some(name=>name.includes(row.id)))?'há contêiner do job em execução'
   :!open?'não foi possível ler os processos'
   :open.some(item=>item===path||item.startsWith(path+sep))?'há processo usando a pasta do job'
   :'';
  return {kind:row.kind,id:row.id,contextId:row.context_id,grantId:row.grant_id,grantState:row.grant_state,fingerprint:row.fingerprint,stale:!reason,reason};
 });
}

type MarkerVerdict={present:boolean;stale:boolean;reason:string;body?:string};
/** The `.running` marker and whether its exam is provably not in progress, by the same rule as personal:status. */
async function judgeMarker(dataDirectory:string,projectId:string,path:string,deps:ProjectRemoveDeps,now:number):Promise<MarkerVerdict>{
 const info=await lstat(path).catch(()=>undefined/* no marker */);
 if(!info)return {present:false,stale:false,reason:''};
 if(info.isSymbolicLink()||!info.isFile())return {present:true,stale:false,reason:'o marcador não é um arquivo comum'};
 const body=await readFile(path,'utf8').catch(()=>undefined/* unreadable: cannot be judged */);
 const examId=body?.trim()??'';
 if(!Id.safeParse(examId).success)return {present:true,stale:false,reason:'o marcador não nomeia um exame'};
 const rows=await readVerificationProgress(dataDirectory,projectId,{all:true}).catch(()=>undefined/* unreadable: cannot be judged */);
 const row=rows?.find(item=>item.id===examId);
 if(!row)return {present:true,stale:false,reason:`o exame ${examId} não tem arquivo de andamento legível`};
 const state=examStatusRow({id:projectId,label:''},row,now,deps.alive??processAlive,deps.startedAt??processStartedAt).state;
 if(state==='em-andamento')return {present:true,stale:false,reason:`o exame ${examId} está em andamento`};
 return {present:true,stale:true,reason:`exame ${examId} ${state}, sem processo vivo`,body};
}

/** Inside the archiving transaction: locks the managers of the jobs' contexts, judges each job again and closes it. */
async function closeStaleJobs(c:pg.PoolClient,ledger:Ledger,projectId:string,jobs:JobVerdict[]):Promise<string[]>{
 if(!jobs.length)return [];
 const contexts=[...new Set(jobs.map(job=>job.contextId))];
 const leased=(await c.query<{context_id:string;live:boolean}>('SELECT context_id::text AS context_id,lease_until>clock_timestamp() AS live FROM ac_managers WHERE context_id=ANY($1::uuid[]) FOR UPDATE',[contexts]))
  .rows.filter(row=>row.live).map(row=>row.context_id);
 if(leased.length)throw new ActiveProject(`o contexto ${leased.join(', ')} ganhou gerente com licença válida.`);
 const lines:string[]=[];
 for(const job of jobs){
  const table=job.kind==='execution'?'ac_native_execution_jobs':'ac_native_qa_jobs';
  const row=(await c.query<{state:string;grant_id:string;intent_id:string;context_id:string;fingerprint:string}>(
   `SELECT j.state,j.grant_id::text AS grant_id,j.intent_id::text AS intent_id,j.context_id::text AS context_id,
     ${job.kind==='execution'?EXECUTION_FINGERPRINT('j'):QA_FINGERPRINT('j')} AS fingerprint FROM ${table} j WHERE j.id=$1 FOR UPDATE`,[job.id])).rows[0];
  // The job must be exactly as judged: a new state, container, launch or stop means something touched it meanwhile.
  if(!row||row.fingerprint!==job.fingerprint)throw new ActiveProject(`o job ${job.id} mudou depois da avaliação (${row?row.fingerprint:'sumiu'}); repita a prévia.`);
  await c.query(`UPDATE ${table} SET state='failed' WHERE id=$1`,[job.id]);
  const grant=(await c.query<{state:string}>('SELECT state FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[row.grant_id])).rows[0];
  const released=Boolean(grant&&grant.state!=='released');
  if(released)await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[row.grant_id,
   {source:STALE_SOURCE,jobId:job.id,projectId,containersRunning:false,processInsideJobDirectory:false}]);
  const open=(await c.query<{open:boolean}>(`SELECT EXISTS(SELECT 1 FROM ac_native_execution_jobs WHERE intent_id=$1 AND state IN ('uncertain','running'))
   OR EXISTS(SELECT 1 FROM ac_native_qa_jobs WHERE intent_id=$1 AND state IN ('uncertain','running'))
   OR EXISTS(SELECT 1 FROM ac_native_planning_jobs pj JOIN ac_semantic_planning_calls pc ON pc.id=pj.id WHERE pc.intent_id=$1 AND pj.state IN ('prepared','uncertain','running'))
   OR EXISTS(SELECT 1 FROM ac_capacity_grants WHERE intent_id=$1 AND state<>'released')
   OR EXISTS(SELECT 1 FROM ac_verify_runs WHERE intent_id=$1 AND status='running') AS open`,[row.intent_id])).rows[0]!.open;
  // Only an intent still 'accepted' (the open state the exam finalizers close too); any other state is left as it is.
  let intentClosed=false;
  if(!open){
   await c.query('SAVEPOINT stale_intent');
   try{intentClosed=Boolean((await c.query("UPDATE ac_intents SET state='failed' WHERE id=$1 AND state='accepted'",[row.intent_id])).rowCount);}
   catch(error){
    await c.query('ROLLBACK TO SAVEPOINT stale_intent');
    throw new ActiveProject(`a intenção ${row.intent_id} do job ${job.id} não pôde ser fechada (${error instanceof Error?error.message.slice(0,120):'erro do banco'}).`);
   }
   await c.query('RELEASE SAVEPOINT stale_intent');
  }
  if(intentClosed)await ledger.refreshPending(c,row.context_id);
  await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'project.remove.stale_job_closed',$2)",[row.context_id,
   {projectId,jobId:job.id,kind:job.kind,previousState:row.state,grantId:row.grant_id,grantReleased:released,intentId:row.intent_id,intentClosed,source:STALE_SOURCE}]);
  lines.push(`job ${job.id}: encerrado como falho (sem processo vivo)${released?', vaga liberada':''}${intentClosed?', intenção fechada':''}.`);
 }
 return lines;
}
const activityText=(a:Activity)=>[a.jobs&&`${a.jobs} job(s) nativo(s) ativo(s)`,a.qa&&`${a.qa} job(s) de QA ativo(s)`,a.grants&&`${a.grants} vaga(s) ou reserva(s) não liberada(s)`,
 a.exams&&`${a.exams} exame(s) em andamento no banco`,a.marker&&'marcador de exame em andamento em verificacoes/<id>/andamento/.running'].filter(Boolean).join('; ');

export async function removePersonalProject(installationPath:string,token:string,options:{apply:boolean;deleteData:boolean;now?:Date;deps?:ProjectRemoveDeps}):Promise<ProjectRemoveResult>{
 const file=resolve(installationPath);
 const config=await loadInstallation(file);
 if(config.activation!=='personal')throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
 const clean=token.trim();
 if(!clean||clean.startsWith('--'))throw new Refusal('PROJECT_REMOVE_USAGE',400);
 const deps=options.deps??{};
 const docker=deps.docker??defaultDocker,git=deps.git??defaultGit;
 const service=basename(config.dataDirectory).replace(/[^A-Za-z0-9_-]/g,'-')||'gateway';
 const restart=`systemctl --user restart agent-control-gateway-${service}`;
 const lines:string[]=[];
 const say=(line:string)=>lines.push(line);
 const ledger=new Ledger(config.databaseUrl,config.installationAuthority?.token);
 try{
  const target=await findTarget(config,ledger,clean);
  const {projectId}=target;
  const remaining={...config,projects:config.projects.filter(item=>item.id!==projectId)};
  // Paths that are never removed: the project repository and every repository or data root of the installation.
  const protectedRoots=[target.repo,config.project.repo,...config.projects.map(item=>item.repo)].filter((item):item is string=>Boolean(item));
  const sharedRepo=target.repo&&[config.project,...remaining.projects].some(item=>item.repo===target.repo);
  const repoOnDisk=target.repo&&!sharedRepo?await realpath(target.repo).then(()=>target.repo,()=>undefined):undefined;
  const archived=await hasArchiveColumn(ledger);
  const db=(await ledger.pool.query<{archived_at:Date|null;contexts:number;access:number}>(
   `SELECT ${archived?'p.archived_at':'NULL::timestamptz AS archived_at'},
     (SELECT count(*)::int FROM ac_contexts WHERE project_id=p.id AND NOT archived) AS contexts,
     (SELECT count(*)::int FROM ac_account_access WHERE project_id=p.id) AS access
    FROM ac_projects p WHERE p.id=$1`,[projectId])).rows[0];
  const verifyDir=join(config.dataDirectory,'verificacoes',projectId);
  const markerPath=join(verifyDir,'andamento','.running');
  const markerVerdict=await judgeMarker(config.dataDirectory,projectId,markerPath,deps,(options.now??new Date()).getTime());
  const counted:Activity={...(db?(await ledger.pool.query<Omit<Activity,'marker'>>(activeSql,[projectId])).rows[0]!:{jobs:0,qa:0,grants:0,exams:0}),marker:markerVerdict.present};
  const boot=config.nativeBootstrap as {execution?:{hostRoot?:string}}|undefined;
  const hostRoot=boot?.execution?.hostRoot??join(config.dataDirectory,'native','execution-host');
  const verdicts=db&&(counted.jobs||counted.qa)?await judgeActiveJobs(ledger,projectId,hostRoot,docker,deps.processPaths??defaultProcessPaths):[];
  const staleJobs=verdicts.filter(item=>item.stale);
  // What still holds the removal once the provably stale jobs and marker are set aside.
  const activity:Activity={jobs:counted.jobs-staleJobs.filter(item=>item.kind==='execution').length,qa:counted.qa-staleJobs.filter(item=>item.kind==='qa').length,
   grants:Math.max(0,counted.grants-new Set(staleJobs.filter(item=>item.grantState!=='released').map(item=>item.grantId)).size),exams:counted.exams,marker:markerVerdict.present&&!markerVerdict.stale};
  const why=[...verdicts.filter(item=>!item.stale).map(item=>`job ${item.id}: ${item.reason}`),...(activity.marker?[`marcador: ${markerVerdict.reason}`]:[])];
  const busy=activityText(activity)+(activityText(activity)&&why.length?` (${why.join('; ')})`:'');

  say(`Projeto ${target.label} (${projectId})${target.inFile?'':', já fora do installation.json'}${db?.archived_at?`, arquivado no banco em ${db.archived_at.toISOString()}`:''}.`);
  if(target.repo)say(`Repositório ${target.repo}: nunca é apagado.`);
  if(busy)say(`Atividade em curso: ${busy}.`);
  for(const job of staleJobs)say(`Atividade parada: job ${job.kind==='execution'?'nativo':'de QA'} ${job.id} sem processo vivo (sem licença de gerente, criado há mais de ${STALE_JOB_HOURS} h, sem contêiner em execução nem processo na pasta); ${options.apply?'é encerrado':'seria encerrado'} como falho${job.grantState!=='released'?', com a vaga liberada':''}, e a intenção fechada se nada mais a usa.`);
  if(markerVerdict.stale)say(`Atividade parada: marcador ${markerPath} (${markerVerdict.reason}); ${options.apply?'é removido':'seria removido'}.`);
  say(target.inFile?`installation.json: o projeto ${options.apply?'sai':'sairia'} de projects[] (com backup).`:'installation.json: nada a mudar.');
  if(db)say(`Banco: projeto ${db.archived_at?'já arquivado':options.apply?'arquivado':'seria arquivado'}; ${db.contexts} contexto(s) ${options.apply?'arquivado(s)':'seriam arquivados'}; ${db.access} acesso(s) de conta ${options.apply?'revogado(s)':'seriam revogados'}; recibos e histórico ficam.`);
  else say('Banco: o projeto não tem linha em ac_projects.');
  if(!archived&&db)say('Banco: falta a migração 124 (ac_projects.archived_at); rode "npm run gateway -- initialize <instalação.json>" antes de aplicar.');

  // ---- What would be removed on disk and in Docker ----
  const jobs=db?(await ledger.pool.query<{id:string;state:string}>(
   `SELECT j.id::text AS id,j.state FROM ac_native_execution_jobs j JOIN ac_contexts x ON x.id=j.context_id WHERE x.project_id=$1
    UNION ALL SELECT j.id::text,j.state FROM ac_native_qa_jobs j JOIN ac_contexts x ON x.id=j.context_id WHERE x.project_id=$1`,[projectId])).rows:[];
  const jobDirs:{id:string;path:string;terminal:boolean;bytes:number}[]=[];
  for(const job of jobs){
   const path=join(hostRoot,job.id);
   const info=await lstat(path).catch(()=>undefined/* no job directory on the host: nothing to remove */);
   // A stale job is closed by the archiving transaction before any data is removed.
   if(info)jobDirs.push({id:job.id,path,terminal:job.state==='completed'||job.state==='failed'||staleJobs.some(item=>item.id===job.id),bytes:0});
  }
  const extraDirs=[join(config.dataDirectory,'qa-cache',projectId),verifyDir];
  const plainDirs:string[]=[];
  for(const path of extraDirs)if(await lstat(path).then(()=>true,()=>false))plainDirs.push(path);
  let jobBytes=0;
  if(options.deleteData||!options.apply)for(const job of jobDirs){job.bytes=await diskUsage(job.path);jobBytes+=job.bytes;}
  const plainBytes=new Map<string,number>();
  for(const path of plainDirs)plainBytes.set(path,await diskUsage(path));
  if(!options.deleteData)say('Dados: ficam no disco (use --apagar-dados para removê-los).');
  say(`Dados${options.deleteData?'':' (com --apagar-dados)'}: ${jobDirs.length} pasta(s) de job nativo em ${hostRoot}, ${gb(jobBytes)}.`);
  for(const path of plainDirs)say(`Dados${options.deleteData?'':' (com --apagar-dados)'}: ${path}, ${gb(plainBytes.get(path)!)}.`);

  const labelled=async(kind:'container'|'volume'|'image')=>{
   const args=kind==='container'?['container','ls','-a','-q','--no-trunc']:kind==='volume'?['volume','ls','-q']:['image','ls','-q','--no-trunc'];
   const listed=await docker([...args,'--filter',`label=${PROJECT_LABEL}=${projectId}`]);
   if(listed.code!==0)return undefined;
   return [...new Set(listed.stdout.split('\n').map(line=>line.trim()).filter(Boolean))];
  };
  const dockerItems={containers:await labelled('container'),volumes:await labelled('volume'),images:await labelled('image')};
  if(!dockerItems.containers||!dockerItems.volumes||!dockerItems.images)say(`Docker: não foi possível listar os recursos rotulados ${PROJECT_LABEL}=${projectId}; nada do Docker será removido.`);
  else say(`Docker${options.deleteData?'':' (com --apagar-dados)'}: ${dockerItems.containers.length} contêiner(es), ${dockerItems.volumes.length} volume(s) e ${dockerItems.images.length} imagem(ns) com o rótulo ${PROJECT_LABEL}=${projectId}.`);

  if(!options.apply){
   const preview=await releaseProjectArtifacts(remaining,projectId,repoOnDisk,false,deps).catch(()=>({lines:['ilegível ou ocupado: nada dele seria removido.'],kept:0}));
   for(const line of preview.lines)say(`Registro de artefatos${options.deleteData?'':' (com --apagar-dados)'}: ${line}`);
   if(repoOnDisk)for(const line of await releaseIdleSharedWorktrees(config.dataDirectory,repoOnDisk,false).catch(()=>[] as string[]))say(line);
   say(`Prévia, nada foi alterado. Para aplicar: npm run personal:project -- --remover ${file} ${projectId}${options.deleteData?' --apagar-dados':''} --sim`);
   return {projectId,label:target.label,applied:false,lines,restart};
  }

  // ---- Apply ----
  if(busy)throw new ActiveProject(busy+'.');
  if(db&&!archived)throw new Refusal('PROJECT_ARCHIVE_MIGRATION_REQUIRED',409);
  const stamp=stampOf(options.now??new Date());
  // The new installation.json is prepared and validated first, but written only after the ledger committed: a refusal of the
  // transaction (late activity) leaves the file exactly as it was.
  let original:Buffer|undefined,next:string|undefined,remoteDropped=false;
  if(target.inFile){
   original=await readFile(file);
   const raw=JSON.parse(original.toString('utf8')) as {projects?:{id?:unknown}[];managerTransport?:{contexts?:{projectId?:unknown}[]};remoteDevelopment?:{projects?:{projectId?:unknown}[]}};
   raw.projects=(raw.projects??[]).filter(item=>item?.id!==projectId);
   if(raw.managerTransport?.contexts)raw.managerTransport.contexts=raw.managerTransport.contexts.filter(item=>item?.projectId!==projectId);
   if(raw.remoteDevelopment?.projects){
    raw.remoteDevelopment.projects=raw.remoteDevelopment.projects.filter(item=>item?.projectId!==projectId);
    // The schema asks for at least one project: without any, remote development is simply off.
    if(!raw.remoteDevelopment.projects.length){delete raw.remoteDevelopment;remoteDropped=true;}
   }
   if(!Installation.safeParse(raw).success)throw new Refusal('INVALID_INSTALLATION',409);
   next=JSON.stringify(raw,null,2)+'\n';
  }
  await deps.beforeArchive?.();
  let closed:string[]=[];
  if(db){
   await ledger.tx(async c=>{
    // Same lock as project registration, then the activity is judged again inside the transaction.
    await c.query('SELECT pg_advisory_xact_lock(189234,37)');
    await c.query('SELECT 1 FROM ac_projects WHERE id=$1 FOR UPDATE',[projectId]);
    closed=await closeStaleJobs(c,ledger,projectId,staleJobs);
    const again=(await c.query<Omit<Activity,'marker'>>(activeSql,[projectId])).rows[0]!;
    const late=activityText({...again,marker:false});
    if(late)throw new ActiveProject(late+'.');
    await c.query('UPDATE ac_projects SET archived_at=COALESCE(archived_at,clock_timestamp()) WHERE id=$1',[projectId]);
    await c.query('UPDATE ac_contexts SET archived=true WHERE project_id=$1 AND NOT archived',[projectId]);
    await c.query('DELETE FROM ac_account_access WHERE project_id=$1',[projectId]);
   });
   for(const line of closed)say(`Banco: ${line}`);
   say(`Banco: projeto arquivado, ${db.contexts} contexto(s) arquivado(s), ${db.access} acesso(s) de conta revogado(s).`);
  }
  if(markerVerdict.stale){
   // Only the very marker judged stale: a new exam would have written its own id.
   const current=await readFile(markerPath,'utf8').catch(()=>undefined/* already gone */);
   if(current!==undefined&&current===markerVerdict.body&&!(await lstat(markerPath)).isSymbolicLink()){await rm(markerPath);say(`${markerPath}: marcador parado removido.`);}
  }
  let backupPath:string|undefined;
  if(original&&next){
   for(let index=1;;index++){
    backupPath=join(dirname(file),`installation.json.before-remove-${stamp}${index===1?'':'-'+index}`);
    try{await writeFile(backupPath,original,{mode:0o600,flag:'wx'});break;}
    catch(error){if(!errno(error,'EEXIST')||index>=100)throw error;}
   }
   await chmod(backupPath,0o600);
   await writePrivate(file,next);
   say(`installation.json: projeto retirado de projects[]${remoteDropped?' e o bloco remoteDevelopment, que ficou sem projeto':''}; backup em ${backupPath}.`);
  }
  await (await import('./personal-ssh.ts')).forgetRemoteProject(config.dataDirectory,projectId);

  let kept=0;
  if(options.deleteData){
   const processPaths=deps.processPaths??defaultProcessPaths,mountInfo=deps.mountInfo??(()=>readFile('/proc/self/mountinfo','utf8'));
   // Facts read once: live process paths, mounts and container bind sources. Any of them unreadable keeps everything on disk.
   let open:string[]|undefined,mounts:string|undefined,binds:string[]|undefined;
   try{open=await processPaths();}catch{open=undefined;}
   try{mounts=await mountInfo();}catch{mounts=undefined;}
   binds=await containerSources(docker);
   const removable=async(path:string,parent:string):Promise<string|undefined>=>{
    if(!open||mounts===undefined||!binds)return 'não foi possível provar que nada usa o diretório';
    if(protectedRoots.some(root=>overlaps(root,path)))return 'sobrepõe um repositório';
    const info=await lstat(path).catch(()=>undefined/* absent, reported below as already gone */);
    if(!info)return 'já não existe';
    if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==process.getuid?.())return 'não é um diretório próprio';
    if(dirname(path)!==parent||await realpath(path)!==path)return 'caminho não canônico';
    try{if(mountedInside(mounts,path))return 'há montagem dentro do diretório';}catch{return 'tabela de montagens ilegível';}
    if(binds.some(source=>overlaps(source,path)))return 'há contêiner com este diretório montado';
    if(open.some(item=>item===path||item.startsWith(path+sep)))return 'há processo usando o diretório';
    return undefined;
   };
   let removedJobs=0,removedJobBytes=0;
   const hostReal=await realpath(hostRoot).catch(()=>undefined/* unresolved root: no job is considered inside it */);
   for(const job of jobDirs){
    if(!job.terminal){kept++;say(`job ${job.id}: preservado (não terminal).`);continue;}
    if(!hostReal||hostReal!==hostRoot){kept++;say(`job ${job.id}: preservado (raiz dos jobs não canônica).`);continue;}
    const reason=await removable(job.path,hostRoot);
    if(reason){if(reason!=='já não existe'){kept++;say(`job ${job.id}: preservado (${reason}).`);}continue;}
    try{
     // A programmer checkout is a linked worktree of the project repository: git forgets it first, so the repository keeps no stale entry.
     for(const leaf of ['work','review-artifact']){
      const linked=await lstat(join(job.path,leaf,'.git')).catch(()=>undefined/* no linked worktree here */);
      if(linked?.isFile()&&repoOnDisk)await git(repoOnDisk,['worktree','remove','--force','--',join(job.path,leaf)]);
     }
     await rm(job.path,{recursive:true});
     removedJobs++;removedJobBytes+=job.bytes;
    }catch{kept++;say(`job ${job.id}: preservado (falha ao remover; repita depois).`);}
   }
   say(`Dados: ${removedJobs} pasta(s) de job removida(s), ${gb(removedJobBytes)}.`);
   for(const path of plainDirs){
    const reason=await removable(path,dirname(path));
    if(reason==='já não existe')continue;
    if(reason){kept++;say(`${path}: preservado (${reason}).`);continue;}
    try{await rm(path,{recursive:true});say(`${path}: removido, ${gb(plainBytes.get(path)!)}.`);}
    catch{kept++;say(`${path}: preservado (falha ao remover; repita depois).`);}
   }
   try{
    const released=await releaseProjectArtifacts(remaining,projectId,repoOnDisk,true,deps);
    kept+=released.kept;
    for(const line of released.lines)say(`Registro de artefatos: ${line}`);
   }catch{kept++;say('Registro de artefatos: ilegível ou ocupado; nada dele foi removido.');}
   if(repoOnDisk){
    try{for(const line of await releaseIdleSharedWorktrees(config.dataDirectory,repoOnDisk,true))say(line);}
    catch{kept++;say('Worktrees compartilhados: falha ao verificar; preservados.');}
   }
   if(dockerItems.containers&&dockerItems.volumes&&dockerItems.images)kept+=await removeLabelled(remaining,projectId,dockerItems as {containers:string[];volumes:string[];images:string[]},docker,deps,say);
  }

  if(db&&target.repo&&!(options.deleteData&&kept)){
   // Last, and kept while data removal left something behind, so that a rerun still knows the repository (linked and shared
   // worktrees are released through it). Freeing the row lets the repository be added again and drops the project from the panel.
   await ledger.pool.query('DELETE FROM ac_project_repositories WHERE project_id=$1',[projectId]);
   say('Banco: ligação do projeto ao repositório retirada (o repositório pode ser acrescentado de novo).');
  }else if(db&&target.repo)say('Banco: ligação ao repositório mantida até os itens preservados saírem; repita o comando abaixo.');
  // By id: the project already left installation.json and is archived, so its label no longer finds it.
  say(kept?`Remoção aplicada com ${kept} item(ns) preservado(s). Para tentar de novo: npm run personal:project -- --remover ${file} ${projectId} --apagar-dados --sim`:'Remoção aplicada.');
  const reportPath=await writeReport(config.dataDirectory,stamp,projectId,lines);
  say(`Relatório: ${reportPath}`);
  return {projectId,label:target.label,applied:true,lines,backupPath,reportPath,restart};
 }finally{await ledger.close();}
}

async function containerSources(docker:NonNullable<RetentionDeps['docker']>):Promise<string[]|undefined>{
 const listed=await docker(['container','ls','-a','--no-trunc','-q']);
 if(listed.code!==0)return undefined;
 const ids=listed.stdout.split('\n').map(line=>line.trim()).filter(Boolean);
 if(!ids.length)return [];
 const inspected=await docker(['container','inspect','--format','{{range .Mounts}}{{println .Source}}{{end}}',...ids]);
 if(inspected.code!==0)return undefined;
 return inspected.stdout.split('\n').map(line=>line.trim()).filter(Boolean);
}

/** Containers (stopped only, no force), then volumes (no force: Docker refuses one in use), then images by id after the pins. */
async function removeLabelled(config:Installation,projectId:string,items:{containers:string[];volumes:string[];images:string[]},docker:NonNullable<RetentionDeps['docker']>,deps:RetentionDeps,say:(line:string)=>void){
 let kept=0;
 for(const id of items.containers){
  const state=await docker(['container','inspect','--format','{{.State.Running}}',id]);
  if(state.code!==0||state.stdout.trim()!=='false'){kept++;say(`contêiner ${id.slice(0,12)}: preservado (em execução ou ilegível).`);continue;}
  const removed=await docker(['container','rm',id]);
  if(removed.code!==0){kept++;say(`contêiner ${id.slice(0,12)}: preservado (o Docker recusou).`);}else say(`contêiner ${id.slice(0,12)}: removido.`);
 }
 for(const name of items.volumes){
  const removed=await docker(['volume','rm',name]);
  if(removed.code!==0){kept++;say(`volume ${name}: preservado (em uso ou recusado pelo Docker).`);}else say(`volume ${name}: removido.`);
 }
 if(!items.images.length)return kept;
 let guard:Awaited<ReturnType<typeof protectedDigests>>|undefined;
 try{guard=await protectedDigests(config,deps,docker,{releasedProject:projectId,apply:true});}catch{guard=undefined;}
 const used=await docker(['container','ls','-a','--no-trunc','-q']);
 const ids=used.code===0?used.stdout.split('\n').map(line=>line.trim()).filter(Boolean):undefined;
 const inUse=ids===undefined?undefined:ids.length?await docker(['container','inspect','--format','{{.Image}}',...ids]):{code:0,stdout:''};
 for(const id of items.images){
  const label=`imagem ${id.slice(0,19)}`;
  if(!guard||!inUse||inUse.code!==0){kept++;say(`${label}: preservada (não foi possível ler os pins ou os contêineres).`);continue;}
  const inspected=await docker(['image','inspect','--format','{{json .RepoDigests}}',id]);
  let digests:string[]=[id];
  try{digests=digests.concat((JSON.parse(inspected.stdout) as string[]|null??[]).map(item=>item.split('@').at(-1)!));}catch{kept++;say(`${label}: preservada (resposta ilegível do Docker).`);continue;}
  if(digests.some(digest=>guard!.pinned.has(digest)||guard!.retired.has(digest)||guard!.foreign.has(digest))){kept++;say(`${label}: preservada (digest fixado ou referenciado).`);continue;}
  if(inUse.stdout.split('\n').some(line=>line.trim()===id)){kept++;say(`${label}: preservada (há contêiner usando a imagem).`);continue;}
  const removed=await docker(['image','rm',id]);
  if(removed.code!==0){kept++;say(`${label}: preservada (o Docker recusou).`);}else say(`${label}: removida.`);
 }
 return kept;
}

async function writeReport(dataDirectory:string,stamp:string,projectId:string,lines:string[]){
 const directory=join(dataDirectory,'project-removals');
 await mkdir(directory,{recursive:true,mode:0o700});
 await chmod(directory,0o700);
 const path=join(directory,`${stamp}-${projectId}-${randomUUID().slice(0,8)}.txt`);
 await writeFile(path,lines.join('\n')+'\n',{mode:0o600,flag:'wx'});
 return path;
}
async function writePrivate(path:string,content:string){
 const temporary=path+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,content,{mode:0o600,flag:'wx'});await chmod(temporary,0o600);await rename(temporary,path);
}

export async function runPersonalProjectRemoveCli(argv:readonly string[],options?:{now?:Date;deps?:ProjectRemoveDeps}):Promise<string[]>{
 const [flag,...rest]=argv;
 const flags=new Set(rest.filter(item=>item.startsWith('--')));
 const positionals=rest.filter(item=>!item.startsWith('--'));
 if(flag!=='--remover'||positionals.length!==2||[...flags].some(item=>item!=='--apagar-dados'&&item!=='--sim')||flags.size!==rest.length-2)throw new Refusal('PROJECT_REMOVE_USAGE',400);
 const result=await removePersonalProject(positionals[0]!,positionals[1]!,{apply:flags.has('--sim'),deleteData:flags.has('--apagar-dados'),...options});
 return result.applied?[...result.lines,`Reinicie o gateway: ${result.restart}`]:result.lines;
}

async function main(){
 try{
  for(const line of await runPersonalProjectRemoveCli(process.argv.slice(2)))console.log(line);
 }catch(error){
  console.error(personalProjectRemoveFailureText(error));
  process.exit(1);
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
