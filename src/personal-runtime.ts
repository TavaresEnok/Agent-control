import {refreshPersonalTemplates} from './personal-policies.ts';
import {personalEgressEnabled} from './personal-egress.ts';
import {nativePlanningExecutorDigest} from './native-planning-contract.ts';
import {appendFileSync,readFileSync} from 'node:fs';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {GitArtifacts} from './git.ts';
import {assertSshOutsideMountRoots,pushIntegratedRemote,registerPersonalRemote,retryPendingRemotePushes} from './personal-ssh.ts';
import type {Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';
import {NativeExecutionSupervisor,openGrantLaunchLockSession,releaseGrantLaunchLock,tryGrantLaunchLock} from './native-execution-supervisor.ts';
import {NativeImplementation} from './native-implementation.ts';
import {NativePlanningSupervisor} from './native-planning-supervisor.ts';
import {NativeQa} from './native-qa.ts';
import {resolvePersonalProjectQa,syncPersonalQaPolicy} from './personal-qa-config.ts';
import {NativeVerification} from './native-verification.ts';
import {Quality} from './quality.ts';
import {SemanticPlanning} from './semantic-planning.ts';
import {PersonalManagerChat} from './personal-manager-chat.ts';
import type {EngineeringOptions} from './engineering.ts';
import {containFailure} from './failure-log.ts';

/** Real Codex and Claude supervisors for an installation whose bootstrap is active. */
/**
 * Personal mode has no external quota probe, so an account is available unless it
 * recorded a provider limit (exhausted_until). Observations expire after an hour,
 * so renew them for accounts that are not currently exhausted.
 */
export async function renewPersonalQuota(ledger:Ledger){
 await ledger.pool.query(`INSERT INTO ac_quota_observations(account_id,status,source,observed_at,expires_at)
  SELECT id,'available','personal://refresh',clock_timestamp(),clock_timestamp()+interval '1 hour' FROM ac_accounts
  WHERE enabled AND mode='subscription_cli' AND (exhausted_until IS NULL OR exhausted_until<=clock_timestamp())
  ON CONFLICT(account_id) DO UPDATE SET status=excluded.status,source=excluded.source,observed_at=excluded.observed_at,expires_at=excluded.expires_at`);
}

const JOB_CONTAINER_PREFIXES=['ac-native-plan-','ac-native-worker-','ac-native-tools-','ac-native-qa-','ac-native-qa-prepare-','ac-native-qa-db-'];
const JOB_TABLES=['ac_native_planning_jobs','ac_native_execution_jobs','ac_native_qa_jobs'] as const;
const execFileAsync=promisify(execFile);
/** Every container name Docker knows, or null when it cannot be listed (then nothing is released). */
async function dockerContainerNames():Promise<string[]|null>{
 try{return (await execFileAsync('docker',['ps','-a','--format','{{.Names}}'],{encoding:'utf8',timeout:15000})).stdout.split('\n').filter(Boolean);}catch{return null;}
}
export type DeadGrantSweepOptions={
 /** Lists container names. Called per grant, after its locks are held, so it is never older than the decision it supports. */
 containers?:()=>Promise<string[]|null>;
 /** Observation points for tests: candidates chosen, per-grant locks held, containers re-read. */
 observe?:(step:'candidates'|'locked'|'probed',grantId?:string)=>Promise<void>;
};
/**
 * Personal mode: a grant left reserved, running or uncertain is dead once its launch is gone and none of its job containers
 * exists. The sweep never trusts an earlier inventory. Candidates are only grants old enough; each one is then taken under
 * the same exclusion a launch uses (the grant's launch lock, then row locks on the grant and its job rows), and only then
 * are the containers listed. A launch that is alive holds the launch lock, so it is skipped; one that appeared after the
 * candidate query is seen by the later listing; a job row younger than the threshold may belong to a supervisor that does
 * not take the launch lock, so it is kept. If Docker cannot be listed, nothing is released.
 */
export async function releaseDeadPersonalGrants(ledger:Ledger,olderThanMinutes=1,options:DeadGrantSweepOptions={}){
 const containers=options.containers??dockerContainerNames;
 const candidates=(await ledger.pool.query<{id:string}>(`SELECT id FROM ac_capacity_grants WHERE state<>'released' AND resource_kind='model'
  AND created_at<clock_timestamp()-make_interval(mins=>$1) ORDER BY created_at`,[olderThanMinutes])).rows;
 await options.observe?.('candidates');
 if(!candidates.length)return 0;
 const session=await openGrantLaunchLockSession(ledger);
 let released=0;
 try{
  for(const {id} of candidates){
   if(session&&!await tryGrantLaunchLock(session,id))continue;
   try{
    released+=await ledger.tx(async c=>{
     const grant=(await c.query(`SELECT id FROM ac_capacity_grants WHERE id=$1 AND state<>'released' AND resource_kind='model'
      AND created_at<clock_timestamp()-make_interval(mins=>$2) FOR UPDATE`,[id,olderThanMinutes])).rows[0];
     if(!grant)return 0;
     const jobs:string[]=[];
     for(const table of JOB_TABLES){
      for(const row of (await c.query(`SELECT id,created_at<clock_timestamp()-make_interval(mins=>$2) settled FROM ${table} WHERE grant_id=$1 FOR UPDATE`,[id,olderThanMinutes])).rows){
       if(!row.settled)return 0;
       jobs.push(String(row.id));
      }
     }
     await options.observe?.('locked',id);
     const names=await containers();
     if(!names)return 0;
     await options.observe?.('probed',id);
     if(jobs.some(job=>JOB_CONTAINER_PREFIXES.some(prefix=>names.includes(prefix+job))))return 0;
     return Number((await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2::jsonb WHERE id=$1 AND state<>'released'",
      [id,JSON.stringify({source:'personal-startup-sweep',containersAbsent:true,jobs})])).rowCount??0);
    });
   }finally{if(session)await releaseGrantLaunchLock(session,id);}
  }
 }finally{await session?.end().catch(()=>undefined/* the session is discarded; its locks drop with it */);}
 return released;
}

