import { createHash,createHmac,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { createServer,request as httpRequest,type IncomingMessage,type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { chmod,chown,lstat,mkdir,readFile,realpath,rm,unlink,writeFile } from 'node:fs/promises';
import { join,resolve,sep } from 'node:path';
import { z } from 'zod';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { Authority,Id,canonical,digest,Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';

const SandboxRequest=z.object({schemaVersion:z.literal(1),action:z.enum(['start','reconcile','cleanup','stop']),jobId:Id,grantId:Id,
 authority:Authority,profile:z.enum(['synthetic-probe-v1','synthetic-implementation-v1']),
 source:z.object({base:z.string().regex(/^[a-f0-9]{40}$/),bundle:z.string().min(1).max(1400000)}).strict().optional(),
 expiresAt:z.number().int().positive(),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type SandboxRequest=z.infer<typeof SandboxRequest>;
function signature(value:Omit<SandboxRequest,'signature'>,key:Uint8Array){return createHmac('sha256',key).update(canonical(value)).digest('hex');}
export function signSandbox(value:Omit<SandboxRequest,'signature'>,key:Uint8Array):SandboxRequest{return {...value,signature:signature(value,key)};}
const Inspect=z.object({Id:z.string().regex(/^[a-f0-9]{64}$/),Image:z.string(),Config:z.object({User:z.string(),Labels:z.record(z.string(),z.string())}).passthrough(),
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
}
export type SandboxBrokerConfig={hostRoot:string;probeHostPath:string;probeSha256:string;implementationPath?:string;implementationSha256?:string;imageId:string;socketPath:string;keyPath:string;databaseUrl:string};
const exec=promisify(execFile);
async function safeGit(cwd:string,args:string[]){
 const result=await exec('/usr/bin/git',['-c','safe.directory='+cwd,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],
  {env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},timeout:10000,maxBuffer:2000000});
 return result.stdout.trim();
}
export class SandboxBroker{
 readonly ledger:Ledger;readonly docker:DockerDaemon;private readonly active=new Set<string>();
 private readonly monitors=new Map<string,ReturnType<typeof setInterval>>();
 constructor(private readonly config:SandboxBrokerConfig,private readonly key:Uint8Array,docker=new DockerDaemon()){
  if(key.byteLength!==32||!/^sha256:[a-f0-9]{64}$/.test(config.imageId)||!/^[a-f0-9]{64}$/.test(config.probeSha256))throw Error('INVALID_BROKER_CONFIG');
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
  return digest(request.source?{...base,sourceDigest:digest(request.source)}:base);
 }
 private inspectExpected(value:Inspected,request:SandboxRequest,spec:string,work:string){
  const labels=value.Config.Labels??{};
  if(labels['ac.scope']!=='isolated-synthetic' ||labels['ac.job']!==request.jobId||labels['ac.grant']!==request.grantId||
    labels['ac.epoch']!==String(request.authority.epoch)||labels['ac.spec']!==spec||value.Image!==this.config.imageId||
    value.Config.User!=='10001:10001'||value.HostConfig.NetworkMode!=='none'||!value.HostConfig.ReadonlyRootfs||value.HostConfig.Privileged||
    !value.HostConfig.CapDrop?.includes('ALL')||!value.HostConfig.SecurityOpt?.some(s=>s.startsWith('no-new-privileges'))||
    value.HostConfig.PidsLimit!==64||value.HostConfig.Memory!==268435456||value.HostConfig.NanoCpus!==1000000000||
    value.Mounts.length!==2||!value.Mounts.some(m=>m.Destination==='/work'&&m.Source===work&&m.RW)||
    !value.Mounts.some(m=>m.Destination==='/runner/probe.mjs'&&m.Source===this.executor(request).path&&!m.RW))
    throw new Refusal('SANDBOX_IDENTITY_MISMATCH');
 }
 async perform(raw:unknown){
  const value=this.validate(raw),name='ac-synthetic-'+value.jobId,work=join(this.config.hostRoot,value.jobId,'work');
  const executor=this.executor(value);
  if(createHash('sha256').update(await readFile(executor.path)).digest('hex')!==executor.hash)
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
   const prior=(await c.query('SELECT * FROM ac_sandbox_jobs WHERE id=$1 FOR UPDATE',[value.jobId])).rows[0];
   if(prior){
    const priorSpec=this.specification(value,work,Number(prior.manager_epoch));
    if(prior.grant_id!==value.grantId||prior.spec_digest!==priorSpec)throw new Refusal('SANDBOX_ID_CONFLICT');
    return {prior,grant,priorSpec};
   }
   if(value.action!=='start')throw new Refusal('SANDBOX_JOB_NOT_FOUND');
   if(Number(grant.manager_epoch)!==value.authority.epoch||grant.state!=='reserved'||!grant.account_enabled||!grant.profile_enabled||
      grant.eligibility!=='documented_supported'||grant.quota_status!=='available'||!grant.quota_fresh)throw new Refusal('GRANT_NOT_ELIGIBLE');
   const owner=grant.role==='programmer'
    ?await c.query('SELECT 1 FROM ac_operations WHERE id=$1 AND intent_id=$2 AND grant_id=$3',[value.jobId,grant.intent_id,value.grantId])
    :await c.query("SELECT 1 FROM ac_stage_operations WHERE id=$1 AND intent_id=$2 AND grant_id=$3 AND (($4='qa' AND node_id='qa') OR ($4='reviewer' AND node_id='review'))",[value.jobId,grant.intent_id,value.grantId,grant.role]);
   if(!owner.rowCount)throw new Refusal('SANDBOX_OPERATION_MISMATCH',403);
   await c.query("INSERT INTO ac_sandbox_jobs(id,context_id,grant_id,manager_epoch,profile,spec_digest,state) VALUES($1,$2,$3,$4,$5,$6,'uncertain')",
    [value.jobId,value.authority.contextId,value.grantId,value.authority.epoch,value.profile,spec]);
   return {prior:null,grant,priorSpec:spec};
  });
  if(admission.prior){
   if(value.action==='cleanup')return this.cleanup(value,admission.prior,admission.priorSpec,work);
   if(value.action==='stop'){
    return this.ledger.tx(async c=>{
     await this.ledger.fence(c,value.authority,true);
     const inspected=await this.docker.inspect(name);
     if(!inspected)return {jobId:value.jobId,state:'uncertain'};
     this.inspectExpected(inspected,{...value,authority:{...value.authority,epoch:Number(admission.prior.manager_epoch)}},admission.priorSpec,work);
     if(inspected.State.Running)await this.docker.stop(inspected.Id);
     return {jobId:value.jobId,state:'uncertain'};
    });
   }
   return this.reconcile(value,admission.prior,admission.priorSpec,work);
  }
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,value.authority);
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
    await safeGit(work,['checkout','--detach',value.source.base]);
    await exec('/bin/chown',['-R','-h','10001:10001',work],{timeout:10000});
   }
   if(await this.docker.inspect(name))throw new Refusal('SANDBOX_NAME_IN_USE');
   const labels={'ac.scope':'isolated-synthetic','ac.job':value.jobId,'ac.grant':value.grantId,'ac.epoch':String(value.authority.epoch),'ac.spec':spec};
   const id=await this.docker.create(name,{Image:this.config.imageId,User:'10001:10001',WorkingDir:'/work',
    Entrypoint:['node','/runner/probe.mjs',...(value.source?[value.jobId]:[])],Env:['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/tmp',
     'GIT_CONFIG_NOSYSTEM=1','GIT_CONFIG_GLOBAL=/dev/null','GIT_AUTHOR_NAME=Synthetic worker','GIT_AUTHOR_EMAIL=fixture@example.invalid',
     'GIT_COMMITTER_NAME=Synthetic worker','GIT_COMMITTER_EMAIL=fixture@example.invalid'],Labels:labels,
    HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,CapDrop:['ALL'],SecurityOpt:['no-new-privileges:true'],
     PidsLimit:64,Memory:268435456,NanoCpus:1000000000,AutoRemove:false,Init:true,
     Tmpfs:{'/tmp':'rw,nosuid,nodev,noexec,size=64m'},LogConfig:{Type:'json-file',Config:{'max-size':'1m','max-file':'1'}},
     Binds:[`${work}:/work:rw`,`${executor.path}:/runner/probe.mjs:ro`]}});
   const created=await this.docker.inspect(id);if(!created)throw new Refusal('DOCKER_CREATE_UNCERTAIN');
   this.inspectExpected(created,value,spec,work);
   await this.ledger.fence(c,value.authority);
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
   const job=(await c.query('SELECT * FROM ac_sandbox_jobs WHERE id=$1 FOR UPDATE',[value.jobId])).rows[0];
   if(['completed','failed'].includes(job.state))return job.receipt;
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
   let implementation:unknown=null,bundle:string|undefined;
   if(value.source&&inspected.State.ExitCode===0){
    const raw=await readFile(join(work,`receipt-${value.jobId}.json`),'utf8');
    const parsed=z.object({operationId:Id,base:z.string().regex(/^[a-f0-9]{40}$/),commit:z.string().regex(/^[a-f0-9]{40}$/),
     tree:z.string().regex(/^[a-f0-9]{40}$/),exitCode:z.literal(0),synthetic:z.literal(true)}).strict().parse(JSON.parse(raw));
    if(parsed.operationId!==value.jobId||parsed.base!==value.source.base||await safeGit(work,['rev-parse','HEAD'])!==parsed.commit||
      await safeGit(work,['rev-parse','HEAD^{tree}'])!==parsed.tree||await safeGit(work,['rev-parse','HEAD^'])!==parsed.base||
      await safeGit(work,['diff-tree','--no-commit-id','--name-only','-r','HEAD'])!==`synthetic-${value.jobId}.txt`)
      throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
    const output=join(this.config.hostRoot,value.jobId,'artifact.bundle');
    await safeGit(work,['bundle','create',output,'HEAD']);
    const content=await readFile(output);if(content.length>1000000)throw new Refusal('SANDBOX_ARTIFACT_TOO_LARGE');
    implementation=parsed;bundle=content.toString('base64');
   }else if(!value.source&&inspected.State.ExitCode===0&&(!probe||probe.visible.length||probe.network||probe.uid!==10001))throw new Refusal('SANDBOX_PROBE_INVALID');
   const receipt={jobId:value.jobId,containerId:inspected.Id,exitCode:inspected.State.ExitCode,finishedAt:inspected.State.FinishedAt,synthetic:true,
    probe,...(value.source?{implementation,bundle}: {})};
   await c.query('UPDATE ac_sandbox_jobs SET state=$2,receipt=$3 WHERE id=$1',[value.jobId,inspected.State.ExitCode===0?'completed':'failed',receipt]);
   await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND state IN ('reserved','running','uncertain')",[value.grantId,receipt]);
   this.active.delete(inspected.Id);const timer=this.monitors.get(inspected.Id);if(timer)clearInterval(timer);this.monitors.delete(inspected.Id);return receipt;
  });
 }
 private async cleanup(value:SandboxRequest,prior:Record<string,unknown>,spec:string,work:string){
  if(!['completed','failed'].includes(String(prior.state)))throw new Refusal('SANDBOX_STILL_ACTIVE');
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
 /** On broker restart, do not leave an old writer running without a fence monitor.
  * Stop matching containers; the successor reconciles their terminal receipts. */
 async neutralizePersistedJobs(){
  const jobs=(await this.ledger.pool.query("SELECT * FROM ac_sandbox_jobs WHERE state IN ('uncertain','running') ORDER BY created_at,id")).rows;
  for(const job of jobs){
   const profile=z.enum(['synthetic-probe-v1','synthetic-implementation-v1']).parse(job.profile);
   let source:SandboxRequest['source'];
   if(profile==='synthetic-implementation-v1'){
    const launch=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_execution_launches WHERE operation_id=$1',[job.id])).rows[0];
    if(!launch||digest(launch.snapshot)!==launch.digest)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
    source=z.object({base:z.string().regex(/^[a-f0-9]{40}$/),bundle:z.string().min(1).max(1400000)}).strict().parse(launch.snapshot.source);
   }
   const value:SandboxRequest={schemaVersion:1,action:'reconcile',jobId:job.id,grantId:job.grant_id,
    authority:{contextId:job.context_id,instanceId:randomUUID(),epoch:Number(job.manager_epoch)},profile,
    ...(source?{source}:{}),expiresAt:Date.now()+30000,signature:'0'.repeat(64)};
   const work=join(this.config.hostRoot,job.id,'work');
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
