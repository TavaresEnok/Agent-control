import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {Capacity} from './capacity.ts';
import {z} from 'zod';
import {Ledger,type Intent} from './ledger.ts';
import {Authority,Command,digest,Refusal} from './contracts.ts';
import {GitArtifacts} from './git.ts';
import {Quality,refuseCurrentProtectedGate} from './quality.ts';
import {NativeExecutionSupervisor} from './native-execution-supervisor.ts';
import {nativeManagedTaskText,readManagedInput,readManagedUnit} from './managed-plan.ts';
import {ManagerPlan} from './planning.ts';
import type {AgentRunSpec,AgentSession,AgentEvent} from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
const execFileAsync=promisify(execFile);
type Source=(intent:Intent,authority:Authority)=>Promise<string>;
type Binding={authority:Authority;resolve:Source};
/** A correction attempt must produce a new commit and tree. The rejected object stays in history only. */
export function assertNativeCorrectionDistinct(commit:string,tree:string,priorCommit:string,priorTree:string){
 if(commit===priorCommit||tree===priorTree)throw new Refusal('NATIVE_CORRECTION_REUSED_COMMIT');
}
/** Runs the implementation stage of the existing native Cezar graph. Source
 * decryption is supplied only by an authorized, live Happier endpoint. */
export class NativeImplementation{
 private readonly sources=new Map<string,Binding>();private active=true;
 constructor(readonly ledger:Ledger,readonly repository:string,readonly quality:Quality,private readonly supervisors:readonly NativeExecutionSupervisor[]){
  if(quality.ledger!==ledger||!supervisors.length||supervisors.length>32||supervisors.some(s=>s.ledger!==ledger))throw new Refusal('NATIVE_IMPLEMENTATION_CONFIGURATION_INVALID');this.supervisors=Object.freeze([...supervisors]);
 }
 bindSource(authority:Authority,resolve:Source){
  const a=Authority.parse(authority),old=this.sources.get(a.contextId);if(old&&old.authority.epoch>a.epoch)throw new Refusal('STALE_MANAGER');
  const entry={authority:Object.freeze({...a}),resolve};this.sources.set(a.contextId,entry);
  return ()=>{if(this.sources.get(a.contextId)===entry)this.sources.delete(a.contextId);};
 }
 hasSource(a:Authority){const entry=this.sources.get(a.contextId);return Boolean(this.active&&entry&&entry.authority.epoch===a.epoch&&entry.authority.instanceId===a.instanceId);}
 close(){this.active=false;this.sources.clear();}
 private async authorize(principal:string,authority:Authority,intentId:string,paused:boolean,c:import('pg').PoolClient){
  const ctx=await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,paused);await this.ledger.assertIntentActive(c,authority.contextId,intentId);
  const i=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[intentId,authority.contextId])).rows[0];
  const repo=(await c.query('SELECT repo FROM ac_project_repositories WHERE project_id=$1',[ctx.project_id])).rows[0];
  if(i?.principal_id!==principal||repo?.repo!==this.repository)throw new Refusal('NATIVE_IMPLEMENTATION_SCOPE_MISMATCH');
 }
 private async frozenTaskText(intent:Intent,messageDigest:string,writePaths:readonly string[]){
  const managed=await readManagedUnit(this.ledger,intent);
  if(!managed||managed.recipe.mode!=='native'||managed.unit.kind!=='task'||!managed.unit.taskId)throw new Refusal('NATIVE_TASK_SOURCE_MISMATCH');
  const saved=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_manager_plans WHERE context_id=$1 AND revision=$2',[intent.context_id,managed.recipe.proposalRevision])).rows[0];
  if(!saved||saved.digest!==managed.recipe.proposalDigest)throw new Refusal('MANAGED_PROPOSAL_MISMATCH');
  const plan=ManagerPlan.parse(saved.snapshot);
  if(digest(plan)!==saved.digest)throw new Refusal('MANAGED_PROPOSAL_MISMATCH');
  const task=plan.tasks.find(item=>item.id===managed.unit.taskId);
  if(!task||digest(task.writePaths)!==digest(writePaths))throw new Refusal('NATIVE_TASK_SOURCE_MISMATCH');
  const text=nativeManagedTaskText(task);
  if(digest(text)!==messageDigest)throw new Refusal('NATIVE_TASK_SOURCE_MISMATCH');
  return text;
 }
 private async materializeManagedCommit(intent:Intent,commit:string){
  const managed=await readManagedUnit(this.ledger,intent);
  if(!managed||managed.recipe.mode!=='native'||managed.unit.kind!=='task')return;
  const cwd=join(this.repository,'.ai/cezar/managed',managed.parentIntentId,managed.unit.runId);
  const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'};
  // The finalized commit is reachable in the job worktree, then imported without a branch.
  // Copy that object into the isolated clone; upload-pack would refuse an unadvertised hash.
  await new Promise<void>((resolve,reject)=>{
   const pack=spawn('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',this.repository,'pack-objects','--revs','--stdout'],{env,stdio:['pipe','pipe','pipe']});
   const unpack=spawn('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',cwd,'unpack-objects'],{env,stdio:['pipe','ignore','pipe']});
   let failure:Error|undefined;const fail=(error:Error)=>{failure??=error;pack.kill('SIGKILL');unpack.kill('SIGKILL');};
   const timer=setTimeout(()=>fail(new Refusal('NATIVE_TASK_WORKTREE_MISMATCH')),10000);
   pack.stdout!.pipe(unpack.stdin!);pack.stdin!.end(commit+'\n');
   pack.once('error',fail);unpack.once('error',fail);
   let pending=2;const done=(code:number|null)=>{if(code)fail(new Refusal('NATIVE_TASK_WORKTREE_MISMATCH'));if(--pending)return;clearTimeout(timer);failure?reject(failure):resolve();};
   pack.once('close',done);unpack.once('close',done);
  });
  await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',cwd,'checkout','--detach',commit],{env,timeout:10000});
  const head=(await execFileAsync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',cwd,'rev-parse','HEAD'],{env,timeout:10000})).stdout.trim();
  if(head!==commit)throw new Refusal('NATIVE_TASK_WORKTREE_MISMATCH');
 }
 private async refuseReusedCorrection(intent:Intent,artifact:{commit_id:string;tree_id:string}){
  const managed=await readManagedUnit(this.ledger,intent);
  if(!managed||managed.recipe.mode!=='native'||(managed.unit.correctionRevision??0)===0)return;
  const input=await readManagedInput(this.ledger,intent.id);
  if(!input.correction||input.correction.revision!==managed.unit.correctionRevision||input.correction.taskId!==managed.unit.taskId)throw new Refusal('MANAGED_CORRECTION_MISMATCH');
  assertNativeCorrectionDistinct(artifact.commit_id,artifact.tree_id,input.correction.priorCommit,input.correction.priorTree);
 }
 async prepareRecovery(intent:Intent,authority:Authority){
  const owner=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1',[intent.id])).rows[0]?.principal_id;if(!owner)throw new Refusal('INTENT_MISSING');
  const job=(await this.ledger.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1',[intent.operation_id])).rows[0];
  if(job){const supervisor=this.supervisors.find(s=>s.supportsAccount(job.account_id)&&s.executorDigest===job.executor_digest&&s.keyFingerprint===job.key_fingerprint);if(!supervisor)throw new Refusal('NATIVE_PROGRAMMER_EXECUTOR_AMBIGUOUS');const result=await supervisor.reconcileRegistered(owner,authority,intent.operation_id);if(result.state!=='completed')return false;const artifact=await supervisor.registerArtifact(owner,authority,intent.operation_id,this.quality);await this.refuseReusedCorrection(intent,artifact);await this.materializeManagedCommit(intent,artifact.commit_id);return true;}
  return this.ledger.tx(async c=>{await this.authorize(owner,authority,intent.id,false,c);if(!this.hasSource(authority))return false;
   const op=(await c.query('SELECT * FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[intent.operation_id,intent.id])).rows[0];if(op?.state!=='registered'||op.handle||op.native_session_id)return false;
   if((await c.query('SELECT 1 FROM ac_execution_launches WHERE operation_id=$1 UNION ALL SELECT 1 FROM ac_sandbox_jobs WHERE id=$1',[intent.operation_id])).rowCount)return false;
   if(op.grant_id){const g=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[op.grant_id])).rows[0];if(!g||!['reserved','released'].includes(g.state))return false;
    if(Number(op.manager_epoch)===authority.epoch&&g.state==='reserved'&&Number(g.manager_epoch)===authority.epoch)return true;
    if(g.state==='reserved')await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[g.id,{state:'not_started',source:'native-unstarted-recovery'}]);
   }
   await c.query('UPDATE ac_operations SET manager_epoch=$2,grant_id=NULL,execution_attempt_id=$3 WHERE id=$1',[intent.operation_id,authority.epoch,randomUUID()]);return true;
  });
 }
 private async releaseUnstarted(intent:Intent,authority:Authority,error:unknown){
  const owner=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1',[intent.id])).rows[0]?.principal_id;if(!owner)return;
  await this.ledger.tx(async c=>{await this.authorize(owner,authority,intent.id,true,c);
   const op=(await c.query('SELECT * FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[intent.operation_id,intent.id])).rows[0];
   if(op?.state!=='registered'||!op.grant_id||(await c.query('SELECT 1 FROM ac_native_execution_jobs WHERE id=$1 UNION ALL SELECT 1 FROM ac_sandbox_jobs WHERE id=$1 UNION ALL SELECT 1 FROM ac_execution_launches WHERE operation_id=$1',[intent.operation_id])).rowCount)return;
   const changed=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND context_id=$3 AND intent_id=$4 AND role='programmer' AND state='reserved' AND manager_epoch=$5 RETURNING id",[op.grant_id,{state:'not_started',source:'native-programmer-preparation'},authority.contextId,intent.id,authority.epoch]);
   if(changed.rowCount)await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1",[intent.operation_id,{operationId:intent.operation_id,exitCode:1,synthetic:false,failureCode:error instanceof Refusal?error.code:'NATIVE_PREPARATION_FAILED'}]);
  });
 }
 start(intent:Intent,authority:Authority,spec:AgentRunSpec,onEvent?:((event:AgentEvent)=>void)):AgentSession{
  let opened=true,canceled=false;const stop=()=>{canceled=true;};
  const result=(async()=>{
   const command=Command.parse(intent.command),p=command.payload;if(p.workflow!=='engineering-native-v1'||intent.context_id!==authority.contextId)throw new Refusal('NATIVE_IMPLEMENTATION_INPUT_MISMATCH');
   const owner=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1',[intent.id])).rows[0]?.principal_id;if(!owner)throw new Refusal('INTENT_MISSING');
   const prior=(await this.ledger.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1',[intent.operation_id])).rows[0];
   let supervisor=prior?this.supervisors.find(s=>s.supportsAccount(prior.account_id)&&s.executorDigest===prior.executor_digest&&s.keyFingerprint===prior.key_fingerprint):undefined;
   if(prior&&!supervisor)throw new Refusal('NATIVE_PROGRAMMER_EXECUTOR_AMBIGUOUS');
   if(!prior){
    const managed=await readManagedUnit(this.ledger,intent);
    let text:string,managedBase:string|undefined,correction:Awaited<ReturnType<typeof readManagedInput>>['correction'];
    if(managed?.recipe.mode==='native'){const input=await readManagedInput(this.ledger,intent.id);managedBase=input.base;correction=input.correction;text=await this.frozenTaskText(intent,p.messageDigest,p.writePaths);}
    else{const source=this.sources.get(authority.contextId);if(!this.hasSource(authority)||!source)throw new Refusal('NATIVE_TASK_SOURCE_MISSING');text=await source.resolve(intent,authority);}
    if(digest(text)!==p.messageDigest)throw new Refusal('NATIVE_TASK_SOURCE_MISMATCH');
    const operation=(await this.ledger.pool.query('SELECT execution_attempt_id FROM ac_operations WHERE id=$1 AND intent_id=$2',[intent.operation_id,intent.id])).rows[0];
    if(!operation)throw new Refusal('OPERATION_MISSING');
    let grant;
    for(;;){if(canceled||!this.active)throw new Refusal('STAGE_CANCELED');try{grant=await new Capacity(this.ledger).reserve(owner,{attemptId:operation.execution_attempt_id,intentId:intent.id,contextId:intent.context_id,role:'programmer'},authority);break;}
     catch(error){if(!(error instanceof Refusal)||!['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','HUMAN_PAUSED','ADMISSION_CLOSED','ORIGINAL_RESERVE_NOT_NEEDED'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,1000));}}
    // Bind the reservation before fallible Git preparation. A preparation error
    // must be able to release this exact, still-unstarted grant.
    await this.ledger.tx(async c=>{
     await this.authorize(owner,authority,intent.id,false,c);
     const bound=await c.query("UPDATE ac_operations SET grant_id=$2 WHERE id=$1 AND intent_id=$3 AND state='registered' AND manager_epoch=$4 AND (grant_id IS NULL OR grant_id=$2) RETURNING id",[intent.operation_id,grant!.id,intent.id,authority.epoch]);
     if(!bound.rowCount)throw new Refusal('NATIVE_IMPLEMENTATION_RECONCILIATION_REQUIRED');
    });
    const eligible=this.supervisors.filter(s=>s.supportsAccount(grant!.account_id));
    if(eligible.length!==1)throw new Refusal('NATIVE_PROGRAMMER_EXECUTOR_AMBIGUOUS');
    supervisor=eligible[0]!;
    const frozen=await this.ledger.tx(async c=>{
     await this.authorize(owner,authority,intent.id,false,c);
     const projectId=(await c.query('SELECT project_id FROM ac_contexts WHERE id=$1',[authority.contextId])).rows[0]?.project_id;
     if(!projectId)throw new Refusal('NATIVE_IMPLEMENTATION_SCOPE_MISMATCH');
     await refuseCurrentProtectedGate(c,projectId,p.writePaths);
     let row=(await c.query('SELECT * FROM ac_native_task_inputs WHERE intent_id=$1',[intent.id])).rows[0];
     if(!row){
      const base=managedBase??await new GitArtifacts(this.repository).resolveTarget(p.targetRef);
      const input={schemaVersion:1,intentId:intent.id,contextId:authority.contextId,base,writePaths:p.writePaths,qualityRevision:p.qualityRevision,targetRef:p.targetRef,messageRef:p.messageRef,messageDigest:p.messageDigest};
      await c.query('INSERT INTO ac_native_task_inputs VALUES($1,$2,$3,$4)',[intent.id,base,input,digest(input)]);row={base_id:base,snapshot:input,digest:digest(input)};
     }
     if(digest(row.snapshot)!==row.digest||row.snapshot.messageDigest!==p.messageDigest||row.snapshot.targetRef!==p.targetRef||digest(row.snapshot.writePaths)!==digest(p.writePaths)||(managedBase!==undefined&&row.base_id!==managedBase))throw new Refusal('NATIVE_TASK_INPUT_CONFLICT');
     const op=(await c.query('SELECT * FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[intent.operation_id,intent.id])).rows[0];
     if(op?.state!=='registered'||Number(op.manager_epoch)!==authority.epoch||!grant||grant.state!=='reserved'||(op.grant_id&&op.grant_id!==grant.id))throw new Refusal('NATIVE_IMPLEMENTATION_RECONCILIATION_REQUIRED');
     await c.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1',[intent.operation_id,grant.id]);return {base:row.base_id,grantId:grant.id};
    });
    if(canceled||!this.active)throw new Refusal('STAGE_CANCELED');
    const task=JSON.stringify({instruction:'Implement the authorized request within the frozen write paths. Tests and independent review are enforced by the controller. Do not approve, integrate, publish or deploy.',request:text,sourceRef:p.messageRef,writePaths:p.writePaths,base:frozen.base,...(correction?{correction:{taskId:correction.taskId,revision:correction.revision,priorCommit:correction.priorCommit,priorTree:correction.priorTree,priorArtifactId:correction.priorArtifactId,decisionDigest:correction.decisionDigest,failedEvidenceIds:correction.failedEvidenceIds}}:{})});
    try{await supervisor.start(owner,authority,{jobId:intent.operation_id,intentId:intent.id,grantId:frozen.grantId,sessionId:z.uuid().parse(spec.sessionId),base:frozen.base,role:'programmer',task,writePaths:p.writePaths});}
    catch(error){const exists=(await this.ledger.pool.query('SELECT 1 FROM ac_native_execution_jobs WHERE id=$1',[intent.operation_id])).rowCount;if(!exists){
      await this.ledger.tx(async c=>{await this.authorize(owner,authority,intent.id,true,c);
       const saved=(await c.query('SELECT state,grant_id FROM ac_operations WHERE id=$1 FOR UPDATE',[intent.operation_id])).rows[0];
       if(saved?.state==='registered'&&saved.grant_id===frozen.grantId&&!Boolean((await c.query('SELECT 1 FROM ac_native_execution_jobs WHERE id=$1',[intent.operation_id])).rowCount)){
        const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state='reserved' AND manager_epoch=$3 RETURNING id",[frozen.grantId,{state:'not_started',source:'native-programmer-admission'},authority.epoch]);
        if(released.rowCount)await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1",[intent.operation_id,{operationId:intent.operation_id,exitCode:1,synthetic:false,failureCode:error instanceof Refusal?error.code:'NATIVE_ADMISSION_FAILED'}]);
       }
      });throw error;
     }}
   }
   if(!supervisor)throw new Refusal('NATIVE_PROGRAMMER_EXECUTOR_AMBIGUOUS');
   for(;;){
    if(canceled||!this.active){await supervisor.reconcileCancellation(owner,authority,intent.operation_id);throw new Refusal('STAGE_CANCELED');}
    const observed=await supervisor.reconcileRegistered(owner,authority,intent.operation_id);
    if(observed.state==='failed')throw new Refusal('NATIVE_IMPLEMENTATION_FAILED');
    if(observed.state==='completed'){
     const artifact=await supervisor.registerArtifact(owner,authority,intent.operation_id,this.quality);
     await this.refuseReusedCorrection(intent,artifact);
     await this.materializeManagedCommit(intent,artifact.commit_id);
     const row=(await this.ledger.pool.query('SELECT g.physical_receipt FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id WHERE j.id=$1',[intent.operation_id])).rows[0];
     const tokens=row?.physical_receipt?.normalizedTokensUsed;
     const text=`Native artifact prepared for independent QA and review: ${artifact.commit_id}`;
     if(Number.isSafeInteger(tokens)&&tokens>=0)onEvent?.({type:'token-usage',tokensUsed:tokens});onEvent?.({type:'text',text});onEvent?.({type:'done'});
     return {text,toolCalls:[],tokensUsed:Number.isSafeInteger(tokens)&&tokens>=0?tokens:0};
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
  })().catch(async error=>{try{await this.releaseUnstarted(intent,authority,error);}catch{}throw error;}).finally(()=>{opened=false;});
  return {result,get open(){return opened;},sendMessage(){return false;},end(){},interrupt:stop,hardStop:stop};
 }
}