/**
 * Integration moves the branch ref only. When that branch is the one checked out in the owner's
 * repository, the files on disk would stay at the old commit and show up as staged reversals.
 * A two-way read-tree brings index and working tree forward and refuses, changing nothing, if a
 * local edit would be overwritten. Best effort: the integration itself has already succeeded.
 */
class PersonalGitArtifacts extends GitArtifacts{
 constructor(private readonly checkout:string){super(checkout);}
 override async cas(candidate:string,base:string,targetRef:string,operationId:string){
  const result=await super.cas(candidate,base,targetRef,operationId);
  if(result.status==='integrated'){
   try{
    const env={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'},git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=','-C',this.checkout,...args],{encoding:'utf8',env,timeout:20000,stdio:['ignore','pipe','ignore']}).trim();
    if(git(['rev-parse','--is-bare-repository'])==='false'&&git(['symbolic-ref','-q','HEAD'])===targetRef)git(['read-tree','-m','-u',base,candidate]);
   }catch{console.error('PERSONAL_CHECKOUT_NOT_UPDATED: the branch moved but local files were left as they were; run git status in the repository.');}
   try{await pushIntegratedRemote(this.checkout,result.commit);}catch{console.error('REMOTE_PUSH_FAILED: the integration stands; the push stays pending.');}
  }
  return result;
 }
}

