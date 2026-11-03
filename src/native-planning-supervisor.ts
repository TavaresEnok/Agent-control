import {constants} from 'node:fs';
import {open,lstat,realpath,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createPrivateKey,createPublicKey,sign,verify,createHash} from 'node:crypto';
import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {AccountHomes} from './account-homes.ts';
import {ProviderEligibility} from './provider-eligibility.ts';
import {usageWindowsObservationSchema} from '../upstream/cezar/packages/contract/src/usage-windows.ts';
import {DockerDaemon} from './sandbox-broker.ts';
import {digest,canonical,Refusal,type Authority} from './contracts.ts';
import {planningReceiptMessage,PlanningPhysicalReceipt,type PlanningExecutor,type PlanningInvocation} from './semantic-planning.ts';
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const nativePlanningExecutorDigest=(imageId:string)=>digest({contract:'native-planning-v1',imageId});
const Result=z.object({schemaVersion:z.literal(1),callId:z.uuid(),output:z.string().max(262144),normalizedTokensUsed:z.number().int().safe().nonnegative().nullable(),
 usageWindows:usageWindowsObservationSchema.nullable(),nativeSessionId:z.string().nullable(),failureCode:z.string().nullable(),exitCode:z.number().int()}).strict();
export type NativePlanningSupervisorConfig={id:string;executorDigest:string;imageId:string;hostRoot:string;accountRoot:string;
 protectedRepositories:readonly string[];signingKeyPem:string;socketPath?:string;providerNetwork:string;accountSubjects:readonly {accountId:string;subjectDigest:string}[]};
/** Fixed Docker supervisor, not a scheduler. No HTTP-controlled image, mount,
 * command, provider address or key. Construction alone performs no inference.
 * Runtime eligibility remains an independent mandatory gate. */
