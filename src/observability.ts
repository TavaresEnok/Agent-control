import {z} from 'zod';
import {Ledger} from './ledger.ts';
import {Id,Refusal} from './contracts.ts';
import {CAPACITY_EXCLUSION_REASONS,type ProfileExclusion} from './capacity-exclusions.ts';
import {DiskAdmissionPolicy,measureDiskCapacity} from './disk-admission.ts';

const metricStates={
 intents:['accepted','running','review','done','failed','canceled','other'],
 grants:['reserved','running','uncertain','released'],
 operations:['registered','running','uncertain','completed','failed','integrated','rejected','canceled_confirmed','other'],
 quota:['available','exhausted','rate_limited','auth_required','unknown','unreachable','disabled','configuration_error'],
 reasons:['NO_ELIGIBLE_CAPACITY','CAPACITY_QUEUED','CAPACITY_BUSY','ORIGINAL_RESERVE_NOT_NEEDED','GLOBAL_CAPACITY_LIMIT','CONTEXT_CAPACITY_LIMIT','ACCOUNT_CAPACITY_LIMIT','other'],
 roles:['manager','programmer','reviewer','qa','specialist','judge','other'],
 storage:['reserved','published','retained','deleting','deleted'],
 managedKinds:['task_implementation','git_composition','unclassified'],
 resourceKinds:['model','local_compositor','other'],
} as const;
const Decimal=z.string().regex(/^\d+$/);
export type MetricSample={labels:Record<string,string>;value:string};
export type OperationalMetric={name:string;help:string;type:'gauge';samples:MetricSample[]};
export type OperationalSnapshot={schemaVersion:1;scope:'installation_aggregate';observedAt:string;
 databaseReadOnly:true;diskObservation:'not_configured'|'observed'|'partially_unavailable';metrics:OperationalMetric[]};
type CounterRow={label:string;value:string};
const sample=(value:string|number,labels:Record<string,string>={}):MetricSample=>({labels,value:Decimal.parse(String(value))});
const gauge=(name:string,help:string,samples:MetricSample[]):OperationalMetric=>({name:'agent_control_'+name,help,type:'gauge',samples});
function enumerated(rows:CounterRow[],states:readonly string[],key:string){
 const counts=new Map<string,bigint>(states.map(state=>[state,0n]));
 for(const row of rows){const state=counts.has(row.label)?row.label:'other';if(counts.has(state))counts.set(state,counts.get(state)!+BigInt(Decimal.parse(row.value)));}
 return states.map(state=>sample(String(counts.get(state)!),{[key]:state}));
}

/** Global administrator aggregates, never a transcript/export endpoint.
 * Runtime/provider/account/project/context IDs, labels, raw errors, quota
 * sources and local paths are neither queried as labels nor returned. */
