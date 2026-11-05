import {z} from 'zod';
import {randomUUID,createHash,createPublicKey,verify} from 'node:crypto';
import type pg from 'pg';
import {Id,Authority,Refusal,digest,canonical} from './contracts.ts';
import {Ledger} from './ledger.ts';
import {Capacity} from './capacity.ts';
import {ManagerPlan,ManagerPlans} from './planning.ts';
import {managerPlanOutputJsonSchema} from '../upstream/cezar/packages/contract/src/agent-control-plans.ts';
const Hash=z.string().regex(/^[a-f0-9]{64}$/);
export const SemanticPlanningRequest=z.object({id:Id,intentId:Id,contextId:Id,expectedRevision:z.number().int().nonnegative(),
 sourceMessageRef:z.string().min(1).max(240).regex(/^[a-z][a-z0-9-]*:[^\s]+$/),
 qualityRevision:z.number().int().positive(),targetRef:z.string().max(240).regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9/_-]*$/),
 knownReferences:z.array(z.string().min(1).max(240).regex(/^[a-z][a-z0-9-]*:[^\s]+$/)).max(256).optional(),text:z.string().min(1).max(100000)}).strict();
const Profile=z.object({id:Id,accountId:Id,provider:z.string().min(1).max(80),model:z.string().min(1).max(100),
 effort:z.enum(['low','medium','high']),mode:z.enum(['synthetic','subscription_cli'])}).strict();
export const PlanningPhysicalReceipt=z.object({payload:z.object({callId:Id,intentId:Id,contextId:Id,grantId:Id,profileId:Id,sessionId:Id,
 epoch:z.number().int().positive(),executorDigest:Hash,inputDigest:Hash,profileDigest:Hash,outputDigest:Hash,physicalDigest:Hash,
 exitCode:z.number().int()}).strict(),signature:z.string().regex(/^[a-f0-9]{128}$/)}).strict();
export const planningReceiptMessage=(payload:z.infer<typeof PlanningPhysicalReceipt>['payload'])=>Buffer.from('agent-control:semantic-planning-receipt:v1\n'+canonical(payload));
export type PlanningInvocation={callId:string;intentId:string;contextId:string;grantId:string;sessionId:string;executionEpoch:number;inputDigest:string;
 profile:z.infer<typeof Profile>;sourceMessageRef:string;text:string;constraints:{qualityRevision:number;targetRef:string;knownReferences:readonly string[]};outputSchema:unknown;assertAuthorized:()=>Promise<void>};
/** Trusted bootstrap adapter only. execute must use the admitted isolated executor;
 * reconcile observes the SAME operation and never launches a replacement. */
export type PlanningExecutor={id:string;digest:string;publicKey:string;provider:string;mode:'synthetic'|'subscription_cli';active?:boolean;
 execute(input:PlanningInvocation):Promise<{output:string;receipt:unknown}>;
 reconcile(input:PlanningInvocation):Promise<{output:string;receipt:unknown}|null>;
 retire?(principal:string,authority:Authority,callId:string):Promise<unknown>};
