import {moduleExamProviders, moduleExamSocket, startModuleExamEgress} from './module-exam-egress.ts';
import {requiredDesignProfile} from './design-model-reservation.ts';
import {assertModelAllowed} from './model-policy.ts';
import {redactNativeLogsOrWithhold,assertNoNativeTaskSecrets} from './native-execution-redaction.ts';
import {readNativeSecretSnapshot,writeNativeSecretSnapshot,quarantineNativeLegacyLog,readNativeArtifactSecrets} from './native-execution-secret-snapshot.ts';
import {collectSecretValues} from '../upstream/cezar/packages/cezar/dist/core/secret-redaction.js';
import {assertCodexSubscriptionIdentity,readMountedCredentialSecrets} from './native-worker-security.ts';
import {isProviderLimit, noteProviderExhaustion, providerLimitDisposition} from './quota-exhaustion.ts';
import {requireProjectEnvironmentLaunch} from './project-environments.ts';
import {verifiedWorktreeWriterContinuation} from './worktree-lease.ts';
import {pinNativeProtocolForNewAttempt} from './native-protocol-compatibility.ts';
import {requireRecoveryInventory} from './recovery-inventory.ts';
import {proveUncreatedNativeResources,cancelPreparedNativeResources,reconcileNativeResourceAdmissions,admitNativeResources,nativeDockerDaemon,type NativeResourceEnvelope} from './native-resource-envelope.ts';
import {constants} from 'node:fs';
import {mkdir,lstat,realpath,readdir,writeFile,open,rename,cp,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createPrivateKey,createPublicKey,sign,createHash,createHmac,randomBytes,verify} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {Ledger} from './ledger.ts';
import {Authority,canonical,digest,Refusal} from './contracts.ts';
import {DockerDaemon} from './sandbox-broker.ts';
import {stageDesignCapturesForJob} from './design-capture-stage.ts';
import {assertNativeSyntheticFixture,type NativeSyntheticFixture} from './native-synthetic-fixture.ts';
import {AccountHomes} from './account-homes.ts';
import {ProviderEligibility} from './provider-eligibility.ts';
import {GitArtifacts} from './git.ts';
import {NativeArtifactFinalizer,NativeArtifactIdentity} from './native-artifact-finalizer.ts';
import {expectedArtifactRisk,type Quality} from './quality.ts';
import {QualityPolicy} from './quality-policy.ts';
import {diskGuardFromEnvironment,type DiskGuard} from './disk-admission.ts';
import {inspectNativeExecutionPair,dockerReadOnly} from './native-execution-docker-observation.ts';
import {nativeContainerNeverStarted} from './native-execution-isolation.ts';
import {readPrivateWorkerFile} from './native-worker-security.ts';
import {usageWindowsObservationSchema} from '../upstream/cezar/packages/contract/src/usage-windows.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {replaceSecretClassFiles} from './verify-redact.ts';
import {rememberExamStripNote} from './exam-strip-note.ts';
import {describeBind,examAccountMount,examWorkerEnv,formatExamStripNote,stripExamHostileConfig} from './verify-exam-isolation.ts';
import {postgresAccountLoginLock,prepareClaudeExamAccessToken,renewClaudeLoginInPlace,safeFailureCode,writePrivateAtomic} from './exam-login.ts';
import {finishExamIntentTx} from './exam-intent.ts';
const Id=z.uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/),GitId=z.string().regex(/^[a-f0-9]{40}$/);
const PreLaunchExamReason=z.enum(['exam_login_stale','exam_login_busy','exam_login_restore_failed']);
const PreLaunchExamPhysicalReceipt=z.object({executionStarted:z.literal(false),jobId:Id,containerId:z.null(),networkId:z.null(),synthetic:z.boolean(),modelInference:z.literal(false),reason:PreLaunchExamReason}).strict();
export class UnstartedExamRetirementPending extends Refusal {
 constructor(readonly jobId:string){super('NATIVE_PRELAUNCH_SETTLEMENT_PENDING',409);Id.parse(jobId);}
}
/** Specialist or reviewer of the readonly design exam. Programmer, qa and judge never match. */
export function readonlyDesignExam(workflow: unknown, role: unknown): boolean {
  return workflow === 'design-readonly-v1' && (role === 'specialist' || role === 'reviewer');
}
const Path=z.string().min(1).max(240).refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!/[\x00-\x1f*?\[\]{}]/.test(p)&&!p.split('/').some(s=>!s||['.','..','.git','.ai'].includes(s)));
export const NativeExecutionRequest=z.object({jobId:Id,intentId:Id,grantId:Id,sessionId:Id,base:GitId,
 role:z.enum(['programmer','qa','reviewer','judge','specialist']),task:z.string().min(1).max(100000),writePaths:z.array(Path).max(64),
 artifactId:Id.optional(),outputSchema:z.record(z.string(),z.unknown()).optional(),timeoutMs:z.number().int().min(1000).max(1800000).default(900000),
 moduleExam:z.object({accountId:Id,profileId:Id,model:z.string().min(1).max(100)}).strict().optional(),
 model:z.string().min(1).max(100).optional(),effort:z.enum(['low','medium','high','xhigh','max']).optional()}).strict().superRefine((v,c)=>{
 if(v.moduleExam&&(v.role!=='specialist'||v.model!==undefined||v.effort!==undefined))c.addIssue({code:'custom',message:'MODULE_EXAM_SCOPE_MISMATCH'});
 if((v.model===undefined)!==(v.effort===undefined))c.addIssue({code:'custom',message:'DESIGN_CREATE_MODEL_UNAVAILABLE'});
 if(v.model!==undefined&&(v.model!=='claude-opus-5-5'||(v.effort!=='high'&&v.effort!=='medium')))c.addIssue({code:'custom',message:'DESIGN_CREATE_MODEL_UNAVAILABLE'});
 if(v.role==='programmer'&&!v.writePaths.length)c.addIssue({code:'custom',message:'PROGRAMMER_SCOPE_REQUIRED'});
 if(v.role!=='programmer'&&(!v.artifactId||!v.outputSchema||v.writePaths.length))c.addIssue({code:'custom',message:'READONLY_ARTIFACT_REQUIRED'});
});
type Input=z.infer<typeof NativeExecutionRequest>;
type PersonalExamRecoveryScope={projectId:string;repository:string;explicitDesignWithdrawal:boolean};
export type NativeExecutionSupervisorConfig={id:string;workerImage:string;toolsImage:string;hostRoot:string;accountRoot:string;repository?:string;
 protectedRepositories:readonly string[];signingKeyPem:string;providerNetworkId:string;provider?:'codex'|'claude'|'grok';socketPath?:string;resourceEnvelope?:NativeResourceEnvelope;accountSubjects:readonly {accountId:string;subjectDigest:string}[];
 workerEnv:readonly string[];toolsEnv:readonly string[];syntheticFixture?:NativeSyntheticFixture;
 /** Writable-account renewal used before a Claude exam copy. Tests inject this and never spawn a real CLI. */
 examLoginRenew?:(accountDir:string)=>Promise<void>;
 /** false: kept only to reconcile and retire jobs started under a replaced image pair; it never launches. */
 active?:boolean};
