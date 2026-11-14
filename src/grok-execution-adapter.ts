import {spawn} from 'node:child_process';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import type {UsageWindowsObservation} from '../upstream/cezar/packages/contract/src/usage-windows.ts';
import {Effort,cliEffort} from './effort.ts';
import {extractJsonObject} from './codex-personal.ts';

const Input=z.object({model:z.string().min(1).max(100),effort:Effort,task:z.string().min(1).max(100000),timeoutMs:z.number().int().min(1000).max(1800000)}).passthrough();
/** Where each role works: the programmer in its writable checkout, evaluators in the read-only copy at /planning. */
export function grokWorkdir(role?:string){return !role||role==='programmer'?'/work':'/planning';}
/** Argv the Grok CLI receives. xhigh and max are already capped at high. */
export function grokProgrammerArgs(model:string,effort:string,task:string,role?:string){
 const mapped=cliEffort('grok',Effort.parse(effort));
 return ['-p',task,'--model',model,'--reasoning-effort',mapped,'--output-format','plain','--cwd',grokWorkdir(role),'--no-plan','--always-approve'];
}
export class GrokExecutionFailure extends Refusal{
 constructor(code:string,readonly tokensUsed:number|null,readonly usageWindows:UsageWindowsObservation|null){super(code);}
}
/** Runs Grok for any role. The isolated worker invokes the Grok CLI already authenticated in the account home.
 * An evaluator (reviewer, QA) is asked for one JSON object and only that object is returned. */
export async function runGrokProgrammer(raw:unknown,signal?:AbortSignal){
 if(process.env.AC_DEBUG_QUOTA_EXHAUSTED==='1')throw new GrokExecutionFailure('PROVIDER_USAGE_LIMIT',null,null);
 const input=Input.parse(raw);
 const role=typeof input.role==='string'?input.role:undefined,schema=input.outputSchema&&typeof input.outputSchema==='object'?input.outputSchema:undefined;
 const evaluator=Boolean(schema)&&role!=='programmer';
 const task=evaluator?'Reply with ONLY one JSON object, no prose and no code fences, matching this JSON Schema: '+JSON.stringify(schema)+'\n\n'+input.task:input.task;
 if(signal?.aborted)throw new GrokExecutionFailure('EXECUTION_CANCELED',null,null);
 const bin=process.env.GROK_BIN??'/usr/local/bin/grok';
 const child=spawn(bin,grokProgrammerArgs(input.model,input.effort,task,role),{cwd:grokWorkdir(role),env:process.env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString('utf8');});
 child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString('utf8');});
 const timedOut=new Promise<never>((_,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new GrokExecutionFailure('EXECUTION_TIMEOUT',null,null));},input.timeoutMs);signal?.addEventListener('abort',()=>{clearTimeout(timer);child.kill('SIGTERM');reject(new GrokExecutionFailure('EXECUTION_CANCELED',null,null));},{once:true});child.once('exit',()=>clearTimeout(timer));});
 const code=await Promise.race([new Promise<number>((resolve,reject)=>child.once('error',()=>reject(new GrokExecutionFailure('EXECUTION_NATIVE_FAILED',null,null))).once('exit',status=>resolve(status??1))),timedOut]);
 if(code!==0)throw new GrokExecutionFailure(stderr.includes('usage limit')||stderr.includes('rate limit')?'PROVIDER_USAGE_LIMIT':'EXECUTION_NATIVE_FAILED',null,null);
 let output=stdout.slice(0,256*1024);
 // An unreadable verdict is returned as is: the worker asks once more, and verification rejects it if it stays unreadable.
 if(evaluator){const parsed=extractJsonObject(output);if(parsed!==undefined)output=JSON.stringify(parsed);}
 return {output,tokensUsed:null,usageWindows:null,nativeSessionId:null};
}