export class OperationalObservability{
 private readonly diskPolicy:DiskAdmissionPolicy|undefined;
 constructor(readonly ledger:Ledger,options:{diskPolicy?:DiskAdmissionPolicy}={}){
  this.diskPolicy=options.diskPolicy?DiskAdmissionPolicy.parse(options.diskPolicy):undefined;
 }
 async snapshot(principal:string):Promise<OperationalSnapshot>{
  const result=await this.ledger.tx(async c=>{
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
   await c.query("SET LOCAL statement_timeout = '2500ms'");
   if(!(await c.query('SELECT 1 FROM ac_control_admins WHERE principal_id=$1',[principal])).rowCount)throw new Refusal('CONTROL_ADMIN_REQUIRED',403);
   const clock=(await c.query('SELECT current_timestamp at')).rows[0].at as Date;
   const metrics:OperationalMetric[]=[];
   const states=async(table:string)=> (await c.query<CounterRow>(`SELECT state label,count(*)::text value FROM ${table} GROUP BY state`)).rows;
   metrics.push(gauge('intents','Current durable intents by state; not completion rate.',enumerated(await states('ac_intents'),metricStates.intents,'state')));
   metrics.push(gauge('grants','Global grants including unresolved physical effects.',enumerated(await states('ac_capacity_grants'),metricStates.grants,'state')));
   const resourceGrants=(await c.query<{kind:string;label:string;value:string}>('SELECT resource_kind kind,state label,count(*)::text value FROM ac_capacity_grants GROUP BY resource_kind,state')).rows;
   metrics.push(gauge('resource_grants','Global reservations by fixed resource kind and state, including uncertain effects.',
    metricStates.resourceKinds.flatMap(kind=>enumerated(resourceGrants.filter(row=>(metricStates.resourceKinds as readonly string[]).includes(row.kind)?row.kind===kind:kind==='other'),metricStates.grants,'state')
     .map(row=>({...row,labels:{...row.labels,resource_kind:kind}})))));
   const operations:MetricSample[]=[];
   for(const [scope,table] of [['implementation','ac_operations'],['stage','ac_stage_operations'],['sandbox','ac_sandbox_jobs'],['remote','ac_remote_operations'],['integration','ac_integration_intents']] as const)
    operations.push(...enumerated(await states(table),metricStates.operations,'state').map(row=>({...row,labels:{...row.labels,scope}})));
   metrics.push(gauge('operations','Physical or integration records; scopes overlap and must not be added as unique jobs.',operations));
   const waits=(await c.query<CounterRow>(`SELECT COALESCE(w.reason,'other') label,count(*)::text value FROM ac_capacity_waits w
    JOIN ac_intents i ON i.id=w.intent_id WHERE i.state NOT IN ('done','review','failed','canceled','cancelled')
    AND NOT EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id=i.id) GROUP BY w.reason`)).rows;
   metrics.push(gauge('capacity_waits','Nonterminal, noncanceled durable capacity waits.',enumerated(waits,metricStates.reasons,'reason')));
   const resourceWaits=(await c.query<{kind:string;label:string;value:string}>(`SELECT w.resource_kind kind,COALESCE(w.reason,'other') label,count(*)::text value
    FROM ac_capacity_waits w JOIN ac_intents i ON i.id=w.intent_id WHERE i.state NOT IN ('done','review','failed','canceled','cancelled')
    AND NOT EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id IN (i.id,i.parent_intent_id)) GROUP BY w.resource_kind,w.reason`)).rows;
   metrics.push(gauge('resource_capacity_waits','Nonterminal noncanceled capacity waits by fixed resource kind and reason.',
    metricStates.resourceKinds.flatMap(kind=>enumerated(resourceWaits.filter(row=>(metricStates.resourceKinds as readonly string[]).includes(row.kind)?row.kind===kind:kind==='other'),metricStates.reasons,'reason')
     .map(row=>({...row,labels:{...row.labels,resource_kind:kind}})))));
   const age=(await c.query(`SELECT COALESCE(GREATEST(0,floor(extract(epoch FROM (current_timestamp-min(w.created_at))))),0)::text seconds
    FROM ac_capacity_waits w JOIN ac_intents i ON i.id=w.intent_id WHERE i.state NOT IN ('done','review','failed','canceled','cancelled')
    AND NOT EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id=i.id)`)).rows[0].seconds;
   metrics.push(gauge('capacity_wait_oldest_seconds','Oldest nonterminal noncanceled wait; zero when empty.',[sample(age)]));
   // Classify only programmer grants linked to the child's physical operation.
   // The immutable recipe and child binding, not the role alone, identify the
   // compositor. Unmatched/ambiguous bindings stay visibly unclassified.
   const managedBindings=`WITH bindings AS (
    SELECT i.id intent_id,i.parent_intent_id,i.parent_unit_id,o.id operation_id,
     CASE WHEN count(u.value)=1 AND min(u.value->>'kind')='task' THEN 'task_implementation'
          WHEN count(u.value)=1 AND min(u.value->>'kind')='composition' THEN 'git_composition'
          ELSE 'unclassified' END kind,
     CASE WHEN count(u.value)=1 THEN min(u.value->>'attemptId') ELSE NULL END attempt_id
    FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id
    LEFT JOIN ac_managed_executions e ON e.parent_intent_id=i.parent_intent_id AND e.context_id=i.context_id
    LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.recipe->'units')='array' THEN e.recipe->'units' ELSE '[]'::jsonb END) u(value)
      ON u.value->>'id'=i.parent_unit_id AND u.value->>'intentId'=i.id::text AND u.value->>'operationId'=o.id::text
    WHERE i.parent_intent_id IS NOT NULL GROUP BY i.id,i.parent_intent_id,i.parent_unit_id,o.id
   )`;
   const managedGrants=(await c.query<{kind:string;label:string;value:string}>(`${managedBindings}
    SELECT CASE WHEN b.attempt_id=g.attempt_id::text THEN b.kind ELSE 'unclassified' END kind,g.state label,count(*)::text value
    FROM bindings b JOIN ac_operations o ON o.id=b.operation_id JOIN ac_capacity_grants g ON g.id=o.grant_id
    WHERE g.role='programmer' AND g.intent_id=b.intent_id GROUP BY 1,2`)).rows;
   const byKind=(rows:{kind:string;label:string;value:string}[],states:readonly string[],key:string)=>
    metricStates.managedKinds.flatMap(kind=>enumerated(rows.filter(row=>row.kind===kind),states,key).map(row=>({...row,labels:{...row.labels,kind}})));
   metrics.push(gauge('managed_programmer_grants','Managed programmer-budget grants linked to unit operations; local composition is not inference or token usage.',
    byKind(managedGrants,metricStates.grants,'state')));
   const managedWaits=(await c.query<{kind:string;label:string;value:string}>(`${managedBindings}
    SELECT CASE WHEN b.attempt_id=w.attempt_id::text THEN b.kind ELSE 'unclassified' END kind,COALESCE(w.reason,'other') label,count(*)::text value
    FROM bindings b JOIN ac_capacity_waits w ON w.intent_id=b.intent_id JOIN ac_intents i ON i.id=b.intent_id
    WHERE w.role='programmer' AND i.state NOT IN ('done','review','failed','canceled','cancelled')
     AND NOT EXISTS(SELECT 1 FROM ac_plan_cancellations k WHERE k.intent_id IN (i.id,i.parent_intent_id)) GROUP BY 1,2`)).rows;
   metrics.push(gauge('managed_programmer_capacity_waits','Nonterminal noncanceled managed programmer waits by frozen unit kind; no inference or token usage is implied.',
    byKind(managedWaits,metricStates.reasons,'reason')));
   const roles=(await c.query<CounterRow>(`SELECT role label,count(*)::text value FROM ac_capacity_grants WHERE state<>'released' GROUP BY role`)).rows;
   metrics.push(gauge('active_grants_by_role','Capacity reservations by fixed role, including uncertain effects.',enumerated(roles,metricStates.roles,'role')));
   const managers=(await c.query<CounterRow>(`SELECT CASE WHEN m.context_id IS NULL THEN 'missing' WHEN m.lease_until<=current_timestamp THEN 'stale' ELSE 'leased' END label,
    count(*)::text value FROM ac_contexts x LEFT JOIN ac_managers m ON m.context_id=x.id WHERE NOT x.archived GROUP BY label`)).rows;
   metrics.push(gauge('managers','Lease observation over nonarchived contexts; does not prove process liveness.',enumerated(managers,['missing','stale','leased'],'state')));
   const contexts=(await c.query(`SELECT count(*) FILTER(WHERE NOT archived)::text active,
    count(*) FILTER(WHERE NOT archived AND paused)::text paused,count(*) FILTER(WHERE NOT archived AND draining)::text draining FROM ac_contexts`)).rows[0];
   metrics.push(gauge('contexts','Administrative context states; categories overlap.',Object.entries(contexts).map(([state,value])=>sample(String(value),{state}))));
   const quota=(await c.query<CounterRow>(`SELECT CASE WHEN NOT a.enabled THEN 'disabled' WHEN q.account_id IS NULL OR q.expires_at<=current_timestamp THEN 'unknown' ELSE q.status END label,
    count(*)::text value FROM ac_accounts a LEFT JOIN ac_quota_observations q ON q.account_id=a.id GROUP BY 1`)).rows;
   metrics.push(gauge('quota_accounts','Observed account availability; expired or missing observations are unknown, never available.',enumerated(quota,metricStates.quota,'state')));
   const cancellations=(await c.query<CounterRow>('SELECT state label,count(*)::text value FROM ac_plan_cancellations GROUP BY state')).rows;
   metrics.push(gauge('cancellations','Durable cancellation request reconciliation.',enumerated(cancellations,['requested','confirmed'],'state')));
   const outbox=(await c.query<CounterRow>('SELECT state label,count(*)::text value FROM ac_outbox GROUP BY state')).rows;
   metrics.push(gauge('outbox','Persisted dispatch outbox states; not a delivery SLO.',enumerated(outbox,['pending','dispatched'],'state')));
   const admission=(await c.query('SELECT enabled FROM ac_admission_control WHERE id=1')).rows[0];
   metrics.push(gauge('admission_enabled','One only when ledger admission is open.',[sample(admission?.enabled?1:0)]));
   const storage=(await c.query('SELECT state,count(*)::text objects,COALESCE(sum(reserved_bytes),0)::text bytes FROM ac_storage_allocations GROUP BY state')).rows;
   metrics.push(gauge('storage_objects','Registered disposable spool objects; no filesystem scan.',metricStates.storage.map(state=>sample(storage.find(row=>row.state===state)?.objects??'0',{state}))));
   metrics.push(gauge('storage_reserved_bytes','Disposable spool accounting by state; deleted bytes are historical, not current usage.',metricStates.storage.map(state=>sample(storage.find(row=>row.state===state)?.bytes??'0',{state}))));
   return {clock,metrics};
  });
  let diskObservation:OperationalSnapshot['diskObservation']=this.diskPolicy?'observed':'not_configured';
  const available:MetricSample[]=[],total:MetricSample[]=[],observed:MetricSample[]=[],belowFloor:MetricSample[]=[];
  if(this.diskPolicy)for(const [index,path] of this.diskPolicy.paths.entries()){
   const labels={volume:'configured_'+index};
   try{
    const disk=await measureDiskCapacity(path);
    available.push(sample(String(disk.availableBytes),labels));total.push(sample(String(disk.totalBytes),labels));observed.push(sample(1,labels));
    belowFloor.push(sample(disk.availableBytes<BigInt(this.diskPolicy.minFreeBytes)+BigInt(this.diskPolicy.estimatedWriteBytes)?1:0,labels));
   }catch{observed.push(sample(0,labels));diskObservation='partially_unavailable';}
  }
  result.metrics.push(gauge('disk_observation_available','One when a fresh measurement exists. Missing measurements have no byte samples.',observed),
   gauge('disk_available_bytes','Bytes available to the collector UID on configured filesystems; paths are never labels.',available),
   gauge('disk_total_bytes','Reported capacity of configured filesystems.',total),
   gauge('disk_below_admission_floor','Fresh available bytes below configured floor plus one write estimate.',belowFloor));
  return {schemaVersion:1,scope:'installation_aggregate',observedAt:result.clock.toISOString(),databaseReadOnly:true,diskObservation,metrics:result.metrics};
 }
}

