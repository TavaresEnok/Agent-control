import {spawn} from 'node:child_process';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import type {UsageWindowsObservation} from '../upstream/cezar/packages/contract/src/usage-windows.ts';

const Input=z.object({model:z.string().min(1).max(100),effort:z.enum(['low','medium','high']),task:z.string().min(1).max(100000),timeoutMs:z.number().int().min(1000).max(1800000)}).passthrough();
export class GrokExecutionFailure extends Refusal{
 constructor(code:string,readonly tokensUsed:number|null,readonly usageWindows:UsageWindowsObservation|null){super(code);}
}
/** Test programmer path. The isolated worker invokes the Grok CLI already authenticated in the account home. */
export async function runGrokProgrammer(raw:unknown,signal?:AbortSignal){
 if(process.env.AC_DEBUG_QUOTA_EXHAUSTED==='1')throw new GrokExecutionFailure('PROVIDER_USAGE_LIMIT',null,null);
 const input=Input.parse(raw);
 if(signal?.aborted)throw new GrokExecutionFailure('EXECUTION_CANCELED',null,null);
 const bin=process.env.GROK_BIN??'/usr/local/bin/grok';
 const child=spawn(bin,['-p',input.task,'--model',input.model,'--reasoning-effort',input.effort,'--output-format','plain','--cwd','/work','--no-plan','--always-approve'],{cwd:'/work',env:process.env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString('utf8');});
 child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString('utf8');});
 const timedOut=new Promise<never>((_,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new GrokExecutionFailure('EXECUTION_TIMEOUT',null,null));},input.timeoutMs);signal?.addEventListener('abort',()=>{clearTimeout(timer);child.kill('SIGTERM');reject(new GrokExecutionFailure('EXECUTION_CANCELED',null,null));},{once:true});child.once('exit',()=>clearTimeout(timer));});
 const code=await Promise.race([new Promise<number>((resolve,reject)=>child.once('error',()=>reject(new GrokExecutionFailure('EXECUTION_NATIVE_FAILED',null,null))).once('exit',status=>resolve(status??1))),timedOut]);
 if(code!==0)throw new GrokExecutionFailure(stderr.includes('usage limit')||stderr.includes('rate limit')?'PROVIDER_USAGE_LIMIT':'EXECUTION_NATIVE_FAILED',null,null);
 return {output:stdout.slice(0,256*1024),tokensUsed:null,usageWindows:null,nativeSessionId:null};
}
