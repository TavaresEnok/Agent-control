import {lstat,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createHash,createPrivateKey,createPublicKey} from 'node:crypto';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import type {Authority} from './contracts.ts';
import type {Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';
import {CodexPlanningAdapter} from './codex-planning-adapter.ts';
import {CodexExecutionAdapter} from './codex-execution-adapter.ts';
import {nativePlanningExecutorDigest} from './native-planning-contract.ts';
import {nativeExecutionExecutorDigest} from './native-execution-contract.ts';
import {NativeQaContract,nativeQaContractDigest} from './native-qa-contract.ts';
import {nativeReviewVerifierDigest} from './native-review-contract.ts';

const Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Image=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Name=z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);
const Env=z.string().max(4096).regex(/^[A-Z_][A-Z0-9_]*=[^\x00\r\n]*$/);
const AccountBinding=z.object({accountId:z.uuid(),subjectDigest:Hash}).strict();
const absolute=z.string().refine(path=>resolve(path)===path,'Absolute canonical path required');
/** File configuration cannot name a Docker socket. Workers never receive the daemon. */
const privatePath=absolute.refine(path=>!path.includes('docker.sock'),'NATIVE_BOOTSTRAP_SOCKET_FORBIDDEN');

export const NativeBootstrapDisabled=z.object({state:z.literal('disabled')}).strict();
export const NativeBootstrapBench=z.object({
 state:z.literal('bench'),contract:z.literal('native-bootstrap-bench-v1'),projectId:z.uuid(),contextId:z.uuid(),
 epoch:z.number().int().positive(),instanceId:z.uuid(),source:z.literal('authorized-endpoint'),
 accounts:z.array(AccountBinding).min(1).max(8),planningDigest:Hash,executionDigest:Hash,
}).strict();
export const NativeBootstrapConfigured=z.object({
 state:z.literal('configured'),contract:z.literal('native-bootstrap-configured-v1'),projectId:z.uuid(),contextId:z.uuid(),
 epoch:z.number().int().positive(),instanceId:z.uuid(),source:z.literal('authorized-endpoint'),
 accounts:z.array(AccountBinding).min(1).max(8),
 planning:z.object({id:Name,imageId:Image,executorDigest:Hash,signingKeyFile:privatePath,keyFingerprint:Hash,hostRoot:privatePath,accountRoot:privatePath}).strict(),
 execution:z.object({id:Name,workerImage:Image,toolsImage:Image,executorDigest:Hash,signingKeyFile:privatePath,keyFingerprint:Hash,
  hostRoot:privatePath,accountRoot:privatePath,providerNetworkId:Hash,workerEnv:z.array(Env).max(16),toolsEnv:z.array(Env).max(16)}).strict(),
 qa:NativeQaContract,qaDigest:Hash,review:z.object({signingKeyFile:privatePath,keyFingerprint:Hash,verifierDigest:Hash}).strict(),
}).strict();
export const NativeBootstrapConfig=z.discriminatedUnion('state',[NativeBootstrapDisabled,NativeBootstrapBench,NativeBootstrapConfigured]);
export type NativeBootstrapConfig=z.infer<typeof NativeBootstrapConfig>;

export type NativeBootstrapReport={
 schemaVersion:1;state:'disabled'|'bench-ready'|'activation-blocked';executionEnabled:false;inferenceEnabled:false;
 realAccountsEnabled:false;adaptersComposed:boolean;ready:false;dormantGuard:'sql-042';capacityGuard:'intact';
 reason?:'PROVIDER_RUNTIME_NOT_ACTIVATED'|'NATIVE_ACTIVATION_NOT_PERMITTED'|'BENCH_SUBSTITUTE_ONLY';
};
export type NativeBootstrapAttachment={
 projectId:string;state:'bench-ready'|'activation-blocked';executionEnabled:boolean;inferenceEnabled:boolean;
 report:NativeBootstrapReport;readSource?:(authority:Authority)=>Promise<string>;
 /** Present only for an injected bench. The runtime must not call these adapters. */
 benchAdapters?:{planning:CodexPlanningAdapter;execution:CodexExecutionAdapter};
};
/** Shared refusal used by the runtime. Opt-in never turns execution or inference on. */
export function assertNativeBootstrapAttachment(projectId:string,attachment:NativeBootstrapAttachment,linked:{implementation?:boolean;executions?:number;planning?:number}={}){
 if(attachment.projectId!==projectId)throw new Refusal('NATIVE_BOOTSTRAP_PROJECT_MISMATCH',403);
 if(attachment.executionEnabled!==false||attachment.inferenceEnabled!==false)throw new Refusal('NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED');
 if(attachment.state==='activation-blocked'&&(linked.implementation||(linked.executions??0)>0||(linked.planning??0)>0))throw new Refusal('NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED');
}
export type BenchRuntime={
 executionMode:'administration-only'|'execution';nativeExecutionReady:boolean;nativeBootstrapReport?:NativeBootstrapReport;
 readAuthorizedBootstrapSource(authority:Authority):Promise<string>;start(mode?:'execution'|'administration-only'):Promise<void>;close():void|Promise<void>;
};
export type BootstrapQuery={query(sql:string,params?:readonly unknown[]):Promise<{rows:Record<string,unknown>[];rowCount:number|null}>};
export type BootstrapShutdownFailure={name:string;code:string};
export type BootstrapShutdown={closed:string[];released:string[];preserved:string[];failures?:BootstrapShutdownFailure[]};
type Component={name:string;phase:'constructed'|'proven-not-started'|'uncertain';grantId?:string;close?:()=>void|Promise<void>};