type ExecutorEntry={executor:Readonly<PlanningExecutor>;key:ReturnType<typeof createPublicKey>;fingerprint:string;identity:string};
const dispatcherId='semantic-planning-v1',dispatcherDigest=digest({contract:dispatcherId});
export class SemanticPlanning{
 private readonly entries=new Map<string,ExecutorEntry>();
 private readonly active=new Map<string,ExecutorEntry>();
 constructor(readonly ledger:Ledger,registered:PlanningExecutor|readonly PlanningExecutor[]){
  const all=Array.isArray(registered)?registered:[registered];if(!all.length||all.length>32)throw new Refusal('PLANNING_EXECUTOR_REGISTRY_INVALID');
  for(const raw of all){
   const executor=Object.freeze({...raw}) as Readonly<PlanningExecutor>;
   z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/).parse(executor.id);Hash.parse(executor.digest);
   z.string().min(1).max(80).parse(executor.provider);z.enum(['synthetic','subscription_cli']).parse(executor.mode);
   const key=createPublicKey({key:Buffer.from(executor.publicKey,'base64'),format:'der',type:'spki'});
   if(key.asymmetricKeyType!=='ed25519')throw new Refusal('PLANNING_RECEIPT_KEY_INVALID');
   const fingerprint=createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
   const entry={executor,key,fingerprint,identity:digest({id:executor.id,digest:executor.digest,provider:executor.provider,mode:executor.mode,key:fingerprint})};
   const id=executor.id+'@'+executor.digest;if(this.entries.has(id))throw new Refusal('PLANNING_EXECUTOR_DUPLICATE');this.entries.set(id,entry);
   if(executor.active!==false){const route=executor.provider+'@'+executor.mode;if(this.active.has(route))throw new Refusal('PLANNING_EXECUTOR_AMBIGUOUS');this.active.set(route,entry);}
  }
 }
 private async authorize(c:pg.PoolClient,principal:string,authority:Authority,intentId:string,paused=false){
  const context=await this.ledger.authorize(c,principal,authority.contextId);
  await this.ledger.fence(c,authority,paused);await this.ledger.assertIntentActive(c,authority.contextId,intentId);return context;
 }
 async plan(principal:string,raw:z.input<typeof SemanticPlanningRequest>,authority:Authority){
  const input=SemanticPlanningRequest.parse(raw);authority=Object.freeze(Authority.parse(authority));
  if(input.contextId!==authority.contextId)throw new Refusal('AUTHORITY_SCOPE_MISMATCH',403);
  const requestedDigest=digest({principal,...input});
  const call=await this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,input.intentId,true);
   const prior=(await c.query('SELECT * FROM ac_semantic_planning_calls WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(prior){
    const legacy=[...this.entries.values()].some(entry=>prior.executor_id===entry.executor.id&&prior.executor_digest===entry.executor.digest&&prior.input_digest===digest({principal,...input,executorIdentity:entry.identity}));
    if(prior.context_id!==input.contextId||prior.principal_id!==principal||(prior.input_digest!==requestedDigest&&!legacy))throw new Refusal('PLANNING_CALL_CONFLICT');return prior;
   }
   await this.ledger.fence(c,authority);
   const project=(await c.query('SELECT project_id FROM ac_contexts WHERE id=$1',[input.contextId])).rows[0];
   await c.query('SELECT id FROM ac_projects WHERE id=$1 FOR SHARE',[project.project_id]);
   const quality=(await c.query('SELECT max(revision) revision FROM ac_quality_policies WHERE project_id=$1',[project.project_id])).rows[0];
   if(quality?.revision!==input.qualityRevision)throw new Refusal('QUALITY_POLICY_CONFLICT');
   const current=Number((await c.query('SELECT COALESCE(max(revision),0) revision FROM ac_manager_plans WHERE context_id=$1',[input.contextId])).rows[0].revision);
   if(current!==input.expectedRevision)throw new Refusal('MANAGER_PLAN_REVISION_CONFLICT');
   if((await c.query("SELECT 1 FROM ac_semantic_planning_calls WHERE context_id=$1 AND state IN ('registered','uncertain','ready')",[input.contextId])).rowCount)throw new Refusal('PLANNING_CONTEXT_BUSY');
   return (await c.query(`INSERT INTO ac_semantic_planning_calls(id,context_id,intent_id,principal_id,input_digest,executor_id,executor_digest,expected_revision,attempt_id,session_id,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'registered') RETURNING *`,[input.id,input.contextId,input.intentId,principal,requestedDigest,dispatcherId,dispatcherDigest,input.expectedRevision,randomUUID(),randomUUID()])).rows[0];
  });
  const inputDigest=String(call.input_digest);
  if(call.state==='published'){await this.retirePublished(principal,input,authority,call);return call.result;}
  if(call.state==='rejected')throw new Refusal(call.failure_code??'PLANNING_OUTPUT_REJECTED');
  if(call.state==='ready')return this.publish(principal,input,authority);
  let grantId:string=call.grant_id;
  if(!grantId){const grant=await new Capacity(this.ledger).reserve(principal,{attemptId:call.attempt_id,intentId:input.intentId,contextId:input.contextId,role:'manager'},authority);grantId=grant.id;}
  const launch=await this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,input.intentId,true);
   const saved=(await c.query('SELECT * FROM ac_semantic_planning_calls WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(saved.state==='published'||saved.state==='ready')return {finished:true};
   if(saved.state==='rejected')throw new Refusal('PLANNING_OUTPUT_REJECTED');
   const grant=(await c.query(`SELECT g.*,p.model,p.effort,p.role profile_role,a.provider,a.mode,a.enabled account_enabled,p.enabled profile_enabled
    FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_accounts a ON a.id=g.account_id WHERE g.id=$1 AND g.context_id=$2 FOR UPDATE OF g`,[grantId,input.contextId])).rows[0];
   if(!grant||grant.intent_id!==input.intentId||grant.role!=='manager'||grant.profile_role!=='manager'||(saved.grant_id&&saved.grant_id!==grant.id))throw new Refusal('PLANNING_GRANT_MISMATCH');
   const profile=Profile.parse({id:grant.profile_id,accountId:grant.account_id,provider:grant.provider,model:grant.model,effort:grant.effort,mode:grant.mode});
   const reconcile=saved.state==='uncertain';
   const selectedId=saved.selected_executor_id??(saved.executor_id!==dispatcherId?saved.executor_id:null);
   const selectedDigest=saved.selected_executor_digest??(saved.executor_id!==dispatcherId?saved.executor_digest:null);
   const entry=reconcile&&selectedId?this.entries.get(selectedId+'@'+selectedDigest):this.active.get(profile.provider+'@'+profile.mode);
   if(!entry||entry.executor.provider!==profile.provider||entry.executor.mode!==profile.mode||
    (saved.selected_key_fingerprint&&saved.selected_key_fingerprint!==entry.fingerprint))throw new Refusal('PLANNING_EXECUTOR_PROFILE_MISMATCH');
   if(!reconcile){
    await this.ledger.fence(c,authority);
    if(grant.state!=='reserved'||Number(grant.manager_epoch)!==authority.epoch||!grant.account_enabled||!grant.profile_enabled)throw new Refusal('PLANNING_GRANT_INACTIVE');
    await c.query("UPDATE ac_semantic_planning_calls SET state='uncertain',grant_id=$2,profile_id=$3,execution_epoch=$4,selected_executor_id=$5,selected_executor_digest=$6,selected_key_fingerprint=$7 WHERE id=$1",[input.id,grant.id,profile.id,authority.epoch,entry.executor.id,entry.executor.digest,entry.fingerprint]);
   }
   return {finished:false,reconcile,profile,entry,epoch:Number(saved.execution_epoch??authority.epoch)};
  });
  if(launch.finished)return this.publish(principal,input,authority);
  const profile=Object.freeze(launch.profile!),entry=launch.entry!,executor=entry.executor;
  const assertAuthorized=async()=>this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,input.intentId,launch.reconcile);
   const row=(await c.query('SELECT state,grant_id,execution_epoch FROM ac_semantic_planning_calls WHERE id=$1',[input.id])).rows[0];
   if(row?.state!=='uncertain'||row.grant_id!==grantId||Number(row.execution_epoch)!==launch.epoch)throw new Refusal('PLANNING_CALL_FENCED');
  });
  const invocation:PlanningInvocation={callId:input.id,intentId:input.intentId,contextId:input.contextId,grantId,sessionId:call.session_id,executionEpoch:launch.epoch!,inputDigest,
   profile,sourceMessageRef:input.sourceMessageRef,text:input.text,constraints:Object.freeze({qualityRevision:input.qualityRevision,targetRef:input.targetRef,knownReferences:Object.freeze([input.sourceMessageRef,...input.knownReferences??[]])}),outputSchema:managerPlanOutputJsonSchema(),assertAuthorized};
  let outcome:Awaited<ReturnType<PlanningExecutor['execute']>>|null;
  try{await assertAuthorized();outcome=launch.reconcile?await executor.reconcile(invocation):await executor.execute(invocation);}
  catch{throw new Refusal('PLANNING_RESULT_UNCERTAIN');}
  if(!outcome)throw new Refusal('PLANNING_RESULT_UNCERTAIN');
  const output=z.string().parse(outcome.output),receipt=PlanningPhysicalReceipt.parse(outcome.receipt),p=receipt.payload;
  if(p.callId!==input.id||p.intentId!==input.intentId||p.contextId!==input.contextId||p.grantId!==grantId||p.profileId!==profile.id||p.sessionId!==call.session_id||p.epoch!==launch.epoch||p.executorDigest!==executor.digest||p.inputDigest!==inputDigest||p.profileDigest!==digest(profile)||p.outputDigest!==createHash('sha256').update(output).digest('hex')||!verify(null,planningReceiptMessage(p),entry.key,Buffer.from(receipt.signature,'hex')))throw new Refusal('PLANNING_RECEIPT_INVALID');
  let proposal:z.infer<typeof ManagerPlan>|undefined;let failure:string|undefined;
  if(p.exitCode!==0)failure='PLANNING_EXECUTOR_FAILED';
  else if(Buffer.byteLength(output)>256*1024)failure='PLANNING_OUTPUT_REJECTED';
  else try{
   proposal=ManagerPlan.parse(JSON.parse(output));
   if(proposal.contextId!==input.contextId||proposal.sourceMessageRef!==input.sourceMessageRef)throw Error();
   const known=new Set([input.sourceMessageRef,...input.knownReferences??[]]),produced=new Set(proposal.tasks.flatMap(task=>task.outputRefs));
   if(!known.has(proposal.objectiveRef)||proposal.constraintRefs.some(ref=>!known.has(ref))||proposal.tasks.some(task=>
    task.qualityRevision!==input.qualityRevision||task.targetRef!==input.targetRef||!known.has(task.objectiveRef)||
    task.acceptanceRefs.some(ref=>!known.has(ref))||task.outputRefs.some(ref=>!ref.startsWith('output:'))||task.inputRefs.some(ref=>!known.has(ref)&&!produced.has(ref))))throw Error();
  }catch{failure='PLANNING_OUTPUT_REJECTED';}
  await this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,input.intentId,true);
   const saved=(await c.query('SELECT * FROM ac_semantic_planning_calls WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1',[grantId])).rows[0];
   if(!grant||grant.state!=='released'||grant.resource_kind!=='model'||grant.role!=='manager'||grant.profile_id!==profile.id||grant.account_id!==profile.accountId||grant.context_id!==input.contextId||grant.intent_id!==input.intentId||Number(grant.manager_epoch)!==launch.epoch||!grant.physical_receipt||grant.physical_receipt.jobId!==input.id||grant.physical_receipt.exitCode!==p.exitCode||!Number.isFinite(Date.parse(grant.physical_receipt.finishedAt))||String(grant.physical_receipt.finishedAt).startsWith('0001-')||!/^[a-f0-9]{64}$/.test(grant.physical_receipt.containerId??'')||digest(grant.physical_receipt)!==p.physicalDigest)throw new Refusal('PLANNING_PHYSICAL_RESULT_UNCONFIRMED');
   if(saved.state==='ready'||saved.state==='published'||saved.state==='rejected'){if(digest(saved.receipt)!==digest(receipt))throw new Refusal('PLANNING_RESULT_CONFLICT');return;}
   if(saved.state!=='uncertain'||saved.grant_id!==grantId)throw new Refusal('PLANNING_CALL_FENCED');
   await c.query('UPDATE ac_semantic_planning_calls SET state=$2,proposal=$3,receipt=$4,failure_code=$5 WHERE id=$1',[input.id,failure?'rejected':'ready',proposal??null,receipt,failure??null]);
  });
  if(failure)throw new Refusal(failure);
  return this.publish(principal,input,authority);
 }
 private async publish(principal:string,input:z.infer<typeof SemanticPlanningRequest>,authority:Authority){
  const published=await this.ledger.tx(async c=>{
   await this.authorize(c,principal,authority,input.intentId);
   const call=(await c.query('SELECT * FROM ac_semantic_planning_calls WHERE id=$1 FOR UPDATE',[input.id])).rows[0];
   if(call?.state==='published')return {result:call.result,call};
   if(call?.state!=='ready')throw new Refusal('PLANNING_RESULT_UNCERTAIN');
   const result=await new ManagerPlans(this.ledger,c).publish(principal,authority,call.expected_revision,call.proposal);
   await c.query("UPDATE ac_semantic_planning_calls SET state='published',result=$2 WHERE id=$1",[input.id,result]);return {result,call};
  });
  // The proposal and signed result are durable before physical retirement. A
  // lost cleanup ACK is retried by the published replay, never by inference.
  await this.retirePublished(principal,input,authority,published.call);return published.result;
 }
 private async retirePublished(principal:string,input:z.infer<typeof SemanticPlanningRequest>,authority:Authority,call:Record<string,any>){
  const entry=this.entries.get(call.selected_executor_id+'@'+call.selected_executor_digest);
  if(entry?.executor.retire){if(entry.fingerprint!==call.selected_key_fingerprint)throw new Refusal('PLANNING_EXECUTOR_KEY_MISMATCH');await entry.executor.retire(principal,authority,input.id);}
 }
}
