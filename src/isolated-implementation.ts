import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {Authority,digest,Refusal,Id} from './contracts.ts';
import {Ledger,type Intent} from './ledger.ts';
import {SandboxClient} from './sandbox-client.ts';
import {diskGuardFromEnvironment,type DiskGuard} from './disk-admission.ts';
import type {AgentRunSpec,AgentSession,AgentEvent} from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
import {readManagedInput,readManagedUnit,type ManagedUnit} from './managed-plan.ts';
import {CorrectionSource} from './sandbox-broker.ts';
import type pg from 'pg';
import {QualityPolicy} from './quality-policy.ts';
const exec=promisify(execFile);
async function git(cwd:string,args:string[]){
 const r=await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],{
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000,maxBuffer:2000000});return r.stdout.trim();
}
const Launch=z.object({profile:z.literal('synthetic-implementation-v1'),source:z.object({base:z.string().regex(/^[a-f0-9]{40}$/),bundle:z.string().max(1400000),outputPath:z.string().min(1).optional(),correction:CorrectionSource.optional()}).strict()}).strict();
async function expectedOutput(cwd:string,launch:z.infer<typeof Launch>,operationId:string){
 const correction=launch.source.correction;if(!correction)return `Synthetic isolated effect ${operationId}`;
 if(!launch.source.outputPath||await git(cwd,['rev-parse','refs/agent-control/correction-source'])!==correction.priorCommit||
   await git(cwd,['rev-parse',`${correction.priorCommit}^{tree}`])!==correction.priorTree||
   await git(cwd,['rev-list','--parents','-n','1',correction.priorCommit])!==`${correction.priorCommit} ${launch.source.base}`)throw new Refusal('MANAGED_CORRECTION_MISMATCH');
 const previous=await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,'show',`${correction.priorCommit}:${launch.source.outputPath}`],
  {encoding:'buffer',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000,maxBuffer:1000000});
 return `Synthetic corrected effect ${operationId}\nPrior content sha256 ${createHash('sha256').update(previous.stdout).digest('hex')}\nDecision ${correction.decisionDigest}`;
}
const Implementation=z.object({operationId:Id,base:z.string().regex(/^[a-f0-9]{40}$/),commit:z.string().regex(/^[a-f0-9]{40}$/),
 tree:z.string().regex(/^[a-f0-9]{40}$/),exitCode:z.literal(0),synthetic:z.literal(true)}).strict();
const Receipt=z.object({jobId:Id,containerId:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int(),implementation:Implementation.nullable(),bundle:z.string().max(1400000).optional()}).passthrough();
const Running=z.object({state:z.literal('running'),containerId:z.string().regex(/^[a-f0-9]{64}$/)}).passthrough();

/** Executes the existing fixed synthetic worker in a broker-created container.
 * No host worktree/Git metadata, administrative socket, key or token enters it.
 * A real provider adapter remains a distinct, unauthorized activation. */