export class NativePlanningSupervisor{
 private readonly subjects=new Map<string,string>();
 private readonly key;private readonly publicKey;private readonly docker:DockerDaemon;
 readonly executor:PlanningExecutor;
 constructor(readonly ledger:Ledger,private readonly config:NativePlanningSupervisorConfig){
  this.config=Object.freeze({...config,protectedRepositories:Object.freeze([...config.protectedRepositories]),accountSubjects:Object.freeze(config.accountSubjects.map(a=>Object.freeze({...a})))});
  z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/).parse(config.id);Hash.parse(config.executorDigest);
  z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(config.imageId);
  if(process.getuid?.()===undefined||process.getuid?.()===0)throw new Refusal('NATIVE_WORKER_NON_ROOT_REQUIRED');
  if(config.executorDigest!==nativePlanningExecutorDigest(config.imageId))throw new Refusal('NATIVE_EXECUTOR_DIGEST_MISMATCH');
  if(config.providerNetwork!=='ac-native-provider'||[config.hostRoot,config.accountRoot,...config.protectedRepositories].some(p=>resolve(p)!==p)||
    config.hostRoot===config.accountRoot||config.hostRoot.startsWith(config.accountRoot+sep)||config.accountRoot.startsWith(config.hostRoot+sep)||
    config.protectedRepositories.some(p=>[config.hostRoot,config.accountRoot].some(r=>p===r||p.startsWith(r+sep)||r.startsWith(p+sep))))throw new Refusal('NATIVE_PLANNING_PATH_INVALID');
  for(const item of config.accountSubjects){z.uuid().parse(item.accountId);Hash.parse(item.subjectDigest);if(this.subjects.has(item.accountId))throw new Refusal('NATIVE_PLANNING_ACCOUNT_DUPLICATE');this.subjects.set(item.accountId,item.subjectDigest);}
  this.key=createPrivateKey(config.signingKeyPem);if(this.key.asymmetricKeyType!=='ed25519')throw new Refusal('PLANNING_RECEIPT_KEY_INVALID');
  this.publicKey=createPublicKey(this.key).export({format:'pem',type:'spki'}).toString();
  this.docker=new DockerDaemon(config.socketPath);
  this.executor=Object.freeze({id:config.id,digest:config.executorDigest,publicKey:createPublicKey(this.key).export({format:'der',type:'spki'}).toString('base64'),provider:'codex',mode:'subscription_cli',
   execute:(input:PlanningInvocation)=>this.execute(input),reconcile:(input:PlanningInvocation)=>this.reconcile(input)});
 }
 private async privateDirectory(path:string){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o7777)!==0o700||s.uid!==process.getuid?.()||await realpath(path)!==path)throw new Refusal('NATIVE_PLANNING_DIRECTORY_UNSAFE');}
 private paths(id:string){z.uuid().parse(id);const root=join(this.config.hostRoot,id);return {root,input:join(root,'input'),output:join(root,'output'),planning:join(root,'planning'),key:join(root,'public-key.pem')};}
 private async execute(input:PlanningInvocation){
  await input.assertAuthorized();
  const identity=await this.ledger.tx(async c=>{
   const call=(await c.query('SELECT * FROM ac_semantic_planning_calls WHERE id=$1 FOR UPDATE',[input.callId])).rows[0];
   if(!call||call.state!=='uncertain'||call.grant_id!==input.grantId||Number(call.execution_epoch)!==input.executionEpoch||call.input_digest!==input.inputDigest||call.selected_executor_id!==this.config.id||call.selected_executor_digest!==this.config.executorDigest)throw new Refusal('PLANNING_CALL_FENCED');
   const g=(await c.query(`SELECT g.*,a.provider,a.mode,a.enabled account_enabled,a.eligibility,a.resource_identity,p.enabled profile_enabled,p.model,p.effort,p.role profile_role,i.principal_id
    FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_intents i ON i.id=g.intent_id
    WHERE g.id=$1 FOR UPDATE OF g`,[input.grantId])).rows[0];
   if(!g||g.state!=='reserved'||g.context_id!==input.contextId||g.intent_id!==input.intentId||Number(g.manager_epoch)!==input.executionEpoch||g.role!=='manager'||g.profile_role!=='manager'||g.account_id!==input.profile.accountId||g.profile_id!==input.profile.id||g.model!==input.profile.model||g.effort!==input.profile.effort||g.provider!=='codex'||g.mode!=='subscription_cli'||g.eligibility!=='documented_supported'||!g.account_enabled||!g.profile_enabled||!this.subjects.has(g.account_id)||g.resource_identity!=='codex:'+this.subjects.get(g.account_id))throw new Refusal('NATIVE_PLANNING_NOT_ELIGIBLE');
   const previous=(await c.query('SELECT id FROM ac_native_planning_jobs WHERE id=$1',[input.callId])).rows[0];
   return {principal:g.principal_id,subjectDigest:this.subjects.get(g.account_id)!,projectId:g.project_id,exists:Boolean(previous)};
  });
  if(identity.exists){const result=await this.reconcile(input);if(!result)throw new Refusal('PLANNING_RESULT_UNCERTAIN');return result;}
  const assessment=(await new ProviderEligibility(this.ledger).view(identity.principal,identity.projectId,input.profile.accountId,1)).latest;
  if(!assessment?.fresh||assessment.effectiveStatus!=='documented_supported'||assessment.provider!=='codex'||assessment.authenticationMode!=='subscription_oauth'||assessment.executionMode!=='central_isolated_cli'||assessment.adapterId!==this.config.id||assessment.adapterVersion!==this.config.executorDigest)throw new Refusal('NATIVE_PLANNING_NOT_ELIGIBLE');
  const authority={contextId:input.contextId,epoch:input.executionEpoch,instanceId:''};
  // Use the actual fenced manager instance, never an instance supplied by a model.
  const manager=(await this.ledger.pool.query('SELECT instance_id FROM ac_managers WHERE context_id=$1 AND epoch=$2',[input.contextId,input.executionEpoch])).rows[0];
  if(!manager)throw new Refusal('PLANNING_CALL_FENCED');authority.instanceId=manager.instance_id;
  await new AccountHomes(this.ledger,this.config.accountRoot,this.config.protectedRepositories).inspectGranted(identity.principal,input.grantId,authority);
  await this.privateDirectory(this.config.hostRoot);const paths=this.paths(input.callId);
  const launch={schemaVersion:1,callId:input.callId,contextId:input.contextId,intentId:input.intentId,grantId:input.grantId,accountId:input.profile.accountId,profileId:input.profile.id,sessionId:input.sessionId,
   epoch:input.executionEpoch,proxyUrl:'http://provider-egress:8080',providerSubjectDigest:identity.subjectDigest,executorDigest:this.config.executorDigest,inputDigest:input.inputDigest,
   model:input.profile.model,effort:input.profile.effort,sourceMessageRef:input.sourceMessageRef,text:input.text,constraints:{contextId:input.contextId,...input.constraints},outputSchema:input.outputSchema,expiresAt:Date.now()+60000};
  const signed={payload:launch,signature:sign(null,Buffer.from('agent-control:native-planning-launch:v1\n'+canonical(launch)),this.key).toString('hex')};
  const name='ac-native-plan-'+input.callId,launchDigest=digest(launch);
  // Journal uncertainty BEFORE touching Docker. If any acknowledgement is lost,
  // reconcile observes this same name; it never starts or creates a substitute.
  await this.ledger.tx(async c=>{await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,input.contextId,input.intentId);
   await c.query("INSERT INTO ac_native_planning_jobs(id,grant_id,context_id,input_digest,launch_digest,container_name,state) VALUES($1,$2,$3,$4,$5,$6,'uncertain')",[input.callId,input.grantId,input.contextId,input.inputDigest,launchDigest,name]);});
  await mkdir(paths.root,{mode:0o700});for(const path of [paths.input,paths.output,paths.planning])await mkdir(path,{mode:0o700});
  await writeFile(join(paths.input,'launch.json'),JSON.stringify(signed),{mode:0o600,flag:'wx'});await writeFile(paths.key,this.publicKey,{mode:0o600,flag:'wx'});
  await input.assertAuthorized();
  const id=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,input.contextId,input.intentId);
   const active=(await c.query(`SELECT g.state,a.enabled account_enabled,p.enabled profile_enabled,q.status,q.expires_at>clock_timestamp() fresh
    FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id JOIN ac_profiles p ON p.id=g.profile_id
    LEFT JOIN ac_quota_observations q ON q.account_id=a.id WHERE g.id=$1 AND g.manager_epoch=$2 FOR UPDATE OF g FOR SHARE OF a,p`,[input.grantId,input.executionEpoch])).rows[0];
   if(!active||active.state!=='reserved'||!active.account_enabled||!active.profile_enabled||active.status!=='available'||!active.fresh)throw new Refusal('NATIVE_PLANNING_NOT_ELIGIBLE');
   const id=await this.docker.create(name,{Image:this.config.imageId,User:String(process.getuid?.())+':'+String(process.getgid?.()),WorkingDir:'/planning',
   Entrypoint:['node','/opt/agent-control/dist/src/native-planning-worker.mjs'],Cmd:[],Env:[],Labels:{'agent-control.contract':'native-planning-v1','agent-control.job':input.callId,'agent-control.launch':launchDigest},
   HostConfig:{NetworkMode:this.config.providerNetwork,ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],PidsLimit:96,Memory:512*1024*1024,NanoCpus:1e9,
    Tmpfs:{'/tmp':'rw,nosuid,nodev,noexec,size=64m'},Binds:[join(this.config.accountRoot,input.profile.accountId)+':/account:rw',paths.input+':/input:ro',paths.output+':/output:rw',paths.planning+':/planning:ro',paths.key+':/runner/planning-public-key.pem:ro']}});
   await this.docker.start(id);return id;
  });
  await this.ledger.pool.query('UPDATE ac_native_planning_jobs SET container_id=$2 WHERE id=$1',[input.callId,id]);
  await this.ledger.tx(async c=>{await c.query("UPDATE ac_native_planning_jobs SET state='running' WHERE id=$1 AND state='uncertain'",[input.callId]);await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1 AND state='reserved'",[input.grantId]);});
  // One bounded observation window. Retries use only reconcile(), never start().
  for(let i=0;i<130;i++){const result=await this.reconcile(input);if(result)return result;await new Promise(r=>setTimeout(r,1000));}
  throw new Refusal('PLANNING_RESULT_UNCERTAIN');
 }
 private async readResult(input:PlanningInvocation){
  const paths=this.paths(input.callId);await this.privateDirectory(paths.root);await this.privateDirectory(paths.output);
  const f=await open(join(paths.output,'planning-result.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.size>2*1024*1024||(s.mode&0o077)!==0||s.uid!==process.getuid?.())throw new Refusal('PLANNING_OUTPUT_INVALID');const b=await f.readFile();if(b.length>2*1024*1024)throw new Refusal('PLANNING_OUTPUT_INVALID');return Result.parse(JSON.parse(b.toString('utf8')));}finally{await f.close();}
 }
 private inspectExpected(physical:NonNullable<Awaited<ReturnType<DockerDaemon['inspect']>>>,job:Record<string,any>,accountId:string){
  if(JSON.stringify(physical.Config.Entrypoint)!==JSON.stringify(['node','/opt/agent-control/dist/src/native-planning-worker.mjs'])||(physical.Config.Cmd?.length??0)>0||physical.Config.WorkingDir!=='/planning'||!physical.Config.Env||physical.Config.Env.some(e=>! /^(PATH|NODE_VERSION|YARN_VERSION)=/.test(e)))throw new Refusal('PLANNING_CONTAINER_MISMATCH');
  if((job.container_id&&job.container_id!==physical.Id)||physical.Image!==this.config.imageId||physical.Config.Labels['agent-control.job']!==job.id||physical.Config.Labels['agent-control.launch']!==job.launch_digest||physical.Config.Labels['agent-control.contract']!=='native-planning-v1'||physical.Config.User!==String(process.getuid?.())+':'+String(process.getgid?.())||physical.HostConfig.Memory!==512*1024*1024||physical.HostConfig.PidsLimit!==96||physical.HostConfig.NanoCpus!==1e9||physical.HostConfig.Privileged||!physical.HostConfig.ReadonlyRootfs||physical.HostConfig.NetworkMode!==this.config.providerNetwork||!physical.HostConfig.CapDrop?.includes('ALL')||!physical.HostConfig.SecurityOpt?.some(s=>s==='no-new-privileges'||s==='no-new-privileges:true'))throw new Refusal('PLANNING_CONTAINER_MISMATCH');
  const p=this.paths(job.id),expected=new Map([[join(this.config.accountRoot,accountId),['/account',true]],[p.input,['/input',false]],[p.output,['/output',true]],[p.planning,['/planning',false]],[p.key,['/runner/planning-public-key.pem',false]]]);
  if(physical.Mounts.length!==expected.size||physical.Mounts.some(m=>{const e=expected.get(m.Source);return !e||e[0]!==m.Destination||e[1]!==m.RW;}))throw new Refusal('PLANNING_CONTAINER_MISMATCH');
 }
 /** Observe an existing operation even after cancellation. This cannot create,
  * start, publish, unpause or approve a plan. The original input/receipt binding
  * is still verified; only the current operator's observation fence is used. */
 async observe(principal:string,authority:Authority,input:PlanningInvocation){
  if(input.contextId!==authority.contextId)throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
  return this.reconcile({...input,assertAuthorized:async()=>this.ledger.tx(async c=>{await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);})});
 }
 /** Physical stop is permitted during a persisted pause/cancellation and never
  * releases a slot. Terminal observation remains a separate signed operation. */
 async stop(principal:string,authority:Authority,callId:string){
  z.uuid().parse(callId);return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const job=(await c.query(`SELECT j.*,g.account_id FROM ac_native_planning_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[callId,authority.contextId])).rows[0];
   if(!job)throw new Refusal('PLANNING_JOB_NOT_FOUND',404);
   const physical=await this.docker.inspect(job.container_name);if(!physical)return {state:'uncertain'};
   this.inspectExpected(physical,job,job.account_id);
   if(physical.State.Running)await this.docker.stop(physical.Id);
   return {state:'stop_requested'};
  });
 }
 /** Explicit removal of an already-receipted container only. Keep the journal,
  * proposal and signed receipt; no account directory can be cleaned here. */
 async cleanup(principal:string,authority:Authority,callId:string){
  z.uuid().parse(callId);return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const job=(await c.query(`SELECT j.*,g.account_id,g.state grant_state,g.physical_receipt FROM ac_native_planning_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
    WHERE j.id=$1 AND j.context_id=$2 FOR UPDATE OF j,g`,[callId,authority.contextId])).rows[0];
   if(!job||!['completed','failed'].includes(job.state)||job.grant_state!=='released'||!job.receipt||job.receipt.payload?.physicalDigest!==digest(job.physical_receipt))throw new Refusal('PLANNING_RESULT_UNCERTAIN');
   const signed=PlanningPhysicalReceipt.parse(job.receipt);if(!verify(null,planningReceiptMessage(signed.payload),createPublicKey(this.key),Buffer.from(signed.signature,'hex')))throw new Refusal('PLANNING_RECEIPT_INVALID');
   const physical=await this.docker.inspect(job.container_name);if(physical){this.inspectExpected(physical,job,job.account_id);if(physical.State.Running||physical.State.Status!=='exited'||physical.Id!==job.physical_receipt.containerId)throw new Refusal('PLANNING_RESULT_UNCERTAIN');await this.docker.remove(physical.Id);}
   // Retain private input/output until encrypted archival and retention policy
   // are configured. Deleting here would break idempotent reconcile after ACK loss.
   return {state:'container_removed',privateFilesRetained:true};
  });
 }
 private async reconcile(input:PlanningInvocation):Promise<{output:string;receipt:unknown}|null>{
  await input.assertAuthorized();if(input.profile.provider!=='codex'||input.profile.mode!=='subscription_cli')throw new Refusal('PLANNING_EXECUTOR_PROFILE_MISMATCH');const job=(await this.ledger.pool.query('SELECT * FROM ac_native_planning_jobs WHERE id=$1 AND grant_id=$2 AND context_id=$3',[input.callId,input.grantId,input.contextId])).rows[0];
  if(!job)return null;if(job.input_digest!==input.inputDigest)throw new Refusal('PLANNING_CALL_CONFLICT');
  const original=(await this.ledger.pool.query('SELECT * FROM ac_semantic_planning_calls WHERE id=$1',[input.callId])).rows[0];
  if(!original||original.grant_id!==input.grantId||original.intent_id!==input.intentId||original.context_id!==input.contextId||original.session_id!==input.sessionId||original.profile_id!==input.profile.id||Number(original.execution_epoch)!==input.executionEpoch||original.selected_executor_id!==this.config.id||original.selected_executor_digest!==this.config.executorDigest)throw new Refusal('PLANNING_CALL_CONFLICT');
  if(['completed','failed'].includes(job.state)){
   const receipt=PlanningPhysicalReceipt.parse(job.receipt),result=await this.readResult(input);
   if(!verify(null,planningReceiptMessage(receipt.payload),createPublicKey(this.key),Buffer.from(receipt.signature,'hex'))||receipt.payload.outputDigest!==createHash('sha256').update(result.output).digest('hex')||receipt.payload.exitCode!==result.exitCode)throw new Refusal('PLANNING_RESULT_CONFLICT');
   return {output:result.output,receipt};
  }
  const physical=await this.docker.inspect(job.container_name);if(!physical)return null;
  this.inspectExpected(physical,job,input.profile.accountId);
  if(physical.State.Running||physical.State.Status==='created')return null;
  if(physical.State.Status!=='exited'||!Number.isFinite(Date.parse(physical.State.FinishedAt))||physical.State.FinishedAt.startsWith('0001-'))return null;
  const result=await this.readResult(input);if(result.callId!==input.callId||result.exitCode!==physical.State.ExitCode||(result.exitCode===0&&result.failureCode!==null))throw new Refusal('PLANNING_OUTPUT_INVALID');
  const physicalReceipt={normalizedTokensUsed:result.normalizedTokensUsed,usageWindows:result.usageWindows,nativeSessionId:result.nativeSessionId,jobId:input.callId,containerId:physical.Id,exitCode:physical.State.ExitCode,finishedAt:physical.State.FinishedAt,synthetic:false,executorDigest:this.config.executorDigest};
  const payload={callId:input.callId,intentId:input.intentId,contextId:input.contextId,grantId:input.grantId,profileId:input.profile.id,sessionId:input.sessionId,epoch:input.executionEpoch,
   executorDigest:this.config.executorDigest,inputDigest:input.inputDigest,profileDigest:digest(input.profile),outputDigest:createHash('sha256').update(result.output).digest('hex'),physicalDigest:digest(physicalReceipt),exitCode:result.exitCode};
  const receipt={payload,signature:sign(null,planningReceiptMessage(payload),this.key).toString('hex')};
  await this.ledger.tx(async c=>{
   const row=(await c.query('SELECT * FROM ac_native_planning_jobs WHERE id=$1 FOR UPDATE',[input.callId])).rows[0];
   if(row.state==='completed'||row.state==='failed'){if(digest(row.receipt)!==digest(receipt))throw new Refusal('PLANNING_RESULT_CONFLICT');return;}
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[input.grantId])).rows[0];
   if(!grant||grant.context_id!==input.contextId||grant.intent_id!==input.intentId||grant.account_id!==input.profile.accountId||grant.profile_id!==input.profile.id||Number(grant.manager_epoch)!==input.executionEpoch||!['reserved','running','uncertain'].includes(grant.state))throw new Refusal('PLANNING_GRANT_MISMATCH');
   await c.query("UPDATE ac_native_planning_jobs SET state=$2,container_id=$3,receipt=$4 WHERE id=$1",[input.callId,result.exitCode===0?'completed':'failed',physical.Id,receipt]);
   await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[input.grantId,physicalReceipt]);
  });
  return {output:result.output,receipt};
 }
}
