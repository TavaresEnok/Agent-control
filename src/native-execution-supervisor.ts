import {constants} from 'node:fs';
import {mkdir,lstat,realpath,writeFile,open,rename} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createPrivateKey,createPublicKey,sign,createHash,randomBytes,verify} from 'node:crypto';
import {z} from 'zod';
import type pg from 'pg';
import {Ledger} from './ledger.ts';
import {Authority,canonical,digest,Refusal} from './contracts.ts';
import {DockerDaemon} from './sandbox-broker.ts';
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
const Id=z.uuid(),Hash=z.string().regex(/^[a-f0-9]{64}$/),GitId=z.string().regex(/^[a-f0-9]{40}$/);
const Path=z.string().min(1).max(240).refine(p=>!p.startsWith('/')&&!p.includes('\\')&&!/[\x00-\x1f*?\[\]{}]/.test(p)&&!p.split('/').some(s=>!s||['.','..','.git','.ai'].includes(s)));
export const NativeExecutionRequest=z.object({jobId:Id,intentId:Id,grantId:Id,sessionId:Id,base:GitId,
 role:z.enum(['programmer','qa','reviewer','judge','specialist']),task:z.string().min(1).max(100000),writePaths:z.array(Path).max(64),
 artifactId:Id.optional(),outputSchema:z.record(z.string(),z.unknown()).optional(),timeoutMs:z.number().int().min(1000).max(1800000).default(900000)}).strict().superRefine((v,c)=>{
 if(v.role==='programmer'&&!v.writePaths.length)c.addIssue({code:'custom',message:'PROGRAMMER_SCOPE_REQUIRED'});
 if(v.role!=='programmer'&&(!v.artifactId||!v.outputSchema||v.writePaths.length))c.addIssue({code:'custom',message:'READONLY_ARTIFACT_REQUIRED'});
});
type Input=z.infer<typeof NativeExecutionRequest>;
export type NativeExecutionSupervisorConfig={id:string;workerImage:string;toolsImage:string;hostRoot:string;accountRoot:string;repository:string;
 protectedRepositories:readonly string[];signingKeyPem:string;providerNetworkId:string;socketPath?:string;accountSubjects:readonly {accountId:string;subjectDigest:string}[];
 workerEnv:readonly string[];toolsEnv:readonly string[]};
export type NativeExecutionOutcome={state:'running'|'uncertain'}|{state:'completed'|'failed';receipt:{payload:Record<string,any>;signature:string};output:string;artifact:z.infer<typeof NativeArtifactIdentity>|null};
const Result=z.object({schemaVersion:z.literal(1),jobId:Id,output:z.string().max(262144),normalizedTokensUsed:z.number().int().safe().nonnegative().nullable(),usageWindows:usageWindowsObservationSchema.nullable(),nativeSessionId:z.string().nullable(),failureCode:z.string().nullable(),exitCode:z.number().int()}).strict();
export {nativeExecutionExecutorDigest};
const toolsEntrypoint=['node','/opt/agent-control/dist/src/native-tools-worker.mjs'];
const workerEntrypoint=['node','/opt/agent-control/dist/src/native-execution-worker.mjs'];
/** Effect supervisor only. A trusted Cezar stage must already own the grant,
 * frozen source and policy. No scheduler, inference on construction, fallback,
 * approval or Git integration occurs here. Production bootstrap does not construct
 * this supervisor; configured opt-in stays activation-blocked. */