/** Same columns the context wait list already exposes, plus optional exclusions.
 * NULL (historical rows) omits the field. Profile ids stay off the aggregate snapshot. */
export type CapacityWaitView={
 attempt_id:string;resource_kind:string;role:string;reason:string|null;desired_profile:string|null;
 priority:number;sequence:string;exclusions?:ProfileExclusion[]};
const StoredExclusion=z.object({profileId:Id,reason:z.enum(CAPACITY_EXCLUSION_REASONS)}).strict();
export function capacityWaitExclusions(value:unknown):ProfileExclusion[]|undefined{
 if(value==null)return undefined;
 const parsed=z.array(StoredExclusion).safeParse(value);
 return parsed.success?parsed.data:undefined;
}
export async function readCapacityWaits(ledger:Ledger,principal:string,contextId:string):Promise<CapacityWaitView[]>{
 return ledger.tx(async c=>{
  await ledger.authorize(c,principal,Id.parse(contextId),false);
  const rows=(await c.query(`SELECT attempt_id,resource_kind,role,reason,desired_profile,priority,sequence::text AS sequence,exclusions
    FROM ac_capacity_waits WHERE context_id=$1 ORDER BY priority DESC,sequence`,[contextId])).rows;
  return rows.map(row=>{
   const view:CapacityWaitView={attempt_id:row.attempt_id,resource_kind:row.resource_kind,role:row.role,reason:row.reason,
    desired_profile:row.desired_profile,priority:Number(row.priority),sequence:String(row.sequence)};
   const exclusions=capacityWaitExclusions(row.exclusions);
   if(exclusions)view.exclusions=exclusions;
   return view;
  });
 });
}

export function prometheus(snapshot:OperationalSnapshot){
 const quote=(value:string)=>value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n');
 const lines:string[]=[];
 for(const metric of snapshot.metrics){
  if(!/^agent_control_[a-z_]+$/.test(metric.name))throw new Refusal('METRIC_NAME_INVALID');
  lines.push(`# HELP ${metric.name} ${metric.help}`,`# TYPE ${metric.name} gauge`);
  for(const row of metric.samples){
   const labels=Object.entries(row.labels).map(([key,value])=>{
    if(!/^[a-z_]+$/.test(key))throw new Refusal('METRIC_LABEL_INVALID');return `${key}="${quote(value)}"`;
   });
   lines.push(`${metric.name}${labels.length?'{'+labels.join(',')+'}':''} ${Decimal.parse(row.value)}`);
  }
 }
 return lines.join('\n')+'\n';
}
