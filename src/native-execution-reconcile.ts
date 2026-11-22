/** Reconciliation of launched jobs: terminal results, stop, cancellation and recovery after a lost response. */
import {Usage} from './usage.ts';
import {assertNoNativeTaskSecrets} from './native-execution-redaction.ts';
import {readNativeSecretSnapshot,writeNativeSecretSnapshot} from './native-execution-secret-snapshot.ts';
import {collectSecretValues} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {isProviderLimit,noteProviderExhaustion,providerLimitDisposition} from './quota-exhaustion.ts';
import {proveUncreatedNativeResources,reconcileNativeResourceAdmissions} from './native-resource-envelope.ts';
import {constants} from 'node:fs';
import {writeFile,open,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createPublicKey,sign,createHmac,randomBytes,verify} from 'node:crypto';
import {z} from 'zod';
import {Authority,canonical,digest,Refusal} from './contracts.ts';
import {DockerDaemon} from './sandbox-broker.ts';
import {assertNativeSyntheticFixture} from './native-synthetic-fixture.ts';
import {NativeArtifactFinalizer,NativeArtifactIdentity} from './native-artifact-finalizer.ts';
import {nativeContainerNeverStarted} from './native-execution-isolation.ts';
import {readPrivateWorkerFile} from './native-worker-security.ts';
import {postgresAccountLoginLock,prepareClaudeExamAccessToken,renewClaudeLoginInPlace,safeFailureCode,writePrivateAtomic} from './exam-login.ts';
import {Id,ModuleExamNeverStartedReceipt,openGrantLaunchLockSession,tryGrantLaunchLock,releaseGrantLaunchLock,NativeExecutionRequest,type Input,type NativeExecutionOutcome,retireNativePrivateNetwork,readonlyExamIsolation,dockerUncertain,type NativeExecutionRecovery} from './native-execution-shared.ts';
import {NativeExecutionExamRecovery} from './native-execution-exam-recovery.ts';
export abstract class NativeExecutionReconciler extends NativeExecutionExamRecovery{
 async reconcileResourceAdmissions(principal:string,authority:Authority){return reconcileNativeResourceAdmissions({docker:this.docker,ledger:this.ledger,principal,authority,recoverSource:'ac_native_execution_jobs',recoverJob:id=>this.recover(principal,authority,id)});}
 async reconcileRegistered(principal:string,authority:Authority,jobId:string){
  try{return await this.reconcile(principal,authority,await this.registeredInput(principal,authority,jobId));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:'uncertain' as const};throw error;}
 }
 async reconcileCancellation(principal:string,authority:Authority,jobId:string){
  const input=await this.registeredInput(principal,authority,jobId);
  const canceled=await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);
   return Boolean((await c.query("SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1 AND context_id=$2 AND state='requested'",[input.intentId,authority.contextId])).rowCount);});
  if(!canceled)return {state:'not_applicable' as const};
  const stopped=await this.stop(principal,authority,input);if(stopped.state!=='stop_requested')return {state:'uncertain' as const};
  const observed=await this.reconcile(principal,authority,input);
  if(observed.state!=='completed'&&observed.state!=='failed')return {state:'uncertain' as const};
  await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);
   const saved=(await c.query(`SELECT j.receipt,g.physical_receipt FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    JOIN ac_plan_cancellations x ON x.intent_id=j.intent_id AND x.state='requested'
    WHERE j.id=$1 AND j.context_id=$2 AND j.state IN ('completed','failed') AND g.state='released' FOR UPDATE OF j,g`,[jobId,authority.contextId])).rows[0];
   if(!saved||digest(saved.receipt)!==digest(observed.receipt)||saved.receipt.payload.physicalDigest!==digest(saved.physical_receipt))throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');
   const receipt={cancellation:true,nativeExecution:observed.receipt};
   if(input.role==='programmer')await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND intent_id=$3 AND state IN ('running','uncertain')",[jobId,receipt,input.intentId]);
   else await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1 AND intent_id=$3 AND state IN ('running','uncertain')",[jobId,receipt,input.intentId]);
  });
  return {state:'reconciled' as const};
 }
 /** Same worker, tools container and grant. Re-prepares Claude exam tokens (never reusing old tokens), renews launch expiry, then starts the exited pair again. */
 protected async resumeExecutionContainers(input:Input,job:Record<string,any>,workerId:string,toolsId:string):Promise<{resumed:true}|{resumed:false;failureCode:string}>{
  const p=this.paths(input.jobId),path=join(p.input,'launch.json'),handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let payload:Record<string,unknown>;
  try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1024*1024)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
   const parsed=JSON.parse((await handle.readFile()).toString('utf8'));payload=parsed.payload;
   if(!payload||typeof payload!=='object'||!verify(null,Buffer.from('agent-control:native-execution-launch:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(String(parsed.signature),'hex')))throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
  }finally{await handle.close();}
  delete payload.oauthAccessToken;
  await this.removeLaunchFiles(input.jobId);
  const synthetic=Boolean(this.config.syntheticFixture);
  const personal=!synthetic&&Boolean((await this.ledger.pool.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'")).rowCount);
  const examWorkflow=(await this.ledger.pool.query('SELECT command FROM ac_intents WHERE id=$1',[input.intentId])).rows[0]?.command?.payload?.workflow;
  const claudeExam=!synthetic&&readonlyExamIsolation(personal,examWorkflow,input.role)&&this.config.provider==='claude';
  if(claudeExam){
   try{
    const envSecrets=[...this.config.workerEnv,...this.config.toolsEnv].flatMap(entry=>{const index=entry.indexOf('=');return index<0?[]:collectSecretValues({[entry.slice(0,index)]:entry.slice(index+1)});});
    const prepared=await prepareClaudeExamAccessToken({accountDir:join(this.config.accountRoot,String(job.account_id)),accountId:String(job.account_id),examMaxMs:input.timeoutMs,renew:this.config.examLoginRenew??renewClaudeLoginInPlace,lock:postgresAccountLoginLock(this.ledger)});
    assertNoNativeTaskSecrets(input.task,[...envSecrets,...prepared.secrets]);
    const tokenBytes=await readPrivateWorkerFile(p.workerToken,512);
    let token:string;try{token=tokenBytes.toString('utf8').trim();}finally{tokenBytes.fill(0);}
    payload.oauthAccessToken=prepared.accessToken;
    payload.credentialSnapshotTag=createHmac('sha256',token).update(canonical([prepared.accessToken])).digest('hex');
    let existingSecrets:string[]=[];
    try{existingSecrets=await readNativeSecretSnapshot(p.secretSnapshot,input.jobId,this.key);}catch{/* no prior snapshot on a first launch; the new one below is written whole */}
    const tempSnap=p.secretSnapshot+'.pending.'+randomBytes(6).toString('hex');
    try{
     await writeNativeSecretSnapshot(tempSnap,input.jobId,this.key,[...new Set([...existingSecrets,...prepared.secrets])]);
     await rename(tempSnap,p.secretSnapshot);
    }catch(snapError){
     await rm(tempSnap,{force:true}).catch(()=>undefined/* best-effort removal of a pending temp file */);
     throw snapError;
    }
   }catch(error){
    await this.removeLaunchFiles(input.jobId).catch(()=>undefined/* launch files are retried by the next reconcile */);
    const code=error instanceof Refusal?error.code:(error as NodeJS.ErrnoException)?.code;
    return {resumed:false,failureCode:safeFailureCode(code,'EXAM_LOGIN_TOKEN_FAILED')};
   }
  }
  payload.expiresAt=Date.now()+50000;
  const pending=join(p.input,'launch.pending.'+randomBytes(6).toString('hex'));
  try{
   await writeFile(pending,JSON.stringify({payload,signature:sign(null,Buffer.from('agent-control:native-execution-launch:v1\n'+canonical(payload)),this.key).toString('hex')}),{mode:0o600,flag:'wx'});
   await rename(pending,path);
  }catch(error){
   await rm(pending,{force:true}).catch(()=>undefined/* best-effort removal of a pending temp file */);
   await this.removeLaunchFiles(input.jobId).catch(()=>undefined/* launch files are retried by the next reconcile */);
   const code=error instanceof Refusal?error.code:(error as NodeJS.ErrnoException)?.code;
   return {resumed:false,failureCode:safeFailureCode(code,'NATIVE_EXECUTION_RESUME_FAILED')};
  }
  await rm(join(p.output,'execution-result.json'),{force:true});
  await this.docker.start(toolsId);await this.docker.start(workerId);
  return {resumed:true};
 }
 async reconcile(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>):Promise<NativeExecutionOutcome>{
  const input=NativeExecutionRequest.parse(raw),job=(await this.ledger.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1',[input.jobId])).rows[0];
  if(!job)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);await this.validateReplay(principal,authority,input,job);
  if(job.state==='completed'||job.state==='failed'){
   const receipt=job.receipt,payload=receipt?.payload;
   const grant=(await this.ledger.pool.query('SELECT * FROM ac_capacity_grants WHERE id=$1',[input.grantId])).rows[0];
   if(!payload||typeof receipt.signature!=='string'||!/^[a-f0-9]{128}$/.test(receipt.signature)||
    !verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(receipt.signature,'hex'))||
    payload.jobId!==input.jobId||payload.intentId!==input.intentId||payload.contextId!==authority.contextId||payload.grantId!==input.grantId||payload.sessionId!==input.sessionId||
    payload.epoch!==Number(job.manager_epoch)||payload.accountId!==job.account_id||payload.profileId!==job.profile_id||payload.profileDigest!==job.profile_digest||payload.inputDigest!==job.input_digest||payload.executorDigest!==this.executorDigest||
    grant?.state!=='released'||grant.account_id!==job.account_id||grant.profile_id!==job.profile_id||grant.role!==job.role||!grant.physical_receipt||payload.physicalDigest!==digest(grant.physical_receipt)||
    ((payload.exitCode===0)!==(job.state==='completed')&&!(job.state==='failed'&&payload.orphanedExam===true&&payload.failureCode==='NATIVE_EXAM_ORPHANED')))
    throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');
   if(payload.executionStarted===false&&this.validPreLaunchExamReceipt(grant.physical_receipt,job.id,Boolean(this.config.syntheticFixture))){
    this.verifyUnstartedReceipt(job,grant,receipt,authority.contextId);
    return {state:'failed',receipt,output:'',artifact:null,failureCode:grant.physical_receipt.reason};
   }
   if(payload.executionStarted===false&&ModuleExamNeverStartedReceipt.safeParse(grant.physical_receipt).success){
    this.verifyModuleExamNeverStartedReceipt(job,grant,receipt,authority.contextId);
    return {state:'failed',receipt,output:'',artifact:null,failureCode:grant.physical_receipt.reason};
   }
   if(payload.orphanedExam===true){
    const saved=(await this.ledger.pool.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1',[input.jobId])).rows[0];
    if(!saved)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
    this.verifyUnstartedRetirement(saved,this.orphanedExamBinding(job,receipt));
    const result=payload.executionStarted===false?null:await this.orphanedExamResult(input.jobId);
    if((result?digest(result):null)!==payload.resultDigest)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
    return {state:'failed',receipt,output:result?.output??'',artifact:null,failureCode:payload.failureCode};
   }
   const result=await this.readResult(input,payload.exitCode);
   if(payload.outputDigest!==digest(result.output)||result.exitCode!==payload.workerExitCode||result.jobId!==input.jobId||
    (input.moduleExam&&grant.physical_receipt.failureCode!==result.failureCode))throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
   await this.removeLaunchFiles(input.jobId);
   return {state:job.state as 'completed'|'failed',receipt,output:result.output,artifact:payload.artifact??null,failureCode:result.failureCode};
  }
  // Never recreate missing resources or rerun an uncertain start.
  const worker=await this.docker.inspect('ac-native-worker-'+input.jobId),tools=await this.docker.inspect('ac-native-tools-'+input.jobId);
  for(const [physical,id,image] of [[worker,job.worker_id,this.config.workerImage],[tools,job.tools_id,this.config.toolsImage]] as const){
   if(!physical)return {state:'uncertain' as const};
   if((id&&physical.Id!==id)||physical.Image!==image||physical.Config.Labels['agent-control.job']!==input.jobId||physical.Config.Labels['agent-control.launch']!==job.input_digest||physical.Config.Labels['agent-control.contract']!=='native-execution-v1')throw new Refusal('NATIVE_EXECUTION_CONTAINER_MISMATCH');
  }
  if(!worker||!tools)return {state:'uncertain' as const};
  if(worker.State.Running||worker.State.Status!=='exited')return {state:'running' as const};
  if(tools.State.Running){await this.stop(principal,authority,input);return {state:'uncertain' as const};}
  if(tools.State.Status!=='exited'||[worker,tools].some(p=>!Number.isFinite(Date.parse(p.State.FinishedAt))||p.State.FinishedAt.startsWith('0001-')))return {state:'uncertain' as const};
  const result=await this.readResult(input,worker.State.ExitCode);
  if(result.jobId!==input.jobId||result.exitCode!==worker.State.ExitCode||(result.exitCode===0&&result.failureCode!==null))throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
  if(input.moduleExam&&isProviderLimit(result.failureCode))await noteProviderExhaustion(this.ledger,job.account_id,result.usageWindows);
  const disposition=input.moduleExam?'seal':await providerLimitDisposition(this.ledger,job.account_id,result.failureCode,result.usageWindows,Date.now(),Date.parse(worker.State.FinishedAt));
  if(disposition==='wait')return {state:'running' as const};
  let resumeFailureCode:string|null=null;
  if(disposition==='resume'){
   const resumed=await this.resumeExecutionContainers(input,job,worker.Id,tools.Id);
   if(resumed.resumed)return {state:'running' as const};
   resumeFailureCode=resumed.failureCode;
   result.failureCode=resumeFailureCode;
   await writePrivateAtomic(join(this.paths(input.jobId).output,'execution-result.json'),JSON.stringify(result));
  }
  const cancellation=(await this.ledger.pool.query("SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1 AND state='requested'",[input.intentId])).rowCount;
  let finalization:any=null,artifact:z.infer<typeof NativeArtifactIdentity>|null=null;
  if(input.role==='programmer'&&!resumeFailureCode){
   const existing=(await this.ledger.pool.query('SELECT state FROM ac_native_artifact_finalizations WHERE job_id=$1',[input.jobId])).rows[0];
   if((result.exitCode===0&&!cancellation)||existing){
    const finalizer=new NativeArtifactFinalizer(this.ledger,this.config.hostRoot);
    const binding={jobId:input.jobId,intentId:input.intentId,grantId:input.grantId,inputDigest:job.input_digest,base:input.base,writePaths:input.writePaths};
    if(cancellation)await finalizer.stop(principal,authority,binding);
    try{finalization=await finalizer.finalize(principal,authority,binding,async()=>{
     const [w,t]=await Promise.all([this.docker.inspect(worker.Id),this.docker.inspect(tools.Id)]);
     if(!w||!t||w.Id!==worker.Id||t.Id!==tools.Id||w.State.Running||t.State.Running||w.State.Status!=='exited'||t.State.Status!=='exited')throw new Refusal('NATIVE_FINALIZER_PHYSICAL_UNCONFIRMED');
    });}catch(error){
     // Another observer may finish the same immutable job between our initial
     // read and finalizer admission. Replay its signed terminal result only.
     if(error instanceof Refusal&&error.code==='NATIVE_FINALIZER_BINDING_MISMATCH'){
      const current=(await this.ledger.pool.query('SELECT state FROM ac_native_execution_jobs WHERE id=$1',[input.jobId])).rows[0];
      if(current&&['completed','failed'].includes(current.state))return this.reconcile(principal,authority,input);
     }
     throw error;
    }
    if(finalization.status==='uncertain')return {state:'uncertain' as const};
    if(!cancellation&&finalization.status==='ready')artifact=NativeArtifactIdentity.parse(finalization.identity);
   }
  }
  const effectiveExitCode=resumeFailureCode?(result.exitCode!==0?result.exitCode:1):finalization?.status==='failed'&&result.exitCode===0?1:result.exitCode;
  const physical={jobId:input.jobId,containerId:worker.Id,toolsContainerId:tools.Id,networkId:job.network_id,exitCode:effectiveExitCode,workerExitCode:worker.State.ExitCode,finalization,finishedAt:worker.State.FinishedAt,toolsFinishedAt:tools.State.FinishedAt,synthetic:Boolean(this.config.syntheticFixture),executorDigest:this.executorDigest,nativeSessionId:result.nativeSessionId,normalizedTokensUsed:result.normalizedTokensUsed,usageCounters:result.usageCounters??null,usageWindows:result.usageWindows,
   ...(input.moduleExam?{failureCode:result.failureCode}:{})};
  const payload={schemaVersion:1,accountId:job.account_id,profileId:job.profile_id,profileDigest:job.profile_digest,jobId:input.jobId,intentId:input.intentId,contextId:authority.contextId,grantId:input.grantId,sessionId:input.sessionId,epoch:Number(job.manager_epoch),inputDigest:job.input_digest,executorDigest:this.executorDigest,outputDigest:digest(result.output),physicalDigest:digest(physical),workerExitCode:result.exitCode,artifact,exitCode:effectiveExitCode};
  const receipt={payload,signature:sign(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),this.key).toString('hex')};
  await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);const saved=(await c.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1 FOR UPDATE',[input.jobId])).rows[0];if(['completed','failed'].includes(saved.state)){if(digest(saved.receipt)!==digest(receipt))throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');return;}
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
   if(!grant||grant.account_id!==job.account_id||grant.profile_id!==job.profile_id||grant.role!==job.role||grant.resource_kind!=='model'||grant.intent_id!==input.intentId||grant.context_id!==authority.contextId||Number(grant.manager_epoch)!==Number(job.manager_epoch)||!['uncertain','running'].includes(grant.state))throw new Refusal('NATIVE_EXECUTION_GRANT_MISMATCH');
   if(!this.config.disabledMeasurementProjects?.includes(grant.project_id)) await new Usage(this.ledger).recordInTransaction(c,principal,authority,{grantId:input.grantId,eventId:input.jobId,seq:1,counters:result.usageCounters??{input:null,output:null,cache:null,reasoning:null}},input.jobId);
   await c.query("UPDATE ac_native_execution_jobs SET state=$2,worker_id=$3,tools_id=$4,receipt=$5 WHERE id=$1",[input.jobId,effectiveExitCode===0?'completed':'failed',worker.Id,tools.Id,receipt]);
   await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[input.grantId,physical]);
   if(input.role==='programmer'&&!cancellation){
    const operationReceipt=artifact?{operationId:input.jobId,commit:artifact.commit,tree:artifact.tree,base:artifact.base,exitCode:0,synthetic:Boolean(this.config.syntheticFixture),nativeExecution:receipt,finalizationDigest:digest(finalization)}:
      {operationId:input.jobId,exitCode:effectiveExitCode,synthetic:Boolean(this.config.syntheticFixture),nativeExecution:receipt,failureCode:resumeFailureCode??finalization?.failureCode??result.failureCode};
    const updated=await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND intent_id=$3 AND grant_id=$4 AND native_session_id=$5 AND manager_epoch=$6 AND state IN ('uncertain','running')",[input.jobId,operationReceipt,input.intentId,input.grantId,input.sessionId,job.manager_epoch]);
    if(!updated.rowCount)throw new Refusal('NATIVE_EXECUTION_OPERATION_MISMATCH');
   }

  });
  await this.removeLaunchFiles(input.jobId);
  return {state:effectiveExitCode===0?'completed' as const:'failed' as const,receipt,output:result.output,artifact,failureCode:resumeFailureCode??finalization?.failureCode??result.failureCode??null};
 }
 async stop(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>){
  const input=NativeExecutionRequest.parse(raw),job=(await this.ledger.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1',[input.jobId])).rows[0];if(!job)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);await this.validateReplay(principal,authority,input,job);
  return this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);
   const names=[['ac-native-worker-'+input.jobId,job.worker_id,this.config.workerImage],['ac-native-tools-'+input.jobId,job.tools_id,this.config.toolsImage]] as const;
   let absent=false;
   for(const [name,id,image] of names){
    let physical;try{physical=await this.docker.inspect(name);}catch(error){if(dockerUncertain(error))return {state:'uncertain' as const};throw error;}
    if(!physical){absent=true;continue;}
    if((id&&physical.Id!==id)||physical.Image!==image||physical.Config.Labels['agent-control.job']!==input.jobId||physical.Config.Labels['agent-control.launch']!==job.input_digest)throw new Refusal('NATIVE_EXECUTION_CONTAINER_MISMATCH');
    if(physical.State.Running){try{await this.docker.stop(physical.Id);}catch(error){if(dockerUncertain(error))return {state:'uncertain' as const};throw error;}}
   }
   if(absent)return {state:'uncertain' as const};
   for(const [name,id] of names){
    let after;try{after=await this.docker.inspect(name);}catch(error){if(dockerUncertain(error))return {state:'uncertain' as const};throw error;}
    if(!after||(id&&after.Id!==id)||after.State.Running)return {state:'uncertain' as const};
   }
   return {state:'stop_requested' as const};
  });
 }
 /** Observe the original pair after a crash. Never creates a network or container.
  * Capacity stays reserved unless both bodies are still created while this recovery
  * holds the job lock, and the network is already gone. A name 404 is not that proof. */
 async recover(principal:string,authority:Authority,jobId:string){
  Id.parse(jobId);
  const loaded=await this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,authority.contextId);
   if(this.config.syntheticFixture)assertNativeSyntheticFixture(this.config.syntheticFixture,this.config,{projectId:context.project_id,contextId:authority.contextId});
   await this.ledger.fence(c,authority,true);
   const row=(await c.query(`SELECT j.*,g.state grant_state,g.physical_receipt,i.principal_id FROM ac_native_execution_jobs j
    JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[jobId,authority.contextId])).rows[0];
   if(!row)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
   if(row.principal_id!==principal)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
   return row;
  });
  // Recovery takes the same per-grant launch lock as the launch: a launch still preparing is preserved, never recovered underneath.
  const session=await openGrantLaunchLockSession(this.ledger);
  if(!session)return this.recoverLoaded(principal,authority,jobId,loaded);
  try{
   if(!await tryGrantLaunchLock(session,String(loaded.grant_id)))return {state:'uncertain' as const,interval:'before_terminal_evidence' as const,grant:'preserved' as const,removed:[] as string[],replayed:false as const};
   try{return await this.recoverLoaded(principal,authority,jobId,loaded);}finally{await releaseGrantLaunchLock(session,String(loaded.grant_id));}
  }finally{await session.end().catch(()=>undefined/* closing a lock session that may already be gone */);}
 }
 protected async recoverLoaded(principal:string,authority:Authority,jobId:string,loaded:Record<string,any>){
  const preserved=(interval:NativeExecutionRecovery['interval'],grant:NativeExecutionRecovery['grant']=loaded.grant_state==='released'?'released':'preserved'):NativeExecutionRecovery=>({state:'uncertain',interval,grant,removed:[],replayed:false});
  if(loaded.key_fingerprint!==this.fingerprint||loaded.executor_digest!==this.executorDigest)return preserved('supervisor_identity');
  if(['completed','failed'].includes(loaded.state)){
   let input;try{input=await this.registeredInput(principal,authority,jobId);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return preserved('terminal_evidence_missing');throw error;}
   const outcome=await this.reconcile(principal,authority,input);
   if(outcome.state!=='completed'&&outcome.state!=='failed')return preserved('terminal_evidence_missing');
   return {state:'acknowledged',interval:'ack_lost',grant:'released',removed:[],replayed:false,receipt:outcome.receipt};
  }
  const workerName='ac-native-worker-'+jobId,toolsName='ac-native-tools-'+jobId;
  const decision=await this.serialEffect(jobId,()=>this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const job=(await c.query(`SELECT j.*,g.state grant_state,g.physical_receipt FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[jobId,authority.contextId])).rows[0];
   if(!job)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
   const receiptUnstarted=job.grant_state==='released'&&job.physical_receipt?.executionStarted===false;
   // A no-create host proof retires pending aggregate slots even if the
   // independent network journal remains uncertain. Network proof below still
   // controls grant release; absence of a container name alone never does.
   let noCreateProof;
   if(!job.worker_id&&!job.tools_id&&job.state==='uncertain'&&!await this.launchPublished(jobId))noCreateProof=await proveUncreatedNativeResources(c,this.docker,jobId,job.grant_id,authority);
   if(noCreateProof&&job.network_id){
    await retireNativePrivateNetwork(this.docker,{networkId:job.network_id,providerNetworkId:this.config.providerNetworkId,jobId,inputDigest:job.input_digest});
    await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state IN ('reserved','uncertain')",[job.grant_id,{...noCreateProof,networkId:job.network_id}]);
    return {kind:'recovery' as const,recovery:{state:'released_unstarted' as const,interval:'proven_not_started' as const,grant:'released' as const,removed:[],replayed:false as const}};
   }

   const read=async()=>{
    const worker=await this.docker.inspect(workerName),tools=await this.docker.inspect(toolsName);
    const network=job.network_id?await this.docker.inspectPrivateNetwork(job.network_id):null;
    return {worker,tools,network};
   };
   const matches=(physical:NonNullable<Awaited<ReturnType<DockerDaemon['inspect']>>>,id:string|null,image:string)=>{
    if((id&&physical.Id!==id)||physical.Image!==image||physical.Config.Labels['agent-control.job']!==jobId||physical.Config.Labels['agent-control.launch']!==job.input_digest||physical.Config.Labels['agent-control.contract']!=='native-execution-v1')throw new Refusal('NATIVE_EXECUTION_CONTAINER_MISMATCH');
   };
   let seen;try{seen=await read();}catch(error){if(dockerUncertain(error))return {kind:'recovery' as const,recovery:preserved('docker_response_lost')};throw error;}
   if(seen.worker)matches(seen.worker,job.worker_id,this.config.workerImage);
   if(seen.tools)matches(seen.tools,job.tools_id,this.config.toolsImage);
   const absent=!seen.worker&&!seen.tools;
   const bothNever=Boolean(seen.worker&&seen.tools&&nativeContainerNeverStarted(seen.worker.State)&&nativeContainerNeverStarted(seen.tools.State));
   if(!bothNever){
    if(absent){
     await this.ledger.fence(c,authority,true);
     let again;try{again=await read();}catch(error){if(dockerUncertain(error))return {kind:'recovery' as const,recovery:preserved('docker_response_lost')};throw error;}
     if(again.worker||again.tools)return {kind:'recovery' as const,recovery:preserved(again.worker&&again.tools&&nativeContainerNeverStarted(again.worker.State)&&nativeContainerNeverStarted(again.tools.State)?'terminal_evidence_missing':'before_terminal_evidence')};
     const published=await this.launchPublished(jobId);
     if(!job.network_id)return {kind:'recovery' as const,recovery:preserved('network_unproven')};
     if(receiptUnstarted&&!again.network&&!published)return {kind:'recovery' as const,recovery:{state:'released_unstarted' as const,interval:'proven_not_started' as const,grant:'released' as const,removed:[],replayed:false as const}};
     return {kind:'recovery' as const,recovery:preserved(again.network?'network_or_container_remains':'terminal_evidence_missing')};
    }
    if((job.worker_id&&!seen.worker)||(job.tools_id&&!seen.tools))return {kind:'recovery' as const,recovery:preserved('terminal_evidence_missing')};
    return {kind:'observe' as const,worker:seen.worker,tools:seen.tools};
   }
   if(job.state!=='uncertain'||(!receiptUnstarted&&!['reserved','uncertain'].includes(job.grant_state)))return {kind:'observe' as const,worker:seen.worker,tools:seen.tools};
   await this.ledger.fence(c,authority,true);
   const current=(await c.query(`SELECT j.*,g.state grant_state,g.physical_receipt FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[jobId,authority.contextId])).rows[0];
   if(!current||current.state!=='uncertain')return {kind:'recovery' as const,recovery:preserved('before_terminal_evidence')};
   let confirmed;try{confirmed=await read();}catch(error){if(dockerUncertain(error))return {kind:'recovery' as const,recovery:preserved('docker_response_lost')};throw error;}
   const pair=[[confirmed.worker,workerName,seen.worker!.Id],[confirmed.tools,toolsName,seen.tools!.Id]] as const;
   for(const [physical,name,id] of pair){
    if(!physical||physical.Id!==id||!nativeContainerNeverStarted(physical.State))return {kind:'recovery' as const,recovery:preserved('before_terminal_evidence')};
    matches(physical,name===workerName?current.worker_id:current.tools_id,name===workerName?this.config.workerImage:this.config.toolsImage);
   }
   const removed:string[]=[];
   for(const [physical] of pair){
    await this.ledger.fence(c,authority,true);
    let live;try{live=await this.docker.inspect(physical!.Id===seen.worker!.Id?workerName:toolsName);}catch(error){if(dockerUncertain(error))return {kind:'recovery' as const,recovery:{...preserved('docker_response_lost'),removed}};throw error;}
    if(!live||live.Id!==physical!.Id||!nativeContainerNeverStarted(live.State))return {kind:'recovery' as const,recovery:{...preserved('before_terminal_evidence'),removed}};
    try{await this.docker.remove(live.Id);}catch(error){if(dockerUncertain(error))return {kind:'recovery' as const,recovery:{...preserved('docker_response_lost'),removed}};throw error;}
    removed.push(live.Id);
   }
   let after;try{after=await read();}catch(error){if(dockerUncertain(error))return {kind:'recovery' as const,recovery:{...preserved('docker_response_lost'),removed}};throw error;}
   const published=await this.launchPublished(jobId);
   if(after.worker||after.tools||after.network)return {kind:'recovery' as const,recovery:{...preserved('network_or_container_remains'),removed}};
   if(published||!current.network_id)return {kind:'recovery' as const,recovery:{...preserved(published?'terminal_evidence_missing':'network_unproven'),removed}};
   if((current.worker_id&&!removed.includes(current.worker_id))||(current.tools_id&&!removed.includes(current.tools_id)))return {kind:'recovery' as const,recovery:{...preserved('terminal_evidence_missing'),removed}};
   if(receiptUnstarted)return {kind:'recovery' as const,recovery:{state:'released_unstarted' as const,interval:'proven_not_started' as const,grant:'released' as const,removed,replayed:false as const}};
   await this.ledger.fence(c,authority,true);
   const fresh=(await c.query(`SELECT j.*,g.state grant_state,g.physical_receipt FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[jobId,authority.contextId])).rows[0];
   if(!fresh||fresh.state!=='uncertain'||!fresh.network_id||!['reserved','uncertain'].includes(fresh.grant_state))return {kind:'recovery' as const,recovery:{...preserved('before_terminal_evidence'),removed}};
   if((fresh.worker_id&&!removed.includes(fresh.worker_id))||(fresh.tools_id&&!removed.includes(fresh.tools_id)))return {kind:'recovery' as const,recovery:{...preserved('terminal_evidence_missing'),removed}};
   let still;try{still=await read();}catch(error){if(dockerUncertain(error))return {kind:'recovery' as const,recovery:{...preserved('docker_response_lost'),removed}};throw error;}
   if(still.worker||still.tools||still.network||await this.launchPublished(jobId))return {kind:'recovery' as const,recovery:{...preserved(still.network||still.worker||still.tools?'network_or_container_remains':'terminal_evidence_missing'),removed}};
   const receipt={executionStarted:false,jobId,containerId:null,networkId:fresh.network_id,synthetic:Boolean(this.config.syntheticFixture),modelInference:false,reason:'proven_not_started'};
   const updated=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state IN ('reserved','uncertain')",[fresh.grant_id,receipt]);
   return {kind:'recovery' as const,recovery:updated.rowCount===1?{state:'released_unstarted' as const,interval:'proven_not_started' as const,grant:'released' as const,removed,replayed:false as const}:{...preserved('before_terminal_evidence'),removed}};
  }));
  if(decision.kind==='recovery'){
   if(decision.recovery.state==='released_unstarted')await this.removeLaunchFiles(jobId);
   return decision.recovery;
  }
  const worker=decision.worker,tools=decision.tools,removed:string[]=[];
  const workerExited=Boolean(worker&&worker.State.Running===false&&worker.State.Status==='exited');
  const toolsRunning=Boolean(tools&&tools.State.Running);
  const toolsExited=Boolean(tools&&tools.State.Running===false&&tools.State.Status==='exited');
  // Worker already exited while tools are still running: only reconcile may ask
  // them to stop. The grant stays until a later observation sees both exited.
  if(!workerExited||(!toolsRunning&&!toolsExited))return {...preserved('before_terminal_evidence'),removed};
  let input;try{input=await this.registeredInput(principal,authority,jobId);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {...preserved('terminal_evidence_missing'),removed};throw error;}
  try{const outcome=await this.reconcile(principal,authority,input);
   if(outcome.state==='completed'||outcome.state==='failed')return {state:'acknowledged',interval:'ack_lost',grant:'released',removed,replayed:false,receipt:outcome.receipt};
   return {...preserved(outcome.state==='running'?'before_terminal_evidence':'terminal_evidence_missing'),removed};
  }catch(error){const code=error instanceof Refusal?error.code:(error as NodeJS.ErrnoException).code;if(code==='ENOENT'||code==='NATIVE_EXECUTION_OUTPUT_INVALID'||code==='NATIVE_EXECUTION_GRANT_MISMATCH'||code==='NATIVE_FINALIZER_PHYSICAL_UNCONFIRMED')return {...preserved('terminal_evidence_missing'),removed};throw error;}
 }
}
