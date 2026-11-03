import type {OperationalSnapshot} from './observability.ts';

/** Point-in-time SLO evaluation over one OperationalSnapshot.
 * No collection, alerts, database, or label export. Missing, stale, and
 * incomplete observations stay unknown and never pass. A partial or
 * unclassified closed series withholds ok from every SLO. Operation samples
 * are complete only when every scope the collector emits has every closed
 * state. Total absence of a duration gauge the collector does not emit stays
 * local to that SLO. */
export const SLO_EVALUATION_VERSION=1 as const;
export const SLO_IDS=['manager_availability','dispatch_latency','queue_backlog','pending_receipt_age','infrastructure_failure_rate'] as const;
export type SloId=(typeof SLO_IDS)[number];
export type SloStatus='ok'|'violated'|'unknown';
export type SloReason='within_objective'|'objective_missed'|'snapshot_absent'|'snapshot_incomplete'|'snapshot_stale'|'snapshot_clock_ahead'|'snapshot_timestamp_invalid'|'evaluation_clock_invalid'|'required_signal_absent'|'signal_incomplete'|'unclassified_samples'|'no_population'|'value_invalid';
export type SloMargin={unit:'ppm'|'count'|'seconds';headroom:string};
export type SloWindow={kind:'snapshot_point';freshnessLimitSeconds:number;observedAt:string|null;ageSeconds:string|null};
export type SloEvaluation={id:SloId;version:1;status:SloStatus;reason:SloReason;margin:SloMargin|null;window:SloWindow};
export type SloEvaluationReport={schemaVersion:1;catalogVersion:1;scope:'installation_aggregate';results:SloEvaluation[]};

/** Bench objectives, version 1. Not a homologated production target.
 * Pass/fail compares the exact ratio with the limit. The displayed ppm
 * headroom then uses floor division. Headroom is signed: >= 0 meets the
 * objective. A fractional miss that floor would hide is reported as -1. */
export const SLO_OBJECTIVES=Object.freeze({
 catalogVersion:SLO_EVALUATION_VERSION,
 freshnessLimitSeconds:300,
 managerAvailabilityMinPpm:1_000_000,
 dispatchLatencyMaxSeconds:2,
 queueBacklogMaxCount:100,
 pendingReceiptAgeMaxSeconds:3_600,
 infrastructureFailureMaxPpm:50_000,
 infrastructureScope:'implementation' as const,
});

/** Gauges this catalog reads. The collector emits the closed-label series.
 * Duration gauges are not emitted today; their absence is unknown, not ok. */
export const SLO_SIGNALS=Object.freeze({
 manager_availability:Object.freeze({metric:'agent_control_managers',collector:'emitted' as const}),
 dispatch_latency:Object.freeze({metric:'agent_control_dispatch_oldest_pending_seconds',collector:'not_emitted' as const}),
 queue_backlog:Object.freeze({metric:'agent_control_capacity_waits',collector:'emitted' as const}),
 pending_receipt_age:Object.freeze({metric:'agent_control_pending_receipt_oldest_seconds',collector:'not_emitted' as const}),
 infrastructure_failure_rate:Object.freeze({metric:'agent_control_operations',collector:'emitted' as const}),
});

const MANAGER_STATES=['leased','stale','missing'] as const;
const WAIT_REASONS=['NO_ELIGIBLE_CAPACITY','CAPACITY_QUEUED','CAPACITY_BUSY','ORIGINAL_RESERVE_NOT_NEEDED','GLOBAL_CAPACITY_LIMIT','CONTEXT_CAPACITY_LIMIT','ACCOUNT_CAPACITY_LIMIT','other'] as const;
/** Closed labels copied from src/observability.ts metricStates.operations and
 * from the collector loop that emits one full state series per scope. Tests
 * parse that source and reject a divergent copy. The rate still reads only
 * infrastructureScope; the other scopes are not added into it. */
const OPERATION_STATES=['registered','running','uncertain','completed','failed','integrated','rejected','canceled_confirmed','other'] as const;
const OPERATION_SCOPES=['implementation','stage','sandbox','remote','integration'] as const;
const LABEL_KEYS=new Set(['state','resource_kind','scope','reason','role','kind','volume']);
const INSTANT=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECIMAL=/^\d{1,18}$/;
const LABEL_VALUE=/^[A-Za-z0-9_]{1,64}$/;
const MAX_METRICS=64;
const MAX_SAMPLES=256;

