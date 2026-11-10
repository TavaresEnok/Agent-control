import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {GitArtifacts} from './git.ts';
import type {Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';
import {NativeExecutionSupervisor} from './native-execution-supervisor.ts';
import {NativeImplementation} from './native-implementation.ts';
import {NativePlanningSupervisor} from './native-planning-supervisor.ts';
import {NativeQa} from './native-qa.ts';
import {NativeVerification} from './native-verification.ts';
import {Quality} from './quality.ts';
import {SemanticPlanning} from './semantic-planning.ts';
import {PersonalManagerChat} from './personal-manager-chat.ts';
import type {EngineeringOptions} from './engineering.ts';

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

/**
 * Personal mode, at startup only. The runtime holds the exclusive repository lock, so a grant
 * left reserved, running or uncertain by an earlier process is dead once none of its job
 * containers exists any more. Without this, two crashed stages block an account for good.
 * If Docker cannot be listed, nothing is released.
 */
export async function releaseDeadPersonalGrants(ledger:Ledger){
 let names:string[];
 try{names=execFileSync('docker',['ps','-a','--format','{{.Names}}'],{encoding:'utf8',timeout:15000}).split('\n').filter(Boolean);}catch{return 0;}
 const rows=(await ledger.pool.query(`SELECT g.id,array_remove(array[pj.id::text,ej.id::text,qj.id::text],NULL) jobs FROM ac_capacity_grants g
  LEFT JOIN ac_native_planning_jobs pj ON pj.grant_id=g.id LEFT JOIN ac_native_execution_jobs ej ON ej.grant_id=g.id LEFT JOIN ac_native_qa_jobs qj ON qj.grant_id=g.id
  WHERE g.state<>'released' AND g.resource_kind='model' AND g.created_at<clock_timestamp()-interval '1 minute'`)).rows;
 let released=0;
 for(const row of rows){
  const jobs=row.jobs as string[];
  if(jobs.some(job=>names.some(name=>name.includes(job))))continue;
  released+=Number((await ledger.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2::jsonb WHERE id=$1 AND state<>'released'",
   [row.id,JSON.stringify({source:'personal-startup-sweep',containersAbsent:true,jobs})])).rowCount??0);
 }
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
  if(result.status==='integrated')try{
   const env={PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'},git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',this.checkout,...args],{encoding:'utf8',env,timeout:20000,stdio:['ignore','pipe','ignore']}).trim();
   if(git(['rev-parse','--is-bare-repository'])==='false'&&git(['symbolic-ref','-q','HEAD'])===targetRef)git(['read-tree','-m','-u',base,candidate]);
  }catch{/* the owner can run git status and reconcile by hand */}
  return result;
 }
}

export async function composePersonalRuntime(config:Installation,ledger:Ledger){
 const boot=config.nativeBootstrap;
 if(!boot||boot.state!=='active')return;
 await renewPersonalQuota(ledger);
 await releaseDeadPersonalGrants(ledger);
 setInterval(()=>{renewPersonalQuota(ledger).catch(()=>{});},10*60*1000).unref();
 const {readPrivateFile}=await import('./installation.ts');
 const planningPem=(await readPrivateFile(boot.planning.signingKeyFile)).toString('utf8');
 const executionPem=(await readPrivateFile(boot.execution.signingKeyFile)).toString('utf8');
 const reviewKey=await readPrivateFile(boot.review.signingKeyFile);
 const rows=(await ledger.pool.query('SELECT id,provider FROM ac_accounts WHERE id = ANY($1::uuid[])',[boot.accounts.map(account=>account.accountId)])).rows;
 const subjects=(provider:string)=>boot.accounts.filter(account=>rows.some(row=>row.id===account.accountId&&row.provider===provider)).map(account=>({accountId:account.accountId,subjectDigest:account.subjectDigest}));
 const protectedRepositories=[config.project.repo,...config.projects.map(project=>project.repo)];
 const planning=[];
 for(const provider of ['codex','claude','grok'] as const){
  const accountSubjects=subjects(provider);
  if(!accountSubjects.length)continue;
  planning.push(new NativePlanningSupervisor(ledger,{id:boot.planning.id+'-'+provider,executorDigest:boot.planning.executorDigest,imageId:boot.planning.imageId,
   hostRoot:boot.planning.hostRoot,accountRoot:boot.planning.accountRoot,protectedRepositories,signingKeyPem:planningPem,providerNetwork:'ac-native-provider',provider,accountSubjects}));
 }
 const executions=[];
 for(const provider of ['codex','claude','grok'] as const){
  const accountSubjects=subjects(provider);
  if(!accountSubjects.length)continue;
  executions.push(new NativeExecutionSupervisor(ledger,{id:boot.execution.id+'-'+provider,workerImage:boot.execution.workerImage,toolsImage:boot.execution.toolsImage,
   hostRoot:boot.execution.hostRoot,accountRoot:boot.execution.accountRoot,repository:config.project.repo,protectedRepositories,signingKeyPem:executionPem,
   providerNetworkId:boot.execution.providerNetworkId,provider,workerEnv:boot.execution.workerEnv,toolsEnv:boot.execution.toolsEnv,accountSubjects}));
 }
 if(!planning.length||!executions.length)throw new Error('PERSONAL_RUNTIME_ACCOUNT_REQUIRED');
 const git=new PersonalGitArtifacts(config.project.repo);
 const quality=new Quality(ledger,reviewKey,git);
 const nativeQa=new NativeQa(ledger,quality,config.project.repo,boot.execution.hostRoot,boot.qa,reviewKey);
 const nativeVerification=new NativeVerification(ledger,quality,executions,reviewKey);
 const implementation=new NativeImplementation(ledger,config.project.repo,quality,executions);
 const semantic=new SemanticPlanning(ledger,planning.map(supervisor=>supervisor.executor));
 const branch=execFileSync('/usr/bin/git',['-C',config.project.repo,'symbolic-ref','--short','HEAD'],{encoding:'utf8'}).trim();
 if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch))throw new Error('PERSONAL_TARGET_UNRESOLVED');
 const engineering:EngineeringOptions={quality,git,verifierKey:reviewKey,nativeQa,nativeVerification,allowedTargets:[`refs/heads/${branch}`]};
 const managerChat=new PersonalManagerChat(ledger,{imageId:boot.planning.imageId,accountRoot:boot.planning.accountRoot});
 return {planning,executions,implementation,semantic,engineering,managerChat};
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
