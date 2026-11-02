import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { Refusal } from './contracts.ts';
const GitId=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Identity=z.object({commit:GitId,base:GitId,tree:GitId,legacyDigest:z.string().regex(/^[a-f0-9]{64}$/),
 source:z.literal('AcSafeGit+AcArtifactIdentity')}).strict();
/** Repository is a controller configuration, never a path supplied by the worker. */
export class GitArtifacts{
 constructor(private readonly repository:string,private readonly rubyBinary='/usr/bin/ruby'){}
 private async invoke(value:Record<string,string>){
  const repo=await realpath(this.repository);
  const payload=JSON.stringify({...value,repo});
  const result=await new Promise<string>((resolve,reject)=>{
   const child=spawn(this.rubyBinary,[new URL('../services/agent-control-git/helper.rb',import.meta.url).pathname],{
    env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
   let output='',failed=false;
   const timeout=setTimeout(()=>{failed=true;child.kill('SIGKILL');reject(new Refusal('GIT_HELPER_TIMEOUT'));},10000);
   child.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>65536){failed=true;child.kill('SIGKILL');reject(new Refusal('GIT_HELPER_OUTPUT_LIMIT'));}});
   child.stderr.resume();
   child.once('error',()=>{clearTimeout(timeout);reject(new Refusal('GIT_HELPER_UNAVAILABLE'));});
   child.once('exit',code=>{clearTimeout(timeout);if(failed)return;code===0?resolve(output):reject(new Refusal('GIT_IDENTITY_REFUSED'));});
   child.stdin.on('error',()=>{});child.stdin.end(payload);
  });
  return JSON.parse(result) as unknown;
 }
 async identity(candidate:string,base:string){
  GitId.parse(candidate);GitId.parse(base);
  const value=Identity.parse(await this.invoke({action:'identity',candidate,base}));
  if(value.commit!==candidate||value.base!==base)throw new Refusal('GIT_IDENTITY_MISMATCH');
  return value;
 }
 async cas(candidate:string,base:string,targetRef:string,operationId:string){
  GitId.parse(candidate);GitId.parse(base);z.string().uuid().parse(operationId);
  z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/).parse(targetRef);
  const result=await this.invoke({action:'cas',candidate,base,targetRef,operationId});
  const rejected=z.object({status:z.literal('rejected'),reason:z.literal('BASE_MOVED')}).strict().safeParse(result);
  if(rejected.success)return rejected.data;
  const applied=Identity.extend({status:z.literal('integrated'),operationId:z.string().uuid(),targetRef:z.string()}).strict().parse(result);
  if(applied.commit!==candidate||applied.base!==base||applied.operationId!==operationId||applied.targetRef!==targetRef)
   throw new Refusal('GIT_CAS_RECEIPT_MISMATCH');
  return applied;
 }
}