export class IsolatedImplementation{
 private active=true;
 private managedRepository?:string;
 private readonly stops=new Set<()=>void>();
 private specialistGuard?: (c:pg.PoolClient,intent:Intent,authority:Authority,writer:{sessionId:string;grantId:string})=>Promise<void>;
 constructor(readonly ledger:Ledger,readonly client=new SandboxClient(),private readonly diskGuard:DiskGuard|undefined=diskGuardFromEnvironment()){}
 bindManagedRepository(repo:string){const path=resolve(repo);if(this.managedRepository&&this.managedRepository!==path)throw new Refusal('MANAGED_REPOSITORY_MISMATCH');this.managedRepository=path;}
 bindSpecialistGuard(guard:(c:pg.PoolClient,intent:Intent,authority:Authority,writer:{sessionId:string;grantId:string})=>Promise<void>){
  if(this.specialistGuard&&this.specialistGuard!==guard)throw new Refusal('SPECIALIST_GUARD_ALREADY_BOUND');this.specialistGuard=guard;
 }
 private async managedCwd(parent:string,unit:ManagedUnit){
  if(!this.managedRepository)throw new Refusal('MANAGED_REPOSITORY_MISSING');
  const repo=await realpath(this.managedRepository),cwd=join(repo,'.ai/cezar/managed',parent,unit.runId);
  if(await realpath(cwd)!==cwd)throw new Refusal('MANAGED_WORKTREE_FORBIDDEN');return cwd;
 }
 close(){this.active=false;for(const stop of this.stops)stop();}
 private async cleanup(jobId:string,grantId:string,authority:Authority,launch:z.infer<typeof Launch>){
  try{return await this.client.perform('cleanup',jobId,grantId,authority,launch);}
  catch(error){
   if(!(error instanceof Refusal)||!['DOCKER_UNCERTAIN','DOCKER_REMOVE_UNCERTAIN','SANDBOX_RESPONSE_UNCERTAIN'].includes(error.code))throw error;
   return this.client.perform('cleanup',jobId,grantId,authority,launch);
  }
 }
 start(intent:Intent,authority:Authority,spec:AgentRunSpec,onEvent?:(e:AgentEvent)=>void,unit?:ManagedUnit):AgentSession{
  let open=true,canceled=false,grantId:string|undefined,execution:z.infer<typeof Launch>|undefined;
  const stop=()=>{if(canceled)return;canceled=true;if(grantId&&execution)void this.client.perform('stop',intent.operation_id,grantId,authority,execution).catch(()=>{});};
  this.stops.add(stop);
  const result=(async()=>{
   const binding=await readManagedUnit(this.ledger,intent);
   if(Boolean(binding)!==Boolean(unit)||(binding&&digest(binding.unit)!==digest(unit)))throw new Refusal('MANAGED_UNIT_MISMATCH');
   const principal=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[intent.id,authority.contextId])).rows[0]?.principal_id;
   if(!principal)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   const saved=await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
    const row=(await c.query(`SELECT o.state,o.receipt,o.manager_epoch,g.state grant_state,j.state job_state,j.receipt job_receipt
      FROM ac_operations o JOIN ac_intents i ON i.id=o.intent_id
      LEFT JOIN ac_capacity_grants g ON g.id=o.grant_id LEFT JOIN ac_sandbox_jobs j ON j.id=o.id
      WHERE o.id=$1 AND i.id=$2 AND i.context_id=$3 AND i.run_id=$4 FOR UPDATE OF o`,
      [intent.operation_id,intent.id,authority.contextId,intent.run_id])).rows[0];
    if(row?.state!=='completed')return null;
    const artifact=Implementation.parse(row.receipt);
    if(Number(row.manager_epoch)>authority.epoch||artifact.operationId!==intent.operation_id||row.grant_state!=='released'||
      row.job_state!=='completed'||!row.job_receipt?.implementation||digest(row.job_receipt.implementation)!==digest(artifact))throw new Refusal('SANDBOX_RECEIPT_UNCONFIRMED');
    if(!this.active||canceled)throw new Refusal('STAGE_CANCELED');
    if(await git(spec.cwd,['rev-parse','HEAD'])!==artifact.commit||await git(spec.cwd,['rev-parse','HEAD^{tree}'])!==artifact.tree)
     throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
    return artifact;
   });
   if(saved){
    if(unit&&await this.reconcileManagedTask(intent,authority,unit)!=='completed')throw new Refusal('MANAGED_RECEIPT_MISMATCH');
    const text=`Reconciled isolated result replayed: ${saved.commit}`;
    onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
   }
   // Before bundling or recording a potentially launched operation. Replay and
   // reconciliation above remain usable during disk pressure.
   await this.diskGuard?.assertAdmission();
   const parent=resolve('.state/isolated-artifacts');await mkdir(parent,{recursive:true,mode:0o700});const temporary=await mkdtemp(join(parent,'operation-'));
   try{
    const managed=unit?await readManagedInput(this.ledger,intent.id):null;
    const base=await git(spec.cwd,['rev-parse','HEAD']);const bundlePath=join(temporary,'source.bundle');
    if(managed&&(managed.unitId!==unit?.id||managed.kind!=='task'||managed.base!==base||!managed.writePaths[0]))throw new Refusal('MANAGED_INPUT_MISMATCH');
    const correction=managed?.correction?CorrectionSource.parse({schemaVersion:1,parentIntentId:managed.parentIntentId,...managed.correction}):undefined;
    if(correction&&(await git(spec.cwd,['rev-parse','refs/agent-control/correction-source'])!==correction.priorCommit||
      await git(spec.cwd,['rev-parse',`${correction.priorCommit}^{tree}`])!==correction.priorTree||
      await git(spec.cwd,['rev-list','--parents','-n','1',correction.priorCommit])!==`${correction.priorCommit} ${base}`))throw new Refusal('MANAGED_CORRECTION_MISMATCH');
    await git(spec.cwd,['bundle','create',bundlePath,'HEAD',...(correction?['refs/agent-control/correction-source']:[])]);const source=await readFile(bundlePath);
    if(source.length>1000000)throw new Refusal('SANDBOX_SOURCE_TOO_LARGE');
    execution=Launch.parse({profile:'synthetic-implementation-v1',source:{base,bundle:source.toString('base64'),...(managed?{outputPath:managed.writePaths[0]}:{}),...(correction?{correction}:{})}});
    const snapshot=execution;
    grantId=await this.ledger.tx(async c=>{
     await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
     if(!this.active||canceled)throw new Refusal('STAGE_CANCELED');
     const operation=(await c.query('SELECT * FROM ac_operations WHERE id=$1 AND intent_id=$2 FOR UPDATE',[intent.operation_id,intent.id])).rows[0];
     if(operation?.state!=='registered'||Number(operation.manager_epoch)!==authority.epoch||!operation.grant_id)throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
     const contract=(await c.query(`SELECT p.snapshot,p.digest FROM ac_execution_contracts x JOIN ac_quality_policies p
      ON p.project_id=x.project_id AND p.revision=x.quality_revision WHERE x.intent_id=$1`,[intent.id])).rows[0];
     if(contract){const policy=QualityPolicy.parse(contract.snapshot);if(digest(policy)!==contract.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
      if(policy.requireSpecialistBeforeImplementation){if(!this.specialistGuard)throw new Refusal('SPECIALIST_ADVICE_REQUIRED');
       await this.specialistGuard(c,intent,authority,{sessionId:z.uuid().parse(spec.sessionId),grantId:operation.grant_id});}}
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
    const committed=await this.apply(principal,intent,authority,spec.cwd,receipt,execution,Boolean(unit));
    await this.cleanup(intent.operation_id,grantId,authority,execution);
    const text=`Isolated synthetic implementation completed: ${committed.commit}`;
    onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
   }finally{await rm(temporary,{recursive:true,force:true});}
  })().finally(()=>{open=false;this.stops.delete(stop);});
  return {result,get open(){return open;},sendMessage(){return false;},end(){},interrupt:stop,hardStop:stop};
 }
 /** Reconcile an immutable launch after controller loss. Never starts a second worker.
  * A running old writer is stopped by the broker and remains uncertain until a later inspection. */
 async reconcileManagedTask(intent:Intent,authority:Authority,unit:ManagedUnit):Promise<'completed'|'uncertain'|'failed'>{
  const bound=await readManagedUnit(this.ledger,intent),input=await readManagedInput(this.ledger,intent.id);
  if(!bound||digest(bound.unit)!==digest(unit)||unit.kind!=='task')throw new Refusal('MANAGED_UNIT_MISMATCH');
  const initial=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   const row=(await c.query(`SELECT i.principal_id,o.state,o.manager_epoch,o.grant_id,l.snapshot,l.digest,l.context_id launch_context,l.manager_epoch launch_epoch
    FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id LEFT JOIN ac_execution_launches l ON l.operation_id=o.id
    WHERE i.id=$1 AND i.context_id=$2 AND i.run_id=$3 AND o.id=$4 FOR UPDATE OF o`,[intent.id,authority.contextId,intent.run_id,intent.operation_id])).rows[0];
   if(!row)throw new Refusal('MANAGED_RECEIPT_MISMATCH');await this.ledger.authorize(c,row.principal_id,authority.contextId);
   return row;
  });
  if(!initial.snapshot||!initial.grant_id||!['running','uncertain','completed'].includes(initial.state))return 'uncertain';
  const launch=Launch.parse(initial.snapshot);
  if(digest(launch)!==initial.digest||initial.launch_context!==authority.contextId||launch.source.base!==input.base||launch.source.outputPath!==input.writePaths[0]||
     digest(launch.source.correction??null)!==digest(input.correction?{schemaVersion:1,parentIntentId:input.parentIntentId,...input.correction}:null)||
     Number(initial.launch_epoch)>authority.epoch||Number(initial.manager_epoch)>authority.epoch)throw new Refusal('MANAGED_RECEIPT_MISMATCH');
  const present=(await this.ledger.pool.query('SELECT 1 FROM ac_sandbox_jobs WHERE id=$1',[intent.operation_id])).rowCount;
  if(!present)return 'uncertain';
  const response=await this.client.perform('reconcile',intent.operation_id,initial.grant_id,authority,launch);
  const parsed=Receipt.safeParse(response);
  if(!parsed.success){if(z.object({state:z.enum(['running','uncertain'])}).passthrough().safeParse(response).success)return 'uncertain';throw new Refusal('MANAGED_RECEIPT_MISMATCH');}
  const receipt=parsed.data;
  const terminal=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   const row=(await c.query(`SELECT o.state,o.receipt operation_receipt,o.manager_epoch operation_epoch,
    g.state grant_state,g.manager_epoch grant_epoch,g.physical_receipt,g.attempt_id,g.role,g.intent_id grant_intent,g.context_id grant_context,
    j.state job_state,j.receipt job_receipt,j.manager_epoch job_epoch,j.profile,j.context_id,j.grant_id
    FROM ac_operations o JOIN ac_capacity_grants g ON g.id=o.grant_id JOIN ac_sandbox_jobs j ON j.id=o.id
    WHERE o.id=$1 AND o.intent_id=$2 FOR UPDATE OF o,g,j`,[intent.operation_id,intent.id])).rows[0];
   if(!row||!['completed','failed'].includes(row.job_state)||row.grant_state!=='released')return null;
   if(row.context_id!==authority.contextId||row.grant_context!==authority.contextId||row.grant_intent!==intent.id||row.attempt_id!==unit.attemptId||row.role!=='programmer'||row.grant_id!==initial.grant_id||row.profile!=='synthetic-implementation-v1'||
      Number(row.job_epoch)!==Number(initial.launch_epoch)||Number(row.grant_epoch)!==Number(initial.launch_epoch)||
      Number(row.operation_epoch)>authority.epoch||digest(row.job_receipt)!==digest(row.physical_receipt)||digest(row.job_receipt)!==digest(response)||
      receipt.jobId!==intent.operation_id||typeof row.job_receipt.finishedAt!=='string'||row.job_receipt.finishedAt.startsWith('0001-')||!Number.isFinite(Date.parse(row.job_receipt.finishedAt))||
      ((receipt.exitCode===0)!==(row.job_state==='completed')))throw new Refusal('MANAGED_RECEIPT_MISMATCH');
   return row;
  });
  if(!terminal)return 'uncertain';
  if(receipt.exitCode!==0){if(terminal.state==='completed')throw new Refusal('MANAGED_RECEIPT_MISMATCH');return 'failed';}
  if(!receipt.implementation||!receipt.bundle||receipt.implementation.operationId!==intent.operation_id||receipt.implementation.base!==input.base)
   throw new Refusal('MANAGED_RECEIPT_MISMATCH');
  const cwd=await this.managedCwd(bound.parentIntentId,unit);
  if(terminal.state==='completed'){
   const content=Buffer.from(receipt.bundle,'base64');
   if(content.length>1000000||content.toString('base64')!==receipt.bundle)throw new Refusal('MANAGED_RECEIPT_MISMATCH');
   const parent=resolve('.state/isolated-artifacts');await mkdir(parent,{recursive:true,mode:0o700});const temporary=await mkdtemp(join(parent,'replay-'));
   try{const file=join(temporary,'result.bundle');await writeFile(file,content,{mode:0o600,flag:'wx'});
    await git(cwd,['bundle','verify',file]);
    const heads=(await git(cwd,['bundle','list-heads',file])).split('\n').sort();
    const expected=[`${receipt.implementation.commit} HEAD`,...(launch.source.correction?[`${launch.source.correction.priorCommit} refs/agent-control/correction-source`]:[])].sort();
    if(digest(heads)!==digest(expected))throw new Refusal('MANAGED_RECEIPT_MISMATCH');
   }finally{await rm(temporary,{recursive:true,force:true});}
   if(digest(terminal.operation_receipt)!==digest(receipt.implementation)||await git(cwd,['rev-parse','HEAD'])!==receipt.implementation.commit||
      await git(cwd,['rev-parse','HEAD^{tree}'])!==receipt.implementation.tree||await git(cwd,['rev-parse','HEAD^'])!==input.base||
      await git(cwd,['diff-tree','--no-commit-id','--name-only','-r','HEAD'])!==input.writePaths[0]||
      await git(cwd,['show',`HEAD:${input.writePaths[0]}`])!==await expectedOutput(cwd,launch,intent.operation_id))throw new Refusal('MANAGED_RECEIPT_MISMATCH');
   await this.cleanup(intent.operation_id,initial.grant_id,authority,launch);
   return 'completed';
  }
  await this.apply(initial.principal_id,intent,authority,cwd,receipt,launch,true);
  await this.cleanup(intent.operation_id,initial.grant_id,authority,launch);
  return 'completed';
 }
 async reconcileExisting(intent:Intent,authority:Authority,cwd:string):Promise<'uncertain'|'completed'|'failed'>{
  const row=await this.ledger.tx(async c=>{
   await this.ledger.fence(c,authority,true);
   const result=(await c.query(`SELECT i.principal_id,i.run_id,i.operation_id,i.plan_revision,i.command,o.state,o.manager_epoch,o.grant_id,o.receipt,l.snapshot,l.digest
     FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id
     LEFT JOIN ac_execution_launches l ON l.operation_id=o.id
     WHERE i.id=$1 AND i.context_id=$2 AND o.id=$3 FOR UPDATE OF o`,
     [intent.id,authority.contextId,intent.operation_id])).rows[0];
   if(!result||result.run_id!==intent.run_id||result.operation_id!==intent.operation_id||
      result.plan_revision!==intent.plan_revision||digest(result.command)!==digest(intent.command))
    throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   await this.ledger.authorize(c,result.principal_id,authority.contextId);
   return result;
  });
  if(row.state==='completed')return 'completed';
  if(!['uncertain','running'].includes(row.state)||!row.snapshot||!row.grant_id||Number(row.manager_epoch)>authority.epoch)
   throw new Refusal('OPERATION_RECONCILIATION_REQUIRED');
  const launch=Launch.parse(row.snapshot);
  if(digest(launch)!==row.digest)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
  const response=await this.client.perform('reconcile',intent.operation_id,row.grant_id,authority,launch);
  const terminal=Receipt.safeParse(response);
  if(!terminal.success)return 'uncertain';
  if(terminal.data.exitCode!==0||!terminal.data.implementation)return 'failed';
  await this.apply(row.principal_id,intent,authority,cwd,terminal.data,launch);
  await this.client.perform('cleanup',intent.operation_id,row.grant_id,authority,launch);
  return 'completed';
 }
 private async apply(principal:string,intent:Intent,authority:Authority,cwd:string,receipt:z.infer<typeof Receipt>,launch:z.infer<typeof Launch>,managed=false){
  if(receipt.jobId!==intent.operation_id||receipt.exitCode!==0||!receipt.implementation||!receipt.bundle)throw new Refusal('SANDBOX_IMPLEMENTATION_FAILED');
  const artifact=receipt.implementation;
  if(artifact.operationId!==intent.operation_id||artifact.base!==launch.source.base)throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
  const content=Buffer.from(receipt.bundle,'base64');if(content.length>1000000||content.toString('base64')!==receipt.bundle)throw new Refusal('SANDBOX_ARTIFACT_INVALID');
  const parent=resolve('.state/isolated-artifacts');const temporary=await mkdtemp(join(parent,'result-'));
  try{
   const path=join(temporary,'result.bundle');await writeFile(path,content,{mode:0o600,flag:'wx'});
   await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,!managed);
    if(managed)await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
    const op=(await c.query('SELECT * FROM ac_operations WHERE id=$1 FOR UPDATE',[intent.operation_id])).rows[0];
    const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[op?.grant_id])).rows[0];
    if(!op||Number(op.manager_epoch)>authority.epoch||!['running','uncertain'].includes(op.state)||grant?.state!=='released'||
      grant.physical_receipt?.jobId!==intent.operation_id||grant.physical_receipt?.containerId!==receipt.containerId)
      throw new Refusal('SANDBOX_RECEIPT_UNCONFIRMED');
    if(managed){const job=(await c.query('SELECT state,receipt FROM ac_sandbox_jobs WHERE id=$1 FOR UPDATE',[intent.operation_id])).rows[0];
     if(job?.state!=='completed'||digest(job.receipt)!==digest(grant.physical_receipt)||digest(job.receipt)!==digest(receipt))throw new Refusal('MANAGED_RECEIPT_MISMATCH');}
    if(launch.source.correction)await git(cwd,['fetch','--no-tags',path,'refs/agent-control/correction-source:refs/agent-control/correction-source']);
    await git(cwd,['fetch','--no-tags',path,'HEAD']);
   const outputPath=launch.source.outputPath??`synthetic-${intent.operation_id}.txt`;
   if(await git(cwd,['rev-parse','FETCH_HEAD'])!==artifact.commit||await git(cwd,['rev-parse',artifact.commit+'^{tree}'])!==artifact.tree||
     await git(cwd,['rev-parse',artifact.commit+'^'])!==artifact.base||await git(cwd,['diff-tree','--no-commit-id','--name-only','-r',artifact.commit])!==outputPath||
     await git(cwd,['show',`${artifact.commit}:${outputPath}`])!==await expectedOutput(cwd,launch,intent.operation_id))
     throw new Refusal('SANDBOX_ARTIFACT_IDENTITY_MISMATCH');
    const head=await git(cwd,['rev-parse','HEAD']);if(head!==artifact.base&&head!==artifact.commit)throw new Refusal('SANDBOX_BASE_CHANGED');
    await git(cwd,['merge','--ff-only',artifact.commit]);
    await c.query("UPDATE ac_operations SET state='completed',manager_epoch=$3,receipt=$2 WHERE id=$1",[intent.operation_id,artifact,authority.epoch]);
   });
  }finally{await rm(temporary,{recursive:true,force:true});}
  return artifact;
 }
}
