import { z } from 'zod';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, lstat, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Authority, Id, Refusal, digest } from './contracts.ts';
import { Ledger } from './ledger.ts';
export const RemoteHostInput=z.object({id:Id,label:z.string().min(1).max(100),hostname:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/),
 port:z.number().int().min(1).max(65535),username:z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
 publicKey:z.string().min(30).max(16384).refine(s=>!/[\r\n]/.test(s)),fingerprint:z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
 credentialRef:Id,remoteRoot:z.string().min(1).max(500).regex(/^\/[^\0\r\n]*$/),
 allowedTasks:z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1).max(50),maxConcurrent:z.number().int().min(1).max(32)}).strict();
export type RemoteHost={id:string;hostname:string;port:number;username:string;public_key:string;fingerprint:string;credential_ref:string;remote_root:string};
const Reply=z.object({schemaVersion:z.literal(1),operationId:Id,state:z.enum(['unknown','uncertain','running','completed','failed']),
 projectId:Id.optional(),taskId:z.string().optional(),epoch:z.number().int().positive().optional(),
 exitCode:z.number().int().optional(),logSha256:z.string().regex(/^[a-f0-9]{64}$/).optional()}).passthrough();
export interface RemoteTransport {exchange(host:RemoteHost,request:object):Promise<unknown>}
function run(binary:string,args:string[],input:string,timeoutMs:number):Promise<string>{
 return new Promise((ok,fail)=>{
  const child=spawn(binary,args,{env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent'},stdio:['pipe','pipe','pipe'],detached:true});
  let stdout='',settled=false;
  const stop=()=>{try{if(child.pid)globalThis.process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const timer=setTimeout(()=>{settled=true;stop();fail(new Refusal('REMOTE_TRANSPORT_UNCERTAIN'));},timeoutMs);
  child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>131072){settled=true;stop();clearTimeout(timer);fail(new Refusal('REMOTE_RESPONSE_TOO_LARGE'));}});
  child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input);
  child.once('error',()=>{clearTimeout(timer);if(!settled){settled=true;fail(new Refusal('REMOTE_TRANSPORT_UNAVAILABLE'));}});
  // 'exit' may precede the final stdout chunk. Reconcile only after all pipes close.
  child.once('close',code=>{clearTimeout(timer);if(settled)return;settled=true;code===0?ok(stdout):fail(new Refusal('REMOTE_TRANSPORT_UNCERTAIN'));});
 });
}
/** No agent chooses a private-key path or accepts a new host key. Allowed targets are controller configuration. */
export class OpenSshTransport implements RemoteTransport{
 constructor(private readonly credentialPath:(id:string)=>Promise<string>,private readonly allowedHosts:ReadonlySet<string>){}
 async exchange(host:RemoteHost,request:object){
  if(!this.allowedHosts.has(host.hostname))throw new Refusal('REMOTE_TARGET_NOT_ENABLED',403);
  const original=await this.credentialPath(host.credential_ref),key=await realpath(original),info=await lstat(original);
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Refusal('SSH_CREDENTIAL_UNSAFE',403);
  const parent=resolve('.state/ssh-control');await mkdir(parent,{recursive:true,mode:0o700});
  const temporary=await mkdtemp(join(parent,'transport-'));
  try{
   const publicPath=join(temporary,'host.pub');await writeFile(publicPath,host.public_key+'\n',{mode:0o600});
   const printed=await run('/usr/bin/ssh-keygen',['-lf',publicPath,'-E','sha256'],'',3000);
   if(printed.trim().split(/\s+/)[1]!==host.fingerprint)throw new Refusal('SSH_FINGERPRINT_MISMATCH',403);
   const knownHosts=join(temporary,'known_hosts');
   await writeFile(knownHosts,`[${host.hostname}]:${host.port} ${host.public_key}\n${host.port===22?host.hostname+' '+host.public_key+'\n':''}`,{mode:0o600});
   const options=['-F','/dev/null','-p',String(host.port),'-i',key,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none',
    '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${knownHosts}`,'-o','GlobalKnownHostsFile=/dev/null',
    '-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','RequestTTY=no','-o','ConnectTimeout=10',
    '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2',`${host.username}@${host.hostname}`,
    'python3','/usr/local/lib/agent-control/worker.py','--config','/etc/agent-control/worker.json'];
   return JSON.parse(await run('/usr/bin/ssh',options,JSON.stringify(request),20000)) as unknown;
  }finally{await rm(temporary,{recursive:true,force:true});}
 }
}
export class RemoteOperations{
 constructor(readonly ledger:Ledger,private readonly transport:RemoteTransport){}
 async registerHost(principal:string,projectId:string,raw:z.input<typeof RemoteHostInput>){
  const host=RemoteHostInput.parse(raw);
  await this.ledger.tx(async c=>{
   if(!(await c.query("SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner'",[projectId,principal])).rowCount)
    throw new Refusal('PROJECT_OWNER_REQUIRED',403);
   const hash=digest({projectId,...host});
   const existing=(await c.query('SELECT registration_digest FROM ac_remote_hosts WHERE id=$1',[host.id])).rows[0];
   if(existing){if(existing.registration_digest!==hash)throw new Refusal('REMOTE_HOST_ID_CONFLICT');return;}
   await c.query(`INSERT INTO ac_remote_hosts(id,project_id,label,hostname,port,username,public_key,fingerprint,credential_ref,remote_root,allowed_tasks,max_concurrent,registration_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[host.id,projectId,host.label,host.hostname,host.port,host.username,host.publicKey,
     host.fingerprint,host.credentialRef,host.remoteRoot,host.allowedTasks,host.maxConcurrent,hash]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES(NULL,'remote.host.registered',$1)",[{projectId,hostId:host.id}]);
  });
 }
 async start(principal:string,request:{operationId:string;contextId:string;hostId:string;taskId:string},authority:Authority){
  const input=z.object({operationId:Id,contextId:Id,hostId:Id,taskId:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)}).strict().parse(request);
  const admitted=await this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,input.contextId);
   if(input.contextId!==authority.contextId)throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
   await this.ledger.fence(c,authority);
   if((await c.query("SELECT 1 FROM ac_plan_cancellations WHERE context_id=$1 AND state='requested'",[authority.contextId])).rowCount)throw new Refusal('PLAN_CANCELLATION_REQUESTED');
   const host=(await c.query('SELECT * FROM ac_remote_hosts WHERE id=$1 AND project_id=$2 AND enabled FOR UPDATE',[input.hostId,context.project_id])).rows[0];
   if(!host||!host.allowed_tasks.includes(input.taskId))throw new Refusal('REMOTE_TASK_FORBIDDEN',403);
   const hash=digest(input);
   const prior=(await c.query('SELECT * FROM ac_remote_operations WHERE id=$1',[input.operationId])).rows[0];
   if(prior){if(prior.request_digest!==hash)throw new Refusal('REMOTE_OPERATION_ID_CONFLICT');return {host,projectId:context.project_id,existing:prior};}
   const active=Number((await c.query("SELECT count(*) n FROM ac_remote_operations WHERE host_id=$1 AND state NOT IN ('completed','failed','canceled_confirmed')",[input.hostId])).rows[0].n);
   if(active>=host.max_concurrent)throw new Refusal('REMOTE_HOST_BUSY');
   await c.query("INSERT INTO ac_remote_operations(id,context_id,host_id,task_id,request_digest,manager_epoch,state) VALUES($1,$2,$3,$4,$5,$6,'uncertain')",
    [input.operationId,input.contextId,input.hostId,input.taskId,hash,authority.epoch]);
   await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'remote.operation.registered',$2)",
    [input.contextId,{operationId:input.operationId,hostId:input.hostId,taskId:input.taskId}]);
   return {host,projectId:context.project_id,existing:null};
  });
  if(admitted.existing)return this.reconcile(principal,input.operationId,authority);
  return this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority);
   if((await c.query("SELECT 1 FROM ac_plan_cancellations WHERE context_id=$1 AND state='requested'",[authority.contextId])).rowCount)throw new Refusal('PLAN_CANCELLATION_REQUESTED');
   await c.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '30 seconds' WHERE context_id=$1",[authority.contextId]);
   // Lock across the authorized transport effect; any lost acknowledgement stays uncertain.
   const response=Reply.parse(await this.transport.exchange(admitted.host,{schemaVersion:1,action:'start',operationId:input.operationId,
    projectId:admitted.projectId,taskId:input.taskId,root:admitted.host.remote_root,epoch:authority.epoch}));
   if(response.operationId!==input.operationId)throw new Refusal('REMOTE_RECEIPT_ID_MISMATCH');
   if(response.state==='unknown')throw new Refusal('REMOTE_START_UNCERTAIN');
   if(response.projectId!==admitted.projectId||response.taskId!==input.taskId||response.epoch!==authority.epoch)throw new Refusal('REMOTE_RECEIPT_SCOPE_MISMATCH');
   if(['completed','failed'].includes(response.state)&&(response.exitCode===undefined||response.logSha256===undefined))throw new Refusal('REMOTE_TERMINAL_RECEIPT_INCOMPLETE');
   if((response.state==='completed'&&response.exitCode!==0)||(response.state==='failed'&&response.exitCode===0))throw new Refusal('REMOTE_TERMINAL_RECEIPT_INVALID');
   await c.query('UPDATE ac_remote_operations SET state=$2,remote_receipt=$3 WHERE id=$1',[input.operationId,response.state,response]);
   return response;
  });
 }
 async reconcile(principal:string,operationId:string,authority:Authority){
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const op=(await c.query('SELECT * FROM ac_remote_operations WHERE id=$1 AND context_id=$2 FOR UPDATE',[Id.parse(operationId),authority.contextId])).rows[0];
   if(!op)throw new Refusal('REMOTE_OPERATION_FORBIDDEN',403);
   if(['completed','failed','canceled_confirmed'].includes(op.state))return op.remote_receipt;
   const host=(await c.query('SELECT * FROM ac_remote_hosts WHERE id=$1',[op.host_id])).rows[0];
   const result=Reply.parse(await this.transport.exchange(host,{schemaVersion:1,action:'inspect',operationId}));
   if(result.operationId!==operationId)throw new Refusal('REMOTE_RECEIPT_ID_MISMATCH');
   if(result.state!=='unknown'&&(result.projectId!==host.project_id||result.taskId!==op.task_id||result.epoch!==Number(op.manager_epoch)))throw new Refusal('REMOTE_RECEIPT_SCOPE_MISMATCH');
   if(['completed','failed'].includes(result.state)&&(result.exitCode===undefined||result.logSha256===undefined))throw new Refusal('REMOTE_TERMINAL_RECEIPT_INCOMPLETE');
   if((result.state==='completed'&&result.exitCode!==0)||(result.state==='failed'&&result.exitCode===0))throw new Refusal('REMOTE_TERMINAL_RECEIPT_INVALID');
   await c.query('UPDATE ac_remote_operations SET state=$2,remote_receipt=$3 WHERE id=$1',[operationId,result.state==='unknown'?'uncertain':result.state,result]);
   return result;
  });
 }
}
