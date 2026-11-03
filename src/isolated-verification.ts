import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {z} from 'zod';
import {Authority,Id,digest,Refusal} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {SandboxClient} from './sandbox-client.ts';
import {diskGuardFromEnvironment,type DiskGuard} from './disk-admission.ts';
import {readManagedInput,readManagedRecipe} from './managed-plan.ts';
import {CorrectionSource} from './sandbox-broker.ts';
const exec=promisify(execFile),GitId=z.string().regex(/^[a-f0-9]{40}$/);
const CompositionSource=z.object({unitId:z.string(),artifactId:Id,commit:GitId,tree:GitId,base:GitId,writePaths:z.array(z.string())}).strict();
const Launch=z.object({profile:z.literal('synthetic-verification-v1'),source:z.object({base:GitId,bundle:z.string().max(1400000),outputPath:z.string().optional(),composition:z.array(CompositionSource).min(2).max(10).optional(),correction:CorrectionSource.optional()}).strict(),
 verification:z.object({artifactId:Id,operationId:Id,kind:z.enum(['qa','review','judge']),verifierDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()}).strict();
const Result=z.object({jobId:Id,containerId:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int(),verification:z.object({
 artifactId:Id,operationId:Id,kind:z.enum(['qa','review','judge']),commit:GitId,tree:GitId,base:GitId,
 verifierDigest:z.string().regex(/^[a-f0-9]{64}$/),output:z.string().max(65536),nodeVersion:z.string()}).strict().nullable()}).passthrough();
export type VerificationArtifact={id:string;commit:string;tree:string;base:string};
export type IsolatedVerificationResult=NonNullable<z.infer<typeof Result>['verification']>&{exitCode:number;containerId:string};
function verifiedResult(response:unknown,stageId:string,artifact:VerificationArtifact,operationId:string,kind:'qa'|'review'|'judge',verifierDigest:string):IsolatedVerificationResult|null{
 const parsed=Result.safeParse(response);if(!parsed.success)return null;
 const result=parsed.data,verification=result.verification;
 if(result.jobId!==stageId||!verification||verification.artifactId!==artifact.id||verification.operationId!==operationId||
   verification.kind!==kind||verification.commit!==artifact.commit||verification.tree!==artifact.tree||verification.base!==artifact.base||verification.verifierDigest!==verifierDigest)
  throw new Refusal('SANDBOX_VERIFICATION_INVALID');
 return {...verification,exitCode:result.exitCode,containerId:result.containerId};
}
async function git(cwd:string,args:string[]){
 const result=await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],{
  env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000,maxBuffer:2000000});
 return result.stdout.trim();
}
/** Fixed verifier in a separate container with read-only code and no controller keys. */
export class IsolatedVerification{
 private active=true;
 private readonly stops=new Set<()=>void>();
 constructor(readonly ledger:Ledger,readonly client:SandboxClient,private readonly diskGuard:DiskGuard|undefined=diskGuardFromEnvironment()){}
 close(){this.active=false;for(const stop of this.stops)stop();}
 async run(principal:string,stageId:string,grantId:string,authority:Authority,cwd:string,
  artifact:{id:string;commit:string;tree:string;base:string},operationId:string,kind:'qa'|'review'|'judge',verifierDigest:string,isCanceled:()=>boolean){
  await this.diskGuard?.assertAdmission();
  const parent=resolve('.state/isolated-artifacts');await mkdir(parent,{recursive:true,mode:0o700});const temporary=await mkdtemp(join(parent,'verify-'));
  let launch:z.infer<typeof Launch>|undefined,stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;if(launch)void this.client.perform('stop',stageId,grantId,authority,launch).catch(()=>{});};
  this.stops.add(stop);
  try{
   if(await git(cwd,['rev-parse','HEAD'])!==artifact.commit||await git(cwd,['rev-parse','HEAD^{tree}'])!==artifact.tree)
    throw new Refusal('ARTIFACT_TREE_MISMATCH');
   const owner=(await this.ledger.pool.query('SELECT i.id,i.parent_intent_id FROM ac_artifacts a JOIN ac_intents i ON i.id=a.intent_id WHERE a.id=$1 AND i.context_id=$2',[artifact.id,authority.contextId])).rows[0];
   if(!owner)throw new Refusal('ARTIFACT_MISSING');
   const input=owner.parent_intent_id?await readManagedInput(this.ledger,owner.id):null;
   let composition:z.infer<typeof CompositionSource>[]|undefined;
   if(input?.kind==='composition'){
    const row=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_managed_composition_sources WHERE intent_id=$1',[owner.id])).rows[0];
    if(!row||digest(row.snapshot)!==row.digest)throw new Refusal('MANAGED_COMPOSITION_SOURCES_MISMATCH');
    composition=z.array(CompositionSource).min(2).max(10).parse(row.snapshot);
    if(digest(composition.map(s=>s.unitId))!==digest(input.sources))throw new Refusal('MANAGED_COMPOSITION_SOURCES_MISMATCH');
    const recipe=await readManagedRecipe(this.ledger,input.parentIntentId);
    if(recipe.schemaVersion!==1)for(const source of composition){
     const unit=recipe.units.find(value=>value.id===source.unitId);
     const selected=unit&&(await this.ledger.pool.query(`SELECT s.artifact_id,a.commit_id,a.tree_id,a.base_id FROM ac_managed_task_selections s
      JOIN ac_artifacts a ON a.id=s.artifact_id WHERE s.parent_intent_id=$1 AND s.task_id=$2 AND s.selected_intent_id=$3`,
      [input.parentIntentId,unit.taskId,unit.intentId])).rows[0];
     if(!selected||selected.artifact_id!==source.artifactId||selected.commit_id!==source.commit||selected.tree_id!==source.tree||selected.base_id!==source.base)
      throw new Refusal('MANAGED_COMPOSITION_SOURCES_MISMATCH');
    }
   }
   const correction=input?.correction?CorrectionSource.parse({schemaVersion:1,parentIntentId:input.parentIntentId,...input.correction}):undefined;
   if(correction&&(input?.kind!=='task'||await git(cwd,['rev-parse','refs/agent-control/correction-source'])!==correction.priorCommit||
    await git(cwd,['rev-parse',`${correction.priorCommit}^{tree}`])!==correction.priorTree))throw new Refusal('MANAGED_CORRECTION_SOURCE_MISMATCH');
   const bundlePath=join(temporary,'source.bundle');await git(cwd,['bundle','create',bundlePath,'HEAD',...(composition?.map((_,i)=>`refs/agent-control/sources/${i}`)??[]),
    ...(correction?['refs/agent-control/correction-source']:[])]);
   const bundle=await readFile(bundlePath);if(bundle.length>1000000)throw new Refusal('SANDBOX_SOURCE_TOO_LARGE');
   const outputPath=input?.kind==='task'?input.writePaths[0]:undefined;
   const legacyDigest=createHash('sha256').update(await readFile(new URL('../scripts/synthetic-verifier.mjs',import.meta.url))).digest('hex');
   launch=Launch.parse({profile:'synthetic-verification-v1',source:{base:artifact.commit,bundle:bundle.toString('base64'),...(outputPath?{outputPath}:{}),...(composition?{composition}:{}),...(correction?{correction}:{})},verification:{artifactId:artifact.id,operationId,kind,...(verifierDigest!==legacyDigest?{verifierDigest}:{})}});
   const snapshot=launch;
   await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);
    const intent=(await c.query('SELECT intent_id FROM ac_stage_operations WHERE id=$1',[stageId])).rows[0];
    if(!intent)throw new Refusal('STAGE_MISSING');
    await this.ledger.assertIntentActive(c,authority.contextId,intent.intent_id);
    if(!this.active||isCanceled())throw new Refusal('STAGE_CANCELED');
    const stage=(await c.query('SELECT * FROM ac_stage_operations WHERE id=$1 FOR UPDATE',[stageId])).rows[0];
    if(stage?.state!=='registered'||Number(stage.manager_epoch)!==authority.epoch||stage.node_id!==kind)
     throw new Refusal('STAGE_RECONCILIATION_REQUIRED');
    await c.query('INSERT INTO ac_stage_execution_launches(stage_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',
     [stageId,authority.contextId,authority.epoch,snapshot,digest(snapshot)]);
    await c.query("UPDATE ac_stage_operations SET state='uncertain',grant_id=$2 WHERE id=$1",[stageId,grantId]);
   });
   if(!this.active||isCanceled())throw new Refusal('STAGE_CANCELED');
   let response:unknown;
   try{response=await this.client.perform('start',stageId,grantId,authority,launch);}
   catch{response=await this.client.perform('reconcile',stageId,grantId,authority,launch);}
   const started=z.object({state:z.literal('running'),containerId:z.string()}).passthrough().safeParse(response);
   if(started.success)await this.ledger.tx(async c=>{
    await this.ledger.fence(c,authority,true);
    await c.query("UPDATE ac_stage_operations SET state='running',handle=$2,started_at=clock_timestamp() WHERE id=$1 AND state='uncertain' AND manager_epoch=$3",
     [stageId,{containerId:started.data.containerId,synthetic:true},authority.epoch]);
   });
   for(let i=0;i<240;i++){
    const terminal=verifiedResult(response,stageId,artifact,operationId,kind,verifierDigest);
    if(terminal)return terminal;
    if(!this.active||isCanceled()){stop();throw new Refusal('STAGE_CANCELED');}
    await new Promise(r=>setTimeout(r,250));response=await this.client.perform('reconcile',stageId,grantId,authority,launch);
   }
   throw new Refusal('SANDBOX_RESULT_UNCERTAIN');
  }finally{this.stops.delete(stop);await rm(temporary,{recursive:true,force:true});}
 }
 async reconcile(principal:string,stageId:string,grantId:string,authority:Authority,artifact:VerificationArtifact,
  operationId:string,kind:'qa'|'review'|'judge',verifierDigest:string){
  const row=await this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const stage=(await c.query(`SELECT s.intent_id,s.manager_epoch,s.node_id,l.snapshot,l.digest FROM ac_stage_operations s
    JOIN ac_stage_execution_launches l ON l.stage_id=s.id WHERE s.id=$1 AND s.grant_id=$2 AND l.context_id=$3`,[stageId,grantId,authority.contextId])).rows[0];
   if(!stage||Number(stage.manager_epoch)>authority.epoch||stage.node_id!==kind)throw new Refusal('STAGE_RECONCILIATION_REQUIRED');
   return stage;
  });
  const launch=Launch.parse(row.snapshot);
  if(digest(launch)!==row.digest||launch.source.base!==artifact.commit||launch.verification.artifactId!==artifact.id||
    launch.verification.operationId!==operationId||launch.verification.kind!==kind)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
  const response=await this.client.perform('reconcile',stageId,grantId,authority,launch);
  const result=verifiedResult(response,stageId,artifact,operationId,kind,verifierDigest);
  if(!result)return null;
  await this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);
   await this.ledger.assertIntentActive(c,authority.contextId,row.intent_id);
   const physical=(await c.query(`SELECT j.context_id,j.grant_id,j.manager_epoch,j.profile,j.state,j.receipt,
    g.manager_epoch grant_epoch,g.state grant_state,g.physical_receipt,s.intent_id,s.node_id,s.manager_epoch stage_epoch,l.snapshot,l.digest
    FROM ac_capacity_grants g JOIN ac_sandbox_jobs j ON j.grant_id=g.id
    JOIN ac_stage_operations s ON s.id=j.id AND s.grant_id=g.id JOIN ac_stage_execution_launches l ON l.stage_id=s.id
    WHERE j.id=$1 AND g.id=$2 FOR UPDATE OF g,j,s`,[stageId,grantId])).rows[0];
   const terminal=z.object({jobId:Id,containerId:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.number().int(),finishedAt:z.string().min(1)}).passthrough().safeParse(response);
   if(!physical||physical.context_id!==authority.contextId||physical.grant_id!==grantId||physical.intent_id!==row.intent_id||physical.node_id!==kind||
      physical.profile!=='synthetic-verification-v1'||Number(physical.manager_epoch)>authority.epoch||
      Number(physical.manager_epoch)!==Number(physical.grant_epoch)||Number(physical.manager_epoch)!==Number(physical.stage_epoch)||
      !['completed','failed'].includes(physical.state)||physical.grant_state!=='released'||!terminal.success||terminal.data.jobId!==stageId||
      !Number.isFinite(Date.parse(terminal.data.finishedAt))||terminal.data.finishedAt.startsWith('0001-')||
      !physical.receipt||!physical.physical_receipt||digest(physical.snapshot)!==physical.digest||physical.digest!==row.digest||digest(physical.receipt)!==digest(response)||
      digest(physical.physical_receipt)!==digest(response))throw new Refusal('VERIFIER_EXECUTION_UNCONFIRMED');
  });
  return result;
 }
 async cleanup(stageId:string,grantId:string,authority:Authority){
  const row=(await this.ledger.pool.query('SELECT snapshot,digest FROM ac_stage_execution_launches WHERE stage_id=$1 AND context_id=$2',[stageId,authority.contextId])).rows[0];
  if(!row)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
  const launch=Launch.parse(row.snapshot);if(digest(launch)!==row.digest)throw new Refusal('SANDBOX_LAUNCH_SNAPSHOT_MISMATCH');
  return this.client.perform('cleanup',stageId,grantId,authority,launch);
 }
}