export type NativeExecutionOutcome={state:'running'|'uncertain'}|{state:'completed'|'failed';receipt:{payload:Record<string,any>;signature:string};output:string;artifact:z.infer<typeof NativeArtifactIdentity>|null;failureCode:string|null};
const Result=z.object({schemaVersion:z.literal(1),jobId:Id,output:z.string().max(262144),normalizedTokensUsed:z.number().int().safe().nonnegative().nullable(),usageWindows:usageWindowsObservationSchema.nullable(),nativeSessionId:z.string().nullable(),failureCode:z.string().nullable(),exitCode:z.number().int()}).strict();
export {nativeExecutionExecutorDigest};
const toolsEntrypoint=['node','/opt/agent-control/dist/src/native-tools-worker.mjs'];
const moduleExamCompanion=['node','-e','setInterval(() => {}, 60_000)'];
const workerEntrypoint=['node','/opt/agent-control/dist/src/native-execution-worker.mjs'];
/** Remove only the private network identified by the signed terminal receipt.
 * Caller must hold the fenced job lock and have confirmed both containers absent. */
export async function retireNativePrivateNetwork(docker:Pick<DockerDaemon,'inspectPrivateNetwork'|'removePrivateNetwork'>,
 identity:{networkId:string;providerNetworkId:string;jobId:string;inputDigest:string}){
 const {networkId,providerNetworkId,jobId,inputDigest}=identity;
 if(!/^[a-f0-9]{64}$/.test(networkId)||networkId===providerNetworkId||!Id.safeParse(jobId).success||!Hash.safeParse(inputDigest).success)
  throw new Refusal('NATIVE_RETIREMENT_NETWORK_UNCONFIRMED');
 const network=await docker.inspectPrivateNetwork(networkId);
 if(network){
  const labels=network.Labels,containers=network.Containers;
  if(network.Id!==networkId||network.Name!=='ac-native-exec-'+jobId||network.Internal!==true||
   !labels||labels['agent-control.contract']!=='native-execution-v1'||labels['agent-control.job']!==jobId||labels['agent-control.launch']!==inputDigest||
   !containers||typeof containers!=='object'||Array.isArray(containers)||Object.keys(containers).length!==0)
   throw new Refusal('NATIVE_RETIREMENT_NETWORK_UNCONFIRMED');
  await docker.removePrivateNetwork(networkId);
 }
 if(await docker.inspectPrivateNetwork(networkId))throw new Refusal('NATIVE_RETIREMENT_NETWORK_UNCONFIRMED');
}
/** Specialist or reviewer of the readonly security exam. Programmer, qa and judge never match. */
export function readonlySecurityExam(workflow:unknown,role:unknown):boolean{
 return workflow==='security-verify-readonly-v1'&&(role==='specialist'||role==='reviewer');
}
/** Personal design or security exam. Programmer, qa, judge and locked mode never match. */
export function readonlyExamIsolation(personal:unknown,workflow:unknown,role:unknown):boolean{
 return Boolean(personal)&&(readonlyDesignExam(workflow,role)||readonlySecurityExam(workflow,role));
}
/** Personal design exam only. Security exams, other roles and locked mode do not stage captures. */
export function stageDesignExamCaptures(personal:unknown,workflow:unknown,role:unknown):boolean{
 return Boolean(personal)&&readonlyDesignExam(workflow,role);
}
/** Effect supervisor only. A trusted Cezar stage must already own the grant,
 * frozen source and policy. No scheduler, inference on construction, fallback,
 * approval or Git integration occurs here. Production bootstrap does not construct
 * this supervisor; configured opt-in stays activation-blocked. */
