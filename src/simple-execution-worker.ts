import {execFile} from 'node:child_process';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {NativeExecutionRequest,Result,type Input} from './native-execution-shared.ts';
import {cliEffort,Effort} from './effort.ts';
import {extractJsonObject} from './codex-personal.ts';
import {redactSecrets} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {readMountedCredentialSecrets} from './native-worker-security.ts';
import {assertNoNativeTaskSecrets} from './native-execution-redaction.ts';
import {Refusal} from './contracts.ts';
import {GitArtifacts} from './git.ts';
import {pinRetainedArtifact} from './native-work-retention.ts';
import {addSimpleWorktree,removeSimpleWorktree,sharedSimpleWorktree,worktreeGit} from './simple-worktree.ts';
import {claudeLimitFromText} from './quota-exhaustion.ts';
import {providerFailureCode} from './exam-login.ts';

export type HostJob={input:Input;repo:string;dataDirectory:string;home:string;provider:'codex'|'claude'|'grok';model:string;effort:string};

async function runCli(job:HostJob,cwd:string,task:string){
 const {input,provider,model,home}=job;
 const effort=cliEffort(provider,Effort.parse(job.effort)),writer=input.role==='programmer';
 const env={HOME:home,PATH:process.env.PATH,LANG:'C.UTF-8',CLAUDE_CONFIG_DIR:home,CODEX_HOME:join(home,'.codex'),TMPDIR:process.env.TMPDIR??'/tmp'};
 let args:string[];
 if(provider==='claude'){
  args=['--print','--model',model,'--effort',effort,'--output-format','json','--no-session-persistence',
   '--setting-sources','user','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
   ...(writer?['--permission-mode','acceptEdits']:['--tools',input.moduleExam?'':'Read,Grep,Glob','--permission-mode','dontAsk']),
   ...(input.outputSchema?['--json-schema',JSON.stringify(input.outputSchema)]:[])];
 }else if(provider==='codex'){
  args=['exec','--ephemeral','--model',model,'-c','model_reasoning_effort='+JSON.stringify(effort),'--sandbox',writer?'workspace-write':'read-only','--json','-'];
 }else{
  args=['--model',model,'--reasoning-effort',effort,'--cwd',cwd,'--no-subagents','--disable-web-search',
   ...(writer?['--no-plan','--always-approve']:['--permission-mode','plan',...(input.moduleExam?['--tools','']:[])]),'--output-format','plain','-p',task];
 }
 const stdout=await new Promise<string>((done,fail)=>{
  const child=execFile(provider,args,{cwd,env,timeout:input.timeoutMs,killSignal:'SIGKILL',maxBuffer:4*1024*1024},(error,out,err)=>{
   if(error){const limit=claudeLimitFromText([err,out]);fail(new Refusal(limit?.failureCode??providerFailureCode(err)??'EXECUTION_NATIVE_FAILED'));}
   else done(out);
  });
  child.stdin?.on('error',()=>{});child.stdin?.end(provider==='grok'?'':task);
 });
 let output=stdout.trim(),tokens:null|number=null;
 let usageCounters=null;
 if(provider==='claude'){
  const reply=JSON.parse(output);
  if(reply.is_error)throw new Refusal(claudeLimitFromText([String(reply.result)])?.failureCode??'EXECUTION_NATIVE_FAILED');
  output=reply.structured_output===undefined?String(reply.result??''):JSON.stringify(reply.structured_output);
  const u=reply.usage;
  if(u){usageCounters={input:u.input_tokens??null,output:u.output_tokens??null,cache:(u.cache_creation_input_tokens??0)+(u.cache_read_input_tokens??0),reasoning:null};
   tokens=(u.input_tokens??0)+(u.output_tokens??0);}
 }else if(provider==='codex'){
  output='';
  let completed=false;
  for(const line of stdout.trim().split('\n')){
   const event=JSON.parse(line);
   if(event.type==='item.completed'&&event.item?.type==='agent_message')output=event.item.text;
   if(event.type==='turn.completed'){
    completed=true;
    if(event.usage){const u=event.usage;tokens=u.input_tokens+u.output_tokens;usageCounters={input:u.input_tokens,output:u.output_tokens,cache:u.cached_input_tokens??null,reasoning:null};}
   }
  }
  if(!completed)throw new Refusal('EXECUTION_NATIVE_TURN_FAILED');
 }
 if(input.outputSchema){const obj=extractJsonObject(output);if(!obj)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');output=JSON.stringify(obj);}
 if(Buffer.byteLength(output)>262144)throw new Refusal('EXECUTION_OUTPUT_TOO_LARGE');
 return {output,normalizedTokensUsed:tokens,usageCounters};
}

export async function finalizeSimpleWork(repo:string,cwd:string,input:Input,secrets:string[]){
 await worktreeGit(cwd,['add','-A','--','.']);
 const tree=(await worktreeGit(cwd,['write-tree'])).trim();
 const changed=(await worktreeGit(cwd,['diff','--name-only','--no-renames','-z',input.base,tree])).split('\0').filter(Boolean);
 if(!changed.length||changed.some(name=>!input.writePaths.some(path=>name===path||name.startsWith(path+'/'))))throw new Refusal('NATIVE_FINALIZER_SCOPE_MISMATCH');
 const commit=(await worktreeGit(cwd,['commit-tree',tree,'-p',input.base,'-m','Agent Control '+input.jobId])).trim();
 const git=new GitArtifacts(repo);
 await git.assertNoNewArtifactSecrets(commit,input.base,secrets);
 const artifact=await git.identity(commit,input.base);
 if(!['kept','created'].includes(await pinRetainedArtifact(repo,input.jobId,commit,tree)))throw new Refusal('NATIVE_ARTIFACT_IDENTITY_MISMATCH');
 return artifact;
}

export async function runSimpleWorker(root:string,job:HostJob,invoke=runCli){
 const input=NativeExecutionRequest.parse(job.input);
 const dir=join(root,'output'),work=join(root,'work');
 let release:(()=>Promise<unknown>)|undefined;
 let result:ReturnType<typeof Result.parse>={schemaVersion:1,jobId:input.jobId,output:'',exitCode:1,failureCode:'EXECUTION_NATIVE_FAILED',nativeSessionId:null,normalizedTokensUsed:null,usageWindows:null};
 try{
  const secrets=await readMountedCredentialSecrets(job.provider,job.home);
  assertNoNativeTaskSecrets(input.task,secrets);
  let cwd=work;
  if(input.role==='programmer'){
   await addSimpleWorktree(job.repo,input.base,work);
   release=()=>removeSimpleWorktree(job.repo,work);
  }else{
   const shared=await sharedSimpleWorktree(job.dataDirectory,job.repo,input.base);
   cwd=shared.path;release=shared.release;
  }
  const task=input.task+(input.outputSchema?'\nReturn JSON matching '+JSON.stringify(input.outputSchema):'');
  const response=await invoke(job,cwd,task);
  if(input.role==='programmer'){
   const artifact=await finalizeSimpleWork(job.repo,cwd,input,secrets);
   await writeFile(join(dir,'artifact.json'),JSON.stringify(artifact),{flag:'wx',mode:0o600});
  }
  result=Result.parse({...result,...response,output:redactSecrets(response.output,secrets),exitCode:0,failureCode:null});
 }catch(error){result.failureCode=error instanceof Refusal?error.code:'EXECUTION_NATIVE_FAILED';}
 finally{await release?.();}
 const pending=join(dir,'result.pending');
 await writeFile(pending,JSON.stringify(result),{mode:0o600});
 await rename(pending,join(dir,'execution-result.json'));
 await writeFile(join(root,'worker-terminal.log'),(result.failureCode??'completed')+'\n',{mode:0o600});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const root=dirname(resolve(process.argv[2]!));
 const job=JSON.parse(await readFile(join(root,'host-job.json'),'utf8')) as HostJob;
 await runSimpleWorker(root,job);
}