type Sample={labels:Record<string,string>;value:string};
type Gauge={samples:Sample[]};
type SignalFailure={ok:false;reason:Extract<SloReason,'required_signal_absent'|'signal_incomplete'|'unclassified_samples'|'value_invalid'>};
type ClosedRead={ok:true;values:Map<string,bigint>}|SignalFailure;

function emptyWindow():SloWindow{return {kind:'snapshot_point',freshnessLimitSeconds:SLO_OBJECTIVES.freshnessLimitSeconds,observedAt:null,ageSeconds:null};}
function parseInstant(value:string){
 if(!INSTANT.test(value))return null;
 const ms=Date.parse(value);
 if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)return null;
 return ms;
}
function margin(unit:SloMargin['unit'],headroom:bigint):SloMargin{return {unit,headroom:headroom.toString()};}
function ppm(numerator:bigint,denominator:bigint){return (numerator*1_000_000n)/denominator;}
function row(id:SloId,status:SloStatus,reason:SloReason,sloMargin:SloMargin|null,window:SloWindow):SloEvaluation{
 return {id,version:1,status,reason,margin:sloMargin,window};
}
function unknownReport(reason:SloReason,window:SloWindow):SloEvaluationReport{
 return {schemaVersion:1,catalogVersion:1,scope:'installation_aggregate',results:SLO_IDS.map(id=>row(id,'unknown',reason,null,window))};
}
function keysOf(labels:Record<string,string>){return Object.keys(labels).sort();}
function sameKeys(labels:Record<string,string>,expected:readonly string[]){
 const keys=keysOf(labels);
 return keys.length===expected.length&&[...expected].sort().every((key,index)=>key===keys[index]);
}
function closed(label:string,expected:readonly string[]){return expected.some(item=>item===label);}

function record(value:unknown){return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;}
function parseSnapshot(snapshot:unknown):{ok:true;metrics:Map<string,Gauge>}|{ok:false}{
 const body=record(snapshot);
 if(!body)return {ok:false};
 if(body.schemaVersion!==1||body.scope!=='installation_aggregate'||body.databaseReadOnly!==true)return {ok:false};
 if(body.diskObservation!=='not_configured'&&body.diskObservation!=='observed'&&body.diskObservation!=='partially_unavailable')return {ok:false};
 if(!Array.isArray(body.metrics)||body.metrics.length>MAX_METRICS)return {ok:false};
 const metrics=new Map<string,Gauge>();
 for(const entry of body.metrics){
  const metric=record(entry);
  if(!metric||typeof metric.name!=='string'||!/^agent_control_[a-z0-9_]+$/.test(metric.name)||metric.type!=='gauge')return {ok:false};
  if(metrics.has(metric.name)||!Array.isArray(metric.samples)||metric.samples.length>MAX_SAMPLES)return {ok:false};
  const samples:Sample[]=[];
  for(const entrySample of metric.samples){
   const sample=record(entrySample);
   if(!sample||typeof sample.value!=='string'||!DECIMAL.test(sample.value))return {ok:false};
   const rawLabels=record(sample.labels);
   if(!rawLabels)return {ok:false};
   const labels:Record<string,string>={};
   for(const [key,value] of Object.entries(rawLabels)){
    if(!LABEL_KEYS.has(key)||typeof value!=='string'||!LABEL_VALUE.test(value))return {ok:false};
    labels[key]=value;
   }
   if(Object.keys(labels).length>4)return {ok:false};
   samples.push({labels,value:sample.value});
  }
  metrics.set(metric.name,{samples});
 }
 return {ok:true,metrics};
}

function readClosed(metric:Gauge|undefined,labelKey:string,expected:readonly string[]):ClosedRead{
 if(!metric)return {ok:false,reason:'required_signal_absent'};
 const values=new Map<string,bigint>();
 for(const sample of metric.samples){
  if(!sameKeys(sample.labels,[labelKey]))return {ok:false,reason:'signal_incomplete'};
  const label=sample.labels[labelKey]!;
  if(!closed(label,expected))return {ok:false,reason:'unclassified_samples'};
  if(values.has(label))return {ok:false,reason:'signal_incomplete'};
  values.set(label,BigInt(sample.value));
 }
 for(const label of expected)if(!values.has(label))return {ok:false,reason:'signal_incomplete'};
 return {ok:true,values};
}

