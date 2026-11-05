import {z} from 'zod';
import {UsageReports,type UsageReportQuery} from './usage-report.ts';
import {Ledger} from './ledger.ts';
import {Authority,Id,digest,Refusal} from './contracts.ts';

// Each value is cumulative for one attempt, as reported by its adapter.
// Cache and reasoning may overlap input/output; never add them into a total.
const Counters=z.object({input:z.number().int().nonnegative().safe().nullable(),output:z.number().int().nonnegative().safe().nullable(),
 cache:z.number().int().nonnegative().safe().nullable(),reasoning:z.number().int().nonnegative().safe().nullable()}).strict();
const Observation=z.object({grantId:Id,eventId:Id,seq:z.number().int().positive().safe(),counters:Counters}).strict();
export class Usage {
 constructor(readonly ledger:Ledger){}
 async record(principal:string,authority:Authority,raw:z.input<typeof Observation>){
  const value=Observation.parse(raw),hash=digest(value);
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,authority.contextId);await this.ledger.fence(c,authority,true);
   const grant=(await c.query('SELECT * FROM ac_capacity_grants WHERE id=$1 AND context_id=$2 FOR UPDATE',[value.grantId,authority.contextId])).rows[0];
   if(!grant||grant.resource_kind!=='model'||Number(grant.manager_epoch)!==authority.epoch)throw new Refusal('USAGE_GRANT_FORBIDDEN',403);
   const prior=(await c.query('SELECT digest,seq FROM ac_usage_observations WHERE grant_id=$1 AND event_id=$2',[value.grantId,value.eventId])).rows[0];
   if(prior){if(prior.digest!==hash)throw new Refusal('USAGE_EVENT_CONFLICT');return {duplicate:true};}
   const last=(await c.query('SELECT seq,counters FROM ac_usage_observations WHERE grant_id=$1 ORDER BY seq DESC LIMIT 1',[value.grantId])).rows[0];
   if(last){
    if(value.seq<=Number(last.seq))throw new Refusal('USAGE_SEQUENCE_STALE');
    for(const k of ['input','output','cache','reasoning'] as const){const old=last.counters[k],next=value.counters[k];
     if(old!==null&&(next===null||next<old))throw new Refusal('USAGE_COUNTER_REGRESSION');}
   }
   await c.query('INSERT INTO ac_usage_observations(grant_id,event_id,seq,counters,digest) VALUES($1,$2,$3,$4,$5)',[value.grantId,value.eventId,value.seq,value.counters,hash]);
   return {duplicate:false};
  });
 }
 async report(principal:string,projectId:string,contextId:string,query:UsageReportQuery){
  return new UsageReports(this.ledger).report(principal,projectId,contextId,query);
 }
 async context(principal:string,contextId:string){
  Id.parse(contextId);
  return this.ledger.tx(async c=>{
   await this.ledger.authorize(c,principal,contextId,false);
   const rows=await c.query(`SELECT g.id grant_id,g.role,g.resource_kind,g.account_id,g.profile_id,g.state,p.model,p.effort,
     u.seq,u.counters,u.observed_at,CASE WHEN g.resource_kind='model' AND g.state='released'
      AND j.state IN ('completed','failed') AND j.receipt->'payload'->>'physicalDigest' IS NOT NULL
      THEN g.physical_receipt->'normalizedTokensUsed' ELSE NULL END reported_tokens,
      j.receipt->'payload'->>'physicalDigest' reported_physical_digest,g.physical_receipt reported_physical
     FROM ac_capacity_grants g LEFT JOIN ac_profiles p ON p.id=g.profile_id AND g.resource_kind='model'
     LEFT JOIN ac_native_planning_jobs j ON j.grant_id=g.id
     LEFT JOIN LATERAL (SELECT seq,counters,observed_at FROM ac_usage_observations WHERE grant_id=g.id AND g.resource_kind='model' ORDER BY seq DESC LIMIT 1) u ON true
     WHERE g.context_id=$1 ORDER BY g.created_at,g.id`,[contextId]);
   return {scope:'reported_attempt_usage',subscriptionBalance:'unknown',overlappingCounters:true,attempts:rows.rows.map(row=>{const {reported_physical,reported_physical_digest,...safe}=row;const total=z.number().int().nonnegative().safe().safeParse(safe.reported_tokens);return {...safe,reported_tokens:total.success&&reported_physical&&digest(reported_physical)===reported_physical_digest?total.data:null};})};
  });
 }
}
