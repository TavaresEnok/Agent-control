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
export async function composePersonalRuntime(config:Installation,ledger:Ledger){
 const boot=config.nativeBootstrap;
 if(!boot||boot.state!=='active')return;
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
 const git=new GitArtifacts(config.project.repo);
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