const guards={dormantGuard:'sql-042' as const,capacityGuard:'intact' as const,executionEnabled:false as const,inferenceEnabled:false as const,realAccountsEnabled:false as const,ready:false as const,schemaVersion:1 as const};
export function disabledNativeBootstrapReport():NativeBootstrapReport{return {...guards,state:'disabled',adaptersComposed:false};}
/** Disabled stays unwired. A configured report is attached as activation-blocked and cannot opt the runtime into execution. Bench stays on the injection path. */
export function nativeBootstrapRuntimeAttachment(projectId:string,report:NativeBootstrapReport):NativeBootstrapAttachment|undefined{
 if(report.state==='disabled')return undefined;
 if(report.state!=='activation-blocked'||report.executionEnabled||report.inferenceEnabled||report.realAccountsEnabled||report.ready||report.adaptersComposed)
  throw new Refusal('NATIVE_BOOTSTRAP_ACTIVATION_BLOCKED');
 const attachment:NativeBootstrapAttachment={projectId,state:'activation-blocked',executionEnabled:false,inferenceEnabled:false,report};
 assertNativeBootstrapAttachment(projectId,attachment);
 return attachment;
}

/** Synchronous binding checks. A returned code means the configuration is refused before files, database writes, Docker or models. */
export function nativeBootstrapSchemaError(value:{project:{id:string;repo:string};projects:{repo:string}[];dataDirectory:string;
 contextVault?:{directory:string;masterFile:string};managerTransport?:{contexts:{projectId:string;contextId:string}[]};nativeBootstrap?:NativeBootstrapConfig}):string|undefined{
 const boot=value.nativeBootstrap;if(!boot||boot.state==='disabled')return;
 if(boot.projectId!==value.project.id)return 'NATIVE_BOOTSTRAP_PROJECT_MISMATCH';
 if(new Set(boot.accounts.map(account=>account.accountId)).size!==boot.accounts.length)return 'NATIVE_BOOTSTRAP_ACCOUNT_DUPLICATE';
 const listed=value.managerTransport?.contexts.filter(item=>item.projectId===boot.projectId&&item.contextId===boot.contextId)??[];
 if(value.managerTransport&&listed.length!==1)return 'NATIVE_BOOTSTRAP_CONTEXT_MISMATCH';
 if(boot.state==='bench')return;
 if(boot.planning.executorDigest!==nativePlanningExecutorDigest(boot.planning.imageId))return 'NATIVE_BOOTSTRAP_DIGEST_MISMATCH';
 if(boot.execution.executorDigest!==nativeExecutionExecutorDigest(boot.execution.workerImage,boot.execution.toolsImage))return 'NATIVE_BOOTSTRAP_DIGEST_MISMATCH';
 if(boot.qaDigest!==nativeQaContractDigest(boot.qa)||boot.review.verifierDigest!==nativeReviewVerifierDigest)return 'NATIVE_BOOTSTRAP_DIGEST_MISMATCH';
 const repos=[value.project.repo,...value.projects.map(project=>project.repo)];
 const paths=[boot.planning.hostRoot,boot.planning.accountRoot,boot.planning.signingKeyFile,boot.execution.hostRoot,boot.execution.accountRoot,boot.execution.signingKeyFile,boot.review.signingKeyFile];
 if(paths.some(path=>path.includes('docker.sock')||resolve(path)!==path))return 'NATIVE_BOOTSTRAP_SOCKET_FORBIDDEN';
 if([...boot.execution.workerEnv,...boot.execution.toolsEnv].some(item=>item.includes('docker.sock')||item.startsWith('DOCKER_HOST=')))return 'NATIVE_BOOTSTRAP_SOCKET_FORBIDDEN';
 const inside=(path:string)=>path===value.dataDirectory||path.startsWith(value.dataDirectory+sep);
 const overlaps=(path:string,other:string)=>path===other||path.startsWith(other+sep)||other.startsWith(path+sep);
 if(paths.some(path=>!inside(path)||repos.some(repo=>overlaps(path,repo))))return 'NATIVE_BOOTSTRAP_PATH_INVALID';
 const roots=[boot.planning.hostRoot,boot.planning.accountRoot,boot.execution.hostRoot,boot.execution.accountRoot];
 if(new Set(roots).size!==roots.length||roots.some((root,index)=>roots.some((other,otherIndex)=>otherIndex!==index&&overlaps(root,other))))return 'NATIVE_BOOTSTRAP_PATH_INVALID';
 const keys=[boot.planning.signingKeyFile,boot.execution.signingKeyFile,boot.review.signingKeyFile];
 if(new Set(keys).size!==keys.length||keys.some(key=>roots.some(root=>overlaps(key,root))))return 'NATIVE_BOOTSTRAP_PATH_INVALID';
 if(value.contextVault&&[value.contextVault.directory,value.contextVault.masterFile].some(vault=>paths.some(path=>overlaps(path,vault))))return 'NATIVE_BOOTSTRAP_PATH_INVALID';
 return;
}

