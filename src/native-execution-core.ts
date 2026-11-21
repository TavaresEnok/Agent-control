/** Supervisor state, identity and scope checks, and the private paths of a job; the base of the native execution supervisor. */
import {moduleExamProviders} from './module-exam-egress.ts';
import {assertModelAllowed} from './model-policy.ts';
import {nativeDockerDaemon} from './native-resource-envelope.ts';
import {constants} from 'node:fs';
import {lstat,realpath,readdir,open,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createPrivateKey,createPublicKey,createHash,verify} from 'node:crypto';
import {z} from 'zod';
import pg from 'pg';
import {Ledger} from './ledger.ts';
import {Authority,canonical,digest,Refusal} from './contracts.ts';
import {DockerDaemon} from './sandbox-broker.ts';
import {assertNativeSyntheticFixture} from './native-synthetic-fixture.ts';
import {QualityPolicy} from './quality-policy.ts';
import {diskGuardFromEnvironment,type DiskGuard} from './disk-admission.ts';
import {readPrivateWorkerFile} from './native-worker-security.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {Id,Hash,terminalWorkLockKey,readonlyDesignExam,NativeExecutionRequest,type Input,type NativeExecutionSupervisorConfig,Result,readonlySecurityExam} from './native-execution-shared.ts';
export abstract class NativeExecutionSupervisorCore{
 readonly executorDigest:string;
 readonly scopeId:string;
 supportsAccount(accountId:string){return this.subjects.has(accountId);}
 get active(){return this.config.active!==false;}
 get keyFingerprint(){return this.fingerprint;}protected readonly key;protected readonly publicKey:string;protected readonly fingerprint:string;
 protected readonly subjects=new Map<string,string>();protected readonly docker:DockerDaemon;protected readonly user:string;
 protected readonly moduleExamEgress=new Map<string,()=>void>();
 closeModuleExamEgress(jobId:string){this.moduleExamEgress.get(jobId)?.();this.moduleExamEgress.delete(jobId);}
 protected readonly effectTails=new Map<string,Promise<void>>();
 constructor(readonly ledger:Ledger,protected readonly config:NativeExecutionSupervisorConfig,protected readonly diskGuard:DiskGuard|undefined=diskGuardFromEnvironment()){
  z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/).parse(config.id);this.scopeId=config.id+'@'+(config.provider??'codex');
  for(const image of [config.workerImage,config.toolsImage])z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(image);
  Hash.parse(config.providerNetworkId);
  if(config.syntheticFixture)assertNativeSyntheticFixture(config.syntheticFixture,config);
  const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid)throw new Refusal('NATIVE_WORKER_NON_ROOT_REQUIRED');this.user=`${uid}:${gid}`;
  const repositories=[...(config.repository?[config.repository]:[]),...config.protectedRepositories];
  if([config.hostRoot,config.accountRoot,...repositories].some(p=>resolve(p)!==p)||
   [config.accountRoot,...repositories].some(p=>p===config.hostRoot||p.startsWith(config.hostRoot+sep)||config.hostRoot.startsWith(p+sep))||repositories.some(p=>p===config.accountRoot||p.startsWith(config.accountRoot+sep)||config.accountRoot.startsWith(p+sep)))throw new Refusal('NATIVE_EXECUTION_PATH_INVALID');
  this.config=Object.freeze({...config,workerEnv:Object.freeze([...config.workerEnv]),toolsEnv:Object.freeze([...config.toolsEnv]),protectedRepositories:Object.freeze([...config.protectedRepositories]),accountSubjects:Object.freeze(config.accountSubjects.map(x=>Object.freeze({...x})))});
  for(const item of config.accountSubjects){Id.parse(item.accountId);Hash.parse(item.subjectDigest);if(this.subjects.has(item.accountId))throw new Refusal('NATIVE_EXECUTION_ACCOUNT_DUPLICATE');this.subjects.set(item.accountId,item.subjectDigest);}
  this.key=createPrivateKey(config.signingKeyPem);if(this.key.asymmetricKeyType!=='ed25519')throw new Refusal('NATIVE_EXECUTION_KEY_INVALID');
  const pub=createPublicKey(this.key);this.publicKey=pub.export({format:'pem',type:'spki'}).toString();this.fingerprint=createHash('sha256').update(pub.export({format:'der',type:'spki'})).digest('hex');
  this.executorDigest=nativeExecutionExecutorDigest(config.workerImage,config.toolsImage);this.docker=nativeDockerDaemon(config.socketPath,config.resourceEnvelope);
 }
 protected paths(id:string){Id.parse(id);const root=join(this.config.hostRoot,id);return {root,input:join(root,'input'),output:join(root,'output'),planning:join(root,'planning'),work:join(root,'work'),key:join(root,'public.pem'),workerToken:join(root,'worker-token'),toolsToken:join(root,'tools-token'),secretSnapshot:join(root,'redaction.enc')};}
 protected async directory(path:string){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o7777)!==0o700||await realpath(path)!==path)throw new Refusal('NATIVE_EXECUTION_DIRECTORY_UNSAFE');}
 protected async scope(c:pg.PoolClient,principal:string,authority:Authority,input:Input,paused=false){
  const context=await this.ledger.authorize(c,principal,authority.contextId);
  if(this.config.syntheticFixture)assertNativeSyntheticFixture(this.config.syntheticFixture,this.config,{projectId:context.project_id,contextId:authority.contextId});
  await this.ledger.fence(c,authority,paused);if(!paused)await this.ledger.assertIntentActive(c,authority.contextId,input.intentId);
  const intent=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[input.intentId,authority.contextId])).rows[0];
  if(intent?.principal_id!==principal)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');return context;
 }
 protected async personalReadonlyExam(c:pg.Pool|pg.PoolClient,intentId:string,role:unknown){
  const workflow=(await c.query('SELECT command FROM ac_intents WHERE id=$1',[intentId])).rows[0]?.command?.payload?.workflow;
  const personal=Boolean((await c.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'")).rowCount);
  return personal&&(readonlyDesignExam(workflow,role)||readonlySecurityExam(workflow,role));
 }
 protected assertQuota(input:Input,grant:{quota_status:string;quota_exhausted:boolean|null}){
  if(input.moduleExam&&(grant.quota_exhausted||['exhausted','rate_limited'].includes(grant.quota_status)))
   throw new Refusal('PROVIDER_USAGE_LIMIT');
  if(grant.quota_status!=='available')throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
 }
 protected async identity(c:pg.PoolClient,principal:string,authority:Authority,input:Input,requireQuota=true){
  const context=await this.scope(c,principal,authority,input);
  const provider=this.config.syntheticFixture?.provider??this.config.provider??'codex',mode=this.config.syntheticFixture?'synthetic':'subscription_cli';
  await this.jobRepository(c,String(context.project_id));
  await c.query('SELECT a.id FROM ac_accounts a JOIN ac_capacity_grants g ON g.account_id=a.id WHERE g.id=$1 FOR SHARE OF a',[input.grantId]);
  const g=(await c.query(`SELECT g.*,a.provider,a.mode,a.enabled account_enabled,a.eligibility,a.resource_identity,p.enabled profile_enabled,p.model,p.effort,p.role profile_role,
   ac_profile_quota_status(a.id,p.model) quota_status,a.exhausted_until>clock_timestamp() quota_exhausted
   FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id JOIN ac_profiles p ON p.id=g.profile_id AND p.account_id=a.id
   JOIN ac_account_access x ON x.account_id=a.id AND x.project_id=g.project_id JOIN ac_quota_observations q ON q.account_id=a.id
   WHERE g.id=$1 FOR UPDATE OF g FOR SHARE OF a,p,x`,[input.grantId])).rows[0];
  if(!g||g.state!=='reserved'||g.resource_kind!=='model'||g.context_id!==authority.contextId||g.project_id!==context.project_id||g.intent_id!==input.intentId||Number(g.manager_epoch)!==authority.epoch||g.role!==input.role||g.profile_role!==input.role||g.provider!==provider||g.mode!==mode||g.eligibility!=='documented_supported'||!g.account_enabled||!g.profile_enabled||!this.subjects.has(g.account_id)||g.resource_identity!==provider+':'+this.subjects.get(g.account_id))throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
  if(input.moduleExam){
   const binding=(await c.query(`SELECT 1 FROM ac_verify_runs r JOIN ac_exam_contexts e
    ON e.context_id=r.context_id AND e.project_id=r.project_id AND e.module=r.module
    JOIN ac_intents i ON i.id=$1 AND i.context_id=r.context_id
    WHERE r.context_id=$2 AND i.state='accepted'
    AND i.command->'payload'->>'workflow'='security-verify-readonly-v1' AND ac_activation_personal()
    AND ((r.intent_id=i.id AND r.commit_id=$3 AND r.status='running') OR
      (i.command->'payload'->>'messageRef'='recheck:'||r.id::text
       AND i.command->'payload'->>'projectId'=r.project_id::text AND i.command->'payload'->>'commit'=$3
       AND r.module <> 'verify' AND r.status IN ('done','failed') AND r.report_dir NOT IN ('pending','discarded')
       AND EXISTS (SELECT 1 FROM ac_memberships m WHERE m.project_id=r.project_id AND m.principal_id=i.principal_id AND m.role='owner')
       AND r.report_dir NOT LIKE 'discarded:%'))`,
    [input.intentId,authority.contextId,input.base])).rowCount;
   if(!binding||this.config.syntheticFixture||!moduleExamProviders.some(candidate=>candidate===this.config.provider)||
    input.moduleExam.accountId!==g.account_id||input.moduleExam.profileId!==g.profile_id||input.moduleExam.model!==g.model)
    throw new Refusal('MODULE_EXAM_SCOPE_MISMATCH');
   if(requireQuota)this.assertQuota(input,g);
   return g;
  }
  if(requireQuota)this.assertQuota(input,g);
  if((input.role==='specialist'||input.role==='reviewer')&&await this.personalReadonlyExam(c,input.intentId,input.role))return g;
  const quality=(await c.query(`SELECT p.snapshot,p.digest FROM ac_execution_contracts x JOIN ac_quality_policies p ON p.project_id=x.project_id AND p.revision=x.quality_revision WHERE x.intent_id=$1 AND x.project_id=$2`,[input.intentId,context.project_id])).rows[0];
  if(!quality)throw new Refusal('NATIVE_EXECUTION_POLICY_REQUIRED');
  const policy=QualityPolicy.parse(quality.snapshot);if(digest(policy)!==quality.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
  if(input.role==='programmer'&&policy.requireSpecialistBeforeImplementation)throw new Refusal('NATIVE_SPECIALIST_GATE_UNAVAILABLE');
  if(input.role==='programmer'){
   const op=(await c.query('SELECT * FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[input.jobId,input.intentId])).rows[0];
   const intent=(await c.query('SELECT command FROM ac_intents WHERE id=$1',[input.intentId])).rows[0];
   const table=intent?.command?.payload?.workflow==='engineering-native-v1'?'ac_native_task_inputs':'ac_managed_delivery_inputs';
   const frozen=(await c.query(`SELECT base_id,snapshot,digest FROM ${table} WHERE intent_id=$1`,[input.intentId])).rows[0];
   if(!op||op.state!=='registered'||op.grant_id!==input.grantId||op.execution_attempt_id!==g.attempt_id||Number(op.manager_epoch)!==authority.epoch||!frozen||frozen.base_id!==input.base||digest(frozen.snapshot)!==frozen.digest||digest(frozen.snapshot.writePaths)!==digest(input.writePaths))throw new Refusal('NATIVE_EXECUTION_INPUT_MISMATCH');
   // Native activation is not allowed to consume a synthetic-only contract.
   const synthetic=(await c.query(`SELECT 1 FROM ac_managed_executions e JOIN ac_intents i ON i.parent_intent_id=e.parent_intent_id WHERE i.id=$1 AND e.recipe->>'mode'='synthetic-only'`,[input.intentId])).rowCount;
   if(synthetic&&!this.config.syntheticFixture)throw new Refusal('NATIVE_EXECUTION_RECIPE_NOT_ACTIVATED');
  }else{
   const artifact=(await c.query(`SELECT a.*,o.native_session_id writer_session FROM ac_artifacts a JOIN ac_operations o ON o.intent_id=a.intent_id WHERE a.id=$1 AND a.intent_id=$2`,[input.artifactId,input.intentId])).rows[0];
   const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[input.jobId,input.intentId])).rows[0];
   const phase=input.role==='reviewer'?'review':input.role;
   if(!artifact||artifact.commit_id!==input.base||artifact.implementation_session_id===input.sessionId||artifact.writer_session===input.sessionId||!stage||stage.state!=='registered'||stage.node_id!==phase||stage.session_id!==input.sessionId||stage.grant_id!==input.grantId||stage.attempt_id!==g.attempt_id||Number(stage.manager_epoch)!==authority.epoch)throw new Refusal('NATIVE_EXECUTION_ARTIFACT_MISMATCH');
  }
  return g;
 }
 protected profileDigest(row:Record<string,any>){return digest({accountId:row.account_id,profileId:row.profile_id,model:row.model,effort:row.effort,role:row.role});}
 /** Queues create/start with recovery on this process. The job row lock does the same across processes. */
 protected serialEffect<T>(id:string,fn:()=>Promise<T>):Promise<T>{
  const previous=this.effectTails.get(id)??Promise.resolve();
  let open:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{open=resolve;});
  const tail=previous.then(()=>gate,()=>gate);
  this.effectTails.set(id,tail);
  return previous.then(fn,fn).finally(()=>{open();if(this.effectTails.get(id)===tail)this.effectTails.delete(id);});
 }
 protected async effect<T>(principal:string,authority:Authority,input:Input,fn:()=>Promise<T>){return this.ledger.tx(async c=>{
  await this.scope(c,principal,authority,input);
  const job=(await c.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1 FOR UPDATE',[input.jobId])).rows[0];
  if(!job||job.state!=='uncertain'||Number(job.manager_epoch)!==authority.epoch)throw new Refusal('NATIVE_EXECUTION_RECONCILE_REQUIRED');
  await c.query('SELECT a.id FROM ac_accounts a JOIN ac_capacity_grants g ON g.account_id=a.id WHERE g.id=$1 FOR SHARE OF a',[input.grantId]);
  const grant=(await c.query(`SELECT g.*,p.model,p.effort,ac_profile_quota_status(a.id,p.model) quota_status,
   a.exhausted_until>clock_timestamp() quota_exhausted FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id
   JOIN ac_profiles p ON p.id=g.profile_id AND p.account_id=a.id JOIN ac_quota_observations q ON q.account_id=a.id
   LEFT JOIN ac_provider_eligibility_assessments e ON e.account_id=a.id AND e.revision=$2
   WHERE g.id=$1 AND g.state='uncertain' AND a.enabled AND p.enabled AND p.role=g.role AND a.provider=$5 AND a.mode=$6
    AND a.eligibility='documented_supported'
   AND (ac_activation_personal() OR (e.status='documented_supported' AND e.expires_at>clock_timestamp() AND e.adapter_id=$3 AND e.adapter_version=$4
    AND e.revision=(SELECT max(revision) FROM ac_provider_eligibility_assessments WHERE account_id=a.id)))
   FOR UPDATE OF g FOR SHARE OF a,p,q`,[input.grantId,job.eligibility_revision,this.config.id,this.executorDigest,this.config.syntheticFixture?.provider??this.config.provider??'codex',this.config.syntheticFixture?'synthetic':'subscription_cli'])).rows[0];
  if(grant?.account_id)await c.query('SELECT account_id FROM ac_provider_eligibility_assessments WHERE account_id=$1 AND revision=$2 FOR SHARE',[grant.account_id,job.eligibility_revision]);
  if(!grant||grant.account_id!==job.account_id||grant.profile_id!==job.profile_id||grant.role!==input.role||grant.context_id!==authority.contextId||
   grant.intent_id!==input.intentId||Number(grant.manager_epoch)!==authority.epoch||this.profileDigest(grant)!==job.profile_digest)throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
  this.assertQuota(input,grant);assertModelAllowed(grant.model);return fn();
 });}
 /** The request this job was launched with, so a caller rebuilding it after a restart replays the same text
  * even when the instruction wording changed since (new wording applies only to new jobs). */
 async storedRequest(principal:string,authority:Authority,jobId:string){return this.registeredInput(principal,authority,jobId);}
 /** Execution host directory: job results live under it (team feed, failure facts). */
 get hostRoot(){return this.config.hostRoot;}
 /** Read the original private request after a controller restart. It is never
  * reconstructed from an agent message or stored as plaintext in PostgreSQL. */
 protected async registeredInput(principal:string,authority:Authority,jobId:string){
  Id.parse(jobId);
  await this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,authority.contextId);
   if(this.config.syntheticFixture)assertNativeSyntheticFixture(this.config.syntheticFixture,this.config,{projectId:context.project_id,contextId:authority.contextId});
   await this.ledger.fence(c,authority,true);
   const row=(await c.query('SELECT intent_id FROM ac_native_execution_jobs WHERE id=$1 AND context_id=$2',[jobId,authority.contextId])).rows[0];
   if(!row)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
   const owner=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[row.intent_id,authority.contextId])).rows[0];
   if(owner?.principal_id!==principal)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  });
  const p=this.paths(jobId);await this.directory(p.root);const bytes=await readPrivateWorkerFile(join(p.root,'request.json'),512*1024);
  try{const input=NativeExecutionRequest.parse(JSON.parse(bytes.toString('utf8')));if(input.jobId!==jobId)throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');return input;}finally{bytes.fill(0);}
 }
 protected async validateReplay(principal:string,authority:Authority,input:Input,row:Record<string,any>){
  await this.ledger.tx(async c=>{const context=await this.scope(c,principal,authority,input,true);await this.jobRepository(c,String(context.project_id));});
  if(row.context_id!==authority.contextId||row.intent_id!==input.intentId||row.grant_id!==input.grantId||row.session_id!==input.sessionId||row.input_digest!==digest(input)||row.executor_digest!==this.executorDigest||row.key_fingerprint!==this.fingerprint||Number(row.manager_epoch)>authority.epoch)throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
 }
 /** Checkout registered for the job's project. Compared after realpath.
  * config.repository, when present, is an extra pin: only that checkout is valid. */
 protected async jobRepository(c:pg.Pool|pg.PoolClient,projectId:string){
  const registered=(await c.query('SELECT repo FROM ac_project_repositories WHERE project_id=$1',[projectId])).rows[0];
  if(typeof registered?.repo!=='string'||!registered.repo)throw new Refusal('NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  let resolved:string;try{resolved=await realpath(registered.repo);}catch{throw new Refusal('NATIVE_EXECUTION_REPOSITORY_MISMATCH');}
  const allowed=new Set<string>();
  for(const candidate of this.config.protectedRepositories){try{allowed.add(await realpath(candidate));}catch{/* an unresolvable entry grants nothing */}}
  if(this.config.repository){
   let pinned:string;try{pinned=await realpath(this.config.repository);}catch{throw new Refusal('NATIVE_EXECUTION_REPOSITORY_MISMATCH');}
   if(resolved!==pinned)throw new Refusal('NATIVE_EXECUTION_REPOSITORY_MISMATCH');
   allowed.add(pinned);
  }
  if(!allowed.has(resolved))throw new Refusal('NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  return resolved;
 }
 protected async removeLaunchFiles(jobId:string){
  const p=this.paths(jobId);
  await rm(join(p.input,'launch.json'),{force:true});
  await rm(join(p.input,'launch.pending'),{force:true});
  try{
   for(const entry of await readdir(p.input)){
    if(entry.startsWith('launch.pending.'))await rm(join(p.input,entry),{force:true});
   }
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
 }
 protected async readResult(input:Input,exitCode:number){
  const p=this.paths(input.jobId);await this.directory(p.root);await this.directory(p.output);
  let result:z.infer<typeof Result>;
  try{const file=await open(join(p.output,'execution-result.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>2*1024*1024)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');const bytes=await file.readFile();if(bytes.length>2*1024*1024)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');result=Result.parse(JSON.parse(bytes.toString('utf8')));}finally{await file.close();}}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||exitCode===0)throw error;result={schemaVersion:1,jobId:input.jobId,output:'',normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:'WORKER_EXITED_WITHOUT_RESULT',exitCode:exitCode};}
  return result;
 }
 /** Validation only: true when the receipt carries this executor's own Ed25519 signature. It cannot launch, write, explore or connect. */
 receiptSignedByThisExecutor(receipt:unknown):boolean{
  try{
   const saved=receipt as {payload?:unknown;signature?:unknown}|null|undefined,payload=saved?.payload;
   return !!payload&&typeof payload==='object'&&typeof saved?.signature==='string'&&/^[a-f0-9]{128}$/.test(saved.signature)&&
    verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(saved.signature,'hex'));
  }catch{return false;}
 }
 /** Register only the exact finalized artifact; Quality still requires
  * independent QA/review and authorized integration. No branch is changed. */
 /** Dedicated connection, outside the ledger pool, that holds a per-job work lock: holding it never takes a pool slot that the
  * transactions of the same operation need, so many jobs locked at once cannot starve the pool. Closing it releases the lock. */
 protected async workLockSession(){
  const client=new pg.Client({connectionString:this.ledger.pool.options.connectionString});
  client.on('error',()=>undefined); // Loss is observed through the abort signal; a late error never crashes the process.
  await client.connect();
  return client;
 }
 /** Runs `effect` holding the job's work lock on a dedicated session, waiting for it (work retention only ever tries it).
  * `held()` is false once that session is lost: the caller must not start reading `work` after that. */
 protected async withTerminalWorkLock<T>(jobId:string,effect:(held:()=>boolean)=>Promise<T>,waitMs=10*60*1000):Promise<T>{
  const key=terminalWorkLockKey(jobId);
  const canceled=new AbortController(),lost=()=>canceled.abort();
  const session=await this.workLockSession();
  session.on('error',lost);session.on('end',lost);
  let locked=false;
  try{
   const deadline=Date.now()+waitMs;
   for(;;){
    if(canceled.signal.aborted)throw new Refusal('NATIVE_ARTIFACT_LOCK_LOST');
    if((await session.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) ok',[key])).rows[0].ok){locked=true;break;}
    if(Date.now()>=deadline)throw new Refusal('NATIVE_ARTIFACT_BUSY',409);
    await new Promise(done=>setTimeout(done,100));
   }
   return await effect(()=>!canceled.signal.aborted);
  }finally{
   if(locked&&!canceled.signal.aborted)await session.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>undefined);
   session.off('error',lost);session.off('end',lost);
   await session.end().catch(()=>undefined);
  }
 }
 protected async launchPublished(jobId:string){
  try{const s=await lstat(join(this.paths(jobId).input,'launch.json'));if(!s.isFile()||s.isSymbolicLink())throw new Refusal('NATIVE_EXECUTION_LAUNCH_UNCERTAIN');return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 }
}