export type PersonalProjectRuntime={engineering:EngineeringOptions;implementation:NativeImplementation};
export async function composePersonalExecutionSupervisors(
 config:Installation,
 ledger:Ledger,
 accountRows?:readonly {id:string;provider:string}[],
):Promise<NativeExecutionSupervisor[]>{
 const boot=config.nativeBootstrap;
 if(!boot||boot.state!=='active')return [];
 const {readPrivateFile}=await import('./installation.ts');
 const executionPem=(await readPrivateFile(boot.execution.signingKeyFile)).toString('utf8');
 const rows=accountRows??(await ledger.pool.query<{id:string;provider:string}>('SELECT id,provider FROM ac_accounts WHERE id = ANY($1::uuid[])',[boot.accounts.map(account=>account.accountId)])).rows;
 const subjects=(provider:string)=>boot.accounts.filter(account=>rows.some(row=>row.id===account.accountId&&row.provider===provider)).map(account=>({accountId:account.accountId,subjectDigest:account.subjectDigest}));
 const protectedRepositories=[config.project.repo,...config.projects.map(project=>project.repo)];
 const disabledMeasurementProjects=[config.project,...config.projects].filter(project=>project.economy?.measurement===false).map(project=>project.id);
 const personalEgress=personalEgressEnabled(config);
 const executions:NativeExecutionSupervisor[]=[];
 for(const provider of ['codex','claude','grok'] as const){
  const accountSubjects=subjects(provider);
  if(!accountSubjects.length)continue;
  executions.push(new NativeExecutionSupervisor(ledger,{id:boot.execution.id+'-'+provider,workerImage:boot.execution.workerImage,toolsImage:boot.execution.toolsImage,
   hostRoot:boot.execution.hostRoot,accountRoot:boot.execution.accountRoot,protectedRepositories,signingKeyPem:executionPem,dataDirectory:config.dataDirectory,
   providerNetworkId:boot.execution.providerNetworkId,provider,workerEnv:boot.execution.workerEnv,toolsEnv:boot.execution.toolsEnv,accountSubjects,disabledMeasurementProjects,personalEgress}));
  for(const pair of (boot.execution.retiredImages??[]).filter(x=>x.workerImage!==boot.execution.workerImage||x.toolsImage!==boot.execution.toolsImage))
   executions.push(new NativeExecutionSupervisor(ledger,{id:boot.execution.id+'-'+provider,workerImage:pair.workerImage,toolsImage:pair.toolsImage,active:false,
    hostRoot:boot.execution.hostRoot,accountRoot:boot.execution.accountRoot,protectedRepositories,signingKeyPem:executionPem,
    providerNetworkId:boot.execution.providerNetworkId,provider,workerEnv:boot.execution.workerEnv,toolsEnv:boot.execution.toolsEnv,accountSubjects,disabledMeasurementProjects}));
 }
 return executions;
}
export async function composePersonalRuntime(config:Installation,ledger:Ledger){
 const boot=config.nativeBootstrap;
 if(!boot||boot.state!=='active')return;
 registerPersonalRemote({dataDirectory:config.dataDirectory,projects:[config.project,...config.projects].map(project=>({id:project.id,repo:project.repo}))});
 assertSshOutsideMountRoots(join(config.dataDirectory,'ssh'),[boot.planning.hostRoot,boot.planning.accountRoot,boot.execution.hostRoot,boot.execution.accountRoot]);
 await renewPersonalQuota(ledger);
 await releaseDeadPersonalGrants(ledger);
 setInterval(()=>{renewPersonalQuota(ledger).catch(containFailure('PERSONAL_QUOTA_RENEWAL_FAILED',undefined));},10*60*1000).unref();
 // A stage that fails before its container exists leaves its reservation behind; without this it would hold an evaluator slot until the next restart.
 let sweepingGrants=false;
 setInterval(()=>{
  if(sweepingGrants)return;
  sweepingGrants=true;
  releaseDeadPersonalGrants(ledger,5).catch(containFailure('PERSONAL_GRANT_SWEEP_FAILED',undefined)).finally(()=>{sweepingGrants=false;});
 },2*60*1000).unref();
 const {readPrivateFile}=await import('./installation.ts');
 const planningPem=(await readPrivateFile(boot.planning.signingKeyFile)).toString('utf8');
 const reviewKey=await readPrivateFile(boot.review.signingKeyFile);
 const rows=(await ledger.pool.query<{id:string;provider:string}>('SELECT id,provider FROM ac_accounts WHERE id = ANY($1::uuid[])',[boot.accounts.map(account=>account.accountId)])).rows;
 const subjects=(provider:string)=>boot.accounts.filter(account=>rows.some(row=>row.id===account.accountId&&row.provider===provider)).map(account=>({accountId:account.accountId,subjectDigest:account.subjectDigest}));
 const protectedRepositories=[config.project.repo,...config.projects.map(project=>project.repo)];
 const planning:NativePlanningSupervisor[]=[];
 const personalEgress=personalEgressEnabled(config);
 for(const provider of ['codex','claude','grok'] as const){
  const accountSubjects=subjects(provider);
  if(!accountSubjects.length)continue;
  planning.push(new NativePlanningSupervisor(ledger,{id:boot.planning.id+'-'+provider,executorDigest:boot.planning.executorDigest,imageId:boot.planning.imageId,
   hostRoot:boot.planning.hostRoot,accountRoot:boot.planning.accountRoot,protectedRepositories,signingKeyPem:planningPem,providerNetwork:'ac-native-provider',provider,accountSubjects,personalEgress}));
  // A rebuilt image changes the executor identity; a call left uncertain under the old one is reconciled only by it.
  for(const imageId of (boot.planning.retiredImageIds??[]).filter(id=>id!==boot.planning.imageId))
   planning.push(new NativePlanningSupervisor(ledger,{id:boot.planning.id+'-'+provider,executorDigest:nativePlanningExecutorDigest(imageId),imageId,active:false,
    hostRoot:boot.planning.hostRoot,accountRoot:boot.planning.accountRoot,protectedRepositories,signingKeyPem:planningPem,providerNetwork:'ac-native-provider',provider,accountSubjects}));
 }
 const executions=await composePersonalExecutionSupervisors(config,ledger,rows);
 if(!planning.length||!executions.length)throw new Error('PERSONAL_RUNTIME_ACCOUNT_REQUIRED');
 const semantic=new SemanticPlanning(ledger,planning.map(supervisor=>supervisor.executor));
 const managerChat=new PersonalManagerChat(ledger,{imageId:boot.planning.imageId,accountRoot:boot.planning.accountRoot,personalEgress});
 const byProject=new Map<string,PersonalProjectRuntime>();
 // One shared supervisor pair. Git, QA, implementation and verification stay on each checkout.
 const bind=async(repo:string,projectId:string,owner:string,primary:boolean)=>{
  try{
   // Worktrees and run records live under .ai/; keep them out of `git status` without touching tracked files.
   try{const exclude=join(repo,'.git','info','exclude');const current=readFileSync(exclude,'utf8');if(!/^\.ai\/$/m.test(current))appendFileSync(exclude,(current.endsWith('\n')?'':'\n')+'.ai/\n');}catch{/* bare or unusual layout: nothing to hide */}
   const git=new PersonalGitArtifacts(repo);
   const quality=new Quality(ledger,reviewKey,git);
   const qaContract=await resolvePersonalProjectQa({dataDirectory:config.dataDirectory,projectId,image:boot.qa.image,fallback:boot.qa});
   const cacheRoot=qaContract.prepareArgv?resolve(join(config.dataDirectory,'qa-cache',projectId)):undefined;
   const nativeQa=new NativeQa(ledger,quality,repo,boot.execution.hostRoot,qaContract,reviewKey,undefined,undefined,undefined,cacheRoot);
   await syncPersonalQaPolicy(ledger,owner,projectId,nativeQa.verifierDigest);
   // A new QA contract publishes a new quality revision; live conversation templates must follow it.
   await refreshPersonalTemplates(ledger,projectId);
   const nativeVerification=new NativeVerification(ledger,quality,executions,reviewKey);
   const implementation=new NativeImplementation(ledger,repo,quality,executions);
   const branch=execFileSync('/usr/bin/git',['-C',repo,'symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim();
   if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch))throw new Error('PERSONAL_TARGET_UNRESOLVED');
   const engineering:EngineeringOptions={quality,git,verifierKey:reviewKey,nativeQa,nativeVerification,allowedTargets:[`refs/heads/${branch}`]};
   byProject.set(projectId,{engineering,implementation});
  }catch(error){if(primary)throw error;}
 };
 await bind(config.project.repo,config.project.id,config.project.owner,true);
 for(const project of config.projects){if(project.id!==config.project.id)await bind(project.repo,project.id,project.owner,false);}
 if(!byProject.has(config.project.id))throw new Error('PERSONAL_TARGET_UNRESOLVED');
 await retryPendingRemotePushes().catch(()=>{console.error('REMOTE_PUSH_RETRY_FAILED');});
 const {reconcilePerformanceResources} = await import('../deploy/modules/desempenho/orchestrator.mjs');
 const recoveryDirectory = join(config.dataDirectory, 'performance-docker');
 let recoveringPerformance = false;
 async function recoverPerformance() {
  if (recoveringPerformance) return;
  recoveringPerformance = true;
  try {
   const result = await reconcilePerformanceResources({recoveryDirectory});
   if (result.invalid || result.pending) console.error('PERFORMANCE_RECOVERY_PENDING', result.invalid, result.pending);
  } catch { console.error('PERFORMANCE_RECOVERY_FAILED'); }
  finally { recoveringPerformance = false; }
 }
 void recoverPerformance();
 setInterval(recoverPerformance, 2*60*1000).unref();
 return {planning,executions,semantic,managerChat,byProject};
}

const SKIP=new Set(['.git','node_modules','dist','.state']);
async function tree(root:string,prefix:string,left:{n:number},out:string[]):Promise<void>{
 if(left.n<=0)return;
 const {readdir}=await import('node:fs/promises');
 let names:string[]=[];
 try{names=await readdir(root);}catch{return;}
 for(const name of names.sort()){
  if(SKIP.has(name)||name.startsWith('.ai'))continue;
  if(left.n--<=0)return;
  out.push(prefix+name);
  try{await tree(join(root,name),prefix+name+'/',left,out);}catch{/* file */}
 }
}
/** Bounded repository listing and README for the manager. No secrets directory is walked. */
export async function personalRepositoryContext(repo:string){
 const lines:string[]=[];
 await tree(repo,'',{n:200},lines);
 let readme='';
 try{readme=(await readFile(join(repo,'README.md'),'utf8')).slice(0,8000);}catch{readme='';}
 return ('Arquivos:\n'+lines.join('\n')+'\n\nREADME:\n'+readme).slice(0,20000);
}