function readBareSeconds(metric:Gauge|undefined):{ok:true;seconds:bigint}|SignalFailure{
 if(!metric)return {ok:false,reason:'required_signal_absent'};
 if(metric.samples.length!==1)return {ok:false,reason:'signal_incomplete'};
 const sample=metric.samples[0]!;
 if(Object.keys(sample.labels).length!==0)return {ok:false,reason:'unclassified_samples'};
 return {ok:true,seconds:BigInt(sample.value)};
}

function readOperations(metric:Gauge|undefined):{ok:true;values:Map<string,bigint>}|SignalFailure{
 if(!metric)return {ok:false,reason:'required_signal_absent'};
 const seen=new Map<string,bigint>();
 for(const sample of metric.samples){
  if(!sameKeys(sample.labels,['scope','state']))return {ok:false,reason:'signal_incomplete'};
  const scope=sample.labels.scope!,state=sample.labels.state!;
  if(!closed(scope,OPERATION_SCOPES)||!closed(state,OPERATION_STATES))return {ok:false,reason:'unclassified_samples'};
  const identity=`${scope}\u0000${state}`;
  if(seen.has(identity))return {ok:false,reason:'signal_incomplete'};
  seen.set(identity,BigInt(sample.value));
 }
 // Every collector scope is required. A series that only closes implementation
 // is incomplete. Missing and partial scopes are not zeros.
 for(const scope of OPERATION_SCOPES){
  for(const state of OPERATION_STATES){
   if(!seen.has(`${scope}\u0000${state}`))return {ok:false,reason:'signal_incomplete'};
  }
 }
 const values=new Map<string,bigint>();
 for(const state of OPERATION_STATES)values.set(state,seen.get(`${SLO_OBJECTIVES.infrastructureScope}\u0000${state}`)!);
 return {ok:true,values};
}

function compareLower(id:SloId,observed:bigint,limit:bigint,unit:SloMargin['unit'],window:SloWindow):SloEvaluation{
 const headroom=limit-observed;
 return row(id,headroom>=0n?'ok':'violated',headroom>=0n?'within_objective':'objective_missed',margin(unit,headroom),window);
}

/** Reasons that make the snapshot incomplete for the whole catalog.
 * `required_signal_absent` counts only when the collector emits that gauge.
 * Duration gauges are not emitted yet, so their absence does not withhold ok. */
const BLOCKS_CATALOG_OK=new Set<SloReason>(['signal_incomplete','unclassified_samples','value_invalid']);

function catalogWithholdsOk(results:SloEvaluation[]){
 return results.some(result=>BLOCKS_CATALOG_OK.has(result.reason)||(result.reason==='required_signal_absent'&&SLO_SIGNALS[result.id].collector==='emitted'));
}

function withholdOk(results:SloEvaluation[]){
 if(!catalogWithholdsOk(results))return results;
 return results.map(result=>result.status==='ok'?row(result.id,'unknown','snapshot_incomplete',null,result.window):result);
}

