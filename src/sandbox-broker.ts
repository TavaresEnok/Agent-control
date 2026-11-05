import { createHash,createHmac,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { createServer,request as httpRequest,type IncomingMessage,type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { chmod,chown,lstat,mkdir,open,readFile,realpath,rm,unlink,writeFile } from 'node:fs/promises';
import {constants} from 'node:fs';
import { join,resolve,sep } from 'node:path';
import { z } from 'zod';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { Authority,Id,canonical,digest,Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';
import {DiskAdmissionGuard,type DiskAdmissionPolicy} from './disk-admission.ts';
import {QualityPolicy} from './quality-policy.ts';
import type pg from 'pg';

const CompositionSource=z.object({unitId:z.string(),artifactId:Id,commit:z.string().regex(/^[a-f0-9]{40}$/),tree:z.string().regex(/^[a-f0-9]{40}$/),base:z.string().regex(/^[a-f0-9]{40}$/),writePaths:z.array(z.string())}).strict();
export const CorrectionSource=z.object({schemaVersion:z.literal(1),parentIntentId:Id,taskId:z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),revision:z.number().int().min(1).max(5),
 priorIntentId:Id,priorArtifactId:Id,failedEvidenceIds:z.array(Id).min(1).max(16),priorCommit:z.string().regex(/^[a-f0-9]{40}$/),
 priorTree:z.string().regex(/^[a-f0-9]{40}$/),decisionDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const SpecialistRequest=z.object({adviceId:Id,intentId:Id,unitId:z.string().min(1).max(200),operationId:Id,policyRevision:z.number().int().positive(),
 scopeDigest:z.string().regex(/^[a-f0-9]{64}$/),inputDigest:z.string().regex(/^[a-f0-9]{64}$/),policyDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const SandboxRequest=z.object({schemaVersion:z.literal(1),action:z.enum(['start','reconcile','cleanup','stop']),jobId:Id,grantId:Id,
 authority:Authority,profile:z.enum(['synthetic-probe-v1','synthetic-implementation-v1','synthetic-verification-v1','synthetic-specialist-v1']),
 source:z.object({base:z.string().regex(/^[a-f0-9]{40}$/),bundle:z.string().min(1).max(1400000),outputPath:z.string().regex(/^(?!\.)(?!.*(?:^|\/)\.)(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/).max(240).optional(),composition:z.array(CompositionSource).min(2).max(10).optional(),correction:CorrectionSource.optional()}).strict().optional(),
 verification:z.object({artifactId:Id,operationId:Id,kind:z.enum(['qa','review','judge']),verifierDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().optional(),
 advice:SpecialistRequest.optional(),
 expiresAt:z.number().int().positive(),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type SandboxRequest=z.infer<typeof SandboxRequest>;
const TerminalReceipt=z.object({jobId:Id,containerId:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int(),finishedAt:z.string().min(1),synthetic:z.literal(true)}).passthrough();
function confirmedTerminal(job:Record<string,any>,grant:Record<string,any>,request:SandboxRequest){
 const receipt=TerminalReceipt.safeParse(job.receipt);
 if(!receipt.success||receipt.data.jobId!==request.jobId||!Number.isFinite(Date.parse(receipt.data.finishedAt))||receipt.data.finishedAt.startsWith('0001-')||
    (job.state==='completed')!==(receipt.data.exitCode===0)||grant.state!=='released'||!grant.physical_receipt||
    digest(job.receipt)!==digest(grant.physical_receipt))throw new Refusal('SANDBOX_RECEIPT_UNCONFIRMED');
 return job.receipt;
}
export type SandboxExecution={profile:'synthetic-implementation-v1';source:NonNullable<SandboxRequest['source']>}|
 {profile:'synthetic-verification-v1';source:NonNullable<SandboxRequest['source']>;verification:NonNullable<SandboxRequest['verification']>}|
 {profile:'synthetic-specialist-v1';source:NonNullable<SandboxRequest['source']>;advice:NonNullable<SandboxRequest['advice']>};
function signature(value:Omit<SandboxRequest,'signature'>,key:Uint8Array){return createHmac('sha256',key).update(canonical(value)).digest('hex');}
export function signSandbox(value:Omit<SandboxRequest,'signature'>,key:Uint8Array):SandboxRequest{return {...value,signature:signature(value,key)};}
const Inspect=z.object({Id:z.string().regex(/^[a-f0-9]{64}$/),Image:z.string(),Config:z.object({User:z.string(),Labels:z.record(z.string(),z.string()),Entrypoint:z.array(z.string()).nullable().optional(),Cmd:z.array(z.string()).nullable().optional(),Env:z.array(z.string()).nullable().optional(),WorkingDir:z.string().optional()}).passthrough(),
 State:z.object({Status:z.string(),Running:z.boolean(),ExitCode:z.number().int(),FinishedAt:z.string()}).passthrough(),
 HostConfig:z.object({NetworkMode:z.string(),ReadonlyRootfs:z.boolean(),Privileged:z.boolean(),CapDrop:z.array(z.string()).nullable(),
 SecurityOpt:z.array(z.string()).nullable(),PidsLimit:z.number().nullable(),Memory:z.number(),NanoCpus:z.number()}).passthrough(),
 Mounts:z.array(z.object({Source:z.string(),Destination:z.string(),RW:z.boolean()}).passthrough())}).passthrough();
type Inspected=z.infer<typeof Inspect>;
/** Fixed Docker API operations. No caller-controlled URL, image, shell or mount is accepted. */
export class DockerDaemon{
 constructor(private readonly socket='/var/run/docker.sock'){}
 private call(method:string,path:string,body?:unknown):Promise<{status:number;body:Buffer}>{
  return new Promise((ok,fail)=>{
   const payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
   const request=httpRequest({socketPath:this.socket,method,path,headers:payload?{'content-type':'application/json','content-length':payload.length}:undefined,timeout:10000},response=>{
    const chunks:Buffer[]=[];let size=0;
    response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1024*1024){request.destroy();fail(new Refusal('DOCKER_RESPONSE_TOO_LARGE'));}else chunks.push(chunk);});
    response.on('end',()=>ok({status:response.statusCode??0,body:Buffer.concat(chunks)}));response.on('error',()=>fail(new Refusal('DOCKER_UNCERTAIN')));
   });
   request.on('timeout',()=>request.destroy());request.on('error',()=>fail(new Refusal('DOCKER_UNCERTAIN')));
   if(payload)request.write(payload);request.end();
  });
 }
 async inspect(name:string):Promise<Inspected|null>{const r=await this.call('GET',`/v1.44/containers/${encodeURIComponent(name)}/json`);
  if(r.status===404)return null;if(r.status!==200)throw new Refusal('DOCKER_UNCERTAIN');return Inspect.parse(JSON.parse(r.body.toString('utf8')));}
 async create(name:string,configuration:object){const r=await this.call('POST',`/v1.44/containers/create?name=${encodeURIComponent(name)}`,configuration);
  if(r.status!==201)throw new Refusal('DOCKER_CREATE_UNCERTAIN');return z.object({Id:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough().parse(JSON.parse(r.body.toString('utf8'))).Id;}
 async start(id:string){const r=await this.call('POST',`/v1.44/containers/${id}/start`);if(r.status!==204)throw new Refusal('DOCKER_START_UNCERTAIN');}
 async stop(id:string){const r=await this.call('POST',`/v1.44/containers/${id}/stop?t=3`);if(![204,304].includes(r.status))throw new Refusal('DOCKER_STOP_UNCERTAIN');}
 async remove(id:string){const r=await this.call('DELETE',`/v1.44/containers/${id}`);if(![204,404].includes(r.status))throw new Refusal('DOCKER_REMOVE_UNCERTAIN');}
 async logs(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw new Refusal('DOCKER_CONTAINER_INVALID');
  const r=await this.call('GET',`/v1.44/containers/${id}/logs?stdout=1&stderr=1&timestamps=0`);
  if(r.status!==200)throw new Refusal('DOCKER_LOGS_UNCERTAIN');return r.body;
 }
 async createPrivateNetwork(name:string,labels:Record<string,string>){
  if(!/^ac-native-exec-[a-f0-9-]{36}$/.test(name))throw new Refusal('DOCKER_NETWORK_INVALID');
  const r=await this.call('POST','/v1.44/networks/create',{Name:name,CheckDuplicate:true,Driver:'bridge',Internal:true,Attachable:false,Labels:labels});
  if(r.status!==201)throw new Refusal('DOCKER_NETWORK_UNCERTAIN');
  return z.object({Id:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough().parse(JSON.parse(r.body.toString('utf8'))).Id;
 }
 async removePrivateNetwork(id:string){
  if(!/^[a-f0-9]{64}$/.test(id))throw new Refusal('DOCKER_NETWORK_INVALID');
  const r=await this.call('DELETE',`/v1.44/networks/${id}`);if(![204,404].includes(r.status))throw new Refusal('DOCKER_NETWORK_UNCERTAIN');
 }
 async inspectPrivateNetwork(id:string):Promise<Record<string,any>|null>{
  if(!/^[a-f0-9]{64}$/.test(id))throw new Refusal('DOCKER_NETWORK_INVALID');
  const r=await this.call('GET',`/v1.44/networks/${id}`);if(r.status===404)return null;
  if(r.status!==200)throw new Refusal('DOCKER_NETWORK_UNCERTAIN');return JSON.parse(r.body.toString('utf8'));
 }
}
export type SandboxBrokerConfig={hostRoot:string;probeHostPath:string;probeSha256:string;implementationPath?:string;implementationSha256?:string;diskPolicy?:DiskAdmissionPolicy;
 verificationPath?:string;verificationSha256?:string;verifierPath?:string;verifierSha256?:string;
 specialistPath?:string;specialistSha256?:string;verifierVersions?:readonly {path:string;hash:string}[];
 imageId:string;socketPath:string;keyPath:string;databaseUrl:string};
const exec=promisify(execFile);
async function safeGit(cwd:string,args:string[]){
 const result=await exec('/usr/bin/git',['-c','safe.directory='+cwd,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],
  {env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},timeout:10000,maxBuffer:2000000});
 return result.stdout.trim();
}
async function correctionOutput(cwd:string,correction:z.infer<typeof CorrectionSource>,outputPath:string,operationId:string){
 const result=await exec('/usr/bin/git',['-c','safe.directory='+cwd,'-c','core.hooksPath=/dev/null','-C',cwd,'show',`${correction.priorCommit}:${outputPath}`],
  {encoding:'buffer',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000,maxBuffer:1000000});
 return `Synthetic corrected effect ${operationId}\nPrior content sha256 ${createHash('sha256').update(result.stdout).digest('hex')}\nDecision ${correction.decisionDigest}`;
}
export class SandboxBroker{
 readonly ledger:Ledger;readonly docker:DockerDaemon;private readonly active=new Set<string>();
 private readonly diskGuard:DiskAdmissionGuard|undefined;
 private readonly monitors=new Map<string,ReturnType<typeof setInterval>>();
 private async requireSpecialist(c:pg.PoolClient,request:SandboxRequest,intentId:string){
  const policy=(await c.query(`SELECT x.quality_revision,p.snapshot,p.digest FROM ac_execution_contracts x JOIN ac_quality_policies p
   ON p.project_id=x.project_id AND p.revision=x.quality_revision WHERE x.intent_id=$1`,[intentId])).rows[0];
  if(!policy)return;
  const parsed=QualityPolicy.parse(policy.snapshot);if(digest(parsed)!==policy.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
  if(!parsed.requireSpecialistBeforeImplementation)return;
  const row=(await c.query(`SELECT a.*,a.operation_id advice_operation,g.state grant_state,g.resource_kind,g.role,g.intent_id grant_intent,g.context_id grant_context,
   g.attempt_id grant_attempt,g.manager_epoch grant_epoch,g.physical_receipt,j.state job_state,j.profile job_profile,j.receipt job_receipt,
   j.context_id job_context,j.grant_id job_grant,j.manager_epoch job_epoch,j.container_id,l.snapshot launch,l.digest launch_digest,
   l.context_id launch_context,l.manager_epoch launch_epoch,i.operation_id,i.parent_unit_id,m.snapshot input,m.digest input_saved,m.base_id input_base,
   o.native_session_id writer_session FROM ac_intents i JOIN ac_operations o ON o.id=i.operation_id
   JOIN ac_managed_delivery_inputs m ON m.intent_id=i.id LEFT JOIN ac_specialist_advice a ON a.intent_id=i.id
   LEFT JOIN ac_capacity_grants g ON g.id=a.grant_id LEFT JOIN ac_sandbox_jobs j ON j.id=a.id
   LEFT JOIN ac_specialist_execution_launches l ON l.advice_id=a.id WHERE i.id=$1 AND i.context_id=$2`,[intentId,request.authority.contextId])).rows[0];
  const receipt=row?.receipt,physical=row?.physical_receipt,advice=physical?.advice;
  if(!row||row.state!=='completed'||typeof row.signature!=='string'||!/^[a-f0-9]{64}$/.test(row.signature)||
    !receipt||receipt.schemaVersion!==1||receipt.kind!=='preimplementation_advice'||receipt.status!=='approved'||receipt.exitCode!==0||row.policy_revision!==policy.quality_revision||
    receipt.adviceId!==row.id||receipt.contextId!==request.authority.contextId||receipt.intentId!==intentId||
    receipt.operationId!==row.operation_id||row.advice_operation!==row.operation_id||receipt.unitId!==row.parent_unit_id||row.unit_id!==row.parent_unit_id||receipt.sessionId!==row.session_id||receipt.grantId!==row.grant_id||
    !row.writer_session||row.writer_session===row.session_id||row.grant_id===request.grantId||row.role!=='specialist'||row.resource_kind!=='model'||
    row.grant_intent!==intentId||row.grant_context!==request.authority.contextId||row.grant_attempt!==row.attempt_id||row.grant_state!=='released'||
    Number(row.grant_epoch)!==Number(row.manager_epoch)||Number(row.manager_epoch)>request.authority.epoch||
    row.job_state!=='completed'||row.job_profile!=='synthetic-specialist-v1'||row.job_context!==request.authority.contextId||
    row.job_grant!==row.grant_id||Number(row.job_epoch)!==Number(row.manager_epoch)||!physical||!row.job_receipt||digest(physical)!==digest(row.job_receipt)||
    physical.jobId!==row.id||typeof physical.containerId!=='string'||!/^[a-f0-9]{64}$/.test(physical.containerId)||physical.containerId!==row.container_id||physical.exitCode!==0||typeof physical.finishedAt!=='string'||
    physical.finishedAt.startsWith('0001-')||!Number.isFinite(Date.parse(physical.finishedAt))||physical.synthetic!==true||
    physical.adviceIsolation?.readOnlySnapshot!==true||physical.adviceIsolation?.uid!==10001||!Array.isArray(physical.adviceIsolation?.visible)||physical.adviceIsolation.visible.length!==0||
    !row.launch||!row.launch.advice||row.launch.profile!=='synthetic-specialist-v1'||row.launch.source?.base!==row.base_id||row.launch_context!==request.authority.contextId||Number(row.launch_epoch)!==Number(row.manager_epoch)||digest(row.launch)!==row.launch_digest||
    digest(row.input)!==row.input_saved||row.input_digest!==row.input_saved||row.input_base!==row.base_id||row.policy_digest!==policy.digest||
    row.scope_digest!==digest({writePaths:row.input.writePaths,acceptanceRefs:row.input.acceptanceRefs})||
    receipt.inputDigest!==row.input_digest||receipt.scopeDigest!==row.scope_digest||receipt.policyDigest!==row.policy_digest||receipt.sourceBase!==row.base_id||receipt.policyRevision!==row.policy_revision||
    !advice||advice.adviceId!==row.id||advice.intentId!==intentId||advice.operationId!==row.operation_id||advice.unitId!==row.parent_unit_id||
    advice.inputDigest!==row.input_digest||advice.scopeDigest!==row.scope_digest||advice.policyDigest!==row.policy_digest||advice.sourceBase!==row.base_id||
    advice.policyRevision!==row.policy_revision||digest(row.launch.advice)!==digest({adviceId:row.id,intentId,unitId:row.parent_unit_id,operationId:row.operation_id,
     policyRevision:row.policy_revision,scopeDigest:row.scope_digest,inputDigest:row.input_digest,policyDigest:row.policy_digest})||
    advice.verdict!=='proceed'||advice.verifierDigest!==receipt.verifierDigest||advice.verifierDigest!==policy.snapshot.specialistVerifierDigest)throw new Refusal('PREIMPLEMENTATION_ADVICE_REQUIRED');
 }
 constructor(private readonly config:SandboxBrokerConfig,private readonly key:Uint8Array,docker=new DockerDaemon()){
  if(key.byteLength!==32||!/^sha256:[a-f0-9]{64}$/.test(config.imageId)||!/^[a-f0-9]{64}$/.test(config.probeSha256))throw Error('INVALID_BROKER_CONFIG');
  this.diskGuard=config.diskPolicy?new DiskAdmissionGuard(config.diskPolicy):undefined;
  if(this.diskGuard&&!this.diskGuard.policy.paths.includes(resolve(config.hostRoot)))throw Error('BROKER_DISK_POLICY_MUST_COVER_HOST_ROOT');
  const versions=config.verifierVersions??[];if(versions.length>16||new Set(versions.map(v=>v.hash)).size!==versions.length||versions.some(v=>!v.path.startsWith('/')||resolve(v.path)!==v.path||!/^[a-f0-9]{64}$/.test(v.hash)))throw Error('INVALID_VERIFIER_VERSIONS');
  this.ledger=new Ledger(config.databaseUrl);this.docker=docker;
 }
 private validate(raw:unknown){
  const value=SandboxRequest.parse(raw),{signature:mac,...body}=value;
  const expected=Buffer.from(signature(body,this.key),'hex'),presented=Buffer.from(mac,'hex');
  if(!timingSafeEqual(expected,presented))throw new Refusal('SANDBOX_SIGNATURE_INVALID',403);
  const now=Date.now();if(value.expiresAt<now||value.expiresAt>now+60000)throw new Refusal('SANDBOX_SIGNATURE_EXPIRED',403);
  return value;
 }
 private async workspace(jobId:string){
  const root=await realpath(this.config.hostRoot),job=resolve(root,jobId),expected=resolve(job,'work');
  if(!expected.startsWith(root+sep))throw new Refusal('SANDBOX_WORKSPACE_FORBIDDEN',403);
  await mkdir(job,{recursive:false,mode:0o700}).catch(async error=>{
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   const existing=await lstat(job);if(existing.isSymbolicLink()||!existing.isDirectory()||(await realpath(job))!==job)throw new Refusal('SANDBOX_WORKSPACE_FORBIDDEN',403);
  });
  await mkdir(expected,{recursive:false,mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
  const info=await lstat(expected),actual=await realpath(expected);
  if(info.isSymbolicLink()||!info.isDirectory()||actual!==expected)throw new Refusal('SANDBOX_WORKSPACE_FORBIDDEN',403);
  // The root-owned parent remains private. Permit the unprivileged broker
  // (without CAP_DAC_OVERRIDE) to read the synthetic worker's receipt.
  await chmod(expected,0o755);await chown(expected,10001,10001);return actual;
 }
 private executor(request:SandboxRequest){
  if(request.profile==='synthetic-specialist-v1'){
   if(!request.source||!request.advice||request.verification||request.source.outputPath||request.source.correction||request.source.composition||
      !this.config.specialistPath||!this.config.specialistSha256)throw new Refusal('SANDBOX_SPECIALIST_NOT_CONFIGURED');
   return {path:this.config.specialistPath,hash:this.config.specialistSha256};
  }
  if(request.advice)throw new Refusal('SANDBOX_PROFILE_MISMATCH');
  if(request.profile==='synthetic-verification-v1'){
   if(!request.source||!request.verification||!this.config.verificationPath||!this.config.verificationSha256||
      !this.config.verifierPath||!this.config.verifierSha256)throw new Refusal('SANDBOX_VERIFICATION_NOT_CONFIGURED');
   const expected=request.verification.verifierDigest;
   const verifier=!expected||expected===this.config.verifierSha256?{path:this.config.verifierPath,hash:this.config.verifierSha256}:this.config.verifierVersions?.find(v=>v.hash===expected);
   if(!verifier)throw new Refusal('VERIFIER_VERSION_NOT_CONFIGURED');
   return {path:this.config.verificationPath,hash:this.config.verificationSha256,verifier};
  }
  if(request.verification)throw new Refusal('SANDBOX_PROFILE_MISMATCH');
  if(request.profile==='synthetic-probe-v1'){
   if(request.source)throw new Refusal('SANDBOX_PROFILE_MISMATCH');
   return {path:this.config.probeHostPath,hash:this.config.probeSha256};
  }
  if(!request.source||!this.config.implementationPath||!this.config.implementationSha256)throw new Refusal('SANDBOX_IMPLEMENTATION_NOT_CONFIGURED');
  return {path:this.config.implementationPath,hash:this.config.implementationSha256};
 }
 private specification(request:SandboxRequest,work:string,epoch=request.authority.epoch){
  const executor=this.executor(request);
  const base={profile:request.profile,image:this.config.imageId,work,probe:executor.path,probeSha256:executor.hash,grant:request.grantId,epoch};
  return digest(request.advice?{...base,sourceDigest:digest(request.source),advice:request.advice}:
   request.verification?{...base,sourceDigest:digest(request.source),verification:request.verification,verifier:executor.verifier}:
   request.source?{...base,sourceDigest:digest(request.source)}:base);
 }
 private inspectExpected(value:Inspected,request:SandboxRequest,spec:string,work:string){
  const labels=value.Config.Labels??{};
  if(labels['ac.scope']!=='isolated-synthetic' ||labels['ac.job']!==request.jobId||labels['ac.grant']!==request.grantId||
    labels['ac.epoch']!==String(request.authority.epoch)||labels['ac.spec']!==spec||value.Image!==this.config.imageId||
    value.Config.User!=='10001:10001'||value.HostConfig.NetworkMode!=='none'||!value.HostConfig.ReadonlyRootfs||value.HostConfig.Privileged||
    !value.HostConfig.CapDrop?.includes('ALL')||!value.HostConfig.SecurityOpt?.some(s=>s.startsWith('no-new-privileges'))||
    value.HostConfig.PidsLimit!==64||value.HostConfig.Memory!==268435456||value.HostConfig.NanoCpus!==1000000000||
    value.Mounts.length!==(request.verification?4:request.advice?3:2)||!value.Mounts.some(m=>m.Destination==='/work'&&m.Source===work&&m.RW===!(request.verification||request.advice))||
    (request.verification&&(!value.Mounts.some(m=>m.Destination==='/output'&&m.Source===join(this.config.hostRoot,request.jobId,'output')&&m.RW)||
      !value.Mounts.some(m=>m.Destination==='/runner/verifier.mjs'&&m.Source===this.executor(request).verifier?.path&&!m.RW)))||
    (request.advice&&!value.Mounts.some(m=>m.Destination==='/output'&&m.Source===join(this.config.hostRoot,request.jobId,'output')&&m.RW))||
    !value.Mounts.some(m=>m.Destination==='/runner/probe.mjs'&&m.Source===this.executor(request).path&&!m.RW))
    throw new Refusal('SANDBOX_IDENTITY_MISMATCH');
 }
 async perform(raw:unknown){
  const value=this.validate(raw),name='ac-synthetic-'+value.jobId,work=join(this.config.hostRoot,value.jobId,'work');
  const executor=this.executor(value);
  if(createHash('sha256').update(await readFile(executor.path)).digest('hex')!==executor.hash)
    throw new Refusal('SANDBOX_EXECUTOR_CHANGED');
  if(executor.verifier&&createHash('sha256').update(await readFile(executor.verifier.path)).digest('hex')!==executor.verifier.hash)
    throw new Refusal('SANDBOX_EXECUTOR_CHANGED');
  const spec=this.specification(value,work);
  const principal=(await this.ledger.pool.query('SELECT i.principal_id FROM ac_capacity_grants g JOIN ac_intents i ON i.id=g.intent_id WHERE g.id=$1',[value.grantId])).rows[0]?.principal_id;
  if(!principal)throw new Refusal('GRANT_FORBIDDEN',403);
  const admission=await this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,value.authority.contextId);await this.ledger.fence(c,value.authority,value.action!=='start');
   const grant=(await c.query(`SELECT g.*,a.enabled account_enabled,a.eligibility,p.enabled profile_enabled,q.status quota_status,q.expires_at>clock_timestamp() quota_fresh
    FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id JOIN ac_profiles p ON p.id=g.profile_id
    LEFT JOIN ac_quota_observations q ON q.account_id=a.id WHERE g.id=$1 AND g.context_id=$2 FOR UPDATE OF g`,[value.grantId,value.authority.contextId])).rows[0];
   if(!grant)throw new Refusal('GRANT_FORBIDDEN',403);
   if(value.action==='start')await this.ledger.assertIntentActive(c,value.authority.contextId,grant.intent_id);
   if(value.action==='start'&&value.profile==='synthetic-implementation-v1')await this.requireSpecialist(c,value,grant.intent_id);
   if(value.source&&!value.advice){
    const binding=(await c.query(`SELECT i.parent_intent_id,m.base_id,m.snapshot,m.digest FROM ac_intents i
     LEFT JOIN ac_managed_delivery_inputs m ON m.intent_id=i.id WHERE i.id=$1`,[grant.intent_id])).rows[0];
    if(binding?.parent_intent_id){
     const input=z.object({kind:z.enum(['task','composition']),writePaths:z.array(z.string()).min(1),sources:z.array(z.string()),correction:z.unknown().optional()}).passthrough().safeParse(binding.snapshot);
     if(!input.success||digest(binding.snapshot)!==binding.digest||
       (input.data.kind==='task'&&(value.source.outputPath!==input.data.writePaths[0]||value.source.composition!==undefined))||
       (!value.verification&&value.source.base!==binding.base_id))throw new Refusal('MANAGED_INPUT_MISMATCH');
     if(input.data.kind==='composition'){
      const sources=(await c.query('SELECT snapshot,digest FROM ac_managed_composition_sources WHERE intent_id=$1',[grant.intent_id])).rows[0];
      if(!value.verification||value.source.outputPath!==undefined||value.source.correction!==undefined||!value.source.composition||!sources||digest(sources.snapshot)!==sources.digest||
        digest(value.source.composition)!==sources.digest||digest(value.source.composition.map(s=>s.unitId))!==digest(input.data.sources))throw new Refusal('MANAGED_COMPOSITION_SOURCES_MISMATCH');
     }
     if(input.data.kind==='task'){
      const correction=value.source.correction;
      if(Boolean(input.data.correction)!==Boolean(correction))throw new Refusal('MANAGED_CORRECTION_MISMATCH');
      if(correction){
       const {schemaVersion,parentIntentId,...saved}=correction;
       if(parentIntentId!==binding.parent_intent_id||digest(saved)!==digest(input.data.correction)||!value.source.outputPath||value.source.composition)
        throw new Refusal('MANAGED_CORRECTION_MISMATCH');
       const d=(await c.query(`SELECT d.*,a.intent_id artifact_intent,a.context_id artifact_context,a.commit_id,a.tree_id,a.base_id artifact_base,
        i.parent_intent_id prior_parent,n.parent_intent_id next_parent FROM ac_managed_correction_decisions d
        JOIN ac_artifacts a ON a.id=d.prior_artifact_id JOIN ac_intents i ON i.id=d.prior_intent_id JOIN ac_intents n ON n.id=d.next_intent_id
        WHERE d.next_intent_id=$1 AND d.context_id=$2`,[grant.intent_id,value.authority.contextId])).rows[0];
       if(!d||d.parent_intent_id!==parentIntentId||d.next_parent!==parentIntentId||d.prior_parent!==parentIntentId||
         d.prior_intent_id!==correction.priorIntentId||d.prior_artifact_id!==correction.priorArtifactId||d.artifact_intent!==d.prior_intent_id||
         d.artifact_context!==value.authority.contextId||d.commit_id!==correction.priorCommit||d.tree_id!==correction.priorTree||
         d.artifact_base!==binding.base_id||d.base_id!==binding.base_id||d.task_id!==correction.taskId||d.revision!==correction.revision||
         Number(d.manager_epoch)>value.authority.epoch||digest(d.failed_evidence_ids)!==digest(correction.failedEvidenceIds)||
         digest([...new Set(correction.failedEvidenceIds)].sort())!==digest(correction.failedEvidenceIds)||d.decision_digest!==correction.decisionDigest||
         digest({parentIntentId,contextId:value.authority.contextId,taskId:d.task_id,revision:d.revision,priorIntentId:d.prior_intent_id,
          priorArtifactId:d.prior_artifact_id,failedEvidenceIds:d.failed_evidence_ids,priorCommit:d.prior_commit,priorTree:d.prior_tree,
          baseId:d.base_id,nextIntentId:d.next_intent_id,managerEpoch:Number(d.manager_epoch)})!==d.decision_digest||
         d.prior_commit!==correction.priorCommit||d.prior_tree!==correction.priorTree)throw new Refusal('MANAGED_CORRECTION_MISMATCH');
       const proof=(await c.query(`SELECT e.id,e.receipt,e.receipt_digest FROM ac_verification_evidence e JOIN ac_stage_operations s ON s.grant_id=e.grant_id AND s.session_id=e.session_id
        JOIN ac_capacity_grants g ON g.id=e.grant_id LEFT JOIN ac_sandbox_jobs j ON j.id=s.id
        WHERE e.id=ANY($1::uuid[]) AND e.artifact_id=$2 AND e.status='failed' AND s.intent_id=$3 AND s.state='completed' AND g.state='released'
        AND e.receipt->>'status'='failed' AND e.receipt->>'artifactId'=$2::text AND e.receipt->>'commit'=$4 AND e.receipt->>'tree'=$5
        AND e.receipt->>'sessionId'=s.session_id::text AND e.receipt->>'grantId'=g.id::text AND g.intent_id=$3 AND g.context_id=$6
        AND g.resource_kind='model' AND g.manager_epoch=s.manager_epoch AND g.manager_epoch<=$7
        AND e.receipt->>'kind'=e.kind AND s.node_id=e.kind
        AND g.role=CASE WHEN e.kind='review' THEN 'reviewer' ELSE e.kind END
        AND e.receipt->>'exitCode'=g.physical_receipt->>'exitCode'
        AND (e.receipt->>'exitCode') ~ '^[1-9][0-9]*$' AND s.receipt->'verification'=e.receipt AND s.receipt->>'signature' ~ '^[a-f0-9]{64}$'
        AND ((j.state='failed' AND j.receipt=g.physical_receipt AND j.receipt->>'jobId'=s.id::text
            AND j.receipt->'verification'->>'artifactId'=$2::text AND j.receipt->'verification'->>'commit'=$4
            AND j.receipt->'verification'->>'tree'=$5 AND j.receipt->'verification'->>'kind'=e.kind)
          OR (g.physical_receipt->>'source'='synthetic-verifier-parent' AND g.physical_receipt->>'state'='exited'
           AND g.physical_receipt->>'processId'=s.handle->>'pid'))`,[correction.failedEvidenceIds,d.prior_artifact_id,d.prior_intent_id,d.prior_commit,d.prior_tree,value.authority.contextId,value.authority.epoch])).rows;
       if(proof.length!==correction.failedEvidenceIds.length||proof.some((row:Record<string,unknown>)=>digest(row.receipt)!==row.receipt_digest))throw new Refusal('MANAGED_CORRECTION_MISMATCH');
      }
     }
    }else if(value.source.outputPath!==undefined||value.source.composition!==undefined||value.source.correction!==undefined)throw new Refusal('MANAGED_INPUT_MISMATCH');
   }
   if(value.advice){
    const advice=value.advice;
    const saved=(await c.query(`SELECT s.*,i.operation_id intent_operation,i.parent_unit_id,m.snapshot,m.digest input_saved,m.base_id,
     o.state writer_state,EXISTS(SELECT 1 FROM ac_sandbox_jobs writer WHERE writer.id=o.id) writer_job,
     l.snapshot launch,l.digest launch_digest,l.context_id launch_context,l.manager_epoch launch_epoch,
     x.quality_revision,x.target_ref,x.digest contract_digest,p.snapshot policy,p.digest policy_saved
     FROM ac_specialist_advice s JOIN ac_intents i ON i.id=s.intent_id JOIN ac_managed_delivery_inputs m ON m.intent_id=i.id
     JOIN ac_operations o ON o.id=i.operation_id JOIN ac_specialist_execution_launches l ON l.advice_id=s.id
     JOIN ac_execution_contracts x ON x.intent_id=i.id JOIN ac_quality_policies p ON p.project_id=x.project_id AND p.revision=x.quality_revision
     WHERE s.id=$1 AND s.context_id=$2 AND s.intent_id=$3`,[value.jobId,value.authority.contextId,grant.intent_id])).rows[0];
    if(!saved||advice.adviceId!==value.jobId||advice.intentId!==grant.intent_id||saved.grant_id!==grant.id||
      saved.attempt_id!==grant.attempt_id||grant.role!=='specialist'||grant.resource_kind!=='model'||saved.operation_id!==advice.operationId||
      saved.intent_operation!==advice.operationId||saved.unit_id!==advice.unitId||saved.parent_unit_id!==advice.unitId||
      saved.policy_revision!==advice.policyRevision||saved.quality_revision!==advice.policyRevision||saved.base_id!==value.source!.base||
      saved.contract_digest!==digest({qualityRevision:saved.quality_revision,targetRef:saved.target_ref})||
      saved.input_digest!==advice.inputDigest||saved.input_saved!==advice.inputDigest||digest(saved.snapshot)!==advice.inputDigest||
      saved.policy_digest!==advice.policyDigest||saved.policy_saved!==advice.policyDigest||digest(saved.policy)!==advice.policyDigest||
      saved.policy.requireSpecialistBeforeImplementation!==true||saved.policy.specialistVerifierDigest!==this.executor(value).hash||
      digest({writePaths:saved.snapshot.writePaths,acceptanceRefs:saved.snapshot.acceptanceRefs})!==advice.scopeDigest||saved.scope_digest!==advice.scopeDigest||
      saved.launch_context!==value.authority.contextId||Number(saved.launch_epoch)!==Number(saved.manager_epoch)||
      digest(saved.launch)!==saved.launch_digest||digest(saved.launch)!==digest({profile:value.profile,source:value.source,advice})||
      (value.action==='start'&&(saved.state!=='uncertain'||saved.writer_state!=='registered'||saved.writer_job))||
      Number(saved.manager_epoch)>value.authority.epoch||Number(saved.manager_epoch)!==Number(grant.manager_epoch))throw new Refusal('SANDBOX_SPECIALIST_SCOPE_MISMATCH');
   }
   const prior=(await c.query('SELECT * FROM ac_sandbox_jobs WHERE id=$1 FOR UPDATE',[value.jobId])).rows[0];
   if(prior){
    const priorSpec=this.specification(value,work,Number(prior.manager_epoch));
    if(prior.context_id!==value.authority.contextId||prior.profile!==value.profile||prior.grant_id!==value.grantId||prior.spec_digest!==priorSpec||
       Number(prior.manager_epoch)>value.authority.epoch||Number(prior.manager_epoch)!==Number(grant.manager_epoch))throw new Refusal('SANDBOX_ID_CONFLICT');
    if(value.action==='start'&&Number(prior.manager_epoch)!==value.authority.epoch)throw new Refusal('SANDBOX_RECONCILIATION_REQUIRED');
    if(['completed','failed'].includes(String(prior.state)))confirmedTerminal(prior,grant,value);
    return {prior,grant,priorSpec};
   }
   if(value.action!=='start')throw new Refusal('SANDBOX_JOB_NOT_FOUND');
   if(Number(grant.manager_epoch)!==value.authority.epoch||grant.state!=='reserved'||!grant.account_enabled||!grant.profile_enabled||
      grant.eligibility!=='documented_supported'||grant.quota_status!=='available'||!grant.quota_fresh)throw new Refusal('GRANT_NOT_ELIGIBLE');
   if(value.advice){
    if(grant.role!=='specialist')throw new Refusal('SANDBOX_PROFILE_ROLE_MISMATCH',403);
   }else if(value.verification){
    const role=value.verification.kind==='review'?'reviewer':value.verification.kind;
    const artifact=await c.query(`SELECT 1 FROM ac_artifacts a JOIN ac_intents i ON i.id=a.intent_id
      WHERE a.id=$1 AND a.context_id=$2 AND a.intent_id=$3 AND a.commit_id=$4 AND i.operation_id=$5`,
      [value.verification.artifactId,value.authority.contextId,grant.intent_id,value.source!.base,value.verification.operationId]);
    if(grant.role!==role||!artifact.rowCount)throw new Refusal('SANDBOX_VERIFICATION_SCOPE_MISMATCH',403);
    const policy=(await c.query(`SELECT p.snapshot,p.digest FROM ac_artifacts a JOIN ac_quality_policies p ON p.project_id=a.project_id AND p.revision=a.policy_revision WHERE a.id=$1 AND a.context_id=$2`,[value.verification.artifactId,value.authority.contextId])).rows[0];
    if(!policy||digest(QualityPolicy.parse(policy.snapshot))!==policy.digest||policy.snapshot.verifierDigest!==this.executor(value).verifier!.hash)throw new Refusal('VERIFIER_VERSION_MISMATCH');
   }else if(grant.role!=='programmer')throw new Refusal('SANDBOX_PROFILE_ROLE_MISMATCH',403);
   const owner=value.advice?await c.query('SELECT 1 FROM ac_specialist_advice WHERE id=$1 AND intent_id=$2 AND grant_id=$3 AND state=$4',[value.jobId,grant.intent_id,value.grantId,'uncertain']):grant.role==='programmer'
    ?await c.query('SELECT 1 FROM ac_operations WHERE id=$1 AND intent_id=$2 AND grant_id=$3',[value.jobId,grant.intent_id,value.grantId])
    :await c.query("SELECT 1 FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 AND grant_id=$3 AND (($4='qa' AND node_id='qa') OR ($4='reviewer' AND node_id='review') OR ($4='judge' AND node_id='judge'))",[value.jobId,grant.intent_id,value.grantId,grant.role]);
   if(!owner.rowCount)throw new Refusal('SANDBOX_OPERATION_MISMATCH',403);
   if(this.diskGuard){
    // Serialize accounting across all broker instances sharing this ledger.
    // Uncertain jobs retain their estimated write budget; never free it merely
    // because a process cannot be observed. Existing reconcile paths bypass
    // admission so storage pressure cannot prevent recovery or stop.
    await c.query('SELECT pg_advisory_xact_lock(189234,34)');
    const pending=BigInt((await c.query("SELECT count(*)::text total FROM ac_sandbox_jobs WHERE state IN ('running','uncertain')")).rows[0].total);
    await this.diskGuard.assertAdmission(pending*BigInt(this.diskGuard.policy.estimatedWriteBytes));
   }
   await c.query("INSERT INTO ac_sandbox_jobs(id,context_id,grant_id,manager_epoch,profile,spec_digest,state) VALUES($1,$2,$3,$4,$5,$6,'uncertain')",
    [value.jobId,value.authority.contextId,value.grantId,value.authority.epoch,value.profile,spec]);
   return {prior:null,grant,priorSpec:spec};
  });
  if(admission.prior){
   if(value.action==='cleanup')return this.cleanup(value,admission.prior,admission.priorSpec,work);
   if(value.action==='stop'){
    if(['completed','failed'].includes(String(admission.prior.state)))return admission.prior.receipt;
    const stopped=await this.ledger.tx(async c=>{
     await this.ledger.fence(c,value.authority,true);
     const inspected=await this.docker.inspect(name);
     if(!inspected)return false;
     this.inspectExpected(inspected,{...value,authority:{...value.authority,epoch:Number(admission.prior.manager_epoch)}},admission.priorSpec,work);
     if(inspected.State.Running)await this.docker.stop(inspected.Id);
     return true;
    });
    return stopped?this.reconcile(value,admission.prior,admission.priorSpec,work):{jobId:value.jobId,state:'uncertain'};
   }
   return this.reconcile(value,admission.prior,admission.priorSpec,work);
  }
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,value.authority);await this.ledger.assertIntentActive(c,value.authority.contextId,admission.grant.intent_id);
   await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '60 seconds' WHERE context_id=$1",[value.authority.contextId]);
   const grant=(await c.query('SELECT state,manager_epoch FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[value.grantId])).rows[0];
   if(!grant||grant.state!=='reserved'||Number(grant.manager_epoch)!==value.authority.epoch)throw new Refusal('GRANT_NOT_ELIGIBLE');
   const actual=await this.workspace(value.jobId);if(actual!==work)throw new Refusal('SANDBOX_WORKSPACE_MISMATCH');
   if(value.source){
    await chown(work,0,0);
    // Import a standalone bundle. No host Git metadata or project path is mounted.
    const bundle=Buffer.from(value.source.bundle,'base64');
    if(bundle.length>1000000||bundle.toString('base64')!==value.source.bundle)throw new Refusal('SANDBOX_SOURCE_INVALID');
    const sourcePath=join(this.config.hostRoot,value.jobId,'source.bundle');await writeFile(sourcePath,bundle,{mode:0o600,flag:'wx'});
    await exec('/usr/bin/git',['init','-q',work],{timeout:10000});
    await safeGit(work,['fetch','--no-tags',sourcePath,'HEAD']);
    if(await safeGit(work,['rev-parse','FETCH_HEAD'])!==value.source.base)throw new Refusal('SANDBOX_SOURCE_IDENTITY_MISMATCH');
    for(const [i,source] of (value.source.composition??[]).entries()){
     const ref=`refs/agent-control/sources/${i}`;
     await safeGit(work,['fetch','--no-tags',sourcePath,`${ref}:${ref}`]);
     if(await safeGit(work,['rev-parse',ref])!==source.commit)throw new Refusal('MANAGED_COMPOSITION_SOURCES_MISMATCH');
    }
    if(value.source.correction){
     const source=value.source.correction,ref='refs/agent-control/correction-source';
     await safeGit(work,['fetch','--no-tags',sourcePath,`${ref}:${ref}`]);
     const base=(await c.query('SELECT base_id FROM ac_managed_delivery_inputs WHERE intent_id=$1',[admission.grant.intent_id])).rows[0]?.base_id;
     if(!base||await safeGit(work,['rev-parse',ref])!==source.priorCommit||
       await safeGit(work,['rev-parse',`${ref}^{tree}`])!==source.priorTree||
       await safeGit(work,['rev-list','--parents','-n','1',source.priorCommit])!==`${source.priorCommit} ${base}`)
      throw new Refusal('MANAGED_CORRECTION_MISMATCH');
    }
    await safeGit(work,['checkout','--detach',value.source.base]);
    if(value.verification){
     const artifact=(await c.query('SELECT tree_id FROM ac_artifacts WHERE id=$1',[value.verification.artifactId])).rows[0];
     if(!artifact||await safeGit(work,['rev-parse','HEAD^{tree}'])!==artifact.tree_id)throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
    }
    await exec('/bin/chown',['-R','-h','10001:10001',work],{timeout:10000});
   }
   const output=join(this.config.hostRoot,value.jobId,'output');
   if(value.verification||value.advice){await mkdir(output,{mode:0o777});await chmod(output,0o777);}
   // Re-observe after checkout immediately before creating any container.
   // Failure here preserves the registered uncertain job/grant for recovery.
   await this.diskGuard?.assertAdmission();
   if(await this.docker.inspect(name))throw new Refusal('SANDBOX_NAME_IN_USE');
   const labels={'ac.scope':'isolated-synthetic','ac.job':value.jobId,'ac.grant':value.grantId,'ac.epoch':String(value.authority.epoch),'ac.spec':spec};
   const id=await this.docker.create(name,{Image:this.config.imageId,User:'10001:10001',WorkingDir:'/work',
    Entrypoint:['node','/runner/probe.mjs',...(value.advice?[Buffer.from(JSON.stringify({...value.advice,sourceBase:value.source!.base})).toString('base64')]:value.verification?[value.verification.operationId,value.verification.kind,...(value.source?.correction?['--correction',Buffer.from(JSON.stringify({outputPath:value.source.outputPath,...value.source.correction})).toString('base64')]:value.source?.composition?['--composition',Buffer.from(JSON.stringify(value.source.composition)).toString('base64')]:value.source?.outputPath?[value.source.outputPath]:[])]:value.source?[value.jobId,...(value.source.outputPath?[value.source.outputPath]:[]),...(value.source.correction?['--correction',Buffer.from(JSON.stringify({outputPath:value.source.outputPath,...value.source.correction})).toString('base64')]:[])]:[])],Env:['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp',
     'GIT_CONFIG_NOSYSTEM=1','GIT_CONFIG_GLOBAL=/dev/null','GIT_AUTHOR_NAME=Synthetic worker','GIT_AUTHOR_EMAIL=fixture@example.invalid',
     'GIT_COMMITTER_NAME=Synthetic worker','GIT_COMMITTER_EMAIL=fixture@example.invalid'],Labels:labels,
    HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],
     PidsLimit:64,Memory:268435456,NanoCpus:1000000000,AutoRemove:false,Init:true,
     Tmpfs:{'/tmp':'rw,nosuid,nodev,noexec,size=64m'},LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}},
    Binds:value.verification?[`${work}:/work:ro`,`${executor.path}:/runner/probe.mjs:ro`,`${executor.verifier!.path}:/runner/verifier.mjs:ro`,`${output}:/output:rw`]:value.advice?
     [`${work}:/work:ro`,`${executor.path}:/runner/probe.mjs:ro`,`${output}:/output:rw`]:
      [`${work}:/work:rw`,`${executor.path}:/runner/probe.mjs:ro`]}});
   const created=await this.docker.inspect(id);if(!created)throw new Refusal('DOCKER_CREATE_UNCERTAIN');
   this.inspectExpected(created,value,spec,work);
   await this.ledger.fence(c,value.authority);await this.ledger.assertIntentActive(c,value.authority.contextId,admission.grant.intent_id);
   if(value.profile==='synthetic-implementation-v1')await this.requireSpecialist(c,value,admission.grant.intent_id);
   this.active.add(id);await this.docker.start(id);this.monitor(id,value.authority);
   await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[value.grantId]);
   await c.query("UPDATE ac_sandbox_jobs SET state='running',container_id=$2 WHERE id=$1",[value.jobId,id]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'sandbox.started',$2)",[value.authority.contextId,{jobId:value.jobId,grantId:value.grantId}]);
   return {jobId:value.jobId,state:'running',containerId:id};
  });
 }
 private async reconcile(value:SandboxRequest,prior:Record<string,unknown>,spec:string,work:string){
  if(['completed','failed'].includes(String(prior.state)))return prior.receipt;
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,value.authority,true);
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 AND context_id=$2 FOR UPDATE',[value.grantId,value.authority.contextId])).rows[0];
   const job=(await c.query('SELECT * FROM ac_sandbox_jobs WHERE id=$1 FOR UPDATE',[value.jobId])).rows[0];
   if(!grant||!job||job.grant_id!==grant.id||job.context_id!==value.authority.contextId||Number(job.manager_epoch)!==Number(grant.manager_epoch)||
      Number(job.manager_epoch)>value.authority.epoch||job.spec_digest!==spec)throw new Refusal('SANDBOX_ID_CONFLICT');
   if(['completed','failed'].includes(job.state))return confirmedTerminal(job,grant,value);
   const inspected=await this.docker.inspect('ac-synthetic-'+value.jobId);
   if(!inspected)return {jobId:value.jobId,state:'uncertain'};
   // Compare against the epoch that created the container, not the successor's epoch.
   const original={...value,authority:{...value.authority,epoch:Number(job.manager_epoch)}};
   this.inspectExpected(inspected,original,spec,work);
   if(inspected.State.Running&&Number(job.manager_epoch)!==value.authority.epoch){
    await this.docker.stop(inspected.Id);
    return {jobId:value.jobId,state:'uncertain',reason:'OLD_WRITER_STOP_REQUESTED'};
   }
   if(inspected.State.Running&&Number(job.manager_epoch)===value.authority.epoch){this.active.add(inspected.Id);this.monitor(inspected.Id,value.authority);}
   if(inspected.State.Status!=='exited'||inspected.State.Running||!inspected.State.FinishedAt||inspected.State.FinishedAt.startsWith('0001-'))
    return {jobId:value.jobId,state:inspected.State.Running?'running':'uncertain'};
   const probeSchema=z.object({visible:z.array(z.string()),network:z.boolean(),uid:z.number()}).strict();
   let probe:z.infer<typeof probeSchema>|null=null;
   try{const decoded=probeSchema.safeParse(JSON.parse(await readFile(join(work,'probe-result.json'),'utf8')));if(decoded.success)probe=decoded.data;}catch{}
   let implementation:unknown=null,bundle:string|undefined,verification:unknown=null,verificationIsolation:unknown=null,advice:unknown=null,adviceIsolation:unknown=null;
   if(value.advice){
    const resultPath=join(this.config.hostRoot,value.jobId,'output','advice-result.json');
    const info=await lstat(resultPath).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
    if(info){
     if(info.isSymbolicLink()||!info.isFile()||info.size>4096||await realpath(resultPath)!==resultPath)throw new Refusal('SANDBOX_SPECIALIST_INVALID');
     const result=z.object({advice:SpecialistRequest.extend({sourceBase:z.string().regex(/^[a-f0-9]{40}$/),verdict:z.enum(['proceed','reject']),
       summary:z.literal('Synthetic pre-implementation advice')}).strict(),
      isolation:z.object({readOnlySnapshot:z.literal(true),uid:z.literal(10001),visible:z.array(z.string()).length(0)}).strict()}).strict().parse(JSON.parse(await readFile(resultPath,'utf8')));
     if(inspected.State.ExitCode!==0||digest(result.advice)!==digest({...value.advice,sourceBase:value.source!.base,verdict:result.advice.verdict,summary:'Synthetic pre-implementation advice'})||
       await safeGit(work,['rev-parse','HEAD'])!==value.source!.base)throw new Refusal('SANDBOX_SPECIALIST_INVALID');
     advice={...result.advice,verifierDigest:this.executor(value).hash};adviceIsolation=result.isolation;
    }else if(inspected.State.ExitCode===0)throw new Refusal('SANDBOX_SPECIALIST_INVALID');
   }else if(value.verification){
    const resultPath=join(this.config.hostRoot,value.jobId,'output','verification-result.json');
    const info=await lstat(resultPath).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
    if(info){
     if(info.isSymbolicLink()||!info.isFile()||info.size>70000||await realpath(resultPath)!==resultPath)throw new Refusal('SANDBOX_VERIFICATION_INVALID');
     const result=z.object({exitCode:z.number().int(),output:z.string().max(65536),nodeVersion:z.string().regex(/^v\d+\.\d+\.\d+$/),synthetic:z.literal(true),
      isolation:z.object({readOnlySnapshot:z.literal(true),uid:z.literal(10001),visible:z.array(z.string()).length(0)}).strict()}).strict()
      .parse(JSON.parse(await readFile(resultPath,'utf8')));
     const checked=z.object({role:z.enum(['qa','review','judge']),status:z.enum(['passed','failed']),checks:z.array(z.string()),synthetic:z.literal(true)}).strict().parse(JSON.parse(result.output));
     const artifact=(await c.query('SELECT * FROM ac_artifacts WHERE id=$1 AND context_id=$2',[value.verification.artifactId,value.authority.contextId])).rows[0];
     if(!artifact||result.exitCode!==inspected.State.ExitCode||checked.role!==value.verification.kind||
       (checked.status==='passed')!==(result.exitCode===0)||artifact.commit_id!==value.source!.base||
       await safeGit(work,['rev-parse','HEAD'])!==artifact.commit_id||await safeGit(work,['rev-parse','HEAD^{tree}'])!==artifact.tree_id)
      throw new Refusal('SANDBOX_VERIFICATION_INVALID');
     verification={...value.verification,commit:artifact.commit_id,tree:artifact.tree_id,base:artifact.base_id,
      verifierDigest:this.executor(value).verifier!.hash,output:result.output,nodeVersion:result.nodeVersion};
     verificationIsolation=result.isolation;
    }else if(inspected.State.ExitCode===0)throw new Refusal('SANDBOX_VERIFICATION_INVALID');
   }else if(value.source&&inspected.State.ExitCode===0){
    const raw=await readFile(join(work,`receipt-${value.jobId}.json`),'utf8');
    const parsed=z.object({operationId:Id,base:z.string().regex(/^[a-f0-9]{40}$/),commit:z.string().regex(/^[a-f0-9]{40}$/),
     tree:z.string().regex(/^[a-f0-9]{40}$/),exitCode:z.literal(0),synthetic:z.literal(true)}).strict().parse(JSON.parse(raw));
    if(parsed.operationId!==value.jobId||parsed.base!==value.source.base||await safeGit(work,['rev-parse','HEAD'])!==parsed.commit||
      await safeGit(work,['rev-parse','HEAD^{tree}'])!==parsed.tree||await safeGit(work,['rev-parse','HEAD^'])!==parsed.base||
      await safeGit(work,['diff-tree','--no-commit-id','--name-only','-r','HEAD'])!==(value.source.outputPath??`synthetic-${value.jobId}.txt`))
      throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
    if(value.source.correction&&await safeGit(work,['show',`HEAD:${value.source.outputPath}`])!==
      await correctionOutput(work,value.source.correction,value.source.outputPath!,value.jobId))throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
    const output=join(this.config.hostRoot,value.jobId,'artifact.bundle');
    await safeGit(work,['bundle','create',output,'HEAD',...(value.source.correction?['refs/agent-control/correction-source']:[])]);
    const content=await readFile(output);if(content.length>1000000)throw new Refusal('SANDBOX_ARTIFACT_TOO_LARGE');
    implementation=parsed;bundle=content.toString('base64');
   }else if(!value.source&&inspected.State.ExitCode===0&&(!probe||probe.visible.length||probe.network||probe.uid!==10001))throw new Refusal('SANDBOX_PROBE_INVALID');
   const receipt={jobId:value.jobId,containerId:inspected.Id,exitCode:inspected.State.ExitCode,finishedAt:inspected.State.FinishedAt,synthetic:true,
    probe,...(value.advice?{advice,adviceIsolation}:value.verification?{verification,verificationIsolation}:value.source?{implementation,bundle}: {})};
   await c.query('UPDATE ac_sandbox_jobs SET state=$2,receipt=$3 WHERE id=$1',[value.jobId,inspected.State.ExitCode===0?'completed':'failed',receipt]);
   const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state IN ('reserved','running','uncertain') RETURNING id",[value.grantId,receipt]);
   if(!released.rowCount)throw new Refusal('SANDBOX_RECEIPT_UNCONFIRMED');
   this.active.delete(inspected.Id);const timer=this.monitors.get(inspected.Id);if(timer)clearInterval(timer);this.monitors.delete(inspected.Id);return receipt;
  });
 }
 private async cleanup(value:SandboxRequest,prior:Record<string,unknown>,spec:string,work:string){
  if(!['completed','failed'].includes(String(prior.state)))throw new Refusal('SANDBOX_STILL_ACTIVE');
  if(value.profile==='synthetic-implementation-v1'){
   const managed=(await this.ledger.pool.query(`SELECT i.parent_intent_id FROM ac_operations o JOIN ac_intents i ON i.id=o.intent_id
    WHERE o.id=$1 AND i.context_id=$2`,[value.jobId,value.authority.contextId])).rows[0];
   if(!managed)throw new Refusal('SANDBOX_OPERATION_MISMATCH',403);
   if(managed.parent_intent_id)return this.retireManagedWriter(value,spec,work);
  }
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,value.authority,true);
   const inspected=await this.docker.inspect('ac-synthetic-'+value.jobId);
   if(inspected){
    const original={...value,authority:{...value.authority,epoch:Number(prior.manager_epoch)}};
    this.inspectExpected(inspected,original,spec,work);
    if(inspected.State.Running||inspected.State.Status!=='exited')throw new Refusal('SANDBOX_STILL_ACTIVE');
    await this.docker.remove(inspected.Id);
   }
   const root=await realpath(this.config.hostRoot),job=resolve(root,value.jobId);
   if(!job.startsWith(root+sep))throw new Refusal('SANDBOX_WORKSPACE_FORBIDDEN',403);
   try{const info=await lstat(job);if(info.isSymbolicLink()||(await realpath(job))!==job)throw new Refusal('SANDBOX_WORKSPACE_FORBIDDEN',403);}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   // Only after a matching container has exited, take back ownership of its
   // dedicated fixture directory so cleanup does not need DAC override.
   const workInfo=await lstat(work).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
   if(workInfo){if(workInfo.isSymbolicLink()||!workInfo.isDirectory()||(await realpath(work))!==work)throw new Refusal('SANDBOX_WORKSPACE_FORBIDDEN',403);
    await exec('/bin/chown',['-R','-h','0:0',work],{timeout:10000});await chmod(work,0o700);}
   await rm(job,{recursive:true,force:true});return {jobId:value.jobId,state:'cleaned'};
  });
 }
 /** Archive the terminal logs before removing the exact stopped container. The
  * managed copy remains in place and is never reassigned. */
 private async retireManagedWriter(value:SandboxRequest,spec:string,work:string){
  const root=await realpath(this.config.hostRoot),jobPath=resolve(root,value.jobId),logPath=join(jobPath,'terminal-container.log');
  if(root!==resolve(this.config.hostRoot)||!jobPath.startsWith(root+sep))throw new Refusal('SANDBOX_WORKSPACE_FORBIDDEN',403);
  const info=await lstat(jobPath).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Refusal('SANDBOX_RETIREMENT_DATA_MISSING');throw error;});
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(jobPath)!==jobPath)throw new Refusal('SANDBOX_WORKSPACE_FORBIDDEN',403);
  const readLog=async()=>{
   const file=await open(logPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(error=>{
    if(['ENOENT','ELOOP'].includes(String((error as NodeJS.ErrnoException).code)))throw new Refusal('SANDBOX_RETIREMENT_LOG_INVALID');throw error;
   });
   try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==0||(stat.mode&0o077)!==0||stat.size>1048576)throw new Refusal('SANDBOX_RETIREMENT_LOG_INVALID');
    return createHash('sha256').update(await file.readFile()).digest('hex');}finally{await file.close();}
  };
  const locked=async(c:pg.PoolClient)=>{
   await this.ledger.fence(c,value.authority,true);
   const row=(await c.query(`SELECT i.id intent_id,i.context_id intent_context,i.parent_intent_id,i.run_id,o.state operation_state,o.receipt operation_receipt,
    o.grant_id operation_grant,o.execution_attempt_id,o.manager_epoch operation_epoch,
    j.id,j.context_id,j.grant_id,j.manager_epoch,j.state,j.container_id,j.receipt,j.profile,j.spec_digest,
    g.state grant_state,g.physical_receipt,g.intent_id grant_intent,g.context_id grant_context,g.manager_epoch grant_epoch,g.role grant_role,g.attempt_id grant_attempt,
    w.holder_intent_id,w.manager_epoch writer_epoch,w.state writer_state,w.proof_digest,w.revocation_job_id,w.revocation_proof
    FROM ac_sandbox_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id JOIN ac_operations o ON o.id=j.id
    JOIN ac_intents i ON i.id=o.intent_id JOIN ac_worktree_writers w ON w.parent_intent_id=i.parent_intent_id AND w.run_id=i.run_id
    WHERE j.id=$1 AND j.context_id=$2 AND j.grant_id=$3 FOR UPDATE OF j,g,o,w`,[value.jobId,value.authority.contextId,value.grantId])).rows[0];
   if(!row||row.profile!=='synthetic-implementation-v1'||row.spec_digest!==spec||row.holder_intent_id!==row.intent_id||
    Number(row.writer_epoch)!==Number(row.manager_epoch)||Number(row.grant_epoch)!==Number(row.manager_epoch)||Number(row.operation_epoch)>value.authority.epoch||
    row.intent_context!==value.authority.contextId||row.operation_grant!==row.grant_id||row.execution_attempt_id!==row.grant_attempt||row.grant_intent!==row.intent_id||
    row.grant_context!==value.authority.contextId||row.grant_role!=='programmer'||Number(row.manager_epoch)>value.authority.epoch||row.operation_state!=='completed'||
    row.grant_state!=='released'||row.state!=='completed'||!row.receipt?.implementation||digest(row.operation_receipt)!==digest(row.receipt.implementation)||
    digest(row.receipt)!==digest(row.physical_receipt)||row.receipt.jobId!==value.jobId||row.receipt.containerId!==row.container_id||
    row.receipt.exitCode!==0||!Number.isFinite(Date.parse(row.receipt.finishedAt))||row.receipt.finishedAt.startsWith('0001-'))
    throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   return row;
  };
  const payloadFor=(row:Record<string,any>,saved:Record<string,any>)=>({schemaVersion:1,kind:'sandbox-container-removed',jobId:value.jobId,
   contextId:row.context_id,grantId:row.grant_id,attemptId:row.grant_attempt,parentIntentId:row.parent_intent_id,
   runId:row.run_id,holderIntentId:row.intent_id,writerEpoch:Number(row.writer_epoch),
   containerId:saved.container_id,terminalDigest:saved.terminal_digest,logSha256:saved.log_sha256});
  const confirmedRevocation=async(row:Record<string,any>,saved:Record<string,any>|undefined)=>{
   if(!saved||saved.state!=='revoked'||saved.parent_intent_id!==row.parent_intent_id||saved.run_id!==row.run_id||saved.holder_intent_id!==row.intent_id||
    Number(saved.writer_epoch)!==Number(row.writer_epoch)||saved.container_id!==row.container_id||saved.terminal_digest!==digest(row.receipt)||
    row.revocation_job_id!==value.jobId||!saved.proof?.payload||digest(saved.proof.payload)!==digest(payloadFor(row,saved))||
    typeof saved.proof.signature!=='string'||!/^[a-f0-9]{64}$/.test(saved.proof.signature)||
    !timingSafeEqual(Buffer.from(saved.proof.signature,'hex'),createHmac('sha256',this.key).update('agent-control:sandbox-writer-retirement:v1\n').update(canonical(saved.proof.payload)).digest())||
    digest(saved.proof)!==row.proof_digest||digest(saved.proof)!==digest(row.revocation_proof)||await readLog()!==saved.log_sha256)
    throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   if(await this.docker.inspect(saved.container_id)||await this.docker.inspect('ac-synthetic-'+value.jobId))throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
  };
  const prepared=await this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_sandbox_writer_retirements WHERE job_id=$1 FOR UPDATE',[value.jobId])).rows[0];
   if(row.writer_state==='neutralized'){
    await confirmedRevocation(row,saved);
    return {done:true as const};
   }
   if(row.writer_state!=='held')throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   const inspected=await this.docker.inspect('ac-synthetic-'+value.jobId);
   if(inspected){
    const original={...value,authority:{...value.authority,epoch:Number(row.manager_epoch)}};
    this.inspectExpected(inspected,original,spec,work);
    if(inspected.Id!==row.container_id||inspected.State.Running||inspected.State.Status!=='exited'||inspected.State.ExitCode!==row.receipt.exitCode||inspected.State.FinishedAt!==row.receipt.finishedAt)
     throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   }else if(!saved)throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   if(!saved){
    const bytes=await this.docker.logs(row.container_id),logSha=createHash('sha256').update(bytes).digest('hex');
    try{const file=await open(logPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    if(await readLog()!==logSha)throw new Refusal('SANDBOX_RETIREMENT_LOG_INVALID');
    await c.query(`INSERT INTO ac_sandbox_writer_retirements(job_id,parent_intent_id,run_id,holder_intent_id,writer_epoch,container_id,terminal_digest,log_sha256,state)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared')`,[value.jobId,row.parent_intent_id,row.run_id,row.intent_id,row.writer_epoch,row.container_id,digest(row.receipt),logSha]);
   }else if(saved.state!=='prepared'||saved.parent_intent_id!==row.parent_intent_id||saved.run_id!==row.run_id||saved.holder_intent_id!==row.intent_id||
    Number(saved.writer_epoch)!==Number(row.writer_epoch)||saved.container_id!==row.container_id||saved.terminal_digest!==digest(row.receipt)||await readLog()!==saved.log_sha256)
    throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   return {done:false as const};
  });
  if(prepared.done)return {jobId:value.jobId,state:'cleaned'};
  return this.ledger.tx(async c=>{
   const row=await locked(c),saved=(await c.query('SELECT * FROM ac_sandbox_writer_retirements WHERE job_id=$1 FOR UPDATE',[value.jobId])).rows[0];
   if(row.writer_state==='neutralized'){
    await confirmedRevocation(row,saved);return {jobId:value.jobId,state:'cleaned'};
   }
   if(!saved||saved.state!=='prepared'||row.writer_state!=='held'||saved.parent_intent_id!==row.parent_intent_id||saved.run_id!==row.run_id||
    saved.holder_intent_id!==row.intent_id||Number(saved.writer_epoch)!==Number(row.writer_epoch)||saved.container_id!==row.container_id||
    saved.terminal_digest!==digest(row.receipt)||await readLog()!==saved.log_sha256)throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   const inspected=await this.docker.inspect('ac-synthetic-'+value.jobId);
   if(inspected){
    const original={...value,authority:{...value.authority,epoch:Number(row.manager_epoch)}};
    this.inspectExpected(inspected,original,spec,work);
    if(inspected.Id!==saved.container_id||inspected.State.Running||inspected.State.Status!=='exited'||inspected.State.ExitCode!==row.receipt.exitCode||inspected.State.FinishedAt!==row.receipt.finishedAt)
     throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
    await this.docker.remove(inspected.Id);
   }
   if(await this.docker.inspect(saved.container_id)||await this.docker.inspect('ac-synthetic-'+value.jobId))throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   const payload=payloadFor(row,saved);
   const proof={payload,signature:createHmac('sha256',this.key).update('agent-control:sandbox-writer-retirement:v1\n').update(canonical(payload)).digest('hex')};
   await c.query("UPDATE ac_sandbox_writer_retirements SET state='revoked',proof=$2 WHERE job_id=$1 AND state='prepared'",[value.jobId,proof]);
   const changed=await c.query(`UPDATE ac_worktree_writers SET state='neutralized',proof_digest=$5,revocation_job_id=$6,revocation_proof=$7
    WHERE parent_intent_id=$1 AND run_id=$2 AND holder_intent_id=$3 AND manager_epoch=$4 AND state='held'`,
    [row.parent_intent_id,row.run_id,row.intent_id,row.writer_epoch,digest(proof),value.jobId,proof]);
   if(!changed.rowCount)throw new Refusal('SANDBOX_RETIREMENT_UNCONFIRMED');
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'worktree.writer_revoked',$2)",
    [value.authority.contextId,{jobId:value.jobId,parentIntentId:row.parent_intent_id,runId:row.run_id,proofDigest:digest(proof)}]);
   return {jobId:value.jobId,state:'cleaned'};
  });
 }
 /** On broker restart, do not leave an old writer running without a fence monitor.
  * Stop matching containers; the successor reconciles their terminal receipts. */
 async neutralizePersistedJobs(){
  const jobs=(await this.ledger.pool.query("SELECT * FROM ac_sandbox_jobs WHERE state IN ('uncertain','running') ORDER BY created_at,id")).rows;
  for(const job of jobs){
   const profile=z.enum(['synthetic-probe-v1','synthetic-implementation-v1','synthetic-verification-v1','synthetic-specialist-v1']).parse(job.profile);
   let source:SandboxRequest['source'];
   let verification:SandboxRequest['verification'];
   let advice:SandboxRequest['advice'];
   if(profile!=='synthetic-probe-v1'){
    const launch=(await this.ledger.pool.query(profile==='synthetic-verification-v1'
     ?'SELECT snapshot,digest FROM ac_stage_execution_launches WHERE stage_id=$1':profile==='synthetic-specialist-v1'
     ?'SELECT snapshot,digest FROM ac_specialist_execution_launches WHERE advice_id=$1':'SELECT snapshot,digest FROM ac_execution_launches WHERE operation_id=$1',[job.id])).rows[0];
    if(!launch||digest(launch.snapshot)!==launch.digest)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
    source=SandboxRequest.shape.source.unwrap().parse(launch.snapshot.source);
    if(profile==='synthetic-verification-v1')verification=SandboxRequest.shape.verification.unwrap().parse(launch.snapshot.verification);
    if(profile==='synthetic-specialist-v1')advice=SpecialistRequest.parse(launch.snapshot.advice);
   }
   const value:SandboxRequest={schemaVersion:1,action:'reconcile',jobId:job.id,grantId:job.grant_id,
    authority:{contextId:job.context_id,instanceId:randomUUID(),epoch:Number(job.manager_epoch)},profile,
    ...(source?{source}:{}),...(verification?{verification}:{}),...(advice?{advice}:{}),expiresAt:Date.now()+30000,signature:'0'.repeat(64)};
   const work=join(this.config.hostRoot,job.id,'work');
   if(profile==='synthetic-specialist-v1'&&this.specification(value,work)!==job.spec_digest)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
   const inspected=await this.docker.inspect('ac-synthetic-'+job.id);
   if(!inspected)continue;
   this.inspectExpected(inspected,value,job.spec_digest,work);
   if(inspected.State.Running)await this.docker.stop(inspected.Id);
  }
 }
 private monitor(id:string,authority:Authority){
  if(this.monitors.has(id))return;
  let checking=false;
  const timer=setInterval(()=>{
   if(checking)return;checking=true;
   let timeout:ReturnType<typeof setTimeout>|undefined;
   const deadline=new Promise<never>((_,fail)=>{timeout=setTimeout(()=>fail(new Error('FENCE_TIMEOUT')),2000);});
   void Promise.race([this.ledger.tx(c=>this.ledger.fence(c,authority,true)),deadline]).catch(()=>this.docker.stop(id).catch(()=>{}))
    .finally(()=>{if(timeout)clearTimeout(timeout);checking=false;});
  },1000);
  this.monitors.set(id,timer);
 }
 async close(){for(const timer of this.monitors.values())clearInterval(timer);for(const id of this.active)try{await this.docker.stop(id);}catch{}await this.ledger.close();}
}
export async function brokerMain(config:SandboxBrokerConfig){
 const directory=resolve(config.socketPath,'..');await mkdir(directory,{recursive:true,mode:0o750});
 await chown(directory,0,1000);await chmod(directory,0o750);
 await mkdir(config.hostRoot,{recursive:true,mode:0o700});const root=await lstat(config.hostRoot);
 if(root.isSymbolicLink()||!root.isDirectory()||(await realpath(config.hostRoot))!==config.hostRoot)throw Error('UNSAFE_SANDBOX_ROOT');
 await chown(config.hostRoot,0,0);await chmod(config.hostRoot,0o700);
 let key:Buffer;try{key=await readFile(config.keyPath);}catch{key=randomBytes(32);await writeFile(config.keyPath,key,{mode:0o640,flag:'wx'});await chown(config.keyPath,0,1000);}
 const keyInfo=await lstat(config.keyPath);
 if(!keyInfo.isFile()||keyInfo.isSymbolicLink()||keyInfo.uid!==0||keyInfo.gid!==1000||(keyInfo.mode&0o037)!==0)throw Error('UNSAFE_BROKER_KEY');
 const broker=new SandboxBroker(config,key);await broker.ledger.migrate();
 const lock=await broker.ledger.pool.connect();
 if(!(await lock.query('SELECT pg_try_advisory_lock(189234,19) ok')).rows[0].ok){lock.release();await broker.close();throw Error('BROKER_ALREADY_RUNNING');}
 await broker.neutralizePersistedJobs();
 try{
  const old=await lstat(config.socketPath);
  if(!old.isSocket()||old.uid!==0)throw Error('UNSAFE_BROKER_SOCKET');
  const occupied=await new Promise<boolean>(resolve=>{
   const socket=createConnection(config.socketPath);socket.setTimeout(500);
   socket.once('connect',()=>{socket.destroy();resolve(true);});
   socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(true);});
  });
  if(occupied)throw Error('BROKER_ALREADY_RUNNING');
  await unlink(config.socketPath);
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){lock.release();await broker.close();throw error;}}
 const server=createServer((req:IncomingMessage,res:ServerResponse)=>{
  if(req.method!=='POST'||req.url!=='/v1/jobs'){res.writeHead(404).end();return;}
  let body='';req.on('data',chunk=>{body+=String(chunk);if(body.length>1500000)req.destroy();});
  req.on('end',()=>{void Promise.resolve().then(()=>broker.perform(JSON.parse(body))).then(result=>{res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));})
   .catch(error=>{if(!(error instanceof Refusal))console.error('sandbox broker failure',String((error as NodeJS.ErrnoException)?.code??'UNKNOWN'));res.writeHead(error instanceof Refusal?error.status:400,{'content-type':'application/json'}).end(JSON.stringify({error:error instanceof Refusal?error.code:'INVALID_REQUEST'}));});});
 });
 await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(config.socketPath,()=>ok());});await chmod(config.socketPath,0o660);await chown(config.socketPath,0,1000);
 let stopping:Promise<void>|undefined;
 const stop=()=>stopping??=(async()=>{
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  try{await lock.query('SELECT pg_advisory_unlock(189234,19)');}catch{}
  lock.release(true);await broker.close();
 })();
 lock.once('error',()=>{void stop().finally(()=>{process.exitCode=1;});});
 lock.once('end',()=>{void stop().finally(()=>{process.exitCode=1;});});
 return {server,broker,stop};
}
