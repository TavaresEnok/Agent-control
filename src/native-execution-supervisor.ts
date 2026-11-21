import {assertDiskSpaceForLaunch} from './personal-disk.ts';
import {pinRetainedArtifact} from './native-work-retention.ts';
import {moduleExamSocket,startModuleExamEgress} from './module-exam-egress.ts';
import {requiredDesignProfile} from './design-model-reservation.ts';
import {assertModelAllowed} from './model-policy.ts';
import {assertNoNativeTaskSecrets} from './native-execution-redaction.ts';
import {writeNativeSecretSnapshot,readNativeArtifactSecrets} from './native-execution-secret-snapshot.ts';
import {collectSecretValues} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {assertCodexSubscriptionIdentity,readMountedCredentialSecrets} from './native-worker-security.ts';
import {requireProjectEnvironmentLaunch} from './project-environments.ts';
import {pinNativeProtocolForNewAttempt} from './native-protocol-compatibility.ts';
import {requireRecoveryInventory} from './recovery-inventory.ts';
import {cancelPreparedNativeResources,admitNativeResources} from './native-resource-envelope.ts';
import {mkdir,lstat,realpath,writeFile,rename,cp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {sign,createHmac,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {Authority,canonical,digest,Refusal} from './contracts.ts';
import {stageDesignCapturesForJob} from './design-capture-stage.ts';
import {AccountHomes} from './account-homes.ts';
import {ProviderEligibility} from './provider-eligibility.ts';
import {GitArtifacts} from './git.ts';
import {NativeArtifactIdentity} from './native-artifact-finalizer.ts';
import {expectedArtifactRisk,type Quality} from './quality.ts';
import {inspectNativeExecutionPair,dockerReadOnly} from './native-execution-docker-observation.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {replaceSecretClassFiles} from './verify-redact.ts';
import {rememberExamStripNote} from './exam-strip-note.ts';
import {reviewDiffDocument} from './review-diff.ts';
import {describeBind,examAccountMount,examWorkerEnv,formatExamStripNote,stripExamHostileConfig} from './verify-exam-isolation.ts';
import {postgresAccountLoginLock,prepareClaudeExamAccessToken,renewClaudeLoginInPlace,safeFailureCode} from './exam-login.ts';
import {nativeReviewMapScope,nativeTaskWithRepoMap} from './native-repo-map.ts';
import {Id,PreLaunchExamReason,withGrantLaunchLock,UnstartedExamRetirementPending,readonlyDesignExam,NativeExecutionRequest,toolsEntrypoint,moduleExamCompanion,workerEntrypoint,retireNativePrivateNetwork,readonlySecurityExam,readonlyExamIsolation,stageDesignExamCaptures} from './native-execution-shared.ts';
import {NativeExecutionTerminalWork} from './native-execution-terminal-work.ts';
export {ModuleExamRecoveryPreserved,terminalWorkClass,terminalWorkLockKey,grantLaunchLockKey,openGrantLaunchLockSession,tryGrantLaunchLock,releaseGrantLaunchLock,withGrantLaunchLock,UnstartedExamRetirementPending,readonlyDesignExam,NativeExecutionRequest,retireNativePrivateNetwork,readonlySecurityExam,readonlyExamIsolation,stageDesignExamCaptures} from './native-execution-shared.ts';
export type {ModuleExamRecoveryReason,NativeModuleExamRecovery,ModuleExamWorkRefusal,ModuleExamWorkRelease,TerminalWorkCategory,TerminalWorkRefusal,TerminalWorkRelease,TerminalWorkObserver,NativeExecutionSupervisorConfig,NativeExecutionOutcome,NativeExecutionRecovery} from './native-execution-shared.ts';
/** Effect supervisor only. A trusted Cezar stage must already own the grant,
 * frozen source and policy. No scheduler, inference on construction, fallback,
 * approval or Git integration occurs here. Production bootstrap does not construct
 * this supervisor; configured opt-in stays activation-blocked. */
export class NativeExecutionSupervisor extends NativeExecutionTerminalWork{
 /** The launch holds the grant's launch lock from the first check to the running state, so a recovery sweep never frees a reservation that is being prepared. */
 async start(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>,signal?:AbortSignal){
  const requested=NativeExecutionRequest.parse(raw);
  return withGrantLaunchLock(this.ledger,requested.grantId,()=>this.startLocked(principal,authority,raw,signal));
 }
 private async startLocked(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>,signal?:AbortSignal){
  const input=NativeExecutionRequest.parse(raw),hash=digest(input),prior=(await this.ledger.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1',[input.jobId])).rows[0];
  if(prior){await this.validateReplay(principal,authority,input,prior);return this.reconcile(principal,authority,input);}
  await assertDiskSpaceForLaunch([...(this.ledger.launchVolumes??[]),this.config.hostRoot,this.config.accountRoot]);
  if(!this.active)throw new Refusal('NATIVE_EXECUTOR_RETIRED');
  const checkAbort=()=>{if(signal?.aborted)throw new Refusal('EXAM_INTERRUPTED');};
  checkAbort();
  const g=await this.ledger.tx(async c=>{const grant=await this.identity(c,principal,authority,input);assertModelAllowed(grant.model);
   // This path creates a private network outside the fenced resource bridge.
   if(await requireRecoveryInventory(c,this.ledger))throw new Refusal('RECOVERY_EFFECT_NOT_INSTRUMENTED');
   // identity/scope validates an issued WeakSet synthetic capability. A JSON
   // flag cannot reach this bypass. Real attempts pin compatibility before any
   // aggregate slot, file preparation, Docker network or group is created.
   if(!this.config.syntheticFixture&&!await c.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'").then(r=>Boolean(r.rowCount)))await pinNativeProtocolForNewAttempt(c,{kind:'execution',jobId:input.jobId,executorDigest:this.executorDigest,model:grant.model,effort:grant.effort});
   return grant;
  });
  const synthetic=Boolean(this.config.syntheticFixture);
  const releaseBeforeLaunch=async(reason:string)=>{
   const receipt={executionStarted:false,jobId:input.jobId,containerId:null,networkId:null,synthetic,modelInference:false,reason};
   const shouldSettle=await this.ledger.tx(async c=>{
    const context=await this.scope(c,principal,authority,input,true);
    const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
    if(!grant||grant.context_id!==authority.contextId||grant.intent_id!==input.intentId||Number(grant.manager_epoch)!==authority.epoch||!['reserved','uncertain'].includes(grant.state))throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
    if(grant.state==='reserved'){
     await this.identity(c,principal,authority,input,!input.moduleExam);
    }else{
     const job=(await c.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1 FOR UPDATE',[input.jobId])).rows[0];
     if(!job||job.state!=='uncertain'||job.worker_id||job.tools_id||job.network_id||job.launch_digest||
      job.grant_id!==input.grantId||job.intent_id!==input.intentId||job.context_id!==authority.contextId||
      job.session_id!==input.sessionId||job.role!==input.role||Number(job.manager_epoch)!==authority.epoch||
      job.input_digest!==hash||job.executor_digest!==this.executorDigest||job.key_fingerprint!==this.fingerprint||
      grant.project_id!==context.project_id||grant.account_id!==job.account_id||grant.profile_id!==job.profile_id||grant.role!==job.role)
      throw new Refusal('NATIVE_EXECUTION_RECONCILE_REQUIRED');
     await cancelPreparedNativeResources(c,this.docker,input.jobId,input.grantId,authority);
    }
    await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state IN ('reserved','uncertain')",[input.grantId,receipt]);
    // The live call has the original request. Limit automatic settlement to
    // exam login refusals that immediately terminate the caller's exam.
    return grant.state==='uncertain'&&PreLaunchExamReason.safeParse(reason).success&&!input.model&&!input.effort&&input.designPurpose!=='create'&&!input.task.startsWith('Pedido de criação.');
   });
   if(!shouldSettle)return;
   // Commit the physical receipt before settlement so maintenance can retry
   // even if inspection, a settlement write or its commit fails.
   try{
    await this.ledger.tx(async c=>{
     const context=await this.scope(c,principal,authority,input,true);
     const row=await this.loadUnstartedExam(c,authority,input.jobId);
     this.validateUnstartedExam(row,context,principal,authority,false);
     if(row.input_digest!==hash||row.grant_id!==input.grantId)throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
     await this.jobRepository(c,String(context.project_id));
     await this.confirmUnstartedAbsence(input.jobId);
     await this.settleUnstartedExam(c,authority,row);
    });
   }catch(error){
    const code=safeFailureCode(error instanceof Refusal?error.code:(error as NodeJS.ErrnoException)?.code,'NATIVE_PRELAUNCH_SETTLEMENT_FAILED');
    console.error(JSON.stringify({event:'NATIVE_PRELAUNCH_SETTLEMENT_PENDING',jobId:input.jobId,code}));
    throw new UnstartedExamRetirementPending(input.jobId);
   }
  };
  const p=this.paths(input.jobId);
  let jobDirCreated=false;
  const failBeforeLaunch=async(reason:string)=>{
   try{
    await releaseBeforeLaunch(reason);
   }catch(releaseError){
    if(releaseError instanceof UnstartedExamRetirementPending)throw releaseError;
    const code=safeFailureCode(releaseError instanceof Refusal?releaseError.code:(releaseError as NodeJS.ErrnoException)?.code,'NATIVE_RELEASE_BEFORE_LAUNCH_FAILED');
    console.error(JSON.stringify({event:'NATIVE_RELEASE_BEFORE_LAUNCH_FAILED',jobId:input.jobId,reason,code}));
    throw releaseError;
   }finally{
    if(jobDirCreated)await rm(p.root,{recursive:true,force:true}).catch(()=>undefined/* best-effort removal of a job dir that never launched */);
   }
  };
  let personal=false;
  let assessment:Awaited<ReturnType<ProviderEligibility['view']>>['latest']|undefined;
  let envSecrets:string[]=[];
  let accountSecrets:string[]=[];
  const accountRoot=join(this.config.accountRoot,g.account_id);
  let examWorkflowEarly:unknown;
  let claudeExam=false;
  let imagesPresent=false;
  try{
   personal=!synthetic&&Boolean((await this.ledger.pool.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'")).rowCount);
   assessment=personal?undefined:(await new ProviderEligibility(this.ledger).view(principal,g.project_id,g.account_id,1)).latest;
   if(!personal&&(!assessment?.fresh||assessment.effectiveStatus!=='documented_supported'||assessment.authenticationMode!==(synthetic?'synthetic':'subscription_oauth')||assessment.executionMode!==(synthetic?'synthetic':'central_isolated_cli')||assessment.adapterId!==this.config.id||assessment.adapterVersion!==this.executorDigest))throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
   await new AccountHomes(this.ledger,this.config.accountRoot,this.config.protectedRepositories).inspectGranted(principal,input.grantId,authority);
   envSecrets=(input.moduleExam?[]:[...this.config.workerEnv,...this.config.toolsEnv]).flatMap(entry=>{const index=entry.indexOf('=');return index<0?[]:collectSecretValues({[entry.slice(0,index)]:entry.slice(index+1)});});
   examWorkflowEarly=(await this.ledger.pool.query('SELECT command FROM ac_intents WHERE id=$1',[input.intentId])).rows[0]?.command?.payload?.workflow;
   claudeExam=!synthetic&&readonlyExamIsolation(personal,examWorkflowEarly,input.role)&&this.config.provider==='claude';
   if(!claudeExam){
    if(input.moduleExam){
     const codexHome=join(accountRoot,'.codex'), info=await lstat(codexHome);
     if(!info.isDirectory()||info.isSymbolicLink()||await realpath(codexHome)!==codexHome)throw new Refusal('EXAM_LOGIN_STALE');
     accountSecrets=(await assertCodexSubscriptionIdentity(this.subjects.get(g.account_id)!,accountRoot)).secrets;
    }
    else if(!synthetic)accountSecrets=personal?await readMountedCredentialSecrets(this.config.provider??'codex',accountRoot):(await assertCodexSubscriptionIdentity(this.subjects.get(g.account_id)!,accountRoot)).secrets;
    else{
     // Synthetic fixtures may opt into the production worker with synthetic
     // auth; older deterministic substitute workers have no auth file.
     let present=true;try{await lstat(join(accountRoot,'.codex','auth.json'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')present=false;else throw error;}
     if(present)accountSecrets=(await assertCodexSubscriptionIdentity(this.subjects.get(g.account_id)!,accountRoot)).secrets;
    }
    assertNoNativeTaskSecrets(input.task,[...envSecrets,...accountSecrets]);
   }
   await this.diskGuard?.assertAdmission();
   await this.directory(this.config.hostRoot);
   imagesPresent=Boolean((await this.docker.imagePresent(this.config.workerImage))&&(await this.docker.imagePresent(this.config.toolsImage)));
  }catch(error){
   await failBeforeLaunch(error instanceof Refusal&&error.code==='NATIVE_EXECUTION_SECRET_IN_TASK'?'secret_in_task':'pre_launch_failed');
   throw error;
  }
  if(!imagesPresent){
   await failBeforeLaunch('native_image_missing');
   throw new Refusal('NATIVE_IMAGE_MISSING');
  }
  // The grant carries the authorized design purpose. Prompt text is not an authorization signal.
  const askedModel=input.model!==undefined||input.effort!==undefined;
  const designCreate=personal&&input.role==='specialist'&&examWorkflowEarly==='design-readonly-v1'&&input.designPurpose==='create';
  try{
   if(input.designPurpose&&!(personal&&readonlyDesignExam(examWorkflowEarly,input.role)))throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE');
   if(askedModel&&(!designCreate||input.model!=='claude-opus-5-5'||input.effort!=='high'))throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE');
   checkAbort();
   await admitNativeResources({docker:this.docker,ledger:this.ledger,principal,authority,intentId:input.intentId,grantId:input.grantId,jobId:input.jobId,names:['ac-native-tools-'+input.jobId,'ac-native-worker-'+input.jobId]});
   // Commit the uncertainty before files, Docker networks or processes exist.
   await this.ledger.tx(async c=>{const current=await this.identity(c,principal,authority,input);assertModelAllowed(current.model);
    if(personal && readonlyDesignExam(examWorkflowEarly,input.role)){
     const purpose=input.designPurpose;
     if(!purpose||current.selection?.designPurpose!==purpose)throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE');
     const profile=await requiredDesignProfile(c,authority.contextId,purpose);
     if(this.config.provider!=='claude'||current.profile_id!==profile.id||current.account_id!==profile.account||
        current.model!==profile.model||current.effort!==profile.effort)throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE');
    }
    if(!synthetic&&!await c.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'").then(r=>Boolean(r.rowCount)))await pinNativeProtocolForNewAttempt(c,{kind:'execution',jobId:input.jobId,executorDigest:this.executorDigest,model:current.model,effort:current.effort});
    if(input.role==='programmer')await requireProjectEnvironmentLaunch(c,{intentId:input.intentId,base:input.base});
    await c.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,executor_digest,key_fingerprint,input_digest,base_id,role,account_id,profile_id,profile_digest,eligibility_revision,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'uncertain')`,[input.jobId,input.grantId,input.intentId,authority.contextId,authority.epoch,input.sessionId,this.executorDigest,this.fingerprint,hash,input.base,input.role,g.account_id,g.profile_id,this.profileDigest(g),assessment?.revision??1]);
    await c.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[input.grantId]);
    if(input.role==='programmer')await c.query("UPDATE ac_operations SET state='uncertain',native_session_id=$2 WHERE id=$1",[input.jobId,input.sessionId]);
    else if((input.role!=='specialist'&&input.role!=='reviewer')||!await this.personalReadonlyExam(c,input.intentId,input.role))await c.query("UPDATE ac_stage_operations SET state='uncertain' WHERE id=$1",[input.jobId]);
   });
  }catch(error){
   await failBeforeLaunch(error instanceof Refusal&&error.code==='DESIGN_CREATE_MODEL_UNAVAILABLE'?'design_create_model_unavailable':'pre_launch_failed');
   throw error;
  }
  let examAccessToken:string|undefined;
  let token='';
  let workerEnv:string[]=[];
  let workerMounts:{source:string;destination:string;writable:boolean}[]=[];
  let toolsMounts:{source:string;destination:string;writable:boolean}[]=[];
  let launchTask=input.task;
  const labels={'agent-control.contract':'native-execution-v1','agent-control.job':input.jobId,'agent-control.launch':hash};
  let inClaudePrep=false;
  try{
   if(claudeExam){
    inClaudePrep=true;
    const prepared=await prepareClaudeExamAccessToken({accountDir:accountRoot,accountId:String(g.account_id),examMaxMs:input.timeoutMs,renew:this.config.examLoginRenew??renewClaudeLoginInPlace,lock:postgresAccountLoginLock(this.ledger),
     ...(input.moduleExam?{freshOnly:true}:{})});
    examAccessToken=prepared.accessToken;
    accountSecrets=prepared.secrets;
    assertNoNativeTaskSecrets(input.task,[...envSecrets,...accountSecrets]);
    inClaudePrep=false;
   }
   const repository=input.moduleExam?undefined:await this.jobRepository(this.ledger.pool,String(g.project_id));
   await mkdir(p.root,{mode:0o700});jobDirCreated=true;
   await writeFile(join(p.root,'request.json'),JSON.stringify(input),{mode:0o600,flag:'wx'});for(const path of [p.input,p.output,p.planning])await mkdir(path,{mode:0o700});
   if(repository)await new GitArtifacts(repository).snapshot(input.base,input.base,p.work);
   if(repository&&input.role!=='programmer')await this.writeCheckoutIdentity(repository,input.jobId,input.base,p.work);
   const examWorkflow=(await this.ledger.pool.query('SELECT command FROM ac_intents WHERE id=$1',[input.intentId])).rows[0]?.command?.payload?.workflow;
   const dataDirectory=this.config.dataDirectory;
   if(repository&&dataDirectory&&(input.role==='programmer'||(input.role==='reviewer'&&!readonlyExamIsolation(personal,examWorkflow,input.role)))){
    // Optional context travels in the signed launch. The original request remains the replay identity.
    launchTask=await nativeTaskWithRepoMap({
     task:input.task,jobId:input.jobId,repoPath:p.work,commit:input.base,projectId:String(g.project_id),dataDirectory,
     secrets:[...envSecrets,...accountSecrets],
     scope:async()=>{
      if(input.role==='programmer')return input.writePaths;
      const artifact=(await this.ledger.pool.query('SELECT base_id FROM ac_artifacts WHERE id=$1',[input.artifactId])).rows[0];
      return nativeReviewMapScope(p.work,artifact?.base_id,input.base);
     },
    });
   }
   if(repository&&stageDesignExamCaptures(personal,examWorkflow,input.role))await stageDesignCapturesForJob(repository,[p.planning,p.work]);
   await writeFile(p.key,this.publicKey,{mode:0o600,flag:'wx'});token=randomBytes(32).toString('hex');
   for(const path of [p.workerToken,p.toolsToken])await writeFile(path,token,{mode:0o600,flag:'wx'});
   // A personal Claude or Codex evaluator reads the artifact itself, so it gets its own read-only copy: the tools container keeps the original and the two may not share a source.
   // Readonly design and security exams have no artifact row. Any personal provider still gets that copy, and no review diff is written.
   const designExam=personal&&readonlyDesignExam(examWorkflow,input.role);
   const securityExam=personal&&readonlySecurityExam(examWorkflow,input.role);
   const isolateExam=readonlyExamIsolation(personal,examWorkflow,input.role);
   const workerArtifact=repository&&(designExam||securityExam||(input.role!=='programmer'&&personal&&(this.config.provider==='claude'||this.config.provider==='codex')))?join(p.root,'review-artifact'):undefined;
   if(workerArtifact&&repository){
    // The copy carries no Git metadata and no Git tool is offered: untrusted repository configuration must not run beside the credentials.
    await cp(p.work,workerArtifact,{recursive:true});await rm(join(workerArtifact,'.git'),{recursive:true,force:true});
    if(isolateExam)await replaceSecretClassFiles(workerArtifact);
    // Every evaluator copy loses agent config (CLAUDE.md, AGENTS.md, .claude/, .mcp.json, .codex/ and the like, at any depth):
    // the change under judgment must not instruct its judge or run a hook beside the judge's login. The diff still shows those files.
    const stripped=await stripExamHostileConfig(workerArtifact);
    if(isolateExam){const stripNote=formatExamStripNote(stripped);if(stripNote)rememberExamStripNote(input.intentId,stripNote);}
    if(!designExam&&!securityExam){
     // For an evaluator, `base` is the artifact commit; the change under review is that commit against the artifact's own base.
     const reviewed=(await this.ledger.pool.query('SELECT base_id FROM ac_artifacts WHERE id=$1',[input.artifactId])).rows[0];
     if(reviewed?.base_id){const change=await new GitArtifacts(repository).diff(input.base,String(reviewed.base_id));await writeFile(join(workerArtifact,'.agent-control-review.diff'),reviewDiffDocument(change,stripped),{mode:0o600,flag:'wx'});}
    }
   }
   await writeNativeSecretSnapshot(p.secretSnapshot,input.jobId,this.key,[token,...envSecrets,...accountSecrets]);
   // Personal Claude, Grok and Codex programmers edit the checkout from the worker itself. Locked Codex keeps the
   // original split: the credentialed worker has no /work and the tools container owns the checkout.
   const workerOwnsCheckout=input.role==='programmer'&&personal&&(this.config.provider==='claude'||this.config.provider==='grok'||this.config.provider==='codex');
   const baseAccountMount=examAccountMount(join(this.config.accountRoot,g.account_id),isolateExam);
   workerEnv=examWorkerEnv(this.config.workerEnv,isolateExam);
   if(synthetic)workerEnv=workerEnv.filter(entry=>!entry.startsWith('AC_VERIFY_EXAM='));
   // Personal egress (AC_PERSONAL_EGRESS=1 on the gateway): the worker sends every provider call through the allowlist proxy.
   if(personal&&!synthetic&&process.env.AC_PERSONAL_EGRESS==='1')workerEnv=[...workerEnv,'AC_PERSONAL_EGRESS=1'];
   workerMounts=[...(claudeExam?[]:[baseAccountMount]),{source:p.input,destination:'/input',writable:false},{source:p.output,destination:'/output',writable:true},{source:p.planning,destination:'/planning',writable:false},{source:p.key,destination:'/runner/execution-public-key.pem',writable:false},{source:p.workerToken,destination:'/runner/exec-token',writable:false},...(workerOwnsCheckout?[{source:p.work,destination:'/work',writable:true}]:workerArtifact?[{source:workerArtifact,destination:'/work',writable:false}]:[])];
   const toolsWork=workerOwnsCheckout?join(p.root,'tools-workspace'):p.work;
   if(toolsWork!==p.work)await mkdir(toolsWork,{mode:0o700});
   toolsMounts=[{source:toolsWork,destination:'/work',writable:input.role==='programmer'},{source:p.toolsToken,destination:'/runner/exec-token',writable:false}];
   if(input.moduleExam){
    const provider=this.config.provider;
    if(provider!=='claude'&&provider!=='codex')throw new Refusal('MODULE_EXAM_PROVIDER_UNAVAILABLE');
    const socket=join(p.root,'egress.sock');
    this.moduleExamEgress.set(input.jobId,await startModuleExamEgress(socket,provider));
    checkAbort();
    workerEnv=[];
    workerMounts=workerMounts.filter(m=>m.destination!=='/account'&&m.destination!=='/work'&&m.destination!=='/runner/exec-token');
    workerMounts.push({source:socket,destination:moduleExamSocket,writable:false});
    if(provider==='codex')workerMounts.push({source:join(accountRoot,'.codex','auth.json'),destination:'/account/.codex/auth.json',writable:false});
    toolsMounts=[];
   }
  }catch(error){
   const reason=inClaudePrep
    ?(error instanceof Refusal&&error.code==='EXAM_LOGIN_BUSY'?'exam_login_busy':error instanceof Refusal&&error.code==='EXAM_LOGIN_STALE'?'exam_login_stale':error instanceof Refusal&&error.code==='EXAM_LOGIN_RESTORE_FAILED'?'exam_login_restore_failed':error instanceof Refusal&&error.code==='NATIVE_EXECUTION_SECRET_IN_TASK'?'secret_in_task':'exam_login_token_failed')
    :'pre_launch_failed';
   await failBeforeLaunch(reason);
   throw error;
  }
  const companion=input.moduleExam?moduleExamCompanion:toolsEntrypoint;
  const toolsEnv=input.moduleExam?[]:[...this.config.toolsEnv];
  const toolsDirectory=input.moduleExam?'/':'/work';
  const host=(networkId:string,mounts:typeof toolsMounts)=>({NetworkMode:networkId,ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9,Tmpfs:{'/tmp':'rw,nosuid,nodev,size=64m'},Binds:mounts.map(m=>describeBind(m))});
  let started:{network:string;tools:string;worker:string};
  try{started=await this.serialEffect(input.jobId,async()=>{
   checkAbort();
   const network=await this.effect(principal,authority,input,()=>this.docker.createPrivateNetwork('ac-native-exec-'+input.jobId,labels));
   await this.ledger.pool.query('UPDATE ac_native_execution_jobs SET network_id=$2 WHERE id=$1',[input.jobId,network]);
   const tools=await this.effect(principal,authority,input,()=>this.docker.create('ac-native-tools-'+input.jobId,{Image:this.config.toolsImage,User:this.user,WorkingDir:toolsDirectory,Entrypoint:companion,Cmd:[],Env:toolsEnv,Labels:labels,HostConfig:host(network,toolsMounts)}));
   await this.ledger.pool.query('UPDATE ac_native_execution_jobs SET tools_id=$2 WHERE id=$1',[input.jobId,tools]);
   const worker=await this.effect(principal,authority,input,()=>this.docker.create('ac-native-worker-'+input.jobId,{Image:this.config.workerImage,User:this.user,WorkingDir:'/planning',Entrypoint:workerEntrypoint,Cmd:[],Env:[...workerEnv],Labels:labels,HostConfig:host(input.moduleExam?'none':network,workerMounts),...(!input.moduleExam?{NetworkingConfig:{EndpointsConfig:{[network]:{},[this.config.providerNetworkId]:{}}}}:{})}));
   await this.ledger.pool.query('UPDATE ac_native_execution_jobs SET worker_id=$2 WHERE id=$1',[input.jobId,worker]);
   // The CLI wrapper waits for a signed launch. No account is opened yet.
   await this.effect(principal,authority,input,()=>this.docker.start(tools));await this.effect(principal,authority,input,()=>this.docker.start(worker));
   return {network,tools,worker};
  });}
  catch(error){
   if(!(error instanceof Refusal)||error.code!=='DOCKER_CREATE_REFUSED')throw error;
   const released=await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
    const row=(await c.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1 AND context_id=$2 FOR UPDATE',[input.jobId,authority.contextId])).rows[0];
    if(!row||row.state!=='uncertain'||row.worker_id||row.tools_id)return false;
    if(row.network_id)await retireNativePrivateNetwork(this.docker,{networkId:row.network_id,providerNetworkId:this.config.providerNetworkId,jobId:input.jobId,inputDigest:row.input_digest});
    let worker;let tools;try{worker=await this.docker.inspect('ac-native-worker-'+input.jobId);tools=await this.docker.inspect('ac-native-tools-'+input.jobId);}catch{return false;}
    if(worker||tools)return false;
    await cancelPreparedNativeResources(c,this.docker,input.jobId,input.grantId,authority);
    const receipt={executionStarted:false,jobId:input.jobId,containerId:null,networkId:row.network_id??null,synthetic,modelInference:false,reason:'docker_create_refused'};
    const updated=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state IN ('reserved','uncertain')",[input.grantId,receipt]);
    return updated.rowCount===1;
   });
   if(released&&jobDirCreated)await rm(p.root,{recursive:true,force:true}).catch(()=>undefined/* best-effort removal of a job dir that never launched */);
   if(!released)throw error;
   throw error;
  }
  const {network,tools,worker}=started;
  const physical=await this.docker.inspectPrivateNetwork(network);const address=physical?.Containers?.[tools]?.IPv4Address?.split('/')[0];
  const expected={jobId:input.jobId,launchDigest:hash,workerImage:this.config.workerImage,toolsImage:this.config.toolsImage,workerUser:this.user,toolsUser:this.user,providerNetwork:this.config.providerNetworkId,networkId:network,toolsAddress:address,workerMounts,toolsMounts,role:input.role,phase:'gated-running',...(input.moduleExam?{moduleExam:true}:{})};
  const rules={state:'running',workerEntrypoint,toolsEntrypoint:companion,workerCmd:[],toolsCmd:[],workerEnv:[...workerEnv],toolsEnv,workerWorkingDir:'/planning',toolsWorkingDir:toolsDirectory,workerMemory:512*1024*1024,toolsMemory:512*1024*1024,workerPids:96,toolsPids:96,workerNanoCpus:1e9,toolsNanoCpus:1e9};
  await inspectNativeExecutionPair(dockerReadOnly(this.config.socketPath??'/var/run/docker.sock'),{worker,tools,network},expected,rules);
  const launchProvider=personal?this.config.provider:this.config.provider&&this.config.provider!=='codex'?this.config.provider:undefined;
  const effectiveModel=g.model,effectiveEffort=g.effort;
  const tagSecrets=claudeExam&&examAccessToken?[examAccessToken]:accountSecrets;
  const launch={schemaVersion:1,jobId:input.jobId,contextId:authority.contextId,intentId:input.intentId,grantId:input.grantId,accountId:g.account_id,profileId:g.profile_id,sessionId:input.sessionId,epoch:authority.epoch,providerSubjectDigest:this.subjects.get(g.account_id)!,credentialSnapshotTag:createHmac('sha256',token).update(canonical(tagSecrets)).digest('hex'),executorDigest:this.executorDigest,inputDigest:hash,proxyUrl:'http://provider-egress:8080',model:effectiveModel,effort:effectiveEffort,role:input.role,task:launchTask,writePaths:input.writePaths,...(input.role!=='programmer'?{artifactCommit:input.base,outputSchema:input.outputSchema}:input.outputSchema?{outputSchema:input.outputSchema}:{}),environmentId:'native_tools',toolsAddress:address,...(input.moduleExam?{moduleExam:true as const}:{}),timeoutMs:input.timeoutMs,expiresAt:Date.now()+60000,...(launchProvider?{provider:launchProvider}:{}),...(synthetic?{synthetic:true}:{}),...(claudeExam&&examAccessToken?{oauthAccessToken:examAccessToken}:{})};
  const signed={payload:launch,signature:sign(null,Buffer.from('agent-control:native-execution-launch:v1\n'+canonical(launch)),this.key).toString('hex')};
  // Atomic publication prevents partial JSON reads by the worker; the journal
  // and private directory make this an exclusive one-time release.
  await this.effect(principal,authority,input,async()=>{checkAbort();await writeFile(join(p.input,'launch.pending'),JSON.stringify(signed),{mode:0o600,flag:'wx'});try{await lstat(join(p.input,'launch.json'));throw new Refusal('NATIVE_EXECUTION_ALREADY_RELEASED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}checkAbort();await rename(join(p.input,'launch.pending'),join(p.input,'launch.json'));});
  await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);await c.query("UPDATE ac_native_execution_jobs SET state='running',launch_digest=$2 WHERE id=$1 AND state='uncertain'",[input.jobId,digest(launch)]);await c.query("UPDATE ac_capacity_grants SET state='running',selection=COALESCE(selection,'{}'::jsonb)||$2::jsonb WHERE id=$1 AND state='uncertain'",[input.grantId,JSON.stringify({effectiveModel,effectiveEffort})]);});
  return {state:'running' as const,jobId:input.jobId};
 }
 /** Serialized with every other registration of the same job and with work retention (same per-job lock): two concurrent calls register once,
  * and the checkout cannot be retired while it is being scanned or imported. After the import, the job's private ref pins the artifact
  * (created by CAS, never moved), so the repository keeps it whatever happens to branches or to `work`. */
 async registerArtifact(principal:string,authority:Authority,jobId:string,quality:Quality){
  if(quality.ledger!==this.ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
  Id.parse(jobId);
  return this.withTerminalWorkLock(jobId,held=>this.registerArtifactLocked(principal,authority,jobId,quality,held));
 }
 private async registerArtifactLocked(principal:string,authority:Authority,jobId:string,quality:Quality,held:()=>boolean){
  const input=await this.registeredInput(principal,authority,jobId),outcome=await this.reconcile(principal,authority,input);
  if(outcome.state!=='completed'||!('artifact' in outcome)||!outcome.artifact||input.role!=='programmer')throw new Refusal('NATIVE_ARTIFACT_NOT_READY');
  const artifact=NativeArtifactIdentity.parse(outcome.artifact);
  const hash=digest({domain:'artifact-v1',intentId:input.intentId,commit:artifact.commit}),id=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  // Replay of a registration that already passed the secret scan and the import: the checkout may have been retired since, so the
  // repository's own copy of the exact identity is the only source (automatic work retention frees `work` only after this row exists).
  const already=(await this.ledger.pool.query('SELECT 1 FROM ac_artifacts WHERE id=$1 AND context_id=$2 AND intent_id=$3 AND commit_id=$4 AND tree_id=$5 AND base_id=$6',
   [id,authority.contextId,input.intentId,artifact.commit,artifact.tree,artifact.base])).rowCount===1;
  if(!held())throw new Refusal('NATIVE_ARTIFACT_LOCK_LOST');
  if(!already){
   const secrets=await readNativeArtifactSecrets(this.paths(jobId).secretSnapshot,jobId,this.key);
   await new GitArtifacts(this.paths(jobId).work).assertNoNewArtifactSecrets(artifact.commit,artifact.base,secrets);
  }
  const revision=await this.ledger.tx(async c=>{const context=await this.scope(c,principal,authority,input,false);
   const contract=(await c.query('SELECT quality_revision,target_ref,digest FROM ac_execution_contracts WHERE intent_id=$1',[input.intentId])).rows[0];
   if(!contract||contract.digest!==digest({qualityRevision:contract.quality_revision,targetRef:contract.target_ref}))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
   const repository=await this.jobRepository(c,String(context.project_id));
   const identity=already?await new GitArtifacts(repository).identity(artifact.commit,artifact.base):await new GitArtifacts(repository).import(this.paths(jobId).work,artifact.commit,artifact.base);
   if(identity.tree!==artifact.tree||identity.legacyDigest!==artifact.legacyDigest)throw new Refusal('NATIVE_ARTIFACT_IDENTITY_MISMATCH');
   const pinned=await pinRetainedArtifact(repository,jobId,artifact.commit,artifact.tree);
   if(pinned!=='created'&&pinned!=='kept')throw new Refusal(pinned==='conflict'?'NATIVE_ARTIFACT_RETENTION_REF_CONFLICT':'NATIVE_ARTIFACT_IDENTITY_MISMATCH');
   if(!held())throw new Refusal('NATIVE_ARTIFACT_LOCK_LOST');
   return contract.quality_revision;
  });
  const risk=await this.ledger.tx(c=>expectedArtifactRisk(c,input.intentId,authority.contextId,revision));
  return quality.register(principal,{id,contextId:authority.contextId,intentId:input.intentId,implementationGrantId:input.grantId,implementationSessionId:input.sessionId,policyRevision:revision,commit:artifact.commit,tree:artifact.tree,base:artifact.base,risk},authority);
 }
}
export {nativeExecutionExecutorDigest};