export class NativeBootstrapRefusal extends Refusal{
 constructor(code:string,readonly shutdown:BootstrapShutdown,status:400|401|403|404|409|503=409){super(code,status);}
}
/** Tracks partial composition. Shutdown closes only components that never started and releases only grants still proven unstarted. */
export class NativeBootstrapSession{
 private readonly components:Component[]=[];private done=false;private result:BootstrapShutdown={closed:[],released:[],preserved:[]};
 readonly replayCount=0;
 track(component:Component){if(this.done)throw new Refusal('NATIVE_BOOTSTRAP_SESSION_CLOSED');this.components.push(component);}
 async shutdown(client?:BootstrapQuery):Promise<BootstrapShutdown>{
  if(this.done)return this.result;
  const closed=[...this.result.closed],released=[...this.result.released],preserved=[...this.result.preserved];
  const failures:BootstrapShutdownFailure[]=[];const pending:Component[]=[];
  for(const component of [...this.components].reverse()){
   try{
    if(component.phase==='uncertain'||(component.phase==='proven-not-started'&&(!component.grantId||!client))){preserved.push(component.name);continue;}
    if(component.phase==='constructed'){await component.close?.();closed.push(component.name);continue;}
    const outcome=await releaseProvenUnstartedGrant(client as BootstrapQuery,component.grantId as string);
    (outcome==='released'?released:preserved).push(component.name);
   }catch(error){
    failures.push({name:component.name,code:error instanceof Error?error.message:'NATIVE_BOOTSTRAP_SHUTDOWN_FAILED'});
    // A rejected release is not proof the grant is still reserved, so it is preserved and not replayed.
    if(component.phase==='proven-not-started')preserved.push(component.name);
    else pending.push(component);
   }
  }
  this.components.length=0;
  for(const component of pending.reverse())this.components.push(component);
  const progress:BootstrapShutdown={closed,released,preserved};
  this.result=progress;
  if(!pending.length)this.done=true;
  if(failures.length)throw new NativeBootstrapRefusal('NATIVE_BOOTSTRAP_SHUTDOWN_INCOMPLETE',{...progress,failures});
  return progress;
 }
}
const releaseSql=`UPDATE ac_capacity_grants AS g
 SET state='released', physical_receipt=$2::jsonb
 WHERE g.id=$1 AND g.state='reserved'
  AND NOT EXISTS (SELECT 1 FROM ac_native_planning_jobs j WHERE j.grant_id=g.id)
  AND NOT EXISTS (SELECT 1 FROM ac_native_execution_jobs j WHERE j.grant_id=g.id)
  AND NOT EXISTS (SELECT 1 FROM ac_native_qa_jobs j WHERE j.grant_id=g.id)
  AND NOT EXISTS (
   SELECT 1 FROM ac_operations o WHERE o.grant_id=g.id
    AND (o.state<>'registered' OR o.handle IS NOT NULL OR o.native_session_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM ac_execution_launches l WHERE l.operation_id=o.id)
     OR EXISTS (SELECT 1 FROM ac_sandbox_jobs s WHERE s.id=o.id)))
 RETURNING g.id`;
