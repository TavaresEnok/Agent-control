/** Recovery of personal and module exams that never started: receipts, retirement bindings and physical evidence. */
import {lstat,realpath,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createPublicKey,sign,verify} from 'node:crypto';
import pg from 'pg';
import {acceptedCommandDigest,Authority,canonical,Command,digest,Refusal} from './contracts.ts';
import {DockerDaemon} from './sandbox-broker.ts';
import {assertNativeSyntheticFixture} from './native-synthetic-fixture.ts';
import {nativeContainerNeverStarted} from './native-execution-isolation.ts';
import {readPrivateWorkerFile} from './native-worker-security.ts';
import {finishExamIntentTx} from './exam-intent.ts';
import {Capacity} from './capacity.ts';
import {fenceInstallationContext} from './installation-authority-fence.ts';
import {grantLaunchLockKey,Result} from './native-execution-shared.ts';
import {Id,PreLaunchExamPhysicalReceipt,ModuleExamNeverStartedReceipt,PassiveExamModules,type ModuleExamRecoveryReason,DockerZeroTime,ModuleExamRemovalDomain,type NativeModuleExamRecovery,readonlyDesignExam,NativeExecutionRequest,type Input,type PersonalExamRecoveryScope,type ModuleExamRecoveryScope,moduleExamCompanion,retireNativePrivateNetwork,readonlySecurityExam,dockerUncertain} from './native-execution-shared.ts';
import {NativeExecutionSupervisorCore} from './native-execution-core.ts';
export abstract class NativeExecutionExamRecovery extends NativeExecutionSupervisorCore{
 protected abstract stoppedNativeContainers(row:Record<string,any>,refusal:string):Promise<string[]>;
 protected abstract removeStoppedNativeContainers(row:Record<string,any>,ids:string[],refusal:string):Promise<void>;
 protected validPreLaunchExamReceipt(physical:unknown,jobId:string,synthetic:boolean){
  const parsed=PreLaunchExamPhysicalReceipt.safeParse(physical);
  return parsed.success&&parsed.data.jobId===jobId&&parsed.data.synthetic===synthetic;
 }
 protected unstartedReceipt(job:Record<string,any>,physical:unknown){
  const payload={schemaVersion:1,accountId:job.account_id,profileId:job.profile_id,profileDigest:job.profile_digest,jobId:job.id,intentId:job.intent_id,contextId:job.context_id,grantId:job.grant_id,sessionId:job.session_id,epoch:Number(job.manager_epoch),inputDigest:job.input_digest,executorDigest:this.executorDigest,outputDigest:digest(''),physicalDigest:digest(physical),workerExitCode:1,artifact:null,exitCode:1,executionStarted:false};
  return {payload,signature:sign(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),this.key).toString('hex')};
 }
 protected verifyUnstartedReceipt(job:Record<string,any>,grant:Record<string,any>,receipt:any,contextId:string){
  const payload=receipt?.payload;
  if(!payload||typeof receipt.signature!=='string'||!/^[a-f0-9]{128}$/.test(receipt.signature)||
   !verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(receipt.signature,'hex'))||
   payload.schemaVersion!==1||payload.jobId!==job.id||payload.intentId!==job.intent_id||payload.contextId!==contextId||payload.grantId!==job.grant_id||payload.sessionId!==job.session_id||
   payload.epoch!==Number(job.manager_epoch)||payload.accountId!==job.account_id||payload.profileId!==job.profile_id||payload.profileDigest!==job.profile_digest||
   payload.inputDigest!==job.input_digest||payload.executorDigest!==job.executor_digest||payload.outputDigest!==digest('')||
   payload.executionStarted!==false||payload.exitCode!==1||payload.workerExitCode!==1||payload.artifact!==null||
   grant?.state!=='released'||!grant.physical_receipt||payload.physicalDigest!==digest(grant.physical_receipt)||
   job.state!=='failed'||job.worker_id||job.tools_id||job.network_id||job.launch_digest)
   throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');
  return payload as Record<string,any>;
 }
 protected unstartedRetirementBinding(row:Record<string,any>,receipt:unknown){
  return {schemaVersion:1,kind:'native-unstarted-retired',jobId:row.id,contextId:row.context_id,intentId:row.intent_id,grantId:row.grant_id,sessionId:row.session_id,epoch:Number(row.manager_epoch),role:row.role,inputDigest:row.input_digest,terminalDigest:digest(receipt),physicalDigest:digest(row.physical_receipt),workerId:null,toolsId:null,networkId:null,executionStarted:false};
 }
 protected async recordExamRetirement(c:pg.PoolClient,binding:{jobId:string;contextId:string}&Record<string,unknown>){
  const saved=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1 FOR UPDATE',[binding.jobId])).rows[0];
  if(saved?.state==='removed')return this.verifyUnstartedRetirement(saved,binding);
  if(!saved){
   await c.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[binding.jobId,binding]);
  }else if(saved.state!=='prepared'||digest(saved.binding)!==digest(binding)){
   throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  }
  const proof={payload:binding,signature:sign(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(binding)),this.key).toString('hex')};
  await c.query("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1 AND state='prepared'",[binding.jobId,proof]);
  await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'native.terminal_retired',$2)",[binding.contextId,{jobId:binding.jobId,proofDigest:digest(proof)}]);
 }
 protected verifyUnstartedRetirement(saved:Record<string,any>,binding:Record<string,unknown>){
  if(saved.state!=='removed'||digest(saved.binding)!==digest(binding)||!saved.proof?.payload||digest(saved.proof.payload)!==digest(binding)||
   typeof saved.proof.signature!=='string'||!/^[a-f0-9]{128}$/.test(saved.proof.signature)||
   !verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(saved.proof.payload)),createPublicKey(this.key),Buffer.from(saved.proof.signature,'hex')))
   throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
 }
 protected async launchPendingExists(jobId:string){
  const p=this.paths(jobId);
  if(await this.launchPublished(jobId))return true;
  try{
   for(const entry of await readdir(p.input)){
    if(entry==='launch.json'||entry==='launch.pending'||entry.startsWith('launch.pending.'))return true;
   }
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  return false;
 }
 protected async confirmUnstartedSpool(jobId:string){
  await this.directory(this.config.hostRoot);
  const p=this.paths(jobId);
  const stat=async(path:string)=>lstat(path).catch(error=>{
   if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
   throw error;
  });
  if(await stat(p.root)){
   await this.directory(p.root);
   if(await stat(p.input))await this.directory(p.input);
   if(await stat(p.output)){
    await this.directory(p.output);
    if((await readdir(p.output)).length)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   }
   if(await stat(join(p.root,'worker-terminal.log'))||await stat(join(p.root,'tools-terminal.log')))
    throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  }
  if(await this.launchPendingExists(jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
 }
 protected async confirmUnstartedAbsence(jobId:string){
  await this.confirmUnstartedSpool(jobId);
  const [worker,tools,network]=await Promise.all([
   this.docker.inspect('ac-native-worker-'+jobId),
   this.docker.inspect('ac-native-tools-'+jobId),
   this.docker.inspectNamedPrivateNetwork('ac-native-exec-'+jobId),
  ]);
  if(worker||tools||network)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
 }
 protected async loadUnstartedExam(c:pg.PoolClient,authority:Pick<Authority,'contextId'>,jobId:string){
  return (await c.query(`SELECT j.*,
   g.state grant_state,g.resource_kind grant_resource_kind,g.project_id grant_project_id,g.context_id grant_context_id,
   g.intent_id grant_intent_id,g.manager_epoch grant_epoch,g.account_id grant_account_id,g.profile_id grant_profile_id,
   g.role grant_role,g.physical_receipt,
   i.principal_id,i.parent_intent_id,i.state intent_state,i.command intent_command,i.digest intent_digest,i.manager_epoch intent_epoch,i.operation_id intent_operation_id,
   a.provider account_provider,a.mode account_mode,a.resource_identity account_resource_identity,
   p.model profile_model,p.effort profile_effort,p.role profile_role,
   EXISTS(SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal') personal,
   EXISTS(SELECT 1 FROM ac_exam_contexts e WHERE e.context_id=j.context_id) dedicated_context,
   (SELECT e.module FROM ac_exam_contexts e WHERE e.context_id=j.context_id) exam_module,
   EXISTS(SELECT 1 FROM ac_verify_runs r JOIN ac_exam_contexts e USING (context_id,project_id,module)
    WHERE r.context_id=j.context_id AND r.project_id=g.project_id AND
     ((r.intent_id=j.intent_id AND r.commit_id=j.base_id) OR
      (i.command->'payload'->>'messageRef'='recheck:'||r.id::text AND r.status IN ('done','failed')))) has_module_run,
   (SELECT x.id FROM ac_contexts x WHERE x.project_id=g.project_id AND NOT x.archived
     AND NOT EXISTS(SELECT 1 FROM ac_exam_contexts e WHERE e.context_id=x.id)
     ORDER BY x.created_at,x.id LIMIT 1) main_context_id,
   EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id=i.id) cancellation_requested,
   EXISTS(SELECT 1 FROM ac_operations o WHERE o.id=j.id OR o.intent_id=i.id) has_operation,
   EXISTS(SELECT 1 FROM ac_stage_operations s WHERE s.id=j.id OR s.intent_id=i.id) has_stage_operation,
   EXISTS(SELECT 1 FROM ac_native_resource_admissions r WHERE (r.job_id=j.id OR r.grant_id=g.id) AND r.state<>'canceled') has_active_admission,
   (EXISTS(SELECT 1 FROM ac_native_execution_jobs other WHERE other.intent_id=i.id AND other.id<>j.id)
    OR EXISTS(SELECT 1 FROM ac_native_qa_jobs q WHERE q.intent_id=i.id)
    OR EXISTS(SELECT 1 FROM ac_native_planning_jobs pj JOIN ac_semantic_planning_calls pc ON pc.id=pj.id WHERE pc.intent_id=i.id)) has_other_job,
   EXISTS(SELECT 1 FROM ac_intents child WHERE child.parent_intent_id=i.id) has_child_intent,
   (EXISTS(SELECT 1 FROM ac_native_execution_jobs other WHERE other.intent_id=i.id AND other.id<>j.id AND other.state IN ('uncertain','running'))
    OR EXISTS(SELECT 1 FROM ac_native_qa_jobs q WHERE q.intent_id=i.id AND q.state IN ('uncertain','running'))
    OR EXISTS(SELECT 1 FROM ac_native_planning_jobs pj JOIN ac_semantic_planning_calls pc ON pc.id=pj.id
      WHERE pc.intent_id=i.id AND pj.state IN ('prepared','uncertain','running'))) has_unresolved_job,
   EXISTS(SELECT 1 FROM ac_capacity_grants other WHERE other.intent_id=i.id AND other.id<>g.id AND other.state<>'released') has_open_grant
   FROM ac_native_execution_jobs j
   JOIN ac_capacity_grants g ON g.id=j.grant_id
   JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
   JOIN ac_accounts a ON a.id=j.account_id
   JOIN ac_profiles p ON p.id=j.profile_id AND p.account_id=a.id
   WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g,i FOR SHARE OF a,p`,[jobId,authority.contextId])).rows[0];
 }
 protected validateUnstartedExam(row:Record<string,any>|undefined,context:Record<string,any>,principal:string,authority:Authority,allowHistorical:boolean,allowRetiredExecutor=false):asserts row is Record<string,any>{
  if(!row)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
  if(!row.personal)throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
  const command=row.intent_command,payload=command?.payload,workflow=payload?.workflow;
  const design=readonlyDesignExam(workflow,row.role),security=readonlySecurityExam(workflow,row.role);
  if(row.principal_id!==principal||row.parent_intent_id!==null||(!design&&!security)||
   !['accepted','failed'].includes(row.intent_state)||row.has_operation||row.has_stage_operation||
   command?.schemaVersion!==1||command.action!=='plan.start'||command.intentId!==row.intent_id||command.contextId!==row.context_id||
   payload.projectId!==context.project_id||payload.commit!==row.base_id||digest(command)!==row.intent_digest||
   Number(row.intent_epoch)!==Number(row.manager_epoch))
   throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  if(row.cancellation_requested)throw new Refusal('PLAN_CANCELLATION_REQUESTED');
  if((!allowRetiredExecutor&&row.executor_digest!==this.executorDigest)||row.key_fingerprint!==this.fingerprint||Number(row.manager_epoch)>authority.epoch)
   throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
  if(!['uncertain','failed'].includes(row.state)||row.worker_id!==null||row.tools_id!==null||row.network_id!==null||row.launch_digest!==null||
   row.has_active_admission||row.has_open_grant||row.has_unresolved_job||row.has_child_intent||(row.state==='uncertain'&&row.receipt!==null))
   throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  if(row.grant_state!=='released'||row.grant_resource_kind!=='model'||row.grant_project_id!==context.project_id||
   row.grant_context_id!==row.context_id||row.grant_intent_id!==row.intent_id||Number(row.grant_epoch)!==Number(row.manager_epoch)||
   row.grant_account_id!==row.account_id||row.grant_profile_id!==row.profile_id||row.grant_role!==row.role)
   throw new Refusal('NATIVE_EXECUTION_GRANT_MISMATCH');
  const fixture=this.config.syntheticFixture,provider=fixture?.provider??this.config.provider??'codex';
  if(!this.subjects.has(row.account_id)||row.account_provider!==provider||row.account_mode!==(fixture?'synthetic':'subscription_cli')||
   row.account_resource_identity!==provider+':'+this.subjects.get(row.account_id)||row.profile_role!==row.role||
   this.profileDigest({account_id:row.account_id,profile_id:row.profile_id,model:row.profile_model,effort:row.profile_effort,role:row.profile_role})!==row.profile_digest)
   throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
  const physical=row.physical_receipt;
  // Only Claude exam credential preparation emits these reasons. The
  // synthetic fixture path skips that preparation entirely.
  if(provider!=='claude'||fixture||!this.validPreLaunchExamReceipt(physical,row.id,false))
   throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');
  const target=`${context.project_id}:${row.base_id}`;
  const markedExam=payload.messageRef===(design?'design-exam:':'verify:')+target;
  const historical=design&&row.role==='specialist'&&
   !row.dedicated_context&&row.context_id===row.main_context_id&&!row.has_other_job&&
   physical.reason==='exam_login_stale'&&payload.messageRef==='design:'+target;
  if(allowHistorical&&!design)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  if(!markedExam){
   if(allowHistorical&&row.has_other_job)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   if(!historical)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
   if(!allowHistorical)throw new Refusal('NATIVE_EXECUTION_HISTORICAL_CONFIRMATION_REQUIRED');
  }
  if(row.state==='failed')this.verifyUnstartedReceipt(row,{state:row.grant_state,physical_receipt:physical},row.receipt,authority.contextId);
 }
 protected async settleUnstartedExam(c:pg.PoolClient,authority:Authority,row:Record<string,any>){
  let receipt=row.receipt;
  if(row.state==='uncertain'){
   receipt=this.unstartedReceipt(row,row.physical_receipt);
   await c.query("UPDATE ac_native_execution_jobs SET state='failed',receipt=$2 WHERE id=$1",[row.id,receipt]);
  }
  await this.recordExamRetirement(c,this.unstartedRetirementBinding(row,receipt));
  await finishExamIntentTx(c,this.ledger,{intentId:row.intent_id,contextId:authority.contextId},'failed');
  return {state:'failed' as const,retirement:'removed' as const,intentState:'failed' as const,receipt};
 }
 protected async validateOptionalUnstartedRequest(jobId:string,row:Record<string,any>,allowExplicitDesign:boolean,orphanedPassive=false){
  await this.directory(this.config.hostRoot);
  const p=this.paths(jobId);
  if(!await lstat(p.root).catch(error=>{
   if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
   throw error;
  }))return;
  await this.directory(p.root);
  const bytes=await readPrivateWorkerFile(join(p.root,'request.json'),512*1024).catch(error=>{
   if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
   throw error;
  });
  if(bytes)try{
   const request=NativeExecutionRequest.parse(JSON.parse(bytes.toString('utf8')));
   if(digest(request)!==row.input_digest||request.jobId!==jobId||request.intentId!==row.intent_id||request.grantId!==row.grant_id||
    request.sessionId!==row.session_id||request.role!==row.role||request.base!==row.base_id||
    (!allowExplicitDesign&&((!orphanedPassive&&(request.model||request.effort))||request.designPurpose==='create'||request.task.startsWith('Pedido de criação.')))||
    (orphanedPassive&&request.writePaths.length!==0))
    throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
  }finally{bytes.fill(0);}
 }

 /** Reconcile an owner-scoped passive exam without taking over its manager epoch. */
 async recoverOrphanedExam(principal:string,jobId:string,scope:{contextId:string;projectId:string;repository:string},apply:boolean){
  Id.parse(jobId);
  return this.serialEffect(jobId,()=>this.ledger.tx(async c=>{
   const job=(await c.query('SELECT grant_id FROM ac_native_execution_jobs WHERE id=$1 AND context_id=$2',[jobId,scope.contextId])).rows[0];
   if(!job)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
   // Same lock as start() and the periodic grant sweep. The xact lock is held
   // on the connection that commits the job, grant and journal together.
   if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',[grantLaunchLockKey(job.grant_id)])).rows[0].ok)
    throw new Refusal('NATIVE_EXECUTION_BUSY');
   const context=await this.ledger.authorize(c,principal,scope.contextId);
   if(context.role!=='owner'||context.project_id!==scope.projectId)
    throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
   const scopedRepository=await realpath(scope.repository).catch(error=>{
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
    throw error;
   });
   if(await this.jobRepository(c,scope.projectId)!==scopedRepository)
    throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
   await fenceInstallationContext(c,scope.contextId,this.ledger.installationAuthority,true);
   // authorize holds the context anchor, which also fences acquire and heartbeat.
   // A terminal run never overrides a live lease.
   const manager=(await c.query('SELECT epoch,lease_until>clock_timestamp() AS live FROM ac_managers WHERE context_id=$1',[scope.contextId])).rows[0];
   if(manager?.live)
    throw new Refusal('NATIVE_ORPHAN_ACTIVE_LEASE');
   const row=await this.loadUnstartedExam(c,scope,jobId);
   if(!row)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
   const operations=(await c.query(`SELECT o.id,o.intent_id,o.manager_epoch,o.state,o.grant_id,o.native_session_id,
    o.handle IS NOT NULL has_handle,o.receipt IS NOT NULL has_receipt,
    EXISTS(SELECT 1 FROM ac_execution_launches l WHERE l.operation_id=o.id) has_launch
    FROM ac_operations o WHERE o.id=$1 OR o.intent_id=$2 FOR UPDATE OF o`,[jobId,row.intent_id])).rows;
   this.validateOrphanedExam(row,operations,principal,scope.projectId);
   if((!manager||Number(manager.epoch)<Number(row.manager_epoch))&&!(await c.query(
    "SELECT 1 FROM ac_verify_runs WHERE intent_id=$1 AND context_id=$2 AND project_id=$3 AND status IN ('failed','done')",
    [row.intent_id,row.context_id,scope.projectId])).rowCount)
    throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   const saved=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   if(row.state==='failed'){
    if(saved?.binding?.kind!=='native-orphaned-exam-retired'||row.grant_state!=='released')
     throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
    this.verifyUnstartedRetirement(saved,this.orphanedExamBinding(row,row.receipt));
    return 'already_recovered' as const;
   }
   if(saved)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   try{await this.validateOptionalUnstartedRequest(jobId,row,false,true);}
   catch(error){
    if(error instanceof Refusal)throw error;
    throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
   }
   const result=await this.orphanedExamResult(jobId);
   if(result&&row.physical_receipt?.executionStarted===false)throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');
   const containerRefusal='NATIVE_ORPHAN_CONTAINER_PRESENT';
   const stopped=await this.stoppedNativeContainers(row,containerRefusal);
   // A recorded worker could have started even if it never wrote a result.
   const executionStarted=Boolean(result||(row.worker_id&&row.physical_receipt?.executionStarted!==false));
   if(!executionStarted){
    if(row.state!=='uncertain'||row.grant_state==='running'||row.worker_id||row.launch_digest||
     row.physical_receipt?.executionStarted===true)
     throw new Refusal('NATIVE_EXECUTION_OUTPUT_MISSING');
    await this.confirmUnstartedSpool(jobId);
   }else{
    const input=this.paths(jobId).input;
    try{await this.directory(input);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   }
   await this.retireOrphanedExamNetwork(row,false);
   if(!apply)return 'eligible' as const;
   await this.removeStoppedNativeContainers(row,stopped,containerRefusal);
   await this.retireOrphanedExamNetwork(row,true);
   const exitCode=result?.exitCode??1;
   const failureCode=!result&&executionStarted?'NATIVE_EXAM_ORPHANED_NO_RESULT':result?.failureCode??'NATIVE_EXAM_ORPHANED';
   const physical={source:'native-orphaned-exam',jobId,containerId:row.worker_id,toolsContainerId:row.tools_id,networkId:row.network_id,
    executionStarted,exitCode,workerExitCode:exitCode,failureCode,
    resultDigest:result&&digest(result)};
   const grantPhysical=row.grant_state==='released'?row.physical_receipt:physical;
   const payload={schemaVersion:1,accountId:row.account_id,profileId:row.profile_id,profileDigest:row.profile_digest,jobId,
    intentId:row.intent_id,contextId:row.context_id,grantId:row.grant_id,sessionId:row.session_id,epoch:Number(row.manager_epoch),
    inputDigest:row.input_digest,executorDigest:row.executor_digest,outputDigest:digest(result?.output??''),physicalDigest:digest(grantPhysical),
    exitCode,workerExitCode:physical.workerExitCode,artifact:null,executionStarted,orphanedExam:true,
    resultDigest:physical.resultDigest,failureCode:physical.failureCode};
   const receipt={payload,signature:sign(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),this.key).toString('hex')};
   await new Capacity(this.ledger).releaseOrphanedNativeExamTx(c,{id:row.grant_id,state:row.grant_state},physical);
   await c.query("UPDATE ac_native_execution_jobs SET state='failed',receipt=$2 WHERE id=$1",[jobId,receipt]);
   await this.recordExamRetirement(c,this.orphanedExamBinding(row,receipt));
   // Multiple slices or reviewers can share one intent. Only close it once
   // every sibling job and reservation has been settled.
   if(!row.has_unresolved_job&&!row.has_open_grant){
    await finishExamIntentTx(c,this.ledger,{intentId:row.intent_id,contextId:scope.contextId},'failed');
   }
   if(executionStarted)await this.removeLaunchFiles(jobId);
   return 'recovered' as const;
  }));
 }

 protected validateOrphanedExam(row:Record<string,any>,operations:Record<string,any>[],principal:string,projectId:string){
  const command=row.intent_command,payload=command?.payload,module=row.exam_module;
  const target=`${projectId}:${row.base_id}`;
  const design=readonlyDesignExam(payload?.workflow,row.role)&&module==='design'&&payload?.messageRef==='design-exam:'+target;
  const security=readonlySecurityExam(payload?.workflow,row.role);
  const verify=security&&(module==='verify'||module==null)&&payload?.messageRef==='verify:'+target;
  const moduleExam=security&&PassiveExamModules.has(module)&&row.has_module_run&&(payload?.messageRef===module+':'+target||
    typeof payload?.messageRef==='string'&&payload.messageRef.startsWith('recheck:')&&Id.safeParse(payload.messageRef.slice(8)).success);
  if(!row.personal||row.principal_id!==principal||row.parent_intent_id!==null||(!design&&!verify&&!moduleExam)||
   row.has_stage_operation||row.has_child_intent||row.has_active_admission||
   command?.schemaVersion!==1||command.action!=='plan.start'||command.intentId!==row.intent_id||command.contextId!==row.context_id||
   payload.projectId!==projectId||payload.commit!==row.base_id||
   Number(row.intent_epoch)!==Number(row.manager_epoch))
   throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  if(verify){
   // Ledger.accept registers an operation for the intent. Verify launches a separate native job.
   // Only the unused registration (after the lease check), or its terminal form, is compatible.
   const parsed=Command.safeParse(command);
   const [operation]=operations;
   if(!parsed.success||acceptedCommandDigest(principal,parsed.data)!==row.intent_digest||
    operations.length!==1||operation.id!==row.intent_operation_id||operation.intent_id!==row.intent_id||
    operation.id===row.id||Number(operation.manager_epoch)!==Number(row.intent_epoch)||
    operation.grant_id!==null||operation.native_session_id!==null||operation.has_handle||operation.has_launch||
    !(operation.state==='completed'||(operation.state==='registered'&&!operation.has_receipt)))
    throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  }else if(operations.length||digest(command)!==row.intent_digest){
   throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  }
  if(row.grant_resource_kind!=='model'||row.grant_project_id!==projectId||row.grant_context_id!==row.context_id||
   row.grant_intent_id!==row.intent_id||Number(row.grant_epoch)!==Number(row.manager_epoch)||
   row.grant_account_id!==row.account_id||row.grant_profile_id!==row.profile_id||row.grant_role!==row.role||
   (row.grant_state==='released'&&!row.physical_receipt))
   throw new Refusal('NATIVE_EXECUTION_GRANT_MISMATCH');
  if(row.key_fingerprint!==this.fingerprint||!this.subjects.has(row.account_id)||this.config.syntheticFixture)
   throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
  if(!['running','uncertain','failed'].includes(row.state)||(row.state!=='failed'&&row.receipt))
   throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
 }

 protected orphanedExamBinding(row:Record<string,any>,receipt:unknown){
  return {schemaVersion:1,kind:'native-orphaned-exam-retired',jobId:row.id,contextId:row.context_id,intentId:row.intent_id,
   grantId:row.grant_id,sessionId:row.session_id,epoch:Number(row.manager_epoch),role:row.role,inputDigest:row.input_digest,
   terminalDigest:digest(receipt),workerId:row.worker_id,toolsId:row.tools_id,networkId:row.network_id};
 }

 protected async orphanedExamResult(jobId:string){
  const p=this.paths(jobId);
  try{
   await this.directory(p.root);
   await this.directory(p.output);
   const bytes=await readPrivateWorkerFile(join(p.output,'execution-result.json'),2*1024*1024);
   try{
    const result=Result.parse(JSON.parse(bytes.toString('utf8')));
    if(result.jobId!==jobId||(result.exitCode===0&&result.failureCode!==null))throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
    return result;
   }finally{bytes.fill(0);}
  }catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
   throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
  }
 }

 protected async retireOrphanedExamNetwork(row:Record<string,any>,apply:boolean){
  const name='ac-native-exec-'+row.id;
  const network=await this.docker.inspectNamedPrivateNetwork(name);
  if(network&&network.Id!==row.network_id)throw new Refusal('NATIVE_RETIREMENT_NETWORK_UNCONFIRMED');
  if(row.network_id)await retireNativePrivateNetwork(this.docker,{networkId:row.network_id,providerNetworkId:this.config.providerNetworkId,jobId:row.id,inputDigest:row.input_digest},apply);
  if(apply&&await this.docker.inspectNamedPrivateNetwork(name))throw new Refusal('NATIVE_RETIREMENT_NETWORK_UNCONFIRMED');
 }

 /** Settle a single personal exam with a durable pre-launch refusal and no physical resources. */
 async recoverUnstartedExam(principal:string,authority:Authority,jobId:string,localOwnerScope?:PersonalExamRecoveryScope){
  return this.recoverUnstartedExamWithProof(principal,authority,jobId,localOwnerScope,false);
 }
 /** Verify an already retired design attempt even when its old image pair is no longer configured. */
 async confirmRetiredUnstartedDesign(principal:string,authority:Authority,jobId:string,scope:PersonalExamRecoveryScope){
  const {state,retirement,intentState}=await this.recoverUnstartedExamWithProof(principal,authority,jobId,scope,true);
  return {state,retirement,intentState};
 }
 protected async recoverUnstartedExamWithProof(principal:string,authority:Authority,jobId:string,localOwnerScope:PersonalExamRecoveryScope|undefined,requireRetirementProof:boolean){
  Id.parse(jobId);
  return this.serialEffect(jobId,()=>this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,authority.contextId);
   if(this.config.syntheticFixture)assertNativeSyntheticFixture(this.config.syntheticFixture,this.config,{projectId:context.project_id,contextId:authority.contextId});
   await this.ledger.fence(c,authority,true);
   const repository=await this.jobRepository(c,String(context.project_id));
   if(localOwnerScope&&(context.role!=='owner'||context.project_id!==localOwnerScope.projectId||
    repository!==await realpath(localOwnerScope.repository)))
    throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
   const row=await this.loadUnstartedExam(c,authority,jobId);
   const explicitDesignWithdrawal=localOwnerScope?.explicitDesignWithdrawal===true;
   this.validateUnstartedExam(row,context,principal,authority,explicitDesignWithdrawal,requireRetirementProof);
   await this.validateOptionalUnstartedRequest(jobId,row,explicitDesignWithdrawal);
   if(row.state==='failed'&&row.intent_state==='failed'){
    const saved=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1',[jobId])).rows[0];
    if(saved?.state==='removed'){
     this.verifyUnstartedRetirement(saved,this.unstartedRetirementBinding(row,row.receipt));
     return {state:'failed' as const,retirement:'removed' as const,intentState:'failed' as const,receipt:row.receipt};
    }
   }
   if(requireRetirementProof)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await this.confirmUnstartedAbsence(jobId);
   return this.settleUnstartedExam(c,authority,row);
  }));
 }

 protected moduleExamPhysicalReceipt(row:Record<string,any>,toolsId:string){
  return {executionStarted:false,jobId:row.id,containerId:null,toolsContainerId:toolsId,networkId:row.network_id,synthetic:false,modelInference:false,moduleExam:true,reason:'module_exam_tools_create_lost'} as const;
 }
 /** Version 1 (legacy) was written before any DELETE and proves nothing about how the container went away.
  * Version 2 is written only after this supervisor's DELETE of the verified Created container was confirmed, and binds
  * the digest of that pre-removal evidence and this supervisor's removal signature; it is the only journal stage that
  * lets a resume accept an absent container. A v1 journal is promoted to v2 right after the confirmed DELETE. */
 protected moduleExamRetirementBinding(row:Record<string,any>,toolsId:string,toolsEvidenceDigest?:string){
  const base={schemaVersion:1,kind:'native-module-exam-never-started-retired',jobId:row.id,contextId:row.context_id,intentId:row.intent_id,grantId:row.grant_id,sessionId:row.session_id,epoch:Number(row.manager_epoch),role:'specialist',inputDigest:row.input_digest,toolsId,networkId:row.network_id,toolsImage:this.config.toolsImage,workerId:null,executionStarted:false,moduleExam:true};
  return toolsEvidenceDigest===undefined?base:{...base,schemaVersion:2,stage:'tools_removed',toolsEvidenceDigest};
 }
 /** The v2 stage is signed by this supervisor under its own domain over every field, so a well-formed row written by
  * anyone else (or by another key) is never accepted as proof that this supervisor removed the container. */
 protected signModuleExamRemoval(unsigned:Record<string,unknown>){
  return {...unsigned,removalSignature:sign(null,Buffer.from(ModuleExamRemovalDomain+canonical(unsigned)),this.key).toString('hex')};
 }
 /** Rebuilds the expected binding from a saved journal, or undefined if the saved one is not exactly a v1 or v2 binding of this job. */
 protected moduleExamSavedBinding(row:Record<string,any>,saved:unknown):{binding:Record<string,unknown>;toolsId:string;removalProven:boolean}|undefined{
  const value=saved as Record<string,unknown>|null|undefined,toolsId=value?.toolsId;
  if(!value||typeof value!=='object'||typeof toolsId!=='string'||!/^[a-f0-9]{64}$/.test(toolsId))return undefined;
  if(value.schemaVersion===2){
   const evidence=value.toolsEvidenceDigest,signature=value.removalSignature;
   if(typeof evidence!=='string'||!/^[a-f0-9]{64}$/.test(evidence)||typeof signature!=='string'||!/^[a-f0-9]{128}$/.test(signature))return undefined;
   const unsigned=this.moduleExamRetirementBinding(row,toolsId,evidence),binding={...unsigned,removalSignature:signature};
   if(digest(value)!==digest(binding)||
    !verify(null,Buffer.from(ModuleExamRemovalDomain+canonical(unsigned)),createPublicKey(this.key),Buffer.from(signature,'hex')))return undefined;
   return {binding,toolsId,removalProven:true};
  }
  const binding=this.moduleExamRetirementBinding(row,toolsId);
  return value.schemaVersion===1&&digest(value)===digest(binding)?{binding,toolsId,removalProven:false}:undefined;
 }
 /** What was verified about the tools container right before this supervisor removed it. */
 protected moduleExamToolsEvidence(tools:NonNullable<Awaited<ReturnType<DockerDaemon['inspect']>>>){
  const state=tools.State as Record<string,unknown>,labels=tools.Config.Labels;
  return digest({id:tools.Id,image:tools.Image,job:labels['agent-control.job'],launch:labels['agent-control.launch'],networkMode:(tools.HostConfig as Record<string,unknown>).NetworkMode,
   status:state.Status,running:state.Running,pid:state.Pid,startedAt:state.StartedAt,finishedAt:state.FinishedAt});
 }
 protected verifyModuleExamNeverStartedReceipt(job:Record<string,any>,grant:Record<string,any>,receipt:any,contextId:string){
  const payload=receipt?.payload,physical=ModuleExamNeverStartedReceipt.safeParse(grant?.physical_receipt);
  if(!physical.success||!payload||typeof receipt.signature!=='string'||
   !verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(receipt.signature,'hex'))||
   payload.schemaVersion!==1||payload.jobId!==job.id||payload.intentId!==job.intent_id||payload.contextId!==contextId||payload.grantId!==job.grant_id||payload.sessionId!==job.session_id||
   payload.epoch!==Number(job.manager_epoch)||payload.accountId!==job.account_id||payload.profileId!==job.profile_id||payload.profileDigest!==job.profile_digest||
   payload.inputDigest!==job.input_digest||payload.executorDigest!==job.executor_digest||payload.outputDigest!==digest('')||
   payload.executionStarted!==false||payload.exitCode!==1||payload.workerExitCode!==1||payload.artifact!==null||
   grant.state!=='released'||payload.physicalDigest!==digest(grant.physical_receipt)||
   physical.data.jobId!==job.id||physical.data.toolsContainerId!==job.tools_id||physical.data.networkId!==job.network_id||
   job.state!=='failed'||job.worker_id||job.launch_digest)
   throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');
  return payload as Record<string,any>;
 }
 /** The spool of a never-started attempt holds the private request and nothing a worker could have written. */
 protected async moduleExamSpoolEvidence(row:Record<string,any>,jobId:string):Promise<ModuleExamRecoveryReason|undefined>{
  try{
   await this.directory(this.config.hostRoot);
   const p=this.paths(jobId);
   await this.directory(p.root);
   const bytes=await readPrivateWorkerFile(join(p.root,'request.json'),512*1024).catch(error=>{
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw error;
   });
   if(!bytes)return 'request_unproven';
   let request:Input;
   try{request=NativeExecutionRequest.parse(JSON.parse(bytes.toString('utf8')));}catch{return 'request_unproven';}finally{bytes.fill(0);}
   const moduleExam=request.moduleExam;
   if(!moduleExam||digest(request)!==row.input_digest||request.jobId!==jobId||request.intentId!==row.intent_id||request.grantId!==row.grant_id||
    request.sessionId!==row.session_id||request.role!=='specialist'||request.base!==row.base_id||
    moduleExam.accountId!==row.account_id||moduleExam.profileId!==row.profile_id||moduleExam.model!==row.profile_model)
    return 'request_unproven';
   if(await this.launchPendingExists(jobId))return 'launch_present';
   const stat=async(path:string)=>lstat(path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
   if(await stat(p.output)){
    await this.directory(p.output);
    if((await readdir(p.output)).length)return 'spool_touched';
   }
   if(await stat(join(p.root,'worker-terminal.log'))||await stat(join(p.root,'tools-terminal.log')))return 'spool_touched';
   return undefined;
  }catch(error){
   if(error instanceof Refusal&&error.code==='NATIVE_EXECUTION_DIRECTORY_UNSAFE')return 'request_unproven';
   if(error instanceof Refusal&&error.code==='NATIVE_EXECUTION_LAUNCH_UNCERTAIN')return 'launch_present';
   if(['ENOENT','ENOTDIR','ELOOP','EACCES'].includes(String((error as NodeJS.ErrnoException).code)))return 'request_unproven';
   throw error;
  }
 }
 /** Same identity the launch created: image, labels, private network, hardening and an empty mount list. */
 protected moduleExamToolsMatches(tools:NonNullable<Awaited<ReturnType<DockerDaemon['inspect']>>>,row:Record<string,any>,jobId:string):ModuleExamRecoveryReason|undefined{
  const same=(value:unknown,expected:readonly string[])=>Array.isArray(value)&&value.length===expected.length&&expected.every((item,index)=>value[index]===item);
  const empty=(value:unknown)=>value==null||(Array.isArray(value)&&value.length===0);
  const host=tools.HostConfig as Record<string,any>,labels=tools.Config.Labels;
  if(tools.Image!==this.config.toolsImage||labels['agent-control.job']!==jobId||labels['agent-control.launch']!==row.input_digest||labels['agent-control.contract']!=='native-execution-v1'||
   tools.Config.User!==this.user||!same(tools.Config.Entrypoint,moduleExamCompanion)||!empty(tools.Config.Cmd)||tools.Config.WorkingDir!=='/'||
   host.NetworkMode!==row.network_id||host.ReadonlyRootfs!==true||host.Privileged!==false||!Array.isArray(host.CapDrop)||!host.CapDrop.includes('ALL')||
   !Array.isArray(host.SecurityOpt)||!host.SecurityOpt.some((item:unknown)=>item==='no-new-privileges'||item==='no-new-privileges:true')||!empty(host.CapAdd)||!empty(host.Devices)||
   Object.keys(host.PortBindings??{}).length!==0||tools.Mounts.length!==0)return 'tools_mismatch';
  const state=tools.State as Record<string,unknown>;
  if(!nativeContainerNeverStarted(state)||state.StartedAt!==DockerZeroTime||state.FinishedAt!==DockerZeroTime)return 'tools_started';
  return undefined;
 }
 /** Locks and judges one never-started passive module-exam attempt. Every verdict other than `ready` or a verified replay keeps the grant. */
 protected async moduleExamEvidence(c:pg.PoolClient,principal:string,authority:Authority,jobId:string,scope:ModuleExamRecoveryScope){
  const context=await this.ledger.authorize(c,principal,authority.contextId);
  if(this.config.syntheticFixture)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  await this.ledger.fence(c,authority,true);
  const repository=await this.jobRepository(c,String(context.project_id));
  if(context.role!=='owner'||context.project_id!==scope.projectId||repository!==await realpath(scope.repository))throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  const row=(await c.query(`SELECT j.*,
   g.state grant_state,g.resource_kind grant_resource_kind,g.project_id grant_project_id,g.context_id grant_context_id,
   g.intent_id grant_intent_id,g.manager_epoch grant_epoch,g.account_id grant_account_id,g.profile_id grant_profile_id,g.role grant_role,g.physical_receipt,
   i.principal_id,i.parent_intent_id,i.state intent_state,i.command intent_command,i.digest intent_digest,
   a.provider account_provider,a.mode account_mode,a.resource_identity account_resource_identity,
   p.model profile_model,p.effort profile_effort,p.role profile_role,
   EXISTS(SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal') personal,
   EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id=i.id) cancellation_requested,
   EXISTS(SELECT 1 FROM ac_operations o WHERE o.id=j.id OR o.intent_id=i.id) has_operation,
   EXISTS(SELECT 1 FROM ac_stage_operations s WHERE s.id=j.id OR s.intent_id=i.id) has_stage_operation,
   EXISTS(SELECT 1 FROM ac_intents child WHERE child.parent_intent_id=i.id) has_child_intent,
   (EXISTS(SELECT 1 FROM ac_native_execution_jobs other WHERE other.intent_id=i.id AND other.id<>j.id AND other.state IN ('uncertain','running'))
    OR EXISTS(SELECT 1 FROM ac_native_qa_jobs q WHERE q.intent_id=i.id AND q.state IN ('uncertain','running'))
    OR EXISTS(SELECT 1 FROM ac_native_planning_jobs pj JOIN ac_semantic_planning_calls pc ON pc.id=pj.id
      WHERE pc.intent_id=i.id AND pj.state IN ('prepared','uncertain','running'))) has_unresolved_job,
   EXISTS(SELECT 1 FROM ac_capacity_grants other WHERE other.intent_id=i.id AND other.id<>g.id AND other.state<>'released') has_open_grant
   FROM ac_native_execution_jobs j
   JOIN ac_capacity_grants g ON g.id=j.grant_id
   JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
   JOIN ac_accounts a ON a.id=j.account_id
   JOIN ac_profiles p ON p.id=j.profile_id AND p.account_id=a.id
   WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g,i FOR SHARE OF a,p`,[jobId,authority.contextId])).rows[0];
  if(!row)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
  if(!row.personal)throw new Refusal('PERSONAL_ACTIVATION_REQUIRED',403);
  const command=row.intent_command,payload=command?.payload;
  const run=(await c.query('SELECT * FROM ac_verify_runs WHERE intent_id=$1 FOR UPDATE',[row.intent_id])).rows[0];
  if(row.principal_id!==principal||row.parent_intent_id!==null||!readonlySecurityExam(payload?.workflow,row.role)||row.role!=='specialist'||
   command?.schemaVersion!==1||command.action!=='plan.start'||command.intentId!==row.intent_id||command.contextId!==row.context_id||
   payload.projectId!==context.project_id||payload.commit!==row.base_id||digest(command)!==row.intent_digest||
   row.has_operation||row.has_stage_operation||row.has_child_intent||
   !run||run.project_id!==context.project_id||run.context_id!==row.context_id||run.commit_id!==row.base_id||!PassiveExamModules.has(String(run.module))||
   !(await c.query('SELECT 1 FROM ac_exam_contexts e WHERE e.project_id=$1 AND e.module=$2 AND e.context_id=$3',[run.project_id,run.module,row.context_id])).rowCount)
   throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  if(row.cancellation_requested)throw new Refusal('PLAN_CANCELLATION_REQUESTED');
  if(Number(row.manager_epoch)>authority.epoch)throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
  if(row.grant_resource_kind!=='model'||row.grant_project_id!==context.project_id||row.grant_context_id!==row.context_id||row.grant_intent_id!==row.intent_id||
   Number(row.grant_epoch)!==Number(row.manager_epoch)||row.grant_account_id!==row.account_id||row.grant_profile_id!==row.profile_id||row.grant_role!==row.role)
   throw new Refusal('NATIVE_EXECUTION_GRANT_MISMATCH');
  const provider=this.config.provider;
  if((provider!=='claude'&&provider!=='codex')||!this.subjects.has(row.account_id)||row.account_provider!==provider||row.account_mode!=='subscription_cli'||
   row.account_resource_identity!==provider+':'+this.subjects.get(row.account_id)||row.profile_role!==row.role||
   this.profileDigest({account_id:row.account_id,profile_id:row.profile_id,model:row.profile_model,effort:row.profile_effort,role:row.profile_role})!==row.profile_digest)
   throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
  const keep=(reason:ModuleExamRecoveryReason,removed:string[]=[])=>({kind:'preserved' as const,recovery:{state:'preserved' as const,reason,grant:(row.grant_state==='released'?'released':'preserved') as 'released'|'preserved',removed,replayed:false}});
  if(row.key_fingerprint!==this.fingerprint||row.executor_digest!==this.executorDigest)return keep('supervisor_identity');
  const journal=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0] as Record<string,any>|undefined;
  const toolsName='ac-native-tools-'+jobId,workerName='ac-native-worker-'+jobId,networkName='ac-native-exec-'+jobId;
  try{
   if(row.state==='failed'){
    // Replay: only a receipt and journal this supervisor signed, with every physical resource still gone.
    if(!row.tools_id||journal?.state!=='removed'||row.grant_state!=='released'||!ModuleExamNeverStartedReceipt.safeParse(row.physical_receipt).success)return keep('job_state');
    this.verifyModuleExamNeverStartedReceipt(row,{state:row.grant_state,physical_receipt:row.physical_receipt},row.receipt,authority.contextId);
    const savedBinding=this.moduleExamSavedBinding(row,journal.binding);
    if(!savedBinding||savedBinding.toolsId!==row.tools_id)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
    this.verifyUnstartedRetirement(journal,savedBinding.binding);
    const [tools,byId,worker,network,named]=await Promise.all([this.docker.inspect(toolsName),this.docker.inspect(row.tools_id),this.docker.inspect(workerName),this.docker.inspectPrivateNetwork(row.network_id),this.docker.inspectNamedPrivateNetwork(networkName)]);
    if(tools||byId||worker||network||named)return keep('residual_resources');
    return {kind:'retired' as const,recovery:{state:'retired' as const,reason:'proven_never_started' as const,grant:'released' as const,removed:[],replayed:true,receipt:row.receipt}};
   }
   if(!['done','failed'].includes(row.intent_state)||run.status==='running')return keep('intent_open');
   if(row.state!=='uncertain')return keep('job_state');
   if(!['reserved','uncertain'].includes(row.grant_state))return keep('grant_state');
   if(row.has_unresolved_job||row.has_open_grant)return keep('sibling_unresolved');
   if(row.worker_id!==null||row.launch_digest!==null||row.receipt!==null)return keep('journal_started');
   // Only the lost create response is in scope: the launch never recorded a tools ID. A recorded ID means the create
   // was answered and the launch stopped later, which this recovery does not judge.
   if(row.tools_id!==null)return keep('tools_registered');
   if(!row.network_id||row.network_id===this.config.providerNetworkId)return keep('network_unproven');
   const spool=await this.moduleExamSpoolEvidence(row,jobId);
   if(spool)return keep(spool);
   let saved:ReturnType<NativeExecutionExamRecovery['moduleExamSavedBinding']>;
   if(journal){
    saved=journal.state==='prepared'?this.moduleExamSavedBinding(row,journal.binding):undefined;
    if(!saved)return keep('retirement_conflict');
   }
   const [tools,worker,network,named]=await Promise.all([this.docker.inspect(toolsName),this.docker.inspect(workerName),this.docker.inspectPrivateNetwork(row.network_id),this.docker.inspectNamedPrivateNetwork(networkName)]);
   if(worker)return keep('worker_present');
   if(tools){
    // A container this supervisor already removed cannot be back under the same name.
    if(saved?.removalProven)return keep('retirement_conflict');
    if(saved&&tools.Id!==saved.toolsId)return keep('tools_mismatch');
    const bad=this.moduleExamToolsMatches(tools,row,jobId);
    if(bad)return keep(bad);
   }else if(!saved)return keep('tools_absent');
   else if(!saved.removalProven)return keep('removal_unproven');
   else{
    const byId=await this.docker.inspect(saved.toolsId);
    if(byId)return keep('retirement_conflict');
   }
   if(network){
    const labels=network.Labels,attached=network.Containers;
    if(network.Id!==row.network_id||network.Name!==networkName||network.Internal!==true||!labels||labels['agent-control.contract']!=='native-execution-v1'||
     labels['agent-control.job']!==jobId||labels['agent-control.launch']!==row.input_digest||named?.Id!==network.Id)return keep('network_mismatch');
    if(attached!=null&&(typeof attached!=='object'||Array.isArray(attached)||Object.keys(attached).length!==0))return keep('network_attached');
   }else if(named||!saved?.removalProven)return keep(named?'network_mismatch':'network_unproven');
   return {kind:'ready' as const,row,tools:tools??null,toolsId:tools?.Id??saved!.toolsId,journal,saved,keep};
  }catch(error){
   if(dockerUncertain(error))return keep('docker_uncertain');
   throw error;
  }
 }
 /** Retire one passive module-exam attempt whose Docker create response was lost and which Docker proves never started.
  * It only removes that attempt's Created tools container and empty private network, settles its job and grant, and
  * writes a signed journal. It never creates or starts a container, never launches a model and never touches the intent. */
 async recoverNeverStartedModuleExam(principal:string,authority:Authority,jobId:string,scope:ModuleExamRecoveryScope):Promise<NativeModuleExamRecovery>{
  Id.parse(jobId);
  return this.serialEffect(jobId,async()=>{
   const removed:string[]=[];
   // Transaction 1: remove the verified Created tools container and COMMIT this supervisor's signed removal stage
   // before anything else is touched. A failure before the confirmed DELETE writes no stage and keeps the grant.
   const first=await this.ledger.tx(async c=>{
    const evidence=await this.moduleExamEvidence(c,principal,authority,jobId,scope);
    if(evidence.kind!=='ready')return evidence.recovery;
    if(evidence.journal?.state==='removed')return evidence.keep('retirement_conflict').recovery;
    if(!evidence.tools)return undefined;
    const {row,toolsId}=evidence;
    try{
     await this.ledger.fence(c,authority,true);
     const live=await this.docker.inspect('ac-native-tools-'+jobId);
     if(!live||live.Id!==toolsId)return evidence.keep('tools_mismatch').recovery;
     const bad=this.moduleExamToolsMatches(live,row,jobId);
     if(bad)return evidence.keep(bad).recovery;
     const toolsEvidence=this.moduleExamToolsEvidence(live);
     await this.docker.remove(live.Id);removed.push(live.Id);
     const [byName,byId]=await Promise.all([this.docker.inspect('ac-native-tools-'+jobId),this.docker.inspect(toolsId)]);
     if(byName||byId)return evidence.keep('residual_resources',removed).recovery;
     // The stage that proves the removal is written only now, after the confirmed DELETE, and committed on its own.
     // A legacy v1 journal (written before any DELETE) is promoted to the same signed stage, guarded on the exact saved row.
     const signed=this.signModuleExamRemoval(this.moduleExamRetirementBinding(row,toolsId,toolsEvidence));
     if(!evidence.journal){
      await c.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[jobId,signed]);
     }else{
      if(evidence.saved?.removalProven!==false||evidence.saved.toolsId!==toolsId)return evidence.keep('retirement_conflict',removed).recovery;
      const promoted=await c.query("UPDATE ac_native_terminal_retirements SET binding=$2 WHERE job_id=$1 AND state='prepared' AND proof IS NULL AND binding=$3::jsonb",[jobId,signed,JSON.stringify(evidence.saved.binding)]);
      if(promoted.rowCount!==1)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
     }
     await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'native.module_exam_tools_removed',$2)",[authority.contextId,{jobId,toolsId,networkId:row.network_id,toolsEvidenceDigest:toolsEvidence,promotedLegacy:Boolean(evidence.journal)}]);
     return undefined;
    }catch(error){
     if(dockerUncertain(error))return evidence.keep('docker_uncertain',removed).recovery;
     throw error;
    }
   });
   if(first)return first;
   // Transaction 2, still serialized on this job: re-read authority, the committed signed stage, the absence of both
   // containers and the network's identity and state, then remove what is left and release the grant. A crash here
   // leaves the committed stage, so a retry on any connection can conclude.
   return this.ledger.tx(async c=>{
    const evidence=await this.moduleExamEvidence(c,principal,authority,jobId,scope);
    if(evidence.kind!=='ready')return evidence.recovery.replayed?evidence.recovery:{...evidence.recovery,removed:[...removed]};
    if(evidence.journal?.state!=='prepared'||evidence.tools||!evidence.saved?.removalProven)return evidence.keep('retirement_conflict',removed).recovery;
    const {row,toolsId}=evidence,binding=evidence.saved.binding;
    try{
     await this.ledger.fence(c,authority,true);
     const [byName,byId,worker]=await Promise.all([this.docker.inspect('ac-native-tools-'+jobId),this.docker.inspect(toolsId),this.docker.inspect('ac-native-worker-'+jobId)]);
     if(byName||byId||worker)return evidence.keep('residual_resources',removed).recovery;
     await retireNativePrivateNetwork(this.docker,{networkId:row.network_id,providerNetworkId:this.config.providerNetworkId,jobId,inputDigest:row.input_digest});
    }catch(error){
     if(dockerUncertain(error))return evidence.keep('docker_uncertain',removed).recovery;
     if(error instanceof Refusal&&error.code==='NATIVE_RETIREMENT_NETWORK_UNCONFIRMED')return evidence.keep('network_mismatch',removed).recovery;
     throw error;
    }
    await this.ledger.fence(c,authority,true);
    if(await this.launchPendingExists(jobId))return evidence.keep('launch_present',removed).recovery;
    const physical=this.moduleExamPhysicalReceipt(row,toolsId),receipt=this.unstartedReceipt(row,physical);
    const proof={payload:binding,signature:sign(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(binding)),this.key).toString('hex')};
    const job=await c.query("UPDATE ac_native_execution_jobs SET state='failed',receipt=$2,tools_id=$3 WHERE id=$1 AND state='uncertain' AND worker_id IS NULL AND tools_id IS NULL AND launch_digest IS NULL AND receipt IS NULL",[jobId,receipt,toolsId]);
    const grant=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state IN ('reserved','uncertain')",[row.grant_id,physical]);
    const closed=await c.query("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1 AND state='prepared'",[jobId,proof]);
    if(job.rowCount!==1||grant.rowCount!==1||closed.rowCount!==1)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'native.module_exam_never_started_retired',$2)",[authority.contextId,{jobId,toolsId,networkId:row.network_id,proofDigest:digest(proof)}]);
    return {state:'retired' as const,reason:'proven_never_started' as const,grant:'released' as const,removed,replayed:false,receipt};
   });
  });
 }
}
