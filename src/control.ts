import { z } from 'zod';
import { Capacity, CapacityPolicy, AccountInput, ProfileInput, QuotaInput } from './capacity.ts';
import { digest, Id, Refusal } from './contracts.ts';
import { Ledger } from './ledger.ts';
const base={schemaVersion:z.literal(1),intentId:Id,deliveryAttemptId:Id,contextId:Id};
export const ControlCommand=z.discriminatedUnion('action',[
 z.object({...base,action:z.literal('account.add'),payload:AccountInput}).strict(),
 z.object({...base,action:z.literal('account.share'),payload:z.object({accountId:Id}).strict()}).strict(),
 z.object({...base,action:z.literal('profile.add'),payload:ProfileInput}).strict(),
 z.object({...base,action:z.literal('policy.publish'),payload:z.object({expectedRevision:z.number().int().nonnegative(),policy:CapacityPolicy}).strict()}).strict(),
 z.object({...base,action:z.literal('policy.assign'),payload:z.object({revision:z.number().int().positive()}).strict()}).strict(),
 z.object({...base,action:z.literal('capacity.configure'),payload:z.object({programmingLimit:z.number().int().min(1).max(128),evaluationLimit:z.number().int().min(1).max(128),expectedRevision:z.number().int().nonnegative()}).strict()}).strict(),
 z.object({...base,action:z.literal('quota.observe'),payload:z.object({accountId:Id,observation:QuotaInput}).strict()}).strict(),
]);
/** Human administration has a separate intent identity but uses the same PG/RBAC authority.
 * A nested Capacity view shares this transaction: effect and dedupe commit together. */
export class Control {
 constructor(readonly ledger:Ledger){}
 async execute(principal:string,raw:z.input<typeof ControlCommand>){
  const command=ControlCommand.parse(raw);
  return this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,command.contextId);
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,2))',[command.intentId]);
   const {deliveryAttemptId,...semantic}=command;
   const hash=digest({principal,...semantic});
   const prior=(await c.query('SELECT * FROM ac_control_intents WHERE id=$1',[command.intentId])).rows[0];
   let result:unknown;
   if(prior){if(prior.payload_digest!==hash)throw new Refusal('CONTROL_INTENT_CONFLICT');result=prior.result;}
   else{
    const service=new Capacity(this.ledger,c);
    switch(command.action){
     case 'account.add':await service.addAccount(principal,context.project_id,command.payload);result={accountId:command.payload.id};break;
     case 'account.share':await service.shareAccount(principal,command.payload.accountId,context.project_id);result={accountId:command.payload.accountId};break;
     case 'profile.add':await service.addProfile(principal,context.project_id,command.payload);result={profileId:command.payload.id};break;
     case 'policy.publish':result={revision:await service.publish(principal,context.project_id,command.payload.expectedRevision,command.payload.policy)};break;
     case 'policy.assign':await service.assignPolicy(principal,command.contextId,command.payload.revision);result={revision:command.payload.revision};break;
     case 'capacity.configure':await service.configure(principal,command.payload);result={applied:true};break;
     case 'quota.observe':await service.observeQuota(principal,command.payload.accountId,command.payload.observation);result={observed:true};break;
    }
    await c.query('INSERT INTO ac_control_intents(id,context_id,principal_id,payload_digest,action,result) VALUES($1,$2,$3,$4,$5,$6)',
     [command.intentId,command.contextId,principal,hash,command.action,result]);
    await c.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'control.applied',$2)",[command.contextId,{intentId:command.intentId,action:command.action}]);
   }
   await c.query('INSERT INTO ac_control_deliveries(id,intent_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[deliveryAttemptId,command.intentId]);
   if((await c.query('SELECT intent_id FROM ac_control_deliveries WHERE id=$1',[deliveryAttemptId])).rows[0].intent_id!==command.intentId)
    throw new Refusal('CONTROL_DELIVERY_CONFLICT');
   return {intentId:command.intentId,state:'applied' as const,result};
  });
 }
 async view(principal:string,contextId:string){
  return this.ledger.tx(async c=>{
   const context=await this.ledger.authorize(c,principal,Id.parse(contextId),false);
   const accounts=(await c.query(`SELECT a.id,a.provider,a.label,a.mode,a.eligibility,a.enabled,a.max_concurrent,
    CASE WHEN q.expires_at>clock_timestamp() THEN q.status ELSE 'unknown' END quota_status,
    q.source quota_source,q.observed_at,q.expires_at
    FROM ac_accounts a JOIN ac_account_access x ON x.account_id=a.id LEFT JOIN ac_quota_observations q ON q.account_id=a.id
    WHERE x.project_id=$1 ORDER BY a.id`,[context.project_id])).rows;
   const profiles=(await c.query('SELECT p.* FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id WHERE x.project_id=$1 ORDER BY p.id',[context.project_id])).rows;
   const policies=(await c.query('SELECT revision,digest,snapshot,published_at FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision',[context.project_id])).rows;
   const grants=(await c.query(`SELECT id,attempt_id,intent_id,profile_id,account_id,role,policy_revision,emergency,state,created_at
    FROM ac_capacity_grants WHERE context_id=$1 ORDER BY created_at DESC LIMIT 100`,[contextId])).rows;
   return {schemaVersion:1,contextId,projectId:context.project_id,assignedPolicyRevision:context.capacity_policy_revision,
    accounts,profiles,policies,grants};
  });
 }
}