/** One conditional update. Uncertain, running or already launched grants match nothing and stay untouched. */
export async function releaseProvenUnstartedGrant(client:BootstrapQuery,grantId:string):Promise<'released'|'preserved'>{
 z.uuid().parse(grantId);
 const result=await client.query(releaseSql,[grantId,JSON.stringify({state:'not_started',source:'native-bootstrap-unstarted'})]);
 if((result.rowCount??result.rows.length)>1)throw new Refusal('NATIVE_BOOTSTRAP_RELEASE_AMBIGUOUS');
 return result.rowCount===1||result.rows.length===1?'released':'preserved';
}

async function fail(session:NativeBootstrapSession,code:string,status:400|403|409=409):Promise<never>{
 throw new NativeBootstrapRefusal(code,await session.shutdown(),status);
}
export function assertManagerTransportAllowed(config:{nativeBootstrap?:{state?:string}}):void{
 if(config.nativeBootstrap?.state==='bench')throw new Refusal('NATIVE_BOOTSTRAP_BENCH_REQUIRES_INJECTION');
}

export async function prepareNativeBootstrap(config:Installation,client?:BootstrapQuery):Promise<{report:NativeBootstrapReport;session:NativeBootstrapSession}>{
 const session=new NativeBootstrapSession();
 const boot=config.nativeBootstrap;
 if(!boot||boot.state==='disabled')return {report:disabledNativeBootstrapReport(),session};
 if(boot.state==='bench')throw new Refusal('NATIVE_BOOTSTRAP_BENCH_REQUIRES_INJECTION');
 const schema=nativeBootstrapSchemaError(config);if(schema)throw new Refusal(schema,403);
 if(!client)throw new Refusal('NATIVE_BOOTSTRAP_AUTHORIZATION_UNAVAILABLE',403);
 const buffers:Buffer[]=[];
 try{
  for(const binding of [boot.planning,boot.execution,boot.review]){
   const {readPrivateFile}=await import('./installation.ts');
   const bytes=await readPrivateFile(binding.signingKeyFile,4096);buffers.push(bytes);
   let fingerprint:string;
   try{
    const key=createPrivateKey(bytes);if(key.asymmetricKeyType!=='ed25519')throw new Refusal('NATIVE_BOOTSTRAP_KEY_INVALID',403);
    fingerprint=createHash('sha256').update(createPublicKey(key).export({format:'der',type:'spki'})).digest('hex');
   }catch(error){if(error instanceof Refusal)throw error;throw new Refusal('NATIVE_BOOTSTRAP_KEY_INVALID',403);}
   if(fingerprint!==binding.keyFingerprint)throw new Refusal('NATIVE_BOOTSTRAP_KEY_MISMATCH',403);
  }
  for(const path of [boot.planning.hostRoot,boot.planning.accountRoot,boot.execution.hostRoot,boot.execution.accountRoot]){
   let info;
   try{info=await lstat(path);}catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='ENOENT'||code==='ENOTDIR'||code==='ELOOP')throw new Refusal('NATIVE_BOOTSTRAP_PATH_INVALID',403);
    throw error;
   }
   if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||await realpath(path)!==path)throw new Refusal('NATIVE_BOOTSTRAP_PATH_INVALID',403);
  }
  const manager=await client.query(`SELECT m.instance_id,m.epoch,x.project_id FROM ac_managers m
   JOIN ac_contexts x ON x.id=m.context_id
   JOIN ac_memberships o ON o.project_id=x.project_id AND o.principal_id=$3 AND o.role='owner'
   WHERE m.context_id=$1 AND x.project_id=$2 AND NOT x.archived`,[boot.contextId,boot.projectId,config.project.owner]);
  const row=manager.rows[0];
  if(manager.rows.length!==1||String(row?.instance_id)!==boot.instanceId||Number(row?.epoch)!==boot.epoch||String(row?.project_id)!==boot.projectId)
   throw new Refusal('NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED',403);
  const accounts=await client.query(`SELECT a.id,a.mode,a.enabled,a.provider,a.resource_identity
   FROM ac_accounts a
   JOIN ac_account_access x ON x.account_id=a.id AND x.project_id=$2
   WHERE a.id = ANY($1::uuid[])`,[boot.accounts.map(account=>account.accountId),boot.projectId]);
  const bound=boot.accounts.every(account=>accounts.rows.some(row=>String(row.id)===account.accountId&&String(row.provider)==='codex'&&String(row.resource_identity)==='codex:'+account.subjectDigest));
  if(accounts.rows.length!==boot.accounts.length||!bound)throw new Refusal('NATIVE_BOOTSTRAP_ACCOUNT_UNBOUND',403);
  const realEnabled=accounts.rows.some(account=>String(account.mode)!=='synthetic'&&account.enabled===true);
  // Opt-in is not an activation permit. SQL 042 and Capacity stay in place; no account row is changed.
  return {session,report:{...guards,state:'activation-blocked',adaptersComposed:false,reason:realEnabled?'PROVIDER_RUNTIME_NOT_ACTIVATED':'NATIVE_ACTIVATION_NOT_PERMITTED'}};
 }catch(error){await session.shutdown();throw error;}
 finally{for(const bytes of buffers)bytes.fill(0);}
}