function evaluateParsed(metrics:Map<string,Gauge>,window:SloWindow):SloEvaluation[]{
 const manager=readClosed(metrics.get(SLO_SIGNALS.manager_availability.metric),'state',MANAGER_STATES);
 const latency=readBareSeconds(metrics.get(SLO_SIGNALS.dispatch_latency.metric));
 const queue=readClosed(metrics.get(SLO_SIGNALS.queue_backlog.metric),'reason',WAIT_REASONS);
 const receipts=readBareSeconds(metrics.get(SLO_SIGNALS.pending_receipt_age.metric));
 const operations=readOperations(metrics.get(SLO_SIGNALS.infrastructure_failure_rate.metric));
 const results:SloEvaluation[]=[];

 if(!manager.ok)results.push(row('manager_availability','unknown',manager.reason,null,window));
 else{
  const total=MANAGER_STATES.reduce((sum,state)=>sum+manager.values.get(state)!,0n);
  if(total===0n)results.push(row('manager_availability','unknown','no_population',null,window));
  else{
   const observed=ppm(manager.values.get('leased')!,total);
   const headroom=observed-BigInt(SLO_OBJECTIVES.managerAvailabilityMinPpm);
   results.push(row('manager_availability',headroom>=0n?'ok':'violated',headroom>=0n?'within_objective':'objective_missed',margin('ppm',headroom),window));
  }
 }

 if(!latency.ok)results.push(row('dispatch_latency','unknown',latency.reason,null,window));
 else results.push(compareLower('dispatch_latency',latency.seconds,BigInt(SLO_OBJECTIVES.dispatchLatencyMaxSeconds),'seconds',window));

 if(!queue.ok)results.push(row('queue_backlog','unknown',queue.reason,null,window));
 else{
  const total=WAIT_REASONS.reduce((sum,reason)=>sum+queue.values.get(reason)!,0n);
  results.push(compareLower('queue_backlog',total,BigInt(SLO_OBJECTIVES.queueBacklogMaxCount),'count',window));
 }

 if(!receipts.ok)results.push(row('pending_receipt_age','unknown',receipts.reason,null,window));
 else results.push(compareLower('pending_receipt_age',receipts.seconds,BigInt(SLO_OBJECTIVES.pendingReceiptAgeMaxSeconds),'seconds',window));

 if(!operations.ok)results.push(row('infrastructure_failure_rate','unknown',operations.reason,null,window));
 else if(operations.values.get('other')!==0n)results.push(row('infrastructure_failure_rate','unknown','unclassified_samples',null,window));
 else{
  const failures=operations.values.get('failed')!;
  const successes=operations.values.get('completed')!+operations.values.get('integrated')!;
  const denominator=failures+successes;
  if(denominator===0n)results.push(row('infrastructure_failure_rate','unknown','no_population',null,window));
  else{
   // Status uses the exact ratio. Floor(ppm) is only the displayed distance:
   // 50001/1000001 is above 50000 ppm, while floor(ppm) is still 50000.
   const limit=BigInt(SLO_OBJECTIVES.infrastructureFailureMaxPpm);
   const scaled=failures*1_000_000n;
   let headroom=limit-(scaled/denominator);
   if(scaled>limit*denominator&&headroom>=0n)headroom=-1n;
   results.push(row('infrastructure_failure_rate',headroom>=0n?'ok':'violated',headroom>=0n?'within_objective':'objective_missed',margin('ppm',headroom),window));
  }
 }
 // A partial, unclassified, or missing emitted series is an incomplete snapshot.
 // That SLO keeps its own reason. Every other SLO that would have been ok becomes
 // unknown. Violated and no_population stay. Not-yet-emitted duration gauges do not.
 return withholdOk(results);
}

function clockMs(now:string|Date|undefined){
 if(now instanceof Date){const ms=now.getTime();return Number.isFinite(ms)?{ok:true as const,ms}:{ok:false as const};}
 if(typeof now!=='string')return {ok:false as const};
 const ms=parseInstant(now);
 return ms===null?{ok:false as const}:{ok:true as const,ms};
}

/** Evaluates the versioned catalog against one snapshot. `now` is required and
 * is the only clock. The function does not read labels into the report and
 * does not treat a missing series as zero. Overlapping operation scopes are
 * not added. */
export function evaluateOperationalSlos(snapshot:OperationalSnapshot|null|undefined,options?:{now?:string|Date}):SloEvaluationReport{
 if(snapshot==null)return unknownReport('snapshot_absent',emptyWindow());
 const clock=clockMs(options?.now);
 if(!clock.ok)return unknownReport('evaluation_clock_invalid',emptyWindow());
 const parsed=parseSnapshot(snapshot);
 const observedAt=typeof snapshot.observedAt==='string'?snapshot.observedAt:null;
 const observedMs=observedAt===null?null:parseInstant(observedAt);
 if(!parsed.ok)return unknownReport('snapshot_incomplete',{...emptyWindow(),observedAt:observedMs===null?null:observedAt});
 if(observedMs===null||observedAt===null)return unknownReport('snapshot_timestamp_invalid',emptyWindow());
 if(observedMs>clock.ms)return unknownReport('snapshot_clock_ahead',{kind:'snapshot_point',freshnessLimitSeconds:SLO_OBJECTIVES.freshnessLimitSeconds,observedAt,ageSeconds:null});
 const delta=clock.ms-observedMs;
 const age=Math.floor(delta/1000);
 const window:SloWindow={kind:'snapshot_point',freshnessLimitSeconds:SLO_OBJECTIVES.freshnessLimitSeconds,observedAt,ageSeconds:String(age)};
 // 300.999s must be stale. Compare the millisecond delta before flooring the displayed age.
 if(delta>SLO_OBJECTIVES.freshnessLimitSeconds*1000)return unknownReport('snapshot_stale',window);
 return {schemaVersion:1,catalogVersion:1,scope:'installation_aggregate',results:evaluateParsed(parsed.metrics,window)};
}
