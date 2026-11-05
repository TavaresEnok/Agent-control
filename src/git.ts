import { spawn, type ChildProcess } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { Refusal } from './contracts.ts';
import { isNormalizedProtectedGatePath } from './quality-gate-paths.ts';
const GitId=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Identity=z.object({commit:GitId,base:GitId,tree:GitId,legacyDigest:z.string().regex(/^[a-f0-9]{64}$/),
 source:z.literal('AcSafeGit+AcArtifactIdentity')}).strict();
/** Repository is a controller configuration, never a path supplied by the worker. */
export class GitArtifacts{
 constructor(private readonly repository:string,private readonly rubyBinary='/usr/bin/ruby'){}
 async assertManagedPath(parentId:string,runId:string,path:string,exists:boolean){
  z.uuid().parse(parentId);z.uuid().parse(runId);
  const repo=await realpath(this.repository),expected=resolve(repo,'.ai/cezar/managed',parentId,runId);
  if(resolve(path)!==expected||await realpath(exists?expected:dirname(expected))!==(exists?expected:dirname(expected)))throw new Refusal('MANAGED_WORKTREE_FORBIDDEN');
 }
 async managedPath(parentId:string,runId:string){
  z.uuid().parse(parentId);z.uuid().parse(runId);const repo=await realpath(this.repository),path=resolve(repo,'.ai/cezar/managed',parentId,runId);
  await this.assertManagedPath(parentId,runId,path,true);return path;
 }
 async verifyComposition(path:string,commit:string,base:string,sources:readonly string[]){
  GitId.parse(commit);GitId.parse(base);z.array(GitId).min(1).max(16).parse(sources);
  const value=Identity.parse(await this.invoke({action:'verify-composition',sourceRepo:path,candidate:commit,base,sources}));
  if(value.commit!==commit||value.base!==base)throw new Refusal('MANAGED_COMPOSITION_MISMATCH');return value;
 }
 async identityAt(path:string,commit:string,base:string){
  GitId.parse(commit);GitId.parse(base);
  const value=Identity.parse(await this.invoke({action:'identity-at',sourceRepo:path,candidate:commit,base}));
  if(value.commit!==commit||value.base!==base)throw new Refusal('MANAGED_SOURCE_MISMATCH');return value;
 }
 private async invoke(value:Record<string,unknown>){
  const repo=await realpath(this.repository);
  const payload=JSON.stringify({...value,repo});
  const result=await new Promise<string>((resolve,reject)=>{
   const child=spawn(this.rubyBinary,[new URL('../services/agent-control-git/helper.rb',import.meta.url).pathname],{
    env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe'],detached:true});
   let output='',failure:string|undefined;
   const terminate=(reason:string)=>{failure??=reason;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
   const timeout=setTimeout(()=>terminate('GIT_HELPER_TIMEOUT'),10000);
   child.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>65536)terminate('GIT_HELPER_OUTPUT_LIMIT');});
   child.stderr.resume();
   child.once('error',()=>{clearTimeout(timeout);reject(new Refusal('GIT_HELPER_UNAVAILABLE'));});
   child.once('close',code=>{clearTimeout(timeout);if(failure){reject(new Refusal(failure));return;}code===0?resolve(output):reject(new Refusal('GIT_IDENTITY_REFUSED'));});
   child.stdin.on('error',()=>{});child.stdin.end(payload);
  });
  return JSON.parse(result) as unknown;
 }
 async resolveTarget(targetRef:string){
  z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/).parse(targetRef);
  const result=z.object({commit:z.string().regex(/^[a-f0-9]{40}$/),targetRef:z.string()}).strict().parse(await this.invoke({action:'head',targetRef}));
  if(result.targetRef!==targetRef)throw new Refusal('GIT_TARGET_MISMATCH');return result.commit;
 }
 async identity(candidate:string,base:string){
  GitId.parse(candidate);GitId.parse(base);
  const value=Identity.parse(await this.invoke({action:'identity',candidate,base}));
  if(value.commit!==candidate||value.base!==base)throw new Refusal('GIT_IDENTITY_MISMATCH');
  return value;
 }
 async import(sourceRepo:string,candidate:string,base:string){
  GitId.parse(candidate);GitId.parse(base);
  const value=Identity.parse(await this.invoke({action:'import',sourceRepo:await realpath(sourceRepo),candidate,base}));
  if(value.commit!==candidate||value.base!==base)throw new Refusal('GIT_IDENTITY_MISMATCH');
  return value;
 }
 async compose(base:string,sources:readonly {commit:string;tree:string;base:string;writePaths:readonly string[]}[],destination:string){
  GitId.parse(base);
  z.array(z.object({commit:GitId,tree:GitId,base:GitId,writePaths:z.array(z.string().min(1))}).strict()).min(1).max(16).parse(sources);
  const requested=resolve(destination);
  const value=Identity.extend({snapshot:z.string()}).strict().parse(await this.invoke({action:'compose',base,sources,destination:requested}));
  if(value.base!==base||value.snapshot!==requested)throw new Refusal('GIT_SNAPSHOT_MISMATCH');
  return value;
 }
 /** The caller records the process under its fenced grant before input is sent.
  * A timeout or lost controller is uncertain, never evidence of physical exit. */
 async composeSupervised(base:string,sources:readonly {commit:string;tree:string;base:string;writePaths:readonly string[];sourceRepo?:string}[],destination:string,
  onStart:(child:ChildProcess)=>Promise<void>){
  GitId.parse(base);z.array(z.object({commit:GitId,tree:GitId,base:GitId,writePaths:z.array(z.string().min(1)),sourceRepo:z.string().optional()}).strict()).min(1).max(16).parse(sources);
  const requested=resolve(destination),repo=await realpath(this.repository);
  const child=spawn(this.rubyBinary,[new URL('../services/agent-control-git/helper.rb',import.meta.url).pathname],{
   env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe'],detached:true});
  let output='',overflow=false;
  child.stdout!.on('data',chunk=>{output+=String(chunk);if(output.length>65536){overflow=true;try{process.kill(-child.pid!,'SIGKILL');}catch{}}});
  child.stderr!.resume();child.stdin!.on('error',()=>{});
  const finished=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((ok,fail)=>{child.once('close',(code,signal)=>ok({code,signal}));child.once('error',fail);});
  void finished.catch(()=>{});
  try{await onStart(child);}catch(error){try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}throw error;}
  child.stdin!.end(JSON.stringify({action:'compose',base,sources,destination:requested,repo}));
  let timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}},30000);
  let outcome:{code:number|null;signal:NodeJS.Signals|null};
  try{outcome=await finished;}finally{clearTimeout(timeout);}
  if(outcome.code!==0||outcome.signal||overflow||timedOut)throw new Refusal('GIT_COMPOSITION_UNCERTAIN');
  const value=Identity.extend({snapshot:z.string()}).strict().parse(JSON.parse(output));
  if(value.base!==base||value.snapshot!==requested)throw new Refusal('GIT_SNAPSHOT_MISMATCH');
  return value;
 }
 async snapshot(candidate:string,base:string,destination:string){
  GitId.parse(candidate);GitId.parse(base);
  const requested=resolve(destination);
  const value=Identity.extend({snapshot:z.string()}).strict().parse(await this.invoke({action:'snapshot',candidate,base,destination:requested}));
  if(value.commit!==candidate||value.base!==base||value.snapshot!==requested)throw new Refusal('GIT_SNAPSHOT_MISMATCH');
  return value;
 }
 async diff(candidate:string,base:string){
  GitId.parse(candidate);GitId.parse(base);
  const value=Identity.extend({diff:z.string().max(20000),truncated:z.boolean(),diffSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
   .parse(await this.invoke({action:'diff',candidate,base}));
  if(value.commit!==candidate||value.base!==base)throw new Refusal('GIT_IDENTITY_MISMATCH');
  return value;
 }
 async protectedPathsChanged(candidate:string,base:string,paths:readonly string[]){
  GitId.parse(candidate);GitId.parse(base);
  if(paths.length<1||paths.length>64||paths.some(path=>!isNormalizedProtectedGatePath(path)))throw new Refusal('PROTECTED_GATE_PATH_INVALID');
  const value=Identity.extend({protectedChanged:z.boolean()}).strict().parse(await this.invoke({action:'protected-paths',candidate,base,paths}));
  if(value.commit!==candidate||value.base!==base)throw new Refusal('GIT_IDENTITY_MISMATCH');
  return value;
 }
 async observe(candidate:string,base:string,targetRef:string){
  GitId.parse(candidate);GitId.parse(base);z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/).parse(targetRef);
  const value=Identity.extend({targetRef:z.string(),head:GitId}).strict().parse(await this.invoke({action:'observe',candidate,base,targetRef}));
  if(value.commit!==candidate||value.base!==base||value.targetRef!==targetRef)throw new Refusal('GIT_IDENTITY_MISMATCH');
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