export async function composeBenchNativeBootstrap(input:{config:Installation;ledger:Ledger;repo:string;
 substitutes:{planning:{adapter:CodexPlanningAdapter;digest:string};execution:{adapter:CodexExecutionAdapter;digest:string}};
 source:{projectId:string;contextId:string;epoch:number;instanceId:string;resolve(authority:Authority):Promise<string>};
 /** Required. A missing registry is not live authority and must not be filled from the frozen contract. */
 registry:{boundAuthority(contextId:string):Authority|undefined|Promise<Authority|undefined>}|undefined;
 constructRuntime?:(attachment:NativeBootstrapAttachment)=>BenchRuntime;}):Promise<{runtime:BenchRuntime;report:NativeBootstrapReport;session:NativeBootstrapSession}>{
 const session=new NativeBootstrapSession();
 const boot=input.config.nativeBootstrap;
 if(!boot||boot.state!=='bench'||boot.contract!=='native-bootstrap-bench-v1')return fail(session,'NATIVE_BOOTSTRAP_BENCH_REQUIRES_INJECTION');
 if(nativeBootstrapSchemaError(input.config))return fail(session,nativeBootstrapSchemaError(input.config)!,403);
 if(!(input.substitutes.planning.adapter instanceof CodexPlanningAdapter)||!(input.substitutes.execution.adapter instanceof CodexExecutionAdapter))
  return fail(session,'NATIVE_BOOTSTRAP_ADAPTER_MISMATCH',403);
 const registry=input.registry;
 if(!registry)return fail(session,'NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED',403);
 session.track({name:'planning-adapter',phase:'constructed'});
 if(input.substitutes.planning.digest!==boot.planningDigest||input.substitutes.execution.digest!==boot.executionDigest)
  return fail(session,'NATIVE_BOOTSTRAP_DIGEST_MISMATCH',403);
 session.track({name:'execution-adapter',phase:'constructed'});
 const sourceMatches=input.source.projectId===boot.projectId&&input.source.contextId===boot.contextId&&input.source.epoch===boot.epoch&&input.source.instanceId===boot.instanceId;
 let bound:Authority|undefined;
 try{bound=await registry.boundAuthority(boot.contextId);}catch{bound=undefined;}
 const registryMatches=Boolean(bound&&bound.contextId===boot.contextId&&bound.epoch===boot.epoch&&bound.instanceId===boot.instanceId);
 if(!sourceMatches||!registryMatches)return fail(session,'NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED',403);
 const report:NativeBootstrapReport={...guards,state:'bench-ready',adaptersComposed:true,reason:'BENCH_SUBSTITUTE_ONLY'};
 const attachment:NativeBootstrapAttachment={projectId:input.config.project.id,state:'bench-ready',executionEnabled:false,inferenceEnabled:false,report,
  benchAdapters:{planning:input.substitutes.planning.adapter,execution:input.substitutes.execution.adapter},
  readSource:async authority=>{
   let live:Authority|undefined;
   try{live=await registry.boundAuthority(boot.contextId);}catch{live=undefined;}
   if(!live||live.contextId!==boot.contextId||live.epoch!==boot.epoch||live.instanceId!==boot.instanceId
    ||authority.contextId!==live.contextId||authority.epoch!==live.epoch||authority.instanceId!==live.instanceId)
    throw new Refusal('NATIVE_BOOTSTRAP_SOURCE_UNAUTHORIZED',403);
   return input.source.resolve(authority);
  }};
 assertNativeBootstrapAttachment(input.config.project.id,attachment);
 let runtime:BenchRuntime;
 try{
  if(input.constructRuntime)runtime=input.constructRuntime(attachment);
  else{
   const {CezarRuntime}=await import('./cezar.ts');
   runtime=new CezarRuntime(input.ledger,input.repo,input.config.project.id,undefined,undefined,undefined,{nativeBootstrap:attachment});
  }
 }catch(error){await session.shutdown();throw error;}
 session.track({name:'runtime',phase:'constructed',close:()=>runtime.close()});
 return {runtime,report,session};
}