export class NativeExecutionSupervisor{
 readonly executorDigest:string;
 supportsAccount(accountId:string){return this.subjects.has(accountId);}
 get keyFingerprint(){return this.fingerprint;}private readonly key;private readonly publicKey:string;private readonly fingerprint:string;
 private readonly subjects=new Map<string,string>();private readonly docker:DockerDaemon;private readonly user:string;
 private readonly effectTails=new Map<string,Promise<void>>();
 constructor(readonly ledger:Ledger,private readonly config:NativeExecutionSupervisorConfig,private readonly diskGuard:DiskGuard|undefined=diskGuardFromEnvironment()){
  z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/).parse(config.id);
  for(const image of [config.workerImage,config.toolsImage])z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(image);
  Hash.parse(config.providerNetworkId);
  const uid=process.getuid?.(),gid=process.getgid?.();if(!uid||!gid)throw new Refusal('NATIVE_WORKER_NON_ROOT_REQUIRED');this.user=`${uid}:${gid}`;
  if([config.hostRoot,config.accountRoot,config.repository,...config.protectedRepositories].some(p=>resolve(p)!==p)||
   [config.accountRoot,config.repository,...config.protectedRepositories].some(p=>p===config.hostRoot||p.startsWith(config.hostRoot+sep)||config.hostRoot.startsWith(p+sep))||[config.repository,...config.protectedRepositories].some(p=>p===config.accountRoot||p.startsWith(config.accountRoot+sep)||config.accountRoot.startsWith(p+sep)))throw new Refusal('NATIVE_EXECUTION_PATH_INVALID');
  this.config=Object.freeze({...config,workerEnv:Object.freeze([...config.workerEnv]),toolsEnv:Object.freeze([...config.toolsEnv]),protectedRepositories:Object.freeze([...config.protectedRepositories]),accountSubjects:Object.freeze(config.accountSubjects.map(x=>Object.freeze({...x})))});
  for(const item of config.accountSubjects){Id.parse(item.accountId);Hash.parse(item.subjectDigest);if(this.subjects.has(item.accountId))throw new Refusal('NATIVE_EXECUTION_ACCOUNT_DUPLICATE');this.subjects.set(item.accountId,item.subjectDigest);}
  this.key=createPrivateKey(config.signingKeyPem);if(this.key.asymmetricKeyType!=='ed25519')throw new Refusal('NATIVE_EXECUTION_KEY_INVALID');
  const pub=createPublicKey(this.key);this.publicKey=pub.export({format:'pem',type:'spki'}).toString();this.fingerprint=createHash('sha256').update(pub.export({format:'der',type:'spki'})).digest('hex');
  this.executorDigest=nativeExecutionExecutorDigest(config.workerImage,config.toolsImage);this.docker=new DockerDaemon(config.socketPath);
 }
 private paths(id:string){Id.parse(id);const root=join(this.config.hostRoot,id);return {root,input:join(root,'input'),output:join(root,'output'),planning:join(root,'planning'),work:join(root,'work'),key:join(root,'public.pem'),workerToken:join(root,'worker-token'),toolsToken:join(root,'tools-token')};}
 private async directory(path:string){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o7777)!==0o700||await realpath(path)!==path)throw new Refusal('NATIVE_EXECUTION_DIRECTORY_UNSAFE');}
 private async scope(c:pg.PoolClient,principal:string,authority:Authority,input:Input,paused=false){
  const context=await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,paused);if(!paused)await this.ledger.assertIntentActive(c,authority.contextId,input.intentId);
  const intent=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[input.intentId,authority.contextId])).rows[0];
  if(intent?.principal_id!==principal)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');return context;
 }
 private async identity(c:pg.PoolClient,principal:string,authority:Authority,input:Input){
  const context=await this.scope(c,principal,authority,input);
  const registered=(await c.query('SELECT repo FROM ac_project_repositories WHERE project_id=$1',[context.project_id])).rows[0];
  if(registered?.repo!==this.config.repository)throw new Refusal('NATIVE_EXECUTION_REPOSITORY_MISMATCH');
  const g=(await c.query(`SELECT g.*,a.provider,a.mode,a.enabled account_enabled,a.eligibility,a.resource_identity,p.enabled profile_enabled,p.model,p.effort,p.role profile_role
   FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id JOIN ac_profiles p ON p.id=g.profile_id AND p.account_id=a.id
   JOIN ac_account_access x ON x.account_id=a.id AND x.project_id=g.project_id JOIN ac_quota_observations q ON q.account_id=a.id
   WHERE g.id=$1 AND q.status='available' AND q.expires_at>clock_timestamp() FOR UPDATE OF g FOR SHARE OF a,p,x`,[input.grantId])).rows[0];
  if(!g||g.state!=='reserved'||g.resource_kind!=='model'||g.context_id!==authority.contextId||g.project_id!==context.project_id||g.intent_id!==input.intentId||Number(g.manager_epoch)!==authority.epoch||g.role!==input.role||g.profile_role!==input.role||g.provider!=='codex'||g.mode!=='subscription_cli'||g.eligibility!=='documented_supported'||!g.account_enabled||!g.profile_enabled||!this.subjects.has(g.account_id)||g.resource_identity!=='codex:'+this.subjects.get(g.account_id))throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
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
   if(synthetic)throw new Refusal('NATIVE_EXECUTION_RECIPE_NOT_ACTIVATED');
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
  const grant=(await c.query(`SELECT g.*,p.model,p.effort FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id
   JOIN ac_profiles p ON p.id=g.profile_id AND p.account_id=a.id JOIN ac_quota_observations q ON q.account_id=a.id
   JOIN ac_provider_eligibility_assessments e ON e.account_id=a.id AND e.revision=$2
   WHERE g.id=$1 AND g.state='uncertain' AND a.enabled AND p.enabled AND p.role=g.role AND a.provider='codex' AND a.mode='subscription_cli'
    AND a.eligibility='documented_supported' AND q.status='available' AND q.expires_at>clock_timestamp()
    AND e.status='documented_supported' AND e.expires_at>clock_timestamp() AND e.adapter_id=$3 AND e.adapter_version=$4
    AND e.revision=(SELECT max(revision) FROM ac_provider_eligibility_assessments WHERE account_id=a.id)
   FOR UPDATE OF g FOR SHARE OF a,p,q,e`,[input.grantId,job.eligibility_revision,this.config.id,this.executorDigest])).rows[0];
  if(!grant||grant.account_id!==job.account_id||grant.profile_id!==job.profile_id||grant.role!==input.role||grant.context_id!==authority.contextId||
   grant.intent_id!==input.intentId||Number(grant.manager_epoch)!==authority.epoch||this.profileDigest(grant)!==job.profile_digest)throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
  return fn();
 });}
 async start(principal:string,authority:Authority,raw:z.input<typeof NativeExecutionRequest>){
  const input=NativeExecutionRequest.parse(raw),hash=digest(input),prior=(await this.ledger.pool.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1',[input.jobId])).rows[0];
  if(prior){await this.validateReplay(principal,authority,input,prior);return this.reconcile(principal,authority,input);}
  const g=await this.ledger.tx(c=>this.identity(c,principal,authority,input));
  const assessment=(await new ProviderEligibility(this.ledger).view(principal,g.project_id,g.account_id,1)).latest;
  if(!assessment?.fresh||assessment.effectiveStatus!=='documented_supported'||assessment.authenticationMode!=='subscription_oauth'||assessment.executionMode!=='central_isolated_cli'||assessment.adapterId!==this.config.id||assessment.adapterVersion!==this.executorDigest)throw new Refusal('NATIVE_EXECUTION_NOT_ELIGIBLE');
  await new AccountHomes(this.ledger,this.config.accountRoot,this.config.protectedRepositories).inspectGranted(principal,input.grantId,authority);
  await this.diskGuard?.assertAdmission();
  await this.directory(this.config.hostRoot);
  // Commit the uncertainty before files, Docker networks or processes exist.
  await this.ledger.tx(async c=>{await this.identity(c,principal,authority,input);
   await c.query(`INSERT INTO ac_native_execution_jobs(id,grant_id,intent_id,context_id,manager_epoch,session_id,executor_digest,key_fingerprint,input_digest,base_id,role,account_id,profile_id,profile_digest,eligibility_revision,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'uncertain')`,[input.jobId,input.grantId,input.intentId,authority.contextId,authority.epoch,input.sessionId,this.executorDigest,this.fingerprint,hash,input.base,input.role,g.account_id,g.profile_id,this.profileDigest(g),assessment.revision]);
   await c.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[input.grantId]);
   if(input.role==='programmer')await c.query("UPDATE ac_operations SET state='uncertain',native_session_id=$2 WHERE id=$1",[input.jobId,input.sessionId]);
   else await c.query("UPDATE ac_stage_operations SET state='uncertain' WHERE id=$1",[input.jobId]);
  });
  const p=this.paths(input.jobId);await mkdir(p.root,{mode:0o700});await writeFile(join(p.root,'request.json'),JSON.stringify(input),{mode:0o600,flag:'wx'});for(const path of [p.input,p.output,p.planning])await mkdir(path,{mode:0o700});
  await new GitArtifacts(this.config.repository).snapshot(input.base,input.base,p.work);
  await writeFile(p.key,this.publicKey,{mode:0o600,flag:'wx'});const token=randomBytes(32).toString('hex');
  for(const path of [p.workerToken,p.toolsToken])await writeFile(path,token,{mode:0o600,flag:'wx'});
  const labels={'agent-control.contract':'native-execution-v1','agent-control.job':input.jobId,'agent-control.launch':hash};
  const workerMounts=[{source:join(this.config.accountRoot,g.account_id),destination:'/account',writable:true},{source:p.input,destination:'/input',writable:false},{source:p.output,destination:'/output',writable:true},{source:p.planning,destination:'/planning',writable:false},{source:p.key,destination:'/runner/execution-public-key.pem',writable:false},{source:p.workerToken,destination:'/runner/exec-token',writable:false}];
  const toolsMounts=[{source:p.work,destination:'/work',writable:input.role==='programmer'},{source:p.toolsToken,destination:'/runner/exec-token',writable:false}];
  const host=(networkId:string,mounts:typeof toolsMounts)=>({NetworkMode:networkId,ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9,Tmpfs:{'/tmp':'rw,nosuid,nodev,size=64m'},Binds:mounts.map(m=>m.source+':'+m.destination+(m.writable?':rw':':ro'))});
  const started=await this.serialEffect(input.jobId,async()=>{
   const network=await this.effect(principal,authority,input,()=>this.docker.createPrivateNetwork('ac-native-exec-'+input.jobId,labels));
   await this.ledger.pool.query('UPDATE ac_native_execution_jobs SET network_id=$2 WHERE id=$1',[input.jobId,network]);
   const tools=await this.effect(principal,authority,input,()=>this.docker.create('ac-native-tools-'+input.jobId,{Image:this.config.toolsImage,User:this.user,WorkingDir:'/work',Entrypoint:toolsEntrypoint,Cmd:[],Env:[...this.config.toolsEnv],Labels:labels,HostConfig:host(network,toolsMounts)}));
   await this.ledger.pool.query('UPDATE ac_native_execution_jobs SET tools_id=$2 WHERE id=$1',[input.jobId,tools]);
   const worker=await this.effect(principal,authority,input,()=>this.docker.create('ac-native-worker-'+input.jobId,{Image:this.config.workerImage,User:this.user,WorkingDir:'/planning',Entrypoint:workerEntrypoint,Cmd:[],Env:[...this.config.workerEnv],Labels:labels,HostConfig:host(network,workerMounts),NetworkingConfig:{EndpointsConfig:{[network]:{},[this.config.providerNetworkId]:{}}}}));
   await this.ledger.pool.query('UPDATE ac_native_execution_jobs SET worker_id=$2 WHERE id=$1',[input.jobId,worker]);
   // The CLI wrapper waits for a signed launch. No account is opened yet.
   await this.effect(principal,authority,input,()=>this.docker.start(tools));await this.effect(principal,authority,input,()=>this.docker.start(worker));
   return {network,tools,worker};
  });
  const {network,tools,worker}=started;
  const physical=await this.docker.inspectPrivateNetwork(network);const address=physical?.Containers?.[tools]?.IPv4Address?.split('/')[0];
  const expected={jobId:input.jobId,launchDigest:hash,workerImage:this.config.workerImage,toolsImage:this.config.toolsImage,workerUser:this.user,toolsUser:this.user,providerNetwork:this.config.providerNetworkId,networkId:network,toolsAddress:address,workerMounts,toolsMounts,role:input.role,phase:'gated-running'};
  const rules={state:'running',workerEntrypoint,toolsEntrypoint,workerCmd:[],toolsCmd:[],workerEnv:[...this.config.workerEnv],toolsEnv:[...this.config.toolsEnv],workerWorkingDir:'/planning',toolsWorkingDir:'/work',workerMemory:512*1024*1024,toolsMemory:512*1024*1024,workerPids:96,toolsPids:96,workerNanoCpus:1e9,toolsNanoCpus:1e9};
  await inspectNativeExecutionPair(dockerReadOnly(this.config.socketPath??'/var/run/docker.sock'),{worker,tools,network},expected,rules);
  const launch={schemaVersion:1,jobId:input.jobId,contextId:authority.contextId,intentId:input.intentId,grantId:input.grantId,accountId:g.account_id,profileId:g.profile_id,sessionId:input.sessionId,epoch:authority.epoch,providerSubjectDigest:this.subjects.get(g.account_id)!,executorDigest:this.executorDigest,inputDigest:hash,proxyUrl:'http://provider-egress:8080',model:g.model,effort:g.effort,role:input.role,task:input.task,writePaths:input.writePaths,...(input.role!=='programmer'?{artifactCommit:input.base,outputSchema:input.outputSchema}:input.outputSchema?{outputSchema:input.outputSchema}:{}),environmentId:'native_tools',toolsAddress:address,timeoutMs:input.timeoutMs,expiresAt:Date.now()+60000};
  const signed={payload:launch,signature:sign(null,Buffer.from('agent-control:native-execution-launch:v1\n'+canonical(launch)),this.key).toString('hex')};
  // Atomic publication prevents partial JSON reads by the worker; the journal
  // and private directory make this an exclusive one-time release.
  await this.effect(principal,authority,input,async()=>{await writeFile(join(p.input,'launch.pending'),JSON.stringify(signed),{mode:0o600,flag:'wx'});try{await lstat(join(p.input,'launch.json'));throw new Refusal('NATIVE_EXECUTION_ALREADY_RELEASED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await rename(join(p.input,'launch.pending'),join(p.input,'launch.json'));});
  await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);await c.query("UPDATE ac_native_execution_jobs SET state='running',launch_digest=$2 WHERE id=$1 AND state='uncertain'",[input.jobId,digest(launch)]);await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1 AND state='uncertain'",[input.grantId]);});
  return {state:'running' as const,jobId:input.jobId};
 }
 /** Read the original private request after a controller restart. It is never
  * reconstructed from an agent message or stored as plaintext in PostgreSQL. */
 private async registeredInput(principal:string,authority:Authority,jobId:string){
  Id.parse(jobId);
  await this.ledger.tx(async c=>{await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const row=(await c.query('SELECT intent_id FROM ac_native_execution_jobs WHERE id=$1 AND context_id=$2',[jobId,authority.contextId])).rows[0];
   if(!row)throw new Refusal('NATIVE_EXECUTION_JOB_NOT_FOUND',404);
   const owner=(await c.query('SELECT principal_id FROM ac_intents WHERE id=$1',[row.intent_id])).rows[0];
   if(owner?.principal_id!==principal)throw new Refusal('NATIVE_EXECUTION_SCOPE_MISMATCH');
  });
  const p=this.paths(jobId);await this.directory(p.root);const bytes=await readPrivateWorkerFile(join(p.root,'request.json'),512*1024);
  try{const input=NativeExecutionRequest.parse(JSON.parse(bytes.toString('utf8')));if(input.jobId!==jobId)throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');return input;}finally{bytes.fill(0);}
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
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(error=>{
    if(['ENOENT','ELOOP'].includes(String((error as NodeJS.ErrnoException).code)))throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');throw error;
   });
   try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>1048576)throw new Refusal('NATIVE_RETIREMENT_LOG_INVALID');
    return createHash('sha256').update(await file.readFile()).digest('hex');}finally{await file.close();}
  };
  const archive=async(path:string,bytes:Buffer)=>{
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
   const receipt=row?.receipt,payload=receipt?.payload,physical=row?.physical_receipt;
   if(!row||row.role!=='programmer'||!['completed','failed'].includes(row.state)||row.grant_state!=='released'||row.operation_state!=='completed'||
    row.intent_id!==input.intentId||row.intent_context!==authority.contextId||row.grant_context!==authority.contextId||row.grant_intent!==row.intent_id||
    row.grant_role!=='programmer'||row.grant_resource_kind!=='model'||row.grant_account!==row.account_id||row.grant_profile!==row.profile_id||
    row.operation_grant!==row.grant_id||row.grant_attempt!==row.execution_attempt_id||
    Number(row.grant_epoch)!==Number(row.manager_epoch)||Number(row.writer_epoch)!==Number(row.manager_epoch)||Number(row.operation_epoch)>authority.epoch||
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
    physical.containerId!==row.worker_id||physical.toolsContainerId!==row.tools_id||
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
   holderIntentId:row.intent_id,writerEpoch:Number(row.writer_epoch),workerId:saved.worker_id,toolsId:saved.tools_id,terminalDigest:saved.terminal_digest,
   workerLogSha256:saved.worker_log_sha256,toolsLogSha256:saved.tools_log_sha256});
  const checked=async(row:Record<string,any>,saved:Record<string,any>|undefined)=>{
   if(!saved||saved.parent_intent_id!==row.parent_intent_id||saved.run_id!==row.run_id||saved.holder_intent_id!==row.intent_id||
    Number(saved.writer_epoch)!==Number(row.writer_epoch)||saved.worker_id!==row.worker_id||saved.tools_id!==row.tools_id||saved.terminal_digest!==digest(row.receipt)||
    await readLog(logs[0]!)!==saved.worker_log_sha256||await readLog(logs[1]!)!==saved.tools_log_sha256)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
  };
  const revoked=async(row:Record<string,any>,saved:Record<string,any>|undefined)=>{
   await checked(row,saved);const proof=saved!.proof;
   if(saved!.state!=='revoked'||row.revocation_job_id!==jobId||!proof?.payload||digest(proof.payload)!==digest(payloadFor(row,saved!))||
    typeof proof.signature!=='string'||!/^[a-f0-9]{128}$/.test(proof.signature)||
    !verify(null,Buffer.from('agent-control:native-writer-retirement:v1\n'+canonical(proof.payload)),createPublicKey(this.key),Buffer.from(proof.signature,'hex'))||
    digest(proof)!==row.proof_digest||digest(proof)!==digest(row.revocation_proof))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   if(await this.docker.inspect(saved!.worker_id)||await this.docker.inspect(saved!.tools_id)||
    await this.docker.inspect('ac-native-worker-'+jobId)||await this.docker.inspect('ac-native-tools-'+jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
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
  if(prepared)return {state:'neutralized' as const};
  return this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_native_writer_retirements WHERE job_id=$1 FOR UPDATE',[jobId])).rows[0];
   if(row.writer_state==='neutralized'){await revoked(row,saved);return {state:'neutralized' as const};}
   if(row.writer_state!=='held'||saved?.state!=='prepared')throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await checked(row,saved);const observed=await pair(row,true);
   for(const container of observed)if(container)await this.docker.remove(container.Id);
   if(await this.docker.inspect(saved.worker_id)||await this.docker.inspect(saved.tools_id)||
    await this.docker.inspect('ac-native-worker-'+jobId)||await this.docker.inspect('ac-native-tools-'+jobId))throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   const payload=payloadFor(row,saved),proof={payload,signature:sign(null,Buffer.from('agent-control:native-writer-retirement:v1\n'+canonical(payload)),this.key).toString('hex')};
   await c.query("UPDATE ac_native_writer_retirements SET state='revoked',proof=$2 WHERE job_id=$1 AND state='prepared'",[jobId,proof]);
   const changed=await c.query(`UPDATE ac_worktree_writers SET state='neutralized',proof_digest=$5,revocation_job_id=$6,revocation_proof=$7
    WHERE parent_intent_id=$1 AND run_id=$2 AND holder_intent_id=$3 AND manager_epoch=$4 AND state='held'`,
    [row.parent_intent_id,row.run_id,row.intent_id,row.writer_epoch,digest(proof),jobId,proof]);
   if(!changed.rowCount)throw new Refusal('NATIVE_RETIREMENT_UNCONFIRMED');
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'worktree.native_writer_revoked',$2)",[authority.contextId,{jobId,parentIntentId:row.parent_intent_id,runId:row.run_id,proofDigest:digest(proof)}]);
   return {state:'neutralized' as const};
  });
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
  await this.ledger.tx(c=>this.scope(c,principal,authority,input,true));
  if(row.context_id!==authority.contextId||row.intent_id!==input.intentId||row.grant_id!==input.grantId||row.session_id!==input.sessionId||row.input_digest!==digest(input)||row.executor_digest!==this.executorDigest||row.key_fingerprint!==this.fingerprint||Number(row.manager_epoch)>authority.epoch)throw new Refusal('NATIVE_EXECUTION_REPLAY_MISMATCH');
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
   const result=await this.readResult(input,payload.exitCode);
   if(payload.outputDigest!==digest(result.output)||result.exitCode!==payload.workerExitCode||result.jobId!==input.jobId)throw new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
   return {state:job.state as 'completed'|'failed',receipt,output:result.output,artifact:payload.artifact??null};
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
  const cancellation=(await this.ledger.pool.query("SELECT 1 FROM ac_plan_cancellations WHERE intent_id=$1 AND state='requested'",[input.intentId])).rowCount;
  let finalization:any=null,artifact:z.infer<typeof NativeArtifactIdentity>|null=null;
  if(input.role==='programmer'){
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
  const effectiveExitCode=finalization?.status==='failed'&&result.exitCode===0?1:result.exitCode;
  const physical={jobId:input.jobId,containerId:worker.Id,toolsContainerId:tools.Id,networkId:job.network_id,exitCode:effectiveExitCode,workerExitCode:worker.State.ExitCode,finalization,finishedAt:worker.State.FinishedAt,toolsFinishedAt:tools.State.FinishedAt,synthetic:false,executorDigest:this.executorDigest,nativeSessionId:result.nativeSessionId,normalizedTokensUsed:result.normalizedTokensUsed,usageWindows:result.usageWindows};
  const payload={schemaVersion:1,accountId:job.account_id,profileId:job.profile_id,profileDigest:job.profile_digest,jobId:input.jobId,intentId:input.intentId,contextId:authority.contextId,grantId:input.grantId,sessionId:input.sessionId,epoch:Number(job.manager_epoch),inputDigest:job.input_digest,executorDigest:this.executorDigest,outputDigest:digest(result.output),physicalDigest:digest(physical),workerExitCode:result.exitCode,artifact,exitCode:effectiveExitCode};
  const receipt={payload,signature:sign(null,Buffer.from('agent-control:native-execution-receipt:v1\n'+canonical(payload)),this.key).toString('hex')};
  await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,true);const saved=(await c.query('SELECT * FROM ac_native_execution_jobs WHERE id=$1 FOR UPDATE',[input.jobId])).rows[0];if(['completed','failed'].includes(saved.state)){if(digest(saved.receipt)!==digest(receipt))throw new Refusal('NATIVE_EXECUTION_RECEIPT_MISMATCH');return;}
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
   if(!grant||grant.account_id!==job.account_id||grant.profile_id!==job.profile_id||grant.role!==job.role||grant.resource_kind!=='model'||grant.intent_id!==input.intentId||grant.context_id!==authority.contextId||Number(grant.manager_epoch)!==Number(job.manager_epoch)||!['uncertain','running'].includes(grant.state))throw new Refusal('NATIVE_EXECUTION_GRANT_MISMATCH');
   await c.query("UPDATE ac_native_execution_jobs SET state=$2,worker_id=$3,tools_id=$4,receipt=$5 WHERE id=$1",[input.jobId,effectiveExitCode===0?'completed':'failed',worker.Id,tools.Id,receipt]);
   await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[input.grantId,physical]);
   if(input.role==='programmer'&&!cancellation){
    const operationReceipt=artifact?{operationId:input.jobId,commit:artifact.commit,tree:artifact.tree,base:artifact.base,exitCode:0,synthetic:false,nativeExecution:receipt,finalizationDigest:digest(finalization)}:
      {operationId:input.jobId,exitCode:effectiveExitCode,synthetic:false,nativeExecution:receipt,failureCode:finalization?.failureCode??result.failureCode};
    const updated=await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1 AND intent_id=$3 AND grant_id=$4 AND native_session_id=$5 AND manager_epoch=$6 AND state IN ('uncertain','running')",[input.jobId,operationReceipt,input.intentId,input.grantId,input.sessionId,job.manager_epoch]);
    if(!updated.rowCount)throw new Refusal('NATIVE_EXECUTION_OPERATION_MISMATCH');
   }

  });
  return {state:effectiveExitCode===0?'completed' as const:'failed' as const,receipt,output:result.output,artifact};
 }
 /** Register only the exact finalized artifact; Quality still requires
  * independent QA/review and authorized integration. No branch is changed. */
 async registerArtifact(principal:string,authority:Authority,jobId:string,quality:Quality){
  if(quality.ledger!==this.ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
  const input=await this.registeredInput(principal,authority,jobId),outcome=await this.reconcile(principal,authority,input);
  if(outcome.state!=='completed'||!('artifact' in outcome)||!outcome.artifact||input.role!=='programmer')throw new Refusal('NATIVE_ARTIFACT_NOT_READY');
  const artifact=NativeArtifactIdentity.parse(outcome.artifact);
  const revision=await this.ledger.tx(async c=>{await this.scope(c,principal,authority,input,false);
   const contract=(await c.query('SELECT quality_revision,target_ref,digest FROM ac_execution_contracts WHERE intent_id=$1',[input.intentId])).rows[0];
   if(!contract||contract.digest!==digest({qualityRevision:contract.quality_revision,targetRef:contract.target_ref}))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
   const identity=await new GitArtifacts(this.config.repository).import(this.paths(jobId).work,artifact.commit,artifact.base);
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
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const row=(await c.query(`SELECT j.*,g.state grant_state,g.physical_receipt,i.principal_id FROM ac_native_execution_jobs j
    JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_intents i ON i.id=j.intent_id
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
   const receipt={executionStarted:false,jobId,containerId:null,networkId:fresh.network_id,synthetic:false,modelInference:false,reason:'proven_not_started'};
   const updated=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state IN ('reserved','uncertain')",[fresh.grant_id,receipt]);
   return {kind:'recovery' as const,recovery:updated.rowCount===1?{state:'released_unstarted' as const,interval:'proven_not_started' as const,grant:'released' as const,removed,replayed:false as const}:{...preserved('before_terminal_evidence'),removed}};
  }));
  if(decision.kind==='recovery')return decision.recovery;
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
function dockerUncertain(error:unknown){return error instanceof Refusal&&error.code.startsWith('DOCKER_');}
export type NativeExecutionRecovery={state:'uncertain'|'released_unstarted'|'acknowledged';interval:'docker_response_lost'|'before_terminal_evidence'|'network_or_container_remains'|'supervisor_identity'|'proven_not_started'|'terminal_evidence_missing'|'ack_lost'|'network_unproven';grant:'preserved'|'released';removed:string[];replayed:false;receipt?:unknown};