export class NativeExecutionSupervisor{
 readonly executorDigest:string;
 readonly scopeId:string;
 supportsAccount(accountId:string){return this.subjects.has(accountId);}
 get active(){return this.config.active!==false;}
 get keyFingerprint(){return this.fingerprint;}private readonly key;private readonly publicKey:string;private readonly fingerprint:string;
 private readonly subjects=new Map<string,string>();private readonly docker:DockerDaemon;private readonly user:string;
 private readonly moduleExamEgress=new Map<string,()=>void>();
 closeModuleExamEgress(jobId:string){this.moduleExamEgress.get(jobId)?.();this.moduleExamEgress.delete(jobId);}
 private readonly effectTails=new Map<string,Promise<void>>();
 constructor(readonly ledger:Ledger,private readonly config:NativeExecutionSupervisorConfig,private readonly diskGuard:DiskGuard|undefined=diskGuardFromEnvironment()){
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
 async reconcileResourceAdmissions(principal:string,authority:Authority){return reconcileNativeResourceAdmissions({docker:this.docker,ledger:this.ledger,principal,authority,recoverSource:'ac_native_execution_jobs',recoverJob:id=>this.recover(principal,authority,id)});}
 private paths(id:string){Id.parse(id);const root=join(this.config.hostRoot,id);return {root,input:join(root,'input'),output:join(root,'output'),planning:join(root,'planning'),work:join(root,'work'),key:join(root,'public.pem'),workerToken:join(root,'worker-token'),toolsToken:join(root,'tools-token'),secretSnapshot:join(root,'redaction.enc')};}
 private async directory(path:string){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o7777)!==0o700||await realpath(path)!==path)throw new Refusal('NATIVE_EXECUTION_DIRECTORY_UNSAFE');}
 private async scope(c:pg.PoolClient,principal:string,authority:Authority,input:Input,paused=false){
  const context=await this.ledger.authorize(c,principal,authority.contextId);
  if(this.config.syntheticFixture)assertNativeSyntheticFixture(this.config.syntheticFixture,this.config,{projectId:context.project_id,contextId:authority.contextId});
  await this.ledger.fence(c,authority,paused);if(!paused)await this.ledger.assertIntentActive(c,authority.contextId,input.intentId);
  const intent=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[input.intentId,authority.contextId])).rows[0];
  if(intent?.principal_id!==principal)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');return context;
 }
 private async personalReadonlyExam(c:pg.Pool|pg.PoolClient,intentId:string,role:unknown){
  const workflow=(await c.query('SELECT command FROM ac_intents WHERE id=$1',[intentId])).rows[0]?.command?.payload?.workflow;
  const personal=Boolean((await c.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal'")).rowCount);
  return personal&&(readonlyDesignExam(workflow,role)||readonlySecurityExam(workflow,role));
 }
 private assertQuota(input:Input,grant:{quota_status:string;quota_exhausted:boolean|null}){
  if(input.moduleExam&&(grant.quota_exhausted||['exhausted','rate_limited'].includes(grant.quota_status)))
   throw new Refusal('PROVIDER_USAGE_LIMIT');
  if(grant.quota_status!=='available')throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
 }
 private async identity(c:pg.PoolClient,principal:string,authority:Authority,input:Input,requireQuota=true){
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
 private profileDigest(row:Record<string,any>){return digest({accountId:row.account_id,profileId:row.profile_id,model:row.model,effort:row.effort,role:row.role});}
 /** Queues create/start with recovery on this process. The job row lock does the same across processes. */
 private serialEffect<T>(id:string,fn:()=>Promise<T>):Promise<T>{
  const previous=this.effectTails.get(id)??Promise.resolve();
  let open:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{open=resolve;});
  const tail=previous.then(()=>gate,()=>gate);
  this.effectTails.set(id,tail);
  return previous.then(fn,fn).finally(()=>{open();if(this.effectTails.get(id)===tail)this.effectTails.delete(id);});
 }
 private async effect<T>(principal:string,authority:Authority,input:Input,fn:()=>Promise<T>){return this.ledger.tx(async c=>{
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
 async start(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>,signal?:AbortSignal){
  const input=NativeExecutionRequest.parse(raw),hash=digest(input),prior=(await this.ledger.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1',[input.jobId])).rows[0];
  if(prior){await this.validateReplay(principal,authority,input,prior);return this.reconcile(principal,authority,input);}
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
    return grant.state==='uncertain'&&PreLaunchExamReason.safeParse(reason).success&&!input.model&&!input.effort&&!input.task.startsWith('Pedido de criação.');
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
    if(jobDirCreated)await rm(p.root,{recursive:true,force:true}).catch(()=>undefined);
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
  // Stored workflow is the signal; the task prefix only separates create from the readonly exam.
  const askedModel=input.model!==undefined||input.effort!==undefined;
  const designCreate=personal&&input.role==='specialist'&&examWorkflowEarly==='design-readonly-v1'&&input.task.startsWith('Pedido de criação.');
  try{
   if(askedModel&&(!designCreate||input.model!=='claude-opus-5-5'||input.effort!=='high'))throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE');
   checkAbort();
   await admitNativeResources({docker:this.docker,ledger:this.ledger,principal,authority,intentId:input.intentId,grantId:input.grantId,jobId:input.jobId,names:['ac-native-tools-'+input.jobId,'ac-native-worker-'+input.jobId]});
   // Commit the uncertainty before files, Docker networks or processes exist.
   await this.ledger.tx(async c=>{const current=await this.identity(c,principal,authority,input);assertModelAllowed(current.model);
    if(personal && readonlyDesignExam(examWorkflowEarly,input.role)){
     const purpose=designCreate?'create':input.task.startsWith('Pedido de confirmação.')?'reviewer':
      input.task.startsWith('Pedido de crítica visual.')||input.task.startsWith('Pedido de crítica visual do revisor.')?'visual':'examiner';
     if(current.selection?.designPurpose!==purpose)throw new Refusal('DESIGN_CREATE_MODEL_UNAVAILABLE');
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
   const examWorkflow=(await this.ledger.pool.query('SELECT command FROM ac_intents WHERE id=$1',[input.intentId])).rows[0]?.command?.payload?.workflow;
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
    if(isolateExam){await replaceSecretClassFiles(workerArtifact);const stripped=await stripExamHostileConfig(workerArtifact);const stripNote=formatExamStripNote(stripped);if(stripNote)rememberExamStripNote(input.intentId,stripNote);}
    if(!designExam&&!securityExam){
     // For an evaluator, `base` is the artifact commit; the change under review is that commit against the artifact's own base.
     const reviewed=(await this.ledger.pool.query('SELECT base_id FROM ac_artifacts WHERE id=$1',[input.artifactId])).rows[0];
     if(reviewed?.base_id){const change=await new GitArtifacts(repository).diff(input.base,String(reviewed.base_id));await writeFile(join(workerArtifact,'.agent-control-review.diff'),change.diff+(change.truncated?'\n[diff truncated]\n':''),{mode:0o600,flag:'wx'});}
    }
   }
   await writeNativeSecretSnapshot(p.secretSnapshot,input.jobId,this.key,[token,...envSecrets,...accountSecrets]);
   // Personal Claude, Grok and Codex programmers edit the checkout from the worker itself. Locked Codex keeps the
   // original split: the credentialed worker has no /work and the tools container owns the checkout.
   const workerOwnsCheckout=input.role==='programmer'&&personal&&(this.config.provider==='claude'||this.config.provider==='grok'||this.config.provider==='codex');
   const baseAccountMount=examAccountMount(join(this.config.accountRoot,g.account_id),isolateExam);
   workerEnv=examWorkerEnv(this.config.workerEnv,isolateExam);
   if(synthetic)workerEnv=workerEnv.filter(entry=>!entry.startsWith('AC_VERIFY_EXAM='));
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
   if(released&&jobDirCreated)await rm(p.root,{recursive:true,force:true}).catch(()=>undefined);
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
  const launch={schemaVersion:1,jobId:input.jobId,contextId:authority.contextId,intentId:input.intentId,grantId:input.grantId,accountId:g.account_id,profileId:g.profile_id,sessionId:input.sessionId,epoch:authority.epoch,providerSubjectDigest:this.subjects.get(g.account_id)!,credentialSnapshotTag:createHmac('sha256',token).update(canonical(tagSecrets)).digest('hex'),executorDigest:this.executorDigest,inputDigest:hash,proxyUrl:'http://provider-egress:8080',model:effectiveModel,effort:effectiveEffort,role:input.role,task:input.task,writePaths:input.writePaths,...(input.role!=='programmer'?{artifactCommit:input.base,outputSchema:input.outputSchema}:input.outputSchema?{outputSchema:input.outputSchema}:{}),environmentId:'native_tools',toolsAddress:address,...(input.moduleExam?{moduleExam:true as const}:{}),timeoutMs:input.timeoutMs,expiresAt:Date.now()+60000,...(launchProvider?{provider:launchProvider}:{}),...(synthetic?{synthetic:true}:{}),...(claudeExam&&examAccessToken?{oauthAccessToken:examAccessToken}:{})};
  const signed={payload:launch,signature:sign(null,Buffer.from('agent-control:native-execution-launch:v1\n'+canonical(launch)),this.key).toString('hex')};
  // Atomic publication prevents partial JSON reads by the worker; the journal
  // and private directory make this an exclusive one-time release.
  await this.effect(principal,authority,input,async()=>{checkAbort();await writeFile(join(p.input,'launch.pending'),JSON.stringify(signed),{mode:0o600,flag:'wx'});try{await lstat(join(p.input,'launch.json'));throw new Refusal('NATIVE_EXECUTION_ALREADY_RELEASED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}checkAbort();await rename(join(p.input,'launch.pending'),join(p.input,'launch.json'));});
  await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);await c.query("UPDATE ac_native_execution_jobs SET state='running',launch_digest=$2 WHERE id=$1 AND state='uncertain'",[input.jobId,digest(launch)]);await c.query("UPDATE ac_capacity_grants SET state='running',selection=COALESCE(selection,'{}'::jsonb)||$2::jsonb WHERE id=$1 AND state='uncertain'",[input.grantId,JSON.stringify({effectiveModel,effectiveEffort})]);});
  return {state:'running' as const,jobId:input.jobId};
 }
 /** Read the original private request after a controller restart. It is never
  * reconstructed from an agent message or stored as plaintext in PostgreSQL. */
 private async registeredInput(principal:string,authority:Authority,jobId:string){
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
 private validPreLaunchExamReceipt(physical:unknown,jobId:string,synthetic:boolean){
  const parsed=PreLaunchExamPhysicalReceipt.safeParse(physical);
  return parsed.success&&parsed.data.jobId===jobId&&parsed.data.synthetic===synthetic;
 }
 private unstartedReceipt(job:Record<string,any>,physical:unknown){
  const payload={schemaVersion:1,accountId:job.account_id,profileId:job.profile_id,profileDigest:job.profile_digest,jobId:job.id,intentId:job.intent_id,contextId:job.context_id,grantId:job.grant_id,sessionId:job.session_id,epoch:Number(job.manager_epoch),inputDigest:job.input_digest,executorDigest:this.executorDigest,outputDigest:digest(''),physicalDigest:digest(physical),workerExitCode:1,artifact:null,exitCode:1,executionStarted:false};
  return {payload,signature:sign(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),this.key).toString('hex')};
 }
 private verifyUnstartedReceipt(job:Record<string,any>,grant:Record<string,any>,receipt:any,contextId:string){
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
 private unstartedRetirementBinding(row:Record<string,any>,receipt:unknown){
  return {schemaVersion:1,kind:'native-unstarted-retired',jobId:row.id,contextId:row.context_id,intentId:row.intent_id,grantId:row.grant_id,sessionId:row.session_id,epoch:Number(row.manager_epoch),role:row.role,inputDigest:row.input_digest,terminalDigest:digest(receipt),physicalDigest:digest(row.physical_receipt),workerId:null,toolsId:null,networkId:null,executionStarted:false};
 }
 private async recordUnstartedRetirement(c:pg.PoolClient,authority:Authority,row:Record<string,any>,receipt:unknown){
  const binding=this.unstartedRetirementBinding(row,receipt);
  const saved=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1 FOR UPDATE',[row.id])).rows[0];
  if(saved?.state==='removed')return this.verifyUnstartedRetirement(saved,binding);
  if(!saved){
   await c.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[row.id,binding]);
  }else if(saved.state!=='prepared'||digest(saved.binding)!==digest(binding)){
   throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  }
  const proof={payload:binding,signature:sign(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(binding)),this.key).toString('hex')};
  await c.query("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1 AND state='prepared'",[row.id,proof]);
  await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'native.terminal_retired',$2)",[authority.contextId,{jobId:row.id,proofDigest:digest(proof)}]);
 }
 private verifyUnstartedRetirement(saved:Record<string,any>,binding:ReturnType<NativeExecutionSupervisor['unstartedRetirementBinding']>){
  if(saved.state!=='removed'||digest(saved.binding)!==digest(binding)||!saved.proof?.payload||digest(saved.proof.payload)!==digest(binding)||
   typeof saved.proof.signature!=='string'||!/^[a-f0-9]{128}$/.test(saved.proof.signature)||
   !verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(saved.proof.payload)),createPublicKey(this.key),Buffer.from(saved.proof.signature,'hex')))
   throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
 }
 private async launchPendingExists(jobId:string){
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
 private async confirmUnstartedAbsence(jobId:string){
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
  const [worker,tools,network]=await Promise.all([
   this.docker.inspect('ac-native-worker-'+jobId),
   this.docker.inspect('ac-native-tools-'+jobId),
   this.docker.inspectNamedPrivateNetwork('ac-native-exec-'+jobId),
  ]);
  if(worker||tools||network||await this.launchPendingExists(jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
 }
 private async loadUnstartedExam(c:pg.PoolClient,authority:Authority,jobId:string){
  return (await c.query(`SELECT j.*,
   g.state grant_state,g.resource_kind grant_resource_kind,g.project_id grant_project_id,g.context_id grant_context_id,
   g.intent_id grant_intent_id,g.manager_epoch grant_epoch,g.account_id grant_account_id,g.profile_id grant_profile_id,
   g.role grant_role,g.physical_receipt,
   i.principal_id,i.parent_intent_id,i.state intent_state,i.command intent_command,i.digest intent_digest,i.manager_epoch intent_epoch,
   a.provider account_provider,a.mode account_mode,a.resource_identity account_resource_identity,
   p.model profile_model,p.effort profile_effort,p.role profile_role,
   EXISTS(SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal') personal,
   EXISTS(SELECT 1 FROM ac_exam_contexts e WHERE e.context_id=j.context_id) dedicated_context,
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
 private validateUnstartedExam(row:Record<string,any>|undefined,context:Record<string,any>,principal:string,authority:Authority,allowHistorical:boolean,allowRetiredExecutor=false):asserts row is Record<string,any>{
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
 private async settleUnstartedExam(c:pg.PoolClient,authority:Authority,row:Record<string,any>){
  let receipt=row.receipt;
  if(row.state==='uncertain'){
   receipt=this.unstartedReceipt(row,row.physical_receipt);
   await c.query("UPDATE ac_native_execution_jobs SET state='failed',receipt=$2 WHERE id=$1",[row.id,receipt]);
  }
  await this.recordUnstartedRetirement(c,authority,row,receipt);
  await finishExamIntentTx(c,this.ledger,{intentId:row.intent_id,contextId:authority.contextId},'failed');
  return {state:'failed' as const,retirement:'removed' as const,intentState:'failed' as const,receipt};
 }
 private async validateOptionalUnstartedRequest(jobId:string,row:Record<string,any>,allowExplicitDesign:boolean){
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
    (!allowExplicitDesign&&(request.model||request.effort||request.task.startsWith('Pedido de criação.'))))
    throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
  }finally{bytes.fill(0);}
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
 private async recoverUnstartedExamWithProof(principal:string,authority:Authority,jobId:string,localOwnerScope:PersonalExamRecoveryScope|undefined,requireRetirementProof:boolean){
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
 async reconcileRegistered(principal:string,authority:Authority,jobId:string){
  try{return await this.reconcile(principal,authority,await this.registeredInput(principal,authority,jobId));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {state:'uncertain' as const};throw error;}
 }
 /** Retire a terminal managed programmer pair. Both physical containers
  * must be absent before the permanently bound copy is marked neutralized. */
 async retireManagedWriter(principal:string,authority:Authority,jobId:string){
  const input=await this.registeredInput(principal,authority,jobId);
  if(input.role!=='programmer')throw new Refusal('NATIVE_RETIREMENT_SCOPE_MISMATCH');
  const parent=(await this.ledger.pool.query('SELECT parent_intent_id FROM ac_intents WHERE id=$1 AND context_id=$2',[input.intentId,authority.contextId])).rows[0];
  if(!parent)throw new Refusal('NATIVE_RETIREMENT_SCOPE_MISMATCH');
  if(!parent.parent_intent_id)return {state:'not_managed' as const};
  const outcome=await this.reconcile(principal,authority,input);
  if((outcome.state!=='completed'&&outcome.state!=='failed')||!('receipt' in outcome))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  const p=this.paths(jobId);await this.directory(this.config.hostRoot);await this.directory(p.root);
  const logs=[join(p.root,'worker-terminal.log'),join(p.root,'tools-terminal.log')];
  const readLog=async(path:string)=>{
   try{await readNativeSecretSnapshot(p.secretSnapshot,jobId,this.key);}catch{return quarantineNativeLegacyLog(path,jobId,this.key);}
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(error=>{
    if(['ENOENT','ELOOP'].includes(String((error as NodeJS.ErrnoException).code)))throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');throw error;
   });
   try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');
    return createHash('sha256').update(await file.readFile()).digest('hex');}finally{await file.close();}
  };
  const archive=async(path:string,raw:Buffer)=>{
   const bytes=await redactNativeLogsOrWithhold(raw,()=>readNativeSecretSnapshot(p.secretSnapshot,jobId,this.key));
   const hash=createHash('sha256').update(bytes).digest('hex');
   try{const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   if(await readLog(path)!==hash)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');return hash;
  };
  const locked=async(c:pg.PoolClient)=>{
   await this.scope(c,principal,authority,input,true);
   const row=(await c.query(`SELECT i.id intent_id,i.context_id intent_context,i.parent_intent_id,i.run_id,
    o.state operation_state,o.receipt operation_receipt,o.grant_id operation_grant,o.execution_attempt_id,o.manager_epoch operation_epoch,
    j.*,g.state grant_state,g.physical_receipt,g.intent_id grant_intent,g.context_id grant_context,g.manager_epoch grant_epoch,g.role grant_role,g.attempt_id grant_attempt,
    g.account_id grant_account,g.profile_id grant_profile,g.resource_kind grant_resource_kind,
    w.holder_intent_id,w.manager_epoch writer_epoch,w.state writer_state,w.proof_digest,w.revocation_job_id,w.revocation_proof,
    EXISTS(SELECT 1 FROM ac_plan_cancellations x WHERE x.intent_id=i.id AND x.context_id=i.context_id) cancellation_requested
    FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_operations o ON o.id=j.id AND o.intent_id=j.intent_id
    JOIN ac_intents i ON i.id=j.intent_id JOIN ac_worktree_writers w ON w.parent_intent_id=i.parent_intent_id AND w.run_id=i.run_id
    WHERE j.id=$1 AND j.context_id=$2 AND j.grant_id=$3 FOR UPDATE OF j,g,o,w`,[jobId,authority.contextId,input.grantId])).rows[0];
   const continuationDigest=row&&Number(row.writer_epoch)!==Number(row.manager_epoch)?await verifiedWorktreeWriterContinuation(c,{parentIntentId:row.parent_intent_id,runId:row.run_id,intentId:row.intent_id,writerEpoch:Number(row.writer_epoch),epoch:Number(row.manager_epoch)}):undefined;
   if(row)row.writer_continuation_digest=continuationDigest;
   const receipt=row?.receipt,payload=receipt?.payload,physical=row?.physical_receipt;
   if(!row||row.role!=='programmer'||!['completed','failed'].includes(row.state)||row.grant_state!=='released'||row.operation_state!=='completed'||
    row.intent_id!==input.intentId||row.intent_context!==authority.contextId||row.grant_context!==authority.contextId||row.grant_intent!==row.intent_id||
    row.grant_role!=='programmer'||row.grant_resource_kind!=='model'||row.grant_account!==row.account_id||row.grant_profile!==row.profile_id||
    row.operation_grant!==row.grant_id||row.grant_attempt!==row.execution_attempt_id||
    Number(row.grant_epoch)!==Number(row.manager_epoch)||(Number(row.writer_epoch)!==Number(row.manager_epoch)&&!continuationDigest)||Number(row.operation_epoch)>authority.epoch||
    row.holder_intent_id!==row.intent_id||row.executor_digest!==this.executorDigest||row.key_fingerprint!==this.fingerprint||row.input_digest!==digest(input)||
    row.session_id!==input.sessionId||!payload||typeof receipt.signature!=='string'||!/^[a-f0-9]{128}$/.test(receipt.signature)||
    !verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(receipt.signature,'hex'))||
    payload.jobId!==jobId||payload.intentId!==row.intent_id||payload.contextId!==authority.contextId||payload.grantId!==row.grant_id||payload.sessionId!==row.session_id||
    payload.epoch!==Number(row.manager_epoch)||payload.inputDigest!==row.input_digest||payload.executorDigest!==this.executorDigest||
    ((payload.exitCode===0)!==(row.state==='completed'))||
    payload.accountId!==row.account_id||payload.profileId!==row.profile_id||payload.profileDigest!==row.profile_digest||
    !physical||physical.exitCode!==payload.exitCode||physical.workerExitCode!==payload.workerExitCode||payload.physicalDigest!==digest(physical)||
    !row.operation_receipt?.nativeExecution||digest(row.operation_receipt.nativeExecution)!==digest(receipt)||
    !/^[a-f0-9]{64}$/.test(String(row.worker_id??''))||!/^[a-f0-9]{64}$/.test(String(row.tools_id??''))||row.worker_id===row.tools_id||
    physical.containerId!==row.worker_id||physical.toolsContainerId!==row.tools_id||physical.networkId!==row.network_id||
    !/^[a-f0-9]{64}$/.test(String(row.network_id??''))||row.network_id===this.config.providerNetworkId||
    (row.operation_receipt.cancellation===true?!row.cancellation_requested:
     (row.operation_receipt.exitCode!==payload.exitCode||(row.state==='completed'&&(!payload.artifact||
      row.operation_receipt.commit!==payload.artifact.commit||row.operation_receipt.tree!==payload.artifact.tree||row.operation_receipt.base!==payload.artifact.base||payload.artifact.base!==input.base))))||
    !Number.isFinite(Date.parse(physical.finishedAt))||!Number.isFinite(Date.parse(physical.toolsFinishedAt))||
    String(physical.finishedAt).startsWith('0001-')||String(physical.toolsFinishedAt).startsWith('0001-'))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   return row;
  };
  const pair=async(row:Record<string,any>,allowMissing:boolean)=>{
   const worker=await this.docker.inspect('ac-native-worker-'+jobId),tools=await this.docker.inspect('ac-native-tools-'+jobId);
   for(const [container,id,image,finished] of [[worker,row.worker_id,this.config.workerImage,row.physical_receipt.finishedAt],
    [tools,row.tools_id,this.config.toolsImage,row.physical_receipt.toolsFinishedAt]] as const){
    if(!container){if(!allowMissing)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');continue;}
    if(container.Id!==id||container.Image!==image||container.Config.Labels['agent-control.job']!==jobId||container.Config.Labels['agent-control.launch']!==row.input_digest||
     container.Config.Labels['agent-control.contract']!=='native-execution-v1'||container.State.Running||container.State.Status!=='exited'||container.State.FinishedAt!==finished||
     (id===row.worker_id&&container.State.ExitCode!==row.physical_receipt.workerExitCode))
     throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   }
   return [worker,tools] as const;
  };
  const payloadFor=(row:Record<string,any>,saved:Record<string,any>)=>({schemaVersion:1,kind:'native-container-pair-removed',jobId,
   contextId:row.context_id,grantId:row.grant_id,attemptId:row.grant_attempt,parentIntentId:row.parent_intent_id,runId:row.run_id,
   holderIntentId:row.intent_id,writerEpoch:Number(row.writer_epoch),...(row.writer_continuation_digest?{writerContinuationDigest:row.writer_continuation_digest}:{}),workerId:saved.worker_id,toolsId:saved.tools_id,terminalDigest:saved.terminal_digest,
   workerLogSha256:saved.worker_log_sha256,toolsLogSha256:saved.tools_log_sha256});
  const checked=async(row:Record<string,any>,saved:Record<string,any>|undefined)=>{
   if(!saved||saved.parent_intent_id!==row.parent_intent_id||saved.run_id!==row.run_id||saved.holder_intent_id!==row.intent_id||
    Number(saved.writer_epoch)!==Number(row.writer_epoch)||saved.worker_id!==row.worker_id||saved.tools_id!==row.tools_id||saved.terminal_digest!==digest(row.receipt)||
    await readLog(logs[0]!)!==saved.worker_log_sha256||await readLog(logs[1]!)!==saved.tools_log_sha256)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  };
  const removeNetwork=async(row:Record<string,any>)=>retireNativePrivateNetwork(this.docker,{networkId:row.network_id,
   providerNetworkId:this.config.providerNetworkId,jobId,inputDigest:row.input_digest});
  const revoked=async(row:Record<string,any>,saved:Record<string,any>|undefined)=>{
   await checked(row,saved);const proof=saved!.proof;
   if(saved!.state!=='revoked'||row.revocation_job_id!==jobId||!proof?.payload||digest(proof.payload)!==digest(payloadFor(row,saved!))||
    typeof proof.signature!=='string'||!/^[a-f0-9]{128}$/.test(proof.signature)||
    !verify(null,Buffer.from('agent-control:native-writer-retirement:v1\n'+canonical(proof.payload)),createPublicKey(this.key),Buffer.from(proof.signature,'hex'))||
    digest(proof)!==row.proof_digest||digest(proof)!==digest(row.revocation_proof))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   if(await this.docker.inspect(saved!.worker_id)||await this.docker.inspect(saved!.tools_id)||
    await this.docker.inspect('ac-native-worker-'+jobId)||await this.docker.inspect('ac-native-tools-'+jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await removeNetwork(row);
  };
  const prepared=await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_writer_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   if(row.writer_state==='neutralized'){await revoked(row,saved);return true;}
   if(row.writer_state!=='held')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await pair(row,Boolean(saved));
   if(!saved){
    const workerHash=await archive(logs[0]!,await this.docker.logs(row.worker_id)),toolsHash=await archive(logs[1]!,await this.docker.logs(row.tools_id));
    await c.query(`INSERT INTO ac_native_writer_retirements(job_id,parent_intent_id,run_id,holder_intent_id,writer_epoch,worker_id,tools_id,terminal_digest,worker_log_sha256,tools_log_sha256,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prepared')`,[jobId,row.parent_intent_id,row.run_id,row.intent_id,row.writer_epoch,row.worker_id,row.tools_id,digest(row.receipt),workerHash,toolsHash]);
   }else{if(saved.state!=='prepared')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');await checked(row,saved);}
   return false;
  });
  if(prepared){await this.removeLaunchFiles(jobId);return {state:'neutralized' as const};}
  const neutralized=await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_writer_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   if(row.writer_state==='neutralized'){await revoked(row,saved);return {state:'neutralized' as const};}
   if(row.writer_state!=='held'||saved?.state!=='prepared')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await checked(row,saved);const observed=await pair(row,true);
   for(const container of observed)if(container)await this.docker.remove(container.Id);
   if(await this.docker.inspect(saved.worker_id)||await this.docker.inspect(saved.tools_id)||
    await this.docker.inspect('ac-native-worker-'+jobId)||await this.docker.inspect('ac-native-tools-'+jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await removeNetwork(row);
   const payload=payloadFor(row,saved),proof={payload,signature:sign(null,Buffer.from('agent-control:native-writer-retirement:v1\n'+canonical(payload)),this.key).toString('hex')};
   await c.query("UPDATE ac_native_writer_retirements SET state='revoked',proof=$2 WHERE job_id=$1 AND state='prepared'",[jobId,proof]);
   const changed=await c.query(`UPDATE ac_worktree_writers SET state='neutralized',proof_digest=$5,revocation_job_id=$6,revocation_proof=$7
    WHERE parent_intent_id=$1 AND run_id=$2 AND holder_intent_id=$3 AND manager_epoch=$4 AND state='held'`,
    [row.parent_intent_id,row.run_id,row.intent_id,row.writer_epoch,digest(proof),jobId,proof]);
   if(!changed.rowCount)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'worktree.native_writer_revoked',$2)",[authority.contextId,{jobId,parentIntentId:row.parent_intent_id,runId:row.run_id,proofDigest:digest(proof)}]);
   return {state:'neutralized' as const};
  });
  await this.removeLaunchFiles(jobId);
  return neutralized;
 }
 /** Retire terminal resources only after their execution and downstream evidence are durable.
  * Managed writers use their separate worktree-neutralization protocol. */
 async retireTerminal(principal:string,authority:Authority,jobId:string){
  const input=await this.registeredInput(principal,authority,jobId);
  const outcome=await this.reconcile(principal,authority,input);
  if((outcome.state!=='completed'&&outcome.state!=='failed')||!('receipt' in outcome))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  const p=this.paths(jobId);await this.directory(this.config.hostRoot);await this.directory(p.root);
  const paths=[join(p.root,'worker-terminal.log'),join(p.root,'tools-terminal.log')];
  const readLog=async(path:string)=>{
   try{await readNativeSecretSnapshot(p.secretSnapshot,jobId,this.key);}catch{return quarantineNativeLegacyLog(path,jobId,this.key);}
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(error=>{if(['ENOENT','ELOOP'].includes(String((error as NodeJS.ErrnoException).code)))throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');throw error;});
   try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');return createHash('sha256').update(await file.readFile()).digest('hex');}finally{await file.close();}
  };
  const archive=async(path:string,raw:Buffer)=>{
   const bytes=await redactNativeLogsOrWithhold(raw,()=>readNativeSecretSnapshot(p.secretSnapshot,jobId,this.key));
   if(bytes.length>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');
   const hash=createHash('sha256').update(bytes).digest('hex');
   try{const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}}
   catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
   if(await readLog(path)!==hash)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');return hash;
  };
  const locked=async(c:pg.PoolClient)=>{
   await this.scope(c,principal,authority,input,true);
   const row=(await c.query(`SELECT j.*,g.state grant_state,g.physical_receipt,g.manager_epoch grant_epoch,g.intent_id grant_intent,g.context_id grant_context,g.account_id grant_account,g.profile_id grant_profile,g.role grant_role,g.resource_kind,
    i.parent_intent_id FROM ac_native_execution_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_intents i ON i.id=j.intent_id AND i.context_id=j.context_id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[jobId,authority.contextId])).rows[0];
   const physical=row?.physical_receipt,receipt=row?.receipt,payload=receipt?.payload;
   if(!row||row.role!==input.role||(input.role==='programmer'&&row.parent_intent_id)||row.grant_state!=='released'||!['completed','failed'].includes(row.state)||
    row.input_digest!==digest(input)||row.executor_digest!==this.executorDigest||row.key_fingerprint!==this.fingerprint||row.intent_id!==input.intentId||row.grant_id!==input.grantId||row.session_id!==input.sessionId||
    row.grant_intent!==row.intent_id||row.grant_context!==row.context_id||row.grant_account!==row.account_id||row.grant_profile!==row.profile_id||row.grant_role!==row.role||row.resource_kind!=='model'||Number(row.grant_epoch)!==Number(row.manager_epoch)||Number(row.manager_epoch)>authority.epoch||
    digest(receipt)!==digest(outcome.receipt)||!payload||typeof receipt.signature!=='string'||!/^[a-f0-9]{128}$/.test(receipt.signature)||!verify(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),createPublicKey(this.key),Buffer.from(receipt.signature,'hex'))||
    payload.jobId!==jobId||payload.contextId!==row.context_id||payload.intentId!==row.intent_id||payload.grantId!==row.grant_id||payload.sessionId!==row.session_id||payload.epoch!==Number(row.manager_epoch)||payload.inputDigest!==row.input_digest||payload.executorDigest!==this.executorDigest||
    !physical||payload.physicalDigest!==digest(physical)||physical.jobId!==jobId||physical.containerId!==row.worker_id||physical.toolsContainerId!==row.tools_id||physical.networkId!==row.network_id||physical.exitCode!==payload.exitCode||physical.workerExitCode!==payload.workerExitCode||((payload.exitCode===0)!==(row.state==='completed'))||
    !/^[a-f0-9]{64}$/.test(String(row.worker_id))||!/^[a-f0-9]{64}$/.test(String(row.tools_id))||row.worker_id===row.tools_id||!/^[a-f0-9]{64}$/.test(String(row.network_id))||row.network_id===this.config.providerNetworkId||
    !Number.isFinite(Date.parse(physical.finishedAt))||!Number.isFinite(Date.parse(physical.toolsFinishedAt))||String(physical.finishedAt).startsWith('0001-')||String(physical.toolsFinishedAt).startsWith('0001-'))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   if((input.role==='specialist'||input.role==='reviewer')&&['completed','failed'].includes(row.state)&&await this.personalReadonlyExam(c,input.intentId,input.role))return row;
   // Cancellation is terminal only once its independently persisted stage receipt is bound.
   const cancellation=(await c.query("SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1 AND context_id=$2",[input.intentId,authority.contextId])).rowCount;
   if(cancellation&&input.role!=='programmer'){
    const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[jobId,input.intentId])).rows[0];
    if(stage?.state!=='completed'||stage.grant_id!==input.grantId||stage.session_id!==input.sessionId||stage.receipt?.cancellation!==true||digest(stage.receipt.nativeExecution)!==digest(receipt))throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   }else if(row.state==='completed'&&['reviewer','judge'].includes(input.role)){
    const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[jobId,input.intentId])).rows[0];
    const evidence=stage?.receipt?.verification;
    // A reviewer that returned no usable verdict leaves no evidence; its closed stage is the terminal proof.
    if(stage?.state==='completed'&&stage.receipt?.invalidVerdict===true&&stage.grant_id===input.grantId&&stage.session_id===input.sessionId&&digest(stage.receipt.nativeExecution)===digest(receipt))return row;
    const stored=evidence&&(await c.query('SELECT receipt,receipt_digest FROM ac_verification_evidence WHERE id=$1 AND grant_id=$2 AND session_id=$3',[evidence.id,input.grantId,input.sessionId])).rows[0];
    if(stage?.state!=='completed'||stage.grant_id!==input.grantId||stage.session_id!==input.sessionId||digest(stage.receipt.nativeExecution)!==digest(receipt)||!stored||digest(stored.receipt)!==digest(evidence)||stored.receipt_digest!==digest(evidence))throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   }else if(input.role==='programmer'){
    const op=(await c.query('SELECT state,receipt FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[jobId,input.intentId])).rows[0];
    if(op?.state!=='completed'||digest(op.receipt?.nativeExecution)!==digest(receipt))throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   }else if(input.role==='qa'&&row.state==='completed'){
    const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[jobId,input.intentId])).rows[0];
    const verdict=stage?.receipt?.qaModel?.verdict;
    if(stage?.state!=='completed'||stage.grant_id!==input.grantId||stage.session_id!==input.sessionId||stage.node_id!=='qa'||(verdict!=='pass'&&verdict!=='reject')||digest(stage.receipt?.nativeExecution)!==digest(receipt))throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   }else if(row.state==='completed')throw new Refusal('NATIVE_RETIREMENT_EVIDENCE_MISSING');
   return row;
  };
  const pair=async(row:Record<string,any>,allowMissing:boolean)=>{
   const worker=await this.docker.inspect('ac-native-worker-'+jobId),tools=await this.docker.inspect('ac-native-tools-'+jobId);
   for(const [item,id,image,finished] of [[worker,row.worker_id,this.config.workerImage,row.physical_receipt.finishedAt],[tools,row.tools_id,this.config.toolsImage,row.physical_receipt.toolsFinishedAt]] as const){
    if(!item){if(!allowMissing)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');continue;}
    if(item.Id!==id||item.Image!==image||item.Config.Labels['agent-control.job']!==jobId||item.Config.Labels['agent-control.launch']!==row.input_digest||item.Config.Labels['agent-control.contract']!=='native-execution-v1'||item.State.Running||item.State.Status!=='exited'||item.State.FinishedAt!==finished||(id===row.worker_id&&item.State.ExitCode!==row.physical_receipt.workerExitCode))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   }return [worker,tools] as const;
  };
  const binding=(row:Record<string,any>,hashes:string[])=>({schemaVersion:1,jobId,contextId:row.context_id,intentId:row.intent_id,grantId:row.grant_id,sessionId:row.session_id,epoch:Number(row.manager_epoch),role:row.role,inputDigest:row.input_digest,terminalDigest:digest(row.receipt),workerId:row.worker_id,toolsId:row.tools_id,networkId:row.network_id,workerLogSha256:hashes[0],toolsLogSha256:hashes[1]});
  const check=async(row:Record<string,any>,saved:Record<string,any>)=>{
   if(!saved||digest(saved.binding)!==digest(binding(row,[await readLog(paths[0]!),await readLog(paths[1]!)])))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   if(saved.state==='removed'&&(!saved.proof?.payload||digest(saved.proof.payload)!==digest(saved.binding)||typeof saved.proof.signature!=='string'||!/^[a-f0-9]{128}$/.test(saved.proof.signature)||!verify(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(saved.proof.payload)),createPublicKey(this.key),Buffer.from(saved.proof.signature,'hex'))))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  };
  await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   await pair(row,Boolean(saved));
   if(saved){await check(row,saved);return;}
   const hashes=[await archive(paths[0]!,await this.docker.logs(row.worker_id)),await archive(paths[1]!,await this.docker.logs(row.tools_id))];
   // Persist directory entries before committing the prepared journal.
   const dir=await open(p.root,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
   await c.query("INSERT INTO ac_native_terminal_retirements(job_id,binding,state) VALUES($1,$2,'prepared')",[jobId,binding(row,hashes)]);
  });
  const retired=await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_terminal_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];await check(row,saved);
   const items=await pair(row,true);if(saved.state==='removed'&&items.some(Boolean))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   for(const item of items)if(item)await this.docker.remove(item.Id);
   if(await this.docker.inspect(row.worker_id)||await this.docker.inspect(row.tools_id)||await this.docker.inspect('ac-native-worker-'+jobId)||await this.docker.inspect('ac-native-tools-'+jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await retireNativePrivateNetwork(this.docker,{networkId:row.network_id,providerNetworkId:this.config.providerNetworkId,jobId,inputDigest:row.input_digest});
   if(saved.state==='prepared'){
    const proof={payload:saved.binding,signature:sign(null,Buffer.from('agent-control:native-terminal-retirement:v1\n'+canonical(saved.binding)),this.key).toString('hex')};
    await c.query("UPDATE ac_native_terminal_retirements SET state='removed',proof=$2 WHERE job_id=$1 AND state='prepared'",[jobId,proof]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'native.terminal_retired',$2)",[authority.contextId,{jobId,proofDigest:digest(proof)}]);
   }else if(saved.state!=='removed')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   return {state:'removed' as const};
  });
  await this.removeLaunchFiles(jobId);
  return retired;
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
 private async validateReplay(principal:string,authority:Authority,input:Input,row:Record<string,any>){
  await this.ledger.tx(async c=>{const context=await this.scope(c,principal,authority,input,true);await this.jobRepository(c,String(context.project_id));});
  if(row.context_id!==authority.contextId||row.intent_id!==input.intentId||row.grant_id!==input.grantId||row.session_id!==input.sessionId||row.input_digest!==digest(input)||row.executor_digest!==this.executorDigest||row.key_fingerprint!==this.fingerprint||Number(row.manager_epoch)>authority.epoch)throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
 }
 /** Checkout registered for the job's project. Compared after realpath.
  * config.repository, when present, is an extra pin: only that checkout is valid. */
 private async jobRepository(c:pg.Pool|pg.PoolClient,projectId:string){
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
 private async removeLaunchFiles(jobId:string){
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
 /** Same worker, tools container and grant. Re-prepares Claude exam tokens (never reusing old tokens), renews launch expiry, then starts the exited pair again. */
 private async resumeExecutionContainers(input:Input,job:Record<string,any>,workerId:string,toolsId:string):Promise<{resumed:true}|{resumed:false;failureCode:string}>{
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
    try{existingSecrets=await readNativeSecretSnapshot(p.secretSnapshot,input.jobId,this.key);}catch{}
    const tempSnap=p.secretSnapshot+'.pending.'+randomBytes(6).toString('hex');
    try{
     await writeNativeSecretSnapshot(tempSnap,input.jobId,this.key,[...new Set([...existingSecrets,...prepared.secrets])]);
     await rename(tempSnap,p.secretSnapshot);
    }catch(snapError){
     await rm(tempSnap,{force:true}).catch(()=>undefined);
     throw snapError;
    }
   }catch(error){
    await this.removeLaunchFiles(input.jobId).catch(()=>undefined);
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
   await rm(pending,{force:true}).catch(()=>undefined);
   await this.removeLaunchFiles(input.jobId).catch(()=>undefined);
   const code=error instanceof Refusal?error.code:(error as NodeJS.ErrnoException)?.code;
   return {resumed:false,failureCode:safeFailureCode(code,'NATIVE_EXECUTION_RESUME_FAILED')};
  }
  await rm(join(p.output,'execution-result.json'),{force:true});
  await this.docker.start(toolsId);await this.docker.start(workerId);
  return {resumed:true};
 }
 private async readResult(input:Input,exitCode:number){
  const p=this.paths(input.jobId);await this.directory(p.root);await this.directory(p.output);
  let result:z.infer<typeof Result>;
  try{const file=await open(join(p.output,'execution-result.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>2*1024*1024)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');const bytes=await file.readFile();if(bytes.length>2*1024*1024)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');result=Result.parse(JSON.parse(bytes.toString('utf8')));}finally{await file.close();}}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'||exitCode===0)throw error;result={schemaVersion:1,jobId:input.jobId,output:'',normalizedTokensUsed:null,usageWindows:null,nativeSessionId:null,failureCode:'WORKER_EXITED_WITHOUT_RESULT',exitCode:exitCode};}
  return result;
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
    ((payload.exitCode===0)!==(job.state==='completed')))throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');
   if(payload.executionStarted===false&&this.validPreLaunchExamReceipt(grant.physical_receipt,job.id,Boolean(this.config.syntheticFixture))){
    this.verifyUnstartedReceipt(job,grant,receipt,authority.contextId);
    return {state:'failed',receipt,output:'',artifact:null,failureCode:grant.physical_receipt.reason};
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
  const physical={jobId:input.jobId,containerId:worker.Id,toolsContainerId:tools.Id,networkId:job.network_id,exitCode:effectiveExitCode,workerExitCode:worker.State.ExitCode,finalization,finishedAt:worker.State.FinishedAt,toolsFinishedAt:tools.State.FinishedAt,synthetic:Boolean(this.config.syntheticFixture),executorDigest:this.executorDigest,nativeSessionId:result.nativeSessionId,normalizedTokensUsed:result.normalizedTokensUsed,usageWindows:result.usageWindows,
   ...(input.moduleExam?{failureCode:result.failureCode}:{})};
  const payload={schemaVersion:1,accountId:job.account_id,profileId:job.profile_id,profileDigest:job.profile_digest,jobId:input.jobId,intentId:input.intentId,contextId:authority.contextId,grantId:input.grantId,sessionId:input.sessionId,epoch:Number(job.manager_epoch),inputDigest:job.input_digest,executorDigest:this.executorDigest,outputDigest:digest(result.output),physicalDigest:digest(physical),workerExitCode:result.exitCode,artifact,exitCode:effectiveExitCode};
  const receipt={payload,signature:sign(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),this.key).toString('hex')};
  await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);const saved=(await c.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1 FOR UPDATE',[input.jobId])).rows[0];if(['completed','failed'].includes(saved.state)){if(digest(saved.receipt)!==digest(receipt))throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');return;}
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
   if(!grant||grant.account_id!==job.account_id||grant.profile_id!==job.profile_id||grant.role!==job.role||grant.resource_kind!=='model'||grant.intent_id!==input.intentId||grant.context_id!==authority.contextId||Number(grant.manager_epoch)!==Number(job.manager_epoch)||!['uncertain','running'].includes(grant.state))throw new Refusal('NATIVE_EXECUTION_GRANT_MISMATCH');
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
 /** Register only the exact finalized artifact; Quality still requires
  * independent QA/review and authorized integration. No branch is changed. */
 async registerArtifact(principal:string,authority:Authority,jobId:string,quality:Quality){
  if(quality.ledger!==this.ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
  const input=await this.registeredInput(principal,authority,jobId),outcome=await this.reconcile(principal,authority,input);
  if(outcome.state!=='completed'||!('artifact' in outcome)||!outcome.artifact||input.role!=='programmer')throw new Refusal('NATIVE_ARTIFACT_NOT_READY');
  const artifact=NativeArtifactIdentity.parse(outcome.artifact);
  const secrets=await readNativeArtifactSecrets(this.paths(jobId).secretSnapshot,jobId,this.key);
  await new GitArtifacts(this.paths(jobId).work).assertNoNewArtifactSecrets(artifact.commit,artifact.base,secrets);
  const revision=await this.ledger.tx(async c=>{const context=await this.scope(c,principal,authority,input,false);
   const contract=(await c.query('SELECT quality_revision,target_ref,digest FROM ac_execution_contracts WHERE intent_id=$1',[input.intentId])).rows[0];
   if(!contract||contract.digest!==digest({qualityRevision:contract.quality_revision,targetRef:contract.target_ref}))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
   const repository=await this.jobRepository(c,String(context.project_id));
   const identity=await new GitArtifacts(repository).import(this.paths(jobId).work,artifact.commit,artifact.base);
   if(identity.tree!==artifact.tree||identity.legacyDigest!==artifact.legacyDigest)throw new Refusal('NATIVE_ARTIFACT_IDENTITY_MISMATCH');return contract.quality_revision;
  });
  const hash=digest({domain:'artifact-v1',intentId:input.intentId,commit:artifact.commit}),id=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  const risk=await this.ledger.tx(c=>expectedArtifactRisk(c,input.intentId,authority.contextId,revision));
  return quality.register(principal,{id,contextId:authority.contextId,intentId:input.intentId,implementationGrantId:input.grantId,implementationSessionId:input.sessionId,policyRevision:revision,commit:artifact.commit,tree:artifact.tree,base:artifact.base,risk},authority);
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
 private async launchPublished(jobId:string){
  try{const s=await lstat(join(this.paths(jobId).input,'launch.json'));if(!s.isFile()||s.isSymbolicLink())throw new Refusal('NATIVE_EXECUTION_LAUNCH_UNCERTAIN');return true;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 }
}
function dockerUncertain(error:unknown){return error instanceof Refusal&&error.code.startsWith('DOCKER_')&&error.code!=='DOCKER_CREATE_REFUSED';}
export type NativeExecutionRecovery={state:'uncertain'|'released_unstarted'|'acknowledged';interval:'docker_response_lost'|'before_terminal_evidence'|'network_or_container_remains'|'supervisor_identity'|'proven_not_started'|'terminal_evidence_missing'|'ack_lost'|'network_unproven';grant:'preserved'|'released';removed:string[];replayed:false;receipt?:unknown};
