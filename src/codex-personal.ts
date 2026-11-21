import {spawn} from 'node:child_process';
import {cliEffort,Effort} from './effort.ts';
import {codexLimitFromText} from './quota-exhaustion.ts';
import type {UsageWindowsObservation} from '../upstream/cezar/packages/contract/src/usage-windows.ts';

export type CodexPersonalRole='programmer'|'qa'|'reviewer'|'judge'|'specialist'|'manager'|'planning';

/**
 * Locked Codex launches omit `provider`. Claude, Grok and personal Codex set it.
 * The subscription digest check belongs only to the locked path.
 */
export function codexWorkerAssertsSubscriptionIdentity(provider:'codex'|'claude'|'grok'|undefined){
 return provider!=='claude'&&provider!=='grok'&&provider!=='codex';
}

/** First parseable JSON object. Fences and surrounding prose are ignored. */
export function extractJsonObject(text:string):unknown{
 const body=text.replace(/```(?:json)?/gi,'');
 for(let start=body.indexOf('{');start>=0;start=body.indexOf('{',start+1)){
  for(let end=body.lastIndexOf('}');end>start;end=body.lastIndexOf('}',end-1)){
   try{return JSON.parse(body.slice(start,end+1));}catch{/* keep scanning */}
  }
 }
 return undefined;
}

/**
 * Argv for personal `codex exec`. The programmer writes the checkout.
 * The worker container is the sandbox (read-only root, no capabilities, only the job's mounts): Codex's own
 * bubblewrap sandbox cannot start inside it, so it is turned off. Evaluators get their checkout mounted read-only.
 * xhigh and max are already capped at high.
 */
/**
 * Proven against Codex 0.166.0 (tests/claude-hardening.test.ts, lab case): an MCP server in the account `config.toml`
 * and one in a trusted project `.codex/config.toml` both start by default. `--ignore-user-config` drops the account
 * config (auth still comes from CODEX_HOME) and with it the project trust, and hooks and plugins stay off.
 */
export const CODEX_HARDENING_ARGS=['--ignore-user-config','--disable','hooks','--disable','plugins'] as const;

export function codexPersonalCommand(input:{role:CodexPersonalRole;model:string;effort:string;prompt:string;outputSchema?:Record<string,unknown>}){
 const mapped=cliEffort('codex',Effort.parse(input.effort));
 // Evaluators have no /work: their read-only copy of the artifact is mounted at /planning, as for Claude and Grok.
 const cwd=input.role==='manager'||input.role==='planning'?'/tmp':input.role==='programmer'?'/work':'/planning';
 const prompt=input.outputSchema&&input.role!=='programmer'&&input.role!=='manager'
  ?'Reply with ONLY one JSON object, no prose and no code fences, matching this JSON Schema: '+JSON.stringify(input.outputSchema)+'\n\n'+input.prompt
  :input.prompt;
 return {bin:'/usr/local/bin/codex',env:['CODEX_HOME=/account/.codex'],args:['exec',...CODEX_HARDENING_ARGS,'--skip-git-repo-check','--sandbox','danger-full-access','--model',input.model,'-c','model_reasoning_effort='+mapped,'-C',cwd,prompt]};
}

/** Runs the personal Codex CLI. A usage-limit message becomes PROVIDER_USAGE_LIMIT. */
export async function runCodexExec(input:{args:readonly string[];timeoutMs:number;signal?:AbortSignal;cwd:string;kind:'execution'|'planning';json?:boolean}):Promise<{output:string;failureCode:string|null;usageWindows:UsageWindowsObservation|null}>{
 const bin=process.env.CODEX_BIN??'/usr/local/bin/codex';
 const child=spawn(bin,[...input.args],{cwd:input.cwd,env:process.env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString('utf8');});
 child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString('utf8');});
 let timedOut=false;
 const timed=new Promise<number>((resolve,reject)=>{
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');reject(Error('TIMEOUT'));},input.timeoutMs);
  const stop=()=>{clearTimeout(timer);child.kill('SIGTERM');reject(Error('CANCELED'));};
  input.signal?.addEventListener('abort',stop,{once:true});
  child.once('error',()=>{clearTimeout(timer);reject(Error('FAILED'));});
  child.once('exit',status=>{clearTimeout(timer);resolve(status??1);});
 });
 const timeoutCode=input.kind==='planning'?'PLANNING_TIMEOUT':'EXECUTION_TIMEOUT';
 const cancelCode=input.kind==='planning'?'PLANNING_CANCELED':'EXECUTION_CANCELED';
 const failCode=input.kind==='planning'?'PLANNING_NATIVE_EXECUTION_FAILED':'EXECUTION_NATIVE_FAILED';
 let code=1,failed=false;
 try{code=await timed;}catch(error){failed=true;code=1;if((error as Error).message==='TIMEOUT')timedOut=true;else if((error as Error).message!=='CANCELED')failed=true;}
 // The stderr transcript echoes every file Codex reads, so a successful run must never be read as a limit,
 // and a failed one is judged only by the end of its output.
 const limit=failed||code!==0?codexLimitFromText([stdout.slice(-4000),stderr.slice(-4000)]):null;
 if(limit)return {output:'',failureCode:limit.failureCode,usageWindows:limit.usageWindows};
 if(input.signal?.aborted)return {output:'',failureCode:cancelCode,usageWindows:null};
 if(timedOut)return {output:'',failureCode:timeoutCode,usageWindows:null};
 if(failed||code!==0)return {output:'',failureCode:failCode,usageWindows:null};
 let output=stdout.slice(0,256*1024);
 if(input.json){const parsed=extractJsonObject(output);if(parsed!==undefined)output=JSON.stringify(parsed);}
 if(Buffer.byteLength(output)>256*1024)return {output:'',failureCode:input.kind==='planning'?'PLANNING_OUTPUT_TOO_LARGE':'EXECUTION_OUTPUT_TOO_LARGE',usageWindows:null};
 return {output,failureCode:null,usageWindows:null};
}
