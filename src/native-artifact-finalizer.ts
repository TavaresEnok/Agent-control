import {spawn,type ChildProcess} from 'node:child_process';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {Authority,digest,Refusal} from './contracts.ts';
import {readPrivateWorkerFile} from './native-worker-security.ts';
const GitId=z.string().regex(/^[a-f0-9]{40}$/),Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const NativeArtifactIdentity=z.object({commit:GitId,base:GitId,tree:GitId,legacyDigest:Hash,source:z.literal('AcSafeGit+AcArtifactIdentity')}).strict();
const Outcome=z.object({schemaVersion:z.literal(1),jobId:z.uuid(),inputDigest:Hash,scopeDigest:Hash,status:z.enum(['ready','failed']),identity:NativeArtifactIdentity.nullable(),failureCode:z.string().nullable()}).strict();
const Handle=z.object({pid:z.number().int().min(2),startTime:z.string().regex(/^\d+$/),bootId:z.string().min(1)}).strict();
type Input={jobId:string;intentId:string;grantId:string;inputDigest:string;base:string;writePaths:readonly string[]};
export class NativeArtifactFinalizer{
 constructor(readonly ledger:Ledger,private readonly root:string){if(resolve(root)!==root)throw new Refusal('NATIVE_FINALIZER_ROOT_INVALID');}
 private async authorize(principal:string,authority:Authority,input:Input,paused:boolean,c:import('pg').PoolClient){
  await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,paused);
  if(!paused)await this.ledger.assertIntentActive(c,authority.contextId,input.intentId);
  const row=(await c.query(`SELECT j.*,g.state grant_state,g.role grant_role,i.principal_id FROM ac_native_execution_jobs j
   JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_intents i ON i.id=j.intent_id
   WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[input.jobId,authority.contextId])).rows[0];
  if(!row||row.intent_id!==input.intentId||row.grant_id!==input.grantId||row.input_digest!==input.inputDigest||row.base_id!==input.base||row.role!=='programmer'||
   row.grant_role!=='programmer'||row.principal_id!==principal||!['running','uncertain'].includes(row.state)||!['running','uncertain'].includes(row.grant_state))throw new Refusal('NATIVE_FINALIZER_BINDING_MISMATCH');
  const source=(await c.query('SELECT snapshot,digest,base_id FROM ac_managed_delivery_inputs WHERE intent_id=$1',[input.intentId])).rows[0];
  if(!source||source.base_id!==input.base||digest(source.snapshot)!==source.digest||digest(source.snapshot.writePaths)!==digest(input.writePaths))throw new Refusal('NATIVE_FINALIZER_SCOPE_MISMATCH');
 }
 private async groupAbsent(raw:unknown){
  const h=Handle.parse(raw),boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();if(h.bootId!==boot)return true;
  try{process.kill(-h.pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;return false;}
 }
 private async outcome(input:Input,scopeDigest:string){
  const bytes=await readPrivateWorkerFile(join(this.root,input.jobId,'finalizer-result.json'),65536);
  try{const result=Outcome.parse(JSON.parse(bytes.toString('utf8')));
   if(result.jobId!==input.jobId||result.inputDigest!==input.inputDigest||result.scopeDigest!==scopeDigest||
    (result.status==='ready'&&(!result.identity||result.identity.base!==input.base||result.failureCode!==null))||
    (result.status==='failed'&&(result.identity!==null||!result.failureCode)))throw new Refusal('NATIVE_FINALIZER_RESULT_INVALID');
   return result;
  }finally{bytes.fill(0);}
 }
 /** Called only after the supervisor observed both model/tools containers exit.
  * The same model grant stays occupied until this local process is confirmed
  * absent. A prior launch is observed; it is never blindly repeated. */
 async finalize(principal:string,authority:Authority,input:Input,assertPhysical:()=>Promise<void>){
  z.uuid().parse(input.jobId);GitId.parse(input.base);Hash.parse(input.inputDigest);
  const scopeDigest=digest(input.writePaths),area=join(this.root,input.jobId),work=join(area,'work');
  const stat=await lstat(area);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o7777)!==0o700||await realpath(area)!==area||await realpath(work)!==work)throw new Refusal('NATIVE_FINALIZER_ROOT_INVALID');
  const decision=await this.ledger.tx(async c=>{
   await this.authorize(principal,authority,input,true,c);
   const saved=(await c.query('SELECT * FROM ac_native_artifact_finalizations WHERE job_id=$1 FOR UPDATE',[input.jobId])).rows[0];
   if(saved){if(saved.input_digest!==input.inputDigest||saved.scope_digest!==scopeDigest||saved.base_id!==input.base||saved.context_id!==authority.contextId||Number(saved.manager_epoch)>authority.epoch)throw new Refusal('NATIVE_FINALIZER_REPLAY_MISMATCH');return {launch:false,row:saved};}
   await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,input.intentId);
   const row=(await c.query(`INSERT INTO ac_native_artifact_finalizations(job_id,context_id,manager_epoch,input_digest,scope_digest,base_id,state)
    VALUES($1,$2,$3,$4,$5,$6,'uncertain') RETURNING *`,[input.jobId,authority.contextId,authority.epoch,input.inputDigest,scopeDigest,input.base])).rows[0];
   return {launch:true,row};
  });
  if(['ready','failed'].includes(decision.row.state))return decision.row.receipt;
  if(decision.launch){
   await assertPhysical();
   const child=spawn('/usr/bin/ruby',[new URL('../services/agent-control-git/native_finalize.rb',import.meta.url).pathname],{env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C.UTF-8'},stdio:['pipe','ignore','ignore'],detached:true});
   child.stdin!.on('error',()=>{});
   const finished=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((ok,fail)=>{child.once('close',(code,signal)=>ok({code,signal}));child.once('error',fail);});void finished.catch(()=>{});
   let timer:ReturnType<typeof setTimeout>|undefined,monitor:ReturnType<typeof setInterval>|undefined;
   const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}};
   try{
    await new Promise<void>((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});
    if(!child.pid)throw new Refusal('NATIVE_FINALIZER_PROCESS_UNAVAILABLE');
    const proc=await readFile(`/proc/${child.pid}/stat`,'utf8'),startTime=proc.slice(proc.lastIndexOf(')')+2).split(' ')[19];
    const handle=Handle.parse({pid:child.pid,startTime,bootId:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()});
    await this.ledger.tx(async c=>{
     await this.authorize(principal,authority,input,false,c);await assertPhysical();
     const updated=await c.query("UPDATE ac_native_artifact_finalizations SET state='running',process_handle=$2 WHERE job_id=$1 AND state='uncertain' AND process_handle IS NULL AND manager_epoch=$3",[input.jobId,handle,authority.epoch]);
     if(!updated.rowCount)throw new Refusal('NATIVE_FINALIZER_RECONCILIATION_REQUIRED');
     // Input is released while the context/manager locks still fence the effect.
     child.stdin!.end(JSON.stringify({jobId:input.jobId,inputDigest:input.inputDigest,scopeDigest,base:input.base,writePaths:input.writePaths,work,output:join(area,'finalizer-result.json')}));
    });
    timer=setTimeout(stop,30000);let checking=false;
    monitor=setInterval(()=>{if(checking)return;checking=true;void this.ledger.tx(async c=>{await this.authorize(principal,authority,input,true,c);await this.ledger.assertIntentActive(c,authority.contextId,input.intentId);}).catch(stop).finally(()=>{checking=false;});},500);
    await finished;
   }catch(error){stop();throw error;}finally{if(timer)clearTimeout(timer);if(monitor)clearInterval(monitor);}
  }
  const row=(await this.ledger.pool.query('SELECT * FROM ac_native_artifact_finalizations WHERE job_id=$1',[input.jobId])).rows[0];
  if(!row?.process_handle||!await this.groupAbsent(row.process_handle))return {status:'uncertain' as const};
  let result:z.infer<typeof Outcome>;
  try{result=await this.outcome(input,scopeDigest);}catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   result={schemaVersion:1,jobId:input.jobId,inputDigest:input.inputDigest,scopeDigest,status:'failed',identity:null,failureCode:'FINALIZER_EXITED_WITHOUT_RESULT'};
  }
  const receipt={...result,process:{...row.process_handle,groupAbsent:true}};
  await this.ledger.tx(async c=>{
   await this.authorize(principal,authority,input,true,c);const saved=(await c.query('SELECT * FROM ac_native_artifact_finalizations WHERE job_id=$1 FOR UPDATE',[input.jobId])).rows[0];
   if(['ready','failed'].includes(saved.state)){if(digest(saved.receipt)!==digest(receipt))throw new Refusal('NATIVE_FINALIZER_RESULT_INVALID');return;}
   if(digest(saved.process_handle)!==digest(row.process_handle))throw new Refusal('NATIVE_FINALIZER_RESULT_INVALID');
   await c.query('UPDATE ac_native_artifact_finalizations SET state=$2,receipt=$3 WHERE job_id=$1',[input.jobId,result.status,receipt]);
  });
  return receipt;
 }
 async stop(principal:string,authority:Authority,input:Input){
  return this.ledger.tx(async c=>{
   await this.authorize(principal,authority,input,true,c);
   const row=(await c.query('SELECT * FROM ac_native_artifact_finalizations WHERE job_id=$1 FOR UPDATE',[input.jobId])).rows[0];
   if(!row||['ready','failed'].includes(row.state))return;
   if(!row.process_handle||await this.groupAbsent(row.process_handle))return;
   const h=Handle.parse(row.process_handle);
   let proc:string;try{proc=await readFile(`/proc/${h.pid}/stat`,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
   if(proc.slice(proc.lastIndexOf(')')+2).split(' ')[19]!==h.startTime)throw new Refusal('NATIVE_FINALIZER_PROCESS_MISMATCH');
   try{process.kill(-h.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  });
 }
}
