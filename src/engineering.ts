import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { Authority, canonical, digest, Refusal } from './contracts.ts';
import { Ledger, type Intent } from './ledger.ts';
import { Capacity } from './capacity.ts';
import { GitArtifacts } from './git.ts';
import { Quality,QualityPolicy, type VerificationReceipt } from './quality.ts';
import { Integrator } from './integration.ts';
import {IsolatedVerification} from './isolated-verification.ts';
import type { AgentRunSpec, AgentSession, AgentEvent } from '../upstream/cezar/packages/cezar/dist/core/agent-runner.js';
export type EngineeringOptions={quality:Quality;git:GitArtifacts;qualityRevision?:number;targetRef?:string;allowedTargets?:readonly string[];verifierKey:Uint8Array;isolatedVerification?:IsolatedVerification};
const nodeSchema=z.enum(['qa','review','judge','integrate']);
function artifactId(intentId:string,commit:string){const h=digest({domain:'artifact-v1',intentId,commit});return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function reviewSession(parent:string,index:number){const h=digest({domain:'review-session-v1',parent,index});return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
function stop(child:ChildProcess|undefined){if(!child||child.exitCode!==null||child.signalCode!==null)return;try{if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}

/** Fixed engineering template adapter. Every invocation comes from an existing Cezar node.
 * Verifiers are synthetic; the isolated runtime uses broker containers for each session. */
export class EngineeringStages{
 private readonly key:Buffer;
 private running=true;
 private readonly children=new Set<ChildProcess>();
 constructor(readonly ledger:Ledger,readonly projectId:string,readonly options:EngineeringOptions){
  if(options.isolatedVerification&&options.isolatedVerification.ledger!==ledger)throw new Refusal('EXECUTOR_LEDGER_MISMATCH');
  this.key=Buffer.from(options.verifierKey);if(this.key.length<32)throw Error('VERIFIER_KEY_TOO_SHORT');
 }
 start(intent:Intent,authority:Authority,nodeId:string,spec:AgentRunSpec,onEvent?:((event:AgentEvent)=>void),internalReview=false):AgentSession{
  const node=nodeSchema.parse(nodeId),sessionId=z.uuid().parse(spec.sessionId);
  let child:ChildProcess|undefined,open=true,canceled=false;
  const nested=new Set<AgentSession>();
  const result=(async()=>{
   if(!this.running)throw new Refusal('RUNTIME_NOT_AUTHORIZED');
   const contract=await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority,true);
    const row=(await c.query('SELECT * FROM ac_execution_contracts WHERE intent_id=$1 AND project_id=$2',[intent.id,this.projectId])).rows[0];
    if(!row||row.digest!==digest({qualityRevision:row.quality_revision,targetRef:row.target_ref}))throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
    const allowed=this.options.allowedTargets??(this.options.targetRef?[this.options.targetRef]:[]);
    if(!allowed.includes(row.target_ref))throw new Refusal('INTEGRATION_TARGET_FORBIDDEN',403);
    return row;
   });
   if(node==='judge'){
    const row=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
      [this.projectId,contract.quality_revision])).rows[0];
    const policy=QualityPolicy.parse(row?.snapshot);
    if(digest(policy)!==row.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
    if(!policy.requireJudge){const text='Synthetic judge not required by the frozen policy.';onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};}
   }
   if(node==='review'&&!internalReview){
    const stored=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
      [this.projectId,contract.quality_revision])).rows[0];
    if(!stored)throw new Refusal('QUALITY_POLICY_REQUIRED');
    const policy=QualityPolicy.parse(stored.snapshot);
    if(digest(policy)!==stored.digest)throw new Refusal('QUALITY_POLICY_DIGEST_MISMATCH');
    if(policy.requiredReviews>1){
     let next=0;
     const worker=async()=>{
      for(;;){
       const index=next++;if(index>=policy.requiredReviews)return;
       let announced=false;
       for(;;){
        if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
        const reviewer=this.start(intent,authority,'review',{...spec,sessionId:reviewSession(sessionId,index)},undefined,true);
        nested.add(reviewer);
        try{await reviewer.result;onEvent?.({type:'text',text:`Synthetic reviewer ${index+1}/${policy.requiredReviews} completed.`});break;}
        catch(error){
         if(!(error instanceof Refusal)||!['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
         if(!announced){onEvent?.({type:'text',text:`Synthetic reviewer ${index+1} waiting for an authorized slot.`});announced=true;}
         await new Promise(resolve=>setTimeout(resolve,2000));
        }finally{nested.delete(reviewer);}
       }
      }
     };
     try{await Promise.all(Array.from({length:policy.requiredReviews},()=>worker()));}
     finally{for(const reviewer of nested)reviewer.hardStop?.();}
     const text=`Synthetic review council completed: ${policy.requiredReviews} independent sessions.`;
     onEvent?.({type:'text',text});onEvent?.({type:'done'});return {text,toolCalls:[],tokensUsed:0};
    }
   }
   const principal=(await this.ledger.pool.query('SELECT principal_id FROM ac_intents WHERE id=$1 AND context_id=$2',[intent.id,authority.contextId])).rows[0]?.principal_id;
   if(!principal)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   const stage=await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
    const frozen=(await c.query('SELECT digest FROM ac_execution_contracts WHERE intent_id=$1 AND project_id=$2',[intent.id,this.projectId])).rows[0];
    if(!frozen||frozen.digest!==contract.digest)throw new Refusal('EXECUTION_CONTRACT_MISMATCH');
    const inserted=await c.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state)
     VALUES($1,$2,$3,$4,$5,$6,'registered') ON CONFLICT(intent_id,node_id,session_id) DO NOTHING RETURNING *`,
     [randomUUID(),intent.id,node,sessionId,randomUUID(),authority.epoch]);
    return inserted.rows[0]??(await c.query('SELECT * FROM ac_stage_operations WHERE intent_id=$1 AND node_id=$2 AND session_id=$3',[intent.id,node,sessionId])).rows[0];
   });
   if(Number(stage.manager_epoch)!==authority.epoch)throw new Refusal('STAGE_RECONCILIATION_REQUIRED');
   if(stage.state==='completed'){
    if(stage.receipt?.verification)await this.options.quality.record(principal,stage.receipt.verification,stage.receipt.signature,authority);
    if(stage.receipt?.integration?.status==='rejected')throw new Refusal('INTEGRATION_REJECTED');
    return {text:`Recorded ${node} result ${stage.id}`,toolCalls:[],tokensUsed:0};
   }
   if(stage.state!=='registered')throw new Refusal('STAGE_RECONCILIATION_REQUIRED');
   const implementation=(await this.ledger.pool.query('SELECT * FROM ac_operations WHERE intent_id=$1',[intent.id])).rows[0];
   if(implementation?.state!=='completed'||!implementation.receipt?.commit||!implementation.native_session_id)throw new Refusal('IMPLEMENTATION_EVIDENCE_MISSING');
   const source=implementation.receipt;
   const artifact=await this.options.quality.register(principal,{id:artifactId(intent.id,source.commit),contextId:intent.context_id,intentId:intent.id,
    implementationGrantId:implementation.grant_id,implementationSessionId:implementation.native_session_id,policyRevision:contract.quality_revision,
    commit:source.commit,tree:source.tree,base:source.base,risk:'high'},authority);
   if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
   if(node==='judge')await this.ledger.tx(c=>this.options.quality.assertReady(c,artifact.id,authority,{ignoreJudge:true}));
   if(node==='integrate'){
    const prepare=()=>this.options.quality.prepareIntegration(principal,artifact.id,authority,contract.target_ref);
    let integration:Awaited<ReturnType<typeof prepare>>,announced=false;
    for(;;){
     if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
     try{integration=await prepare();break;}
     catch(error){
      if(!(error instanceof Refusal)||!['INTEGRATION_APPROVAL_REQUIRED','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
      if(!announced){onEvent?.({type:'text',text:'Integration is waiting for an authorized approval or admission. No Git effect started.'});announced=true;}
      await new Promise(resolve=>setTimeout(resolve,1000));
     }
    }
    await this.ledger.tx(async c=>{await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
     await c.query("UPDATE ac_stage_operations SET state='uncertain' WHERE id=$1 AND state='registered'",[stage.id]);});
    const receipt=await new Integrator(this.ledger,this.options.quality,this.options.git,this.projectId,contract.target_ref).integrate(principal,integration.id,authority);
    await this.ledger.tx(async c=>{await this.ledger.fence(c,authority,true);
     await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1",[stage.id,{integration:receipt}]);});
    if(receipt.status!=='integrated')throw new Refusal('INTEGRATION_REJECTED');
   }else{
    const reserve=()=>new Capacity(this.ledger).reserve(principal,{attemptId:stage.attempt_id,intentId:intent.id,contextId:intent.context_id,
     role:node==='qa'?'qa':node==='judge'?'judge':'reviewer'},authority);
    // Capacity exhaustion is an admission wait in this same native session,
    // not failed verification. Reuse the persisted stage/attempt on every poll.
    let grant:Awaited<ReturnType<typeof reserve>>;let waitReason:string|undefined;
    for(;;){
     if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
     try{grant=await reserve();break;}
     catch(error){
      if(!(error instanceof Refusal)||!['CAPACITY_BUSY','CAPACITY_QUEUED','NO_ELIGIBLE_CAPACITY','HUMAN_PAUSED','ADMISSION_CLOSED'].includes(error.code))throw error;
      if(waitReason!==error.code){onEvent?.({type:'text',text:`Stage ${node} waiting: ${error.code}. No verifier launched.`});waitReason=error.code;}
      await new Promise(resolve=>setTimeout(resolve,1000));
     }
    }
    if(Number(grant.manager_epoch)!==authority.epoch||grant.state!=='reserved')throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
    if(this.options.isolatedVerification){
     const qualityRow=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
      [this.projectId,contract.quality_revision])).rows[0];
     const policy=QualityPolicy.parse(qualityRow?.snapshot);
     const verifierDigest=createHash('sha256').update(await readFile(new URL('../scripts/synthetic-verifier.mjs',import.meta.url))).digest('hex');
     if(digest(policy)!==qualityRow.digest||policy.verifierDigest!==verifierDigest)throw new Refusal('VERIFIER_VERSION_MISMATCH');
     const verified=await this.options.isolatedVerification.run(principal,stage.id,grant.id,authority,spec.cwd,
      {id:artifact.id,commit:source.commit,tree:source.tree,base:source.base},intent.operation_id,node,verifierDigest,()=>canceled||!this.running);
     const logs=resolve('.state/verification-logs');await mkdir(logs,{recursive:true,mode:0o700});
     await writeFile(join(logs,stage.id+'.log'),verified.output,{mode:0o600});
     const receipt:VerificationReceipt={schemaVersion:1,id:randomUUID(),artifactId:artifact.id,kind:node==='review'?'review':node,sessionId,
      grantId:grant.id,policyRevision:contract.quality_revision,commit:source.commit,tree:source.tree,base:source.base,
      status:verified.exitCode===0?'passed':'failed',exitCode:verified.exitCode,verifierDigest,
      logSha256:createHash('sha256').update(verified.output).digest('hex'),
      commandDigest:digest({executor:'isolated-fixed-verifier-v1',verifierDigest,node,commit:source.commit,tree:source.tree,base:source.base}),
      verifierVersion:'synthetic-isolated-verifier-v1/'+verified.nodeVersion};
     const signature=createHmac('sha256',this.key).update(canonical(receipt)).digest('hex');
     await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority,true);
      const physical=(await c.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1 FOR UPDATE',[grant.id])).rows[0];
      if(physical?.state!=='released'||physical.physical_receipt?.jobId!==stage.id||physical.physical_receipt?.containerId!==verified.containerId)
       throw new Refusal('VERIFIER_EXECUTION_UNCONFIRMED');
      await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1 AND manager_epoch=$3",
       [stage.id,{verification:receipt,signature},authority.epoch]);
     });
     await this.options.quality.record(principal,receipt,signature,authority);
     await this.options.isolatedVerification.cleanup(stage.id,grant.id,authority);
     if(verified.exitCode!==0)throw new Refusal('VERIFICATION_FAILED');
    }else{
    const parent=resolve('.state/verifier-workspaces');await mkdir(parent,{recursive:true,mode:0o700});
    const temporary=await mkdtemp(join(parent,'stage-'));let monitor:ReturnType<typeof setInterval>|undefined;
    try{
     const script=await readFile(new URL('../scripts/synthetic-verifier.mjs',import.meta.url));
     const verifierDigest=createHash('sha256').update(script).digest('hex');
     const qualityRow=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2',
       [this.projectId,contract.quality_revision])).rows[0];
     const policy=QualityPolicy.parse(qualityRow?.snapshot);
     if(digest(policy)!==qualityRow.digest||policy.verifierDigest!==verifierDigest)throw new Refusal('VERIFIER_VERSION_MISMATCH');
     const verifierPath=join(temporary,'verifier.mjs');await writeFile(verifierPath,script,{mode:0o500});
     const snapshot=await this.options.git.snapshot(source.commit,source.base,join(temporary,'snapshot'));
     if(snapshot.tree!==source.tree)throw new Refusal('ARTIFACT_TREE_MISMATCH');
     await this.ledger.tx(async c=>{await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
      await c.query("UPDATE ac_stage_operations SET state='uncertain',grant_id=$2 WHERE id=$1 AND state='registered'",[stage.id,grant.id]);});
     let completion:Promise<number|null>|undefined;
     let output='',overLimit=false;
     await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,intent.id);
      if(canceled||!this.running)throw new Refusal('STAGE_CANCELED');
      const eligible=await c.query(`SELECT g.id FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id JOIN ac_profiles p ON p.id=g.profile_id
       JOIN ac_quota_observations q ON q.account_id=a.id WHERE g.id=$1 AND g.context_id=$2 AND g.manager_epoch=$3 AND g.state='reserved'
       AND a.enabled AND p.enabled AND a.eligibility='documented_supported' AND q.status='available' AND q.expires_at>clock_timestamp() FOR UPDATE OF g`,
       [grant.id,authority.contextId,authority.epoch]);
      if(!eligible.rowCount)throw new Refusal('GRANT_NOT_ELIGIBLE');
      child=spawn(process.execPath,[verifierPath,snapshot.snapshot,intent.operation_id,node],
       {cwd:snapshot.snapshot,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:temporary},stdio:['ignore','pipe','pipe'],detached:true});
      this.children.add(child);child.once('exit',()=>this.children.delete(child!));
      completion=new Promise((ok,fail)=>{child!.once('exit',ok);child!.once('error',fail);});void completion.catch(()=>{});
      const append=(chunk:Buffer)=>{output+=chunk.toString();if(output.length>65536){overLimit=true;stop(child);}};
      child.stdout!.on('data',append);child.stderr!.on('data',append);
      await new Promise<void>((ok,fail)=>{child!.once('spawn',ok);child!.once('error',fail);});
      const stat=await readFile(`/proc/${child.pid}/stat`,'utf8');const startTime=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
      if(!/^\d+$/.test(startTime??''))throw new Refusal('PROCESS_IDENTITY_UNAVAILABLE');
      const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
      await c.query("UPDATE ac_capacity_grants SET state='running' WHERE id=$1",[grant.id]);
      await c.query("UPDATE ac_stage_operations SET state='running',handle=$2,started_at=clock_timestamp() WHERE id=$1",[stage.id,{pid:child.pid,startTime,bootId,sessionId}]);
     });
     let checking=false;
     monitor=setInterval(()=>{if(checking)return;checking=true;void this.ledger.tx(c=>this.ledger.fence(c,authority,true)).catch(()=>stop(child)).finally(()=>{checking=false;});},500);
     if(!completion)throw new Refusal('PROCESS_COMPLETION_MISSING');
     const code=await completion;
     if(overLimit)throw new Refusal('VERIFIER_OUTPUT_LIMIT');
     const logs=resolve('.state/verification-logs');await mkdir(logs,{recursive:true,mode:0o700});
     await writeFile(join(logs,stage.id+'.log'),output,{mode:0o600});
     const receipt:VerificationReceipt={schemaVersion:1,id:randomUUID(),artifactId:artifact.id,kind:node==='qa'?'qa':node==='judge'?'judge':'review',sessionId,
      grantId:grant.id,policyRevision:contract.quality_revision,commit:source.commit,tree:source.tree,base:source.base,
      status:code===0?'passed':'failed',exitCode:code??-1,verifierDigest,logSha256:createHash('sha256').update(output).digest('hex'),
      commandDigest:digest({executor:'fixed-verifier-v1',verifierDigest,node,commit:source.commit,tree:source.tree,base:source.base}),verifierVersion:'synthetic-fixed-verifier-v1/'+process.version};
     const signature=createHmac('sha256',this.key).update(canonical(receipt)).digest('hex');
     await this.ledger.tx(async c=>{
      await this.ledger.fence(c,authority,true);
      const released=await c.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1 AND manager_epoch=$3 AND state='running'",
       [grant.id,{state:'exited',processId:String(child?.pid),exitCode:code,source:'synthetic-verifier-parent'},authority.epoch]);
      if(!released.rowCount)throw new Refusal('GRANT_RECONCILIATION_REQUIRED');
      await c.query("UPDATE ac_stage_operations SET state='completed',receipt=$2,finished_at=clock_timestamp() WHERE id=$1",[stage.id,{verification:receipt,signature}]);
     });
     await this.options.quality.record(principal,receipt,signature,authority);
     if(code!==0)throw new Refusal('VERIFICATION_FAILED');
    }finally{if(monitor)clearInterval(monitor);stop(child);await rm(temporary,{recursive:true,force:true});}
    }
   }
   const text=`Synthetic ${node} completed for artifact ${artifact.id}`;onEvent?.({type:'text',text});onEvent?.({type:'done'});
   return {text,toolCalls:[],tokensUsed:0};
  })().finally(()=>{open=false;});
  return {result,get open(){return open;},get pid(){return child?.pid;},sendMessage(){return false;},end(){},interrupt(){canceled=true;stop(child);for(const reviewer of nested)reviewer.interrupt();},hardStop(){canceled=true;stop(child);for(const reviewer of nested)reviewer.hardStop?.();}};
 }
 close(){this.running=false;for(const child of this.children)stop(child);this.options.isolatedVerification?.close();}
}
