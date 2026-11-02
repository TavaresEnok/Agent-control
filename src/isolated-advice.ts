import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {z} from 'zod';
import {Authority,Id,digest,Refusal} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {SandboxClient} from './sandbox-client.ts';
import {SpecialistRequest} from './sandbox-broker.ts';
import {readManagedInput} from './managed-plan.ts';

const exec=promisify(execFile),GitId=z.string().regex(/^[a-f0-9]{40}$/);
const Launch=z.object({profile:z.literal('synthetic-specialist-v1'),source:z.object({base:GitId,bundle:z.string().max(1400000)}).strict(),advice:SpecialistRequest}).strict();
const Physical=z.object({jobId:Id,containerId:z.string().regex(/^[a-f0-9]{64}$/),exitCode:z.literal(0),finishedAt:z.string().min(1),synthetic:z.literal(true),
 advice:SpecialistRequest.extend({sourceBase:GitId,verdict:z.enum(['proceed','reject']),summary:z.literal('Synthetic pre-implementation advice'),verifierDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
 adviceIsolation:z.object({readOnlySnapshot:z.literal(true),uid:z.literal(10001),visible:z.array(z.string()).length(0)}).strict()}).passthrough();
async function git(cwd:string,args:string[]){const result=await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],{
 env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'},timeout:10000,maxBuffer:2000000});return result.stdout.trim();}
export type SpecialistInput={intentId:string;unitId:string;policyRevision:number;scopeDigest:string;inputDigest:string;policyDigest:string;base:string};
/** Advice is an isolated observation, never an implementation artifact. */
export class IsolatedAdvice{
 constructor(readonly ledger:Ledger,readonly client=new SandboxClient()){}
 async run(principal:string,adviceId:string,grantId:string,authority:Authority,cwd:string,input:SpecialistInput,isCanceled:()=>boolean){
  const frozen=await readManagedInput(this.ledger,input.intentId);
  if(frozen.unitId!==input.unitId||frozen.base!==input.base||digest(frozen)!==input.inputDigest||
    digest({writePaths:frozen.writePaths,acceptanceRefs:frozen.acceptanceRefs})!==input.scopeDigest)throw new Refusal('SPECIALIST_INPUT_MISMATCH');
  const root=resolve('.state/isolated-artifacts');await mkdir(root,{recursive:true,mode:0o700});const temporary=await mkdtemp(join(root,'advice-'));
  try{
   if(await git(cwd,['rev-parse','HEAD'])!==input.base)throw new Refusal('SPECIALIST_INPUT_MISMATCH');
   const bundlePath=join(temporary,'source.bundle');await git(cwd,['bundle','create',bundlePath,'HEAD']);const bundle=await readFile(bundlePath);
   if(bundle.length>1000000)throw new Refusal('SANDBOX_SOURCE_TOO_LARGE');
   const operation=(await this.ledger.pool.query('SELECT operation_id FROM ac_intents WHERE id=$1 AND context_id=$2',[input.intentId,authority.contextId])).rows[0];
   if(!operation)throw new Refusal('INTENT_SCOPE_MISMATCH',403);
   const launch=Launch.parse({profile:'synthetic-specialist-v1',source:{base:input.base,bundle:bundle.toString('base64')},
    advice:{adviceId,intentId:input.intentId,unitId:input.unitId,operationId:operation.operation_id,policyRevision:input.policyRevision,
     scopeDigest:input.scopeDigest,inputDigest:input.inputDigest,policyDigest:input.policyDigest}});
   await this.ledger.tx(async c=>{
    await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,input.intentId);
    if(isCanceled())throw new Refusal('STAGE_CANCELED');
    const row=(await c.query(`SELECT a.*,g.role,g.resource_kind,g.state grant_state,g.intent_id grant_intent,g.context_id grant_context,g.manager_epoch grant_epoch,g.attempt_id grant_attempt,
     p.snapshot policy,p.digest policy_saved FROM ac_specialist_advice a JOIN ac_capacity_grants g ON g.id=a.grant_id
     JOIN ac_execution_contracts x ON x.intent_id=a.intent_id JOIN ac_quality_policies p ON p.project_id=x.project_id AND p.revision=x.quality_revision
     WHERE a.id=$1 AND a.context_id=$2 FOR UPDATE OF a,g`,[adviceId,authority.contextId])).rows[0];
    if(!row||row.intent_id!==input.intentId||row.unit_id!==input.unitId||row.operation_id!==operation.operation_id||row.policy_revision!==input.policyRevision||
     row.base_id!==input.base||row.input_digest!==input.inputDigest||row.scope_digest!==input.scopeDigest||row.policy_digest!==input.policyDigest||
     row.policy_saved!==input.policyDigest||digest(row.policy)!==input.policyDigest||row.grant_id!==grantId||row.grant_intent!==input.intentId||
     row.grant_context!==authority.contextId||row.grant_attempt!==row.attempt_id||row.role!=='specialist'||row.resource_kind!=='model'||row.grant_state!=='reserved'||
     Number(row.manager_epoch)!==authority.epoch||Number(row.grant_epoch)!==authority.epoch||row.state!=='registered')throw new Refusal('SPECIALIST_LAUNCH_FORBIDDEN');
    await c.query('INSERT INTO ac_specialist_execution_launches(advice_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',[adviceId,authority.contextId,authority.epoch,launch,digest(launch)]);
    await c.query("UPDATE ac_specialist_advice SET state='uncertain' WHERE id=$1",[adviceId]);
   });
   if(isCanceled())throw new Refusal('STAGE_CANCELED');
   let response:unknown;try{response=await this.client.perform('start',adviceId,grantId,authority,launch);}catch{response=await this.client.perform('reconcile',adviceId,grantId,authority,launch);}
   for(let i=0;i<240;i++){
    const physical=Physical.safeParse(response);
    if(physical.success){
     if(isCanceled()||physical.data.jobId!==adviceId||physical.data.advice.sourceBase!==input.base)throw new Refusal('SANDBOX_SPECIALIST_INVALID');
     const {sourceBase,verdict,summary,verifierDigest,...returned}=physical.data.advice;
     if(digest(returned)!==digest(launch.advice)||!Number.isFinite(Date.parse(physical.data.finishedAt))||physical.data.finishedAt.startsWith('0001-'))throw new Refusal('SANDBOX_SPECIALIST_INVALID');
     await this.ledger.tx(async c=>{
      await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority);await this.ledger.assertIntentActive(c,authority.contextId,input.intentId);
      const row=(await c.query(`SELECT j.state,j.receipt,g.state grant_state,g.physical_receipt FROM ac_sandbox_jobs j JOIN ac_capacity_grants g ON g.id=j.grant_id
       WHERE j.id=$1 AND g.id=$2 AND j.context_id=$3 FOR UPDATE OF g,j`,[adviceId,grantId,authority.contextId])).rows[0];
      if(!row||row.state!=='completed'||row.grant_state!=='released'||!row.receipt||!row.physical_receipt||digest(row.receipt)!==digest(response)||digest(row.physical_receipt)!==digest(response))throw new Refusal('SANDBOX_SPECIALIST_UNCONFIRMED');
     });
     try{await this.client.perform('cleanup',adviceId,grantId,authority,launch);}
     catch(error){await this.ledger.tx(async c=>{await this.ledger.fence(c,authority,true);
      await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'sandbox.cleanup_pending',$2)",[authority.contextId,{adviceId,reason:error instanceof Refusal?error.code:'TRANSPORT_UNCERTAIN'}]);});}
     return physical.data;
    }
    const failed=z.object({jobId:Id,exitCode:z.number().int()}).passthrough().safeParse(response);
    if(failed.success)throw new Refusal('SANDBOX_SPECIALIST_FAILED');
    if(isCanceled()){await this.client.perform('stop',adviceId,grantId,authority,launch);throw new Refusal('STAGE_CANCELED');}
    await new Promise(r=>setTimeout(r,250));response=await this.client.perform('reconcile',adviceId,grantId,authority,launch);
   }
   throw new Refusal('SANDBOX_RESULT_UNCERTAIN');
  }finally{await rm(temporary,{recursive:true,force:true});}
 }
}
