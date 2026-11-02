import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {Authority,digest,Refusal,Id} from './contracts.ts';
import {Ledger,type Intent} from './ledger.ts';
import {SandboxClient} from './sandbox-client.ts';
import type {AgentRunSpec,AgentSession,AgentEvent} from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
const exec=promisify(execFile);
async function git(cwd:string,args:string[]){
 const r=await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],{
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000,maxBuffer:2000000});return r.stdout.trim();
}
const Launch=z.object({profile:z.literal('synthetic-implementation-v1'),source:z.object({base:z.string().regex(/^[a-f0-9]{40}$/),bundle:z.string().max(1400000)}).strict()}).strict();
const Implementation=z.object({operationId:Id,base:z.string().regex(/^[a-f0-9]{40}$/),commit:z.string().regex(/^[a-f0-9]{40}$/),
 tree:z.string().regex(/^[a-f0-9]{40}$/),exitCode:z.literal(0),synthetic:z.literal(true)}).strict();
const Receipt=z.object({jobId:Id,containerId:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int(),implementation:Implementation.nullable(),bundle:z.string().max(1400000).optional()}).passthrough();
const Running=z.object({state:z.literal('running'),containerId:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough();

/** Executes the existing fixed synthetic worker in a broker-created container.
 * No host worktree/Git metadata, administrative socket, key or token enters it.
 * A real provider adapter remains a distinct, unauthorized activation. */
export class IsolatedImplementation{
 private active=true;
 private readonly stops=new Set<()=>void>();
 constructor(readonly ledger:Ledger,readonly client=new SandboxClient()){}
 close(){this.active=false;for(const stop of this.stops)stop();}
 start(intent:Intent,authority:Authority,spec:AgentRunSpec,onEvent?:(e:AgentEvent)=>void):AgentSession{
  let open=true,canceled=false,grantId:string|undefined,execution:z.infer<typeof Launch>|undefined;
  const stop=()=>{if(canceled)return;canceled=true;if(grantId&&execution)void this.client.perform('stop',intent.operation_id,grantId,authority,execution).catch(()=>{});};
  this.stops.add(stop);
  const result=(async()=>{
   const principal=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[intent.id,authority.contextId])).rows[0]?.principal_id;
   if(!principal)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   const parent=resolve('.state/isolated-artifacts');await mkdir(parent,{recursive:true,mode:0o700});const temporary=await mkdtemp(join(parent,'operation-'));
   try{
    const base=await git(spec.cwd,['rev-parse','HEAD']);const bundlePath=join(temporary,'source.bundle');
    await git(spec.cwd,['bundle','create',bundlePath,'HEAD']);const source=await readFile(bundlePath);
    if(source.length>1000000)throw new Refusal('SANDBOX_SOURCE_TOO_LARGE');
    execution=Launch.parse({profile:'synthetic-implementation-v1',source:{base,bundle:source.toString('base64')}});
    const snapshot=execution;
    grantId=await this.ledger.tx(async c=>{
     await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);
     if(!this.active||canceled)throw new Refusal('STAGE_CANCELED');
     const operation=(await c.query('SELECT * FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[intent.operation_id,intent.id])).rows[0];
     if(operation?.state!=='registered'||Number(operation.manager_epoch)!==authority.epoch||!operation.grant_id)throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
     await c.query('INSERT INTO ac_execution_launches(operation_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',
      [intent.operation_id,authority.contextId,authority.epoch,snapshot,digest(snapshot)]);
     await c.query("UPDATE ac_operations SET state='uncertain',native_session_id=$2 WHERE id=$1",[intent.operation_id,z.uuid().parse(spec.sessionId)]);
     return operation.grant_id as string;
    });
    if(canceled||!this.active)throw new Refusal('STAGE_CANCELED');
    let receipt:z.infer<typeof Receipt>|undefined;
    let first:unknown;
    try{first=await this.client.perform('start',intent.operation_id,grantId,authority,execution);}
    catch{
     // The start acknowledgement may be lost after Docker accepted the request.
     // Query the same immutable job; never submit a second start here.
     first=await this.client.perform('reconcile',intent.operation_id,grantId,authority,execution);
    }
    const started=Running.safeParse(first),terminal=Receipt.safeParse(first);
    if(started.success){
     await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority,true);
      await c.query("UPDATE ac_operations SET state='running',handle=$2 WHERE id=$1 AND state='uncertain' AND manager_epoch=$3",
       [intent.operation_id,{containerId:started.data.containerId,operationId:intent.operation_id,epoch:authority.epoch,synthetic:true},authority.epoch]);
     });
    }else if(terminal.success)receipt=terminal.data;
    else if(!z.object({state:z.enum(['uncertain','running'])}).passthrough().safeParse(first).success)
     throw new Refusal('SANDBOX_START_UNCERTAIN');
    for(let i=0;i<240;i++){
     if(receipt)break;
     if(canceled||!this.active){stop();throw new Refusal('STAGE_CANCELED');}
     const response=await this.client.perform('reconcile',intent.operation_id,grantId,authority,execution);
     const terminal=Receipt.safeParse(response);if(terminal.success){receipt=terminal.data;break;}
     await new Promise(resolve=>setTimeout(resolve,250));
    }
    if(!receipt)throw new Refusal('SANDBOX_RESULT_UNCERTAIN');
    const committed=await this.apply(principal,intent,authority,spec.cwd,receipt,execution);
    await this.client.perform('cleanup',intent.operation_id,grantId,authority,execution);
    const text=`Isolated synthetic implementation completed: ${committed.commit}`;
    onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
   }finally{await rm(temporary,{recursive:true,force:true});}
  })().finally(()=>{open=false;this.stops.delete(stop);});
  return {result,get open(){return open;},sendMessage(){return false;},end(){},interrupt:stop,hardStop:stop};
 }
 private async apply(principal:string,intent:Intent,authority:Authority,cwd:string,receipt:z.infer<typeof Receipt>,launch:z.infer<typeof Launch>){
  if(receipt.jobId!==intent.operation_id||receipt.exitCode!==0||!receipt.implementation||!receipt.bundle)throw new Refusal('SANDBOX_IMPLEMENTATION_FAILED');
  const artifact=receipt.implementation;
  if(artifact.operationId!==intent.operation_id||artifact.base!==launch.source.base)throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
  const content=Buffer.from(receipt.bundle,'base64');if(content.length>1000000||content.toString('base64')!==receipt.bundle)throw new Refusal('SANDBOX_ARTIFACT_INVALID');
  const parent=resolve('.state/isolated-artifacts');const temporary=await mkdtemp(join(parent,'result-'));
  try{
   const path=join(temporary,'result.bundle');await writeFile(path,content,{mode:0o600,flag:'wx'});
   await git(cwd,['fetch','--no-tags',path,'HEAD']);
   if(await git(cwd,['rev-parse','FETCH_HEAD'])!==artifact.commit||await git(cwd,['rev-parse',artifact.commit+'^{tree}'])!==artifact.tree||
     await git(cwd,['rev-parse',artifact.commit+'^'])!==artifact.base||await git(cwd,['diff-tree','--no-commit-id','--name-only','-r',artifact.commit])!==`synthetic-${intent.operation_id}.txt`||
     await git(cwd,['show',`${artifact.commit}:synthetic-${intent.operation_id}.txt`])!==`Synthetic isolated effect ${intent.operation_id}`)
     throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
   await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
    const op=(await c.query('SELECT * FROM ac_operations WHERE id=$1 FOR UPDATE',[intent.operation_id])).rows[0];
    const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[op?.grant_id])).rows[0];
    if(!op||Number(op.manager_epoch)!==authority.epoch||!['running','uncertain'].includes(op.state)||grant?.state!=='released'||
      grant.physical_receipt?.jobId!==intent.operation_id||grant.physical_receipt?.containerId!==receipt.containerId)
      throw new Refusal('SANDBOX_RECEIPT_UNCONFIRMED');
    const head=await git(cwd,['rev-parse','HEAD']);if(head!==artifact.base&&head!==artifact.commit)throw new Refusal('SANDBOX_BASE_CHANGED');
    await git(cwd,['merge','--ff-only',artifact.commit]);
    await c.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1",[intent.operation_id,artifact]);
   });
  }finally{await rm(temporary,{recursive:true,force:true});}
  return artifact;
 }
}
