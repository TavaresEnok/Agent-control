import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import type {OperationalMetric,OperationalSnapshot} from '../src/observability.ts';
import {evaluateOperationalSlos,SLO_IDS,SLO_OBJECTIVES,SLO_SIGNALS,type SloEvaluation,type SloId} from '../src/slo-evaluation.ts';

const NOW='2026-11-03T12:00:00.000Z';
const SECRET='DO_NOT_EXPORT_principal@example.com /secret/path token';
const WAIT_REASONS=['NO_ELIGIBLE_CAPACITY','CAPACITY_QUEUED','CAPACITY_BUSY','ORIGINAL_RESERVE_NOT_NEEDED','GLOBAL_CAPACITY_LIMIT','CONTEXT_CAPACITY_LIMIT','ACCOUNT_CAPACITY_LIMIT','other'] as const;

function quoted(block:string){return [...block.matchAll(/'([^']+)'/g)].map(match=>match[1]!);}
function source(name:string){return readFileSync(new URL(`../src/${name}`,import.meta.url),'utf8');}
/** Scopes and states the collector actually emits. The evaluator copy is checked
 * against this parse so a fixture cannot invent a shorter closed series. */
function collectorOperationSeries(){
 const collector=source('observability.ts');
 const states=collector.match(/operations:\[([^\]]+)\]/);
 const loop=collector.match(/for\(const \[scope,table\] of \[([\s\S]*?)\] as const\)/);
 if(!states||!loop)throw new Error('collector operation series not found');
 const stateLabels=quoted(states[1]!);
 const pairs=quoted(loop[1]!);
 if(pairs.length===0||pairs.length%2!==0||stateLabels.length===0)throw new Error('collector operation series malformed');
 return {scopes:pairs.filter((_,index)=>index%2===0),states:stateLabels};
}
function evaluatorOperationSeries(){
 const evaluator=source('slo-evaluation.ts');
 const states=evaluator.match(/const OPERATION_STATES=\[([^\]]+)\]/);
 const scopes=evaluator.match(/const OPERATION_SCOPES=\[([^\]]+)\]/);
 if(!states||!scopes)throw new Error('evaluator operation series not found');
 return {scopes:quoted(scopes[1]!),states:quoted(states[1]!)};
}
const COLLECTOR_SERIES=collectorOperationSeries();

function gauge(name:string,samples:OperationalMetric['samples'],help=SECRET):OperationalMetric{
 return {name,help,type:'gauge',samples};
}
function states(name:string,key:string,labels:readonly string[],values:Record<string,string>={}){
 return gauge(name,labels.map(label=>({labels:{[key]:label},value:values[label]??'0'})));
}
function managers(values:Record<string,string>={}){return states('agent_control_managers','state',['leased','stale','missing'],values);}
function waits(values:Record<string,string>={}){return states('agent_control_capacity_waits','reason',WAIT_REASONS,values);}
function closedOperations(byScope:Record<string,Record<string,string>>={}){
 return COLLECTOR_SERIES.scopes.flatMap(scope=>COLLECTOR_SERIES.states.map(state=>({
  labels:{scope,state},value:byScope[scope]?.[state]??'0',
 })));
}
function bare(name:string,value:string){return gauge(name,[{labels:{},value}]);}
function snapshot(metrics:OperationalMetric[],observedAt=NOW,patch?:Partial<OperationalSnapshot>):OperationalSnapshot{
 return {schemaVersion:1,scope:'installation_aggregate',observedAt,databaseReadOnly:true,diskObservation:'not_configured',metrics,...patch};
}
function healthy(extra:OperationalMetric[]=[]):OperationalSnapshot{
 return snapshot([
  managers({leased:'4'}),
  waits(),
  gauge('agent_control_operations',closedOperations({implementation:{completed:'19',failed:'1'}})),
  ...extra,
 ]);
}
function at(report:ReturnType<typeof evaluateOperationalSlos>,id:SloId){
 const found=report.results.find(result=>result.id===id);
 assert.ok(found);
 return found;
}
function shift(ms:number){return new Date(Date.parse(NOW)+ms).toISOString();}
function statuses(report:ReturnType<typeof evaluateOperationalSlos>){return report.results.map(result=>result.status);}

test('the evaluator requires every scope and state the collector emits',()=>{
 assert.deepEqual(evaluatorOperationSeries(),COLLECTOR_SERIES);
 assert.ok(COLLECTOR_SERIES.scopes.length>1);
 assert.equal(COLLECTOR_SERIES.scopes[0],'implementation');
 assert.ok(COLLECTOR_SERIES.states.includes('failed'));
 assert.ok(COLLECTOR_SERIES.states.includes('other'));
});

test('versioned objectives meet on a fresh closed-label snapshot and omit sensitive text',()=>{
 const report=evaluateOperationalSlos(healthy([
  bare(SLO_SIGNALS.dispatch_latency.metric,String(SLO_OBJECTIVES.dispatchLatencyMaxSeconds)),
  bare(SLO_SIGNALS.pending_receipt_age.metric,String(SLO_OBJECTIVES.pendingReceiptAgeMaxSeconds)),
 ]),{now:NOW});
 assert.deepEqual(report.results.map(result=>result.id),[...SLO_IDS]);
 assert.deepEqual(statuses(report),['ok','ok','ok','ok','ok']);
 for(const result of report.results){
  assert.equal(result.version,1);
  assert.equal(result.reason,'within_objective');
  assert.deepEqual(result.window,{kind:'snapshot_point',freshnessLimitSeconds:SLO_OBJECTIVES.freshnessLimitSeconds,observedAt:NOW,ageSeconds:'0'});
 }
 assert.equal(at(report,'queue_backlog').margin?.headroom,String(SLO_OBJECTIVES.queueBacklogMaxCount));
 for(const id of SLO_IDS)if(id!=='queue_backlog')assert.equal(at(report,id).margin?.headroom,'0');
 assert.equal(report.schemaVersion,1);
 assert.equal(report.catalogVersion,1);
 assert.equal(at(report,'manager_availability').margin?.unit,'ppm');
 assert.equal(at(report,'queue_backlog').margin?.unit,'count');
 assert.equal(at(report,'dispatch_latency').margin?.unit,'seconds');
 assert.equal(at(report,'infrastructure_failure_rate').margin?.unit,'ppm');
 const encoded=JSON.stringify(report);
 assert.equal(encoded.includes(SECRET),false);
 assert.equal(encoded.includes('agent_control_'),false);
 assert.equal(encoded.includes('@'),false);
});

test('collector snapshots without duration gauges stay unknown for those SLOs only',()=>{
 const report=evaluateOperationalSlos(healthy(),{now:NOW});
 assert.equal(at(report,'manager_availability').status,'ok');
 assert.equal(at(report,'queue_backlog').status,'ok');
 assert.equal(at(report,'infrastructure_failure_rate').status,'ok');
 assert.deepEqual(at(report,'dispatch_latency'),{id:'dispatch_latency',version:1,status:'unknown',reason:'required_signal_absent',margin:null,window:at(report,'manager_availability').window});
 assert.equal(at(report,'pending_receipt_age').reason,'required_signal_absent');
 assert.equal(SLO_SIGNALS.dispatch_latency.collector,'not_emitted');
 assert.equal(SLO_SIGNALS.pending_receipt_age.collector,'not_emitted');
 assert.equal(SLO_SIGNALS.manager_availability.collector,'emitted');
});

test('objectives miss by a deterministic margin without treating quality rejections as infrastructure failures',()=>{
 const report=evaluateOperationalSlos(snapshot([
  managers({leased:'1',missing:'1'}),
  waits({CAPACITY_QUEUED:String(SLO_OBJECTIVES.queueBacklogMaxCount+1)}),
  gauge('agent_control_operations',closedOperations({
   implementation:{failed:'1',completed:'18',rejected:'1000',running:'500'},
   sandbox:{failed:'999'},
  })),
  bare(SLO_SIGNALS.dispatch_latency.metric,String(SLO_OBJECTIVES.dispatchLatencyMaxSeconds+1)),
  bare(SLO_SIGNALS.pending_receipt_age.metric,String(SLO_OBJECTIVES.pendingReceiptAgeMaxSeconds+1)),
 ]),{now:NOW});
 assert.deepEqual(statuses(report),['violated','violated','violated','violated','violated']);
 const marginOf=(id:SloId)=>at(report,id).margin?.headroom;
 assert.equal(marginOf('manager_availability'),'-500000');
 assert.equal(marginOf('dispatch_latency'),'-1');
 assert.equal(marginOf('queue_backlog'),'-1');
 assert.equal(marginOf('pending_receipt_age'),'-1');
 assert.equal(marginOf('infrastructure_failure_rate'),'-2631');
 for(const result of report.results)assert.equal(result.reason,'objective_missed');
});

test('rejections and in-flight work do not dilute or create an infrastructure rate',()=>{
 const diluted=evaluateOperationalSlos(snapshot([
  managers({leased:'1'}),waits(),
  gauge('agent_control_operations',closedOperations({implementation:{failed:'5',rejected:'1000'}})),
 ]),{now:NOW});
 assert.equal(at(diluted,'infrastructure_failure_rate').status,'violated');
 assert.equal(at(diluted,'infrastructure_failure_rate').margin?.headroom,'-950000');
 const onlyRejections=evaluateOperationalSlos(snapshot([
  managers({leased:'1'}),waits(),
  gauge('agent_control_operations',closedOperations({implementation:{rejected:'40',running:'7'}})),
 ]),{now:NOW});
 assert.equal(at(onlyRejections,'infrastructure_failure_rate').status,'unknown');
 assert.equal(at(onlyRejections,'infrastructure_failure_rate').reason,'no_population');
 assert.equal(at(onlyRejections,'infrastructure_failure_rate').margin,null);
 const successes=evaluateOperationalSlos(snapshot([
  managers({leased:'1'}),waits(),
  gauge('agent_control_operations',closedOperations({implementation:{completed:'10',integrated:'9',rejected:'80',uncertain:'4'}})),
 ]),{now:NOW});
 assert.equal(at(successes,'infrastructure_failure_rate').status,'ok');
 assert.equal(at(successes,'infrastructure_failure_rate').margin?.headroom,'50000');
});

test('absent, stale, ahead, incomplete, empty, and unclassified snapshots are never ok',()=>{
 const absent=evaluateOperationalSlos(null,{now:'not-a-clock'});
 assert.deepEqual(statuses(absent),['unknown','unknown','unknown','unknown','unknown']);
 assert.equal(at(absent,'manager_availability').reason,'snapshot_absent');
 assert.equal(at(absent,'manager_availability').margin,null);
 assert.equal(at(absent,'manager_availability').window.ageSeconds,null);
 assert.deepEqual(evaluateOperationalSlos(undefined,{now:NOW}).results.map(result=>result.reason),absent.results.map(result=>result.reason));

 const stale=evaluateOperationalSlos(healthy([
  bare(SLO_SIGNALS.dispatch_latency.metric,'999'),
  bare(SLO_SIGNALS.pending_receipt_age.metric,'999'),
 ]),{now:shift(301_000)});
 assert.deepEqual(statuses(stale),['unknown','unknown','unknown','unknown','unknown']);
 assert.equal(at(stale,'dispatch_latency').reason,'snapshot_stale');
 assert.equal(at(stale,'dispatch_latency').window.ageSeconds,'301');
 assert.equal(at(stale,'dispatch_latency').margin,null);

 const boundary=evaluateOperationalSlos(healthy(),{now:shift(300_000)});
 assert.equal(at(boundary,'manager_availability').status,'ok');
 assert.equal(at(boundary,'manager_availability').window.ageSeconds,'300');

 const ahead=evaluateOperationalSlos(healthy(),{now:new Date(Date.parse(NOW)-1)});
 assert.equal(at(ahead,'queue_backlog').reason,'snapshot_clock_ahead');
 assert.equal(at(ahead,'queue_backlog').status,'unknown');
 assert.equal(at(ahead,'queue_backlog').window.ageSeconds,null);

 const brokenTime=evaluateOperationalSlos(snapshot([managers({leased:'1'}),waits(),gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}}))], '2026-11-03T12:00:00Z'),{now:NOW});
 assert.equal(at(brokenTime,'manager_availability').reason,'snapshot_timestamp_invalid');
 assert.equal(statuses(brokenTime).includes('ok'),false);

 const emptyManagers=evaluateOperationalSlos(snapshot([managers(),waits(),gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}}))]),{now:NOW});
 assert.equal(at(emptyManagers,'manager_availability').reason,'no_population');
 assert.equal(at(emptyManagers,'manager_availability').status,'unknown');

 const missingSeries=evaluateOperationalSlos(snapshot([gauge('agent_control_managers',[{labels:{state:'leased'},value:'1'}]),waits(),gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}}))]),{now:NOW});
 assert.equal(at(missingSeries,'manager_availability').reason,'signal_incomplete');
 assert.equal(at(missingSeries,'manager_availability').status,'unknown');
 assert.equal(at(missingSeries,'queue_backlog').status,'unknown');
 assert.equal(at(missingSeries,'queue_backlog').reason,'snapshot_incomplete');
 assert.equal(at(missingSeries,'queue_backlog').margin,null);
 assert.equal(at(missingSeries,'infrastructure_failure_rate').reason,'snapshot_incomplete');
 assert.equal(statuses(missingSeries).includes('ok'),false);
 const missingEmitted=evaluateOperationalSlos(snapshot([waits(),gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}}))]),{now:NOW});
 assert.equal(at(missingEmitted,'manager_availability').reason,'required_signal_absent');
 assert.equal(at(missingEmitted,'queue_backlog').status,'unknown');
 assert.equal(at(missingEmitted,'queue_backlog').reason,'snapshot_incomplete');
 assert.equal(statuses(missingEmitted).includes('ok'),false);
 const partialAndMissed=evaluateOperationalSlos(snapshot([
  gauge('agent_control_managers',[{labels:{state:'leased'},value:'1'}]),
  waits({CAPACITY_QUEUED:String(SLO_OBJECTIVES.queueBacklogMaxCount+1)}),
  gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}})),
 ]),{now:NOW});
 assert.equal(at(partialAndMissed,'manager_availability').reason,'signal_incomplete');
 assert.equal(at(partialAndMissed,'queue_backlog').status,'violated');
 assert.equal(at(partialAndMissed,'queue_backlog').reason,'objective_missed');
 assert.equal(at(partialAndMissed,'infrastructure_failure_rate').status,'unknown');
 assert.equal(at(partialAndMissed,'infrastructure_failure_rate').reason,'snapshot_incomplete');
 assert.equal(statuses(partialAndMissed).includes('ok'),false);

 const unclassified=evaluateOperationalSlos(snapshot([
  gauge('agent_control_managers',[
   {labels:{state:'leased'},value:'3'},
   {labels:{state:'stale'},value:'0'},
   {labels:{state:'missing'},value:'0'},
   {labels:{state:'DO_NOT_EXPORT_TOKEN'},value:'9'},
  ]),
  waits(),
  gauge('agent_control_operations',closedOperations({implementation:{completed:'1',other:'2'}})),
  gauge(SLO_SIGNALS.dispatch_latency.metric,[{labels:{state:'DO_NOT_EXPORT_TOKEN'},value:'0'}]),
 ]),{now:NOW});
 assert.equal(at(unclassified,'manager_availability').reason,'unclassified_samples');
 assert.equal(at(unclassified,'dispatch_latency').reason,'unclassified_samples');
 assert.equal(at(unclassified,'infrastructure_failure_rate').reason,'unclassified_samples');
 assert.equal(at(unclassified,'queue_backlog').status,'unknown');
 assert.equal(at(unclassified,'queue_backlog').reason,'snapshot_incomplete');
 assert.equal(at(unclassified,'queue_backlog').margin,null);
 assert.equal(JSON.stringify(unclassified).includes('DO_NOT_EXPORT_TOKEN'),false);
 assert.equal(statuses(unclassified).includes('ok'),false);

 const dirty=snapshot([
  managers({leased:'9'}),waits(),gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}})),
  gauge('agent_control_disk_available_bytes',[{labels:{volume:'configured_0'},value:'1'.repeat(19)}]),
 ]);
 const incomplete=evaluateOperationalSlos(dirty,{now:NOW});
 assert.deepEqual(statuses(incomplete),['unknown','unknown','unknown','unknown','unknown']);
 assert.equal(at(incomplete,'manager_availability').reason,'snapshot_incomplete');
 assert.equal(JSON.stringify(incomplete).includes('1'.repeat(19)),false);

 const leaked=evaluateOperationalSlos(snapshot([
  gauge('agent_control_managers',[{labels:{account:'DO_NOT_EXPORT_ACCOUNT'},value:'1'}]),
 ]),{now:NOW});
 assert.equal(at(leaked,'manager_availability').reason,'snapshot_incomplete');
 assert.equal(JSON.stringify(leaked).includes('DO_NOT_EXPORT_ACCOUNT'),false);
 assert.equal(JSON.stringify(leaked).includes(SECRET),false);

 const blank=evaluateOperationalSlos({} as OperationalSnapshot,{now:NOW});
 assert.equal(at(blank,'pending_receipt_age').reason,'snapshot_incomplete');
 assert.equal(statuses(blank).includes('ok'),false);
 const wrongScope=evaluateOperationalSlos(snapshot([managers({leased:'1'})],NOW,{scope:'DO_NOT_EXPORT_SCOPE' as OperationalSnapshot['scope']}),{now:NOW});
 assert.equal(at(wrongScope,'manager_availability').reason,'snapshot_incomplete');
 assert.equal(JSON.stringify(wrongScope).includes('DO_NOT_EXPORT_SCOPE'),false);
 assert.equal(at(evaluateOperationalSlos(snapshot([managers({leased:'1'})],NOW,{databaseReadOnly:false as true}),{now:NOW}),'manager_availability').reason,'snapshot_incomplete');
 assert.equal(at(evaluateOperationalSlos(snapshot([managers({leased:'1'})],NOW,{schemaVersion:2 as 1}),{now:NOW}),'manager_availability').reason,'snapshot_incomplete');
 assert.equal(at(evaluateOperationalSlos(snapshot([managers({leased:'1'})],NOW,{diskObservation:'DO_NOT_EXPORT_DISK' as OperationalSnapshot['diskObservation']}),{now:NOW}),'manager_availability').reason,'snapshot_incomplete');
 assert.equal(at(evaluateOperationalSlos(healthy(),{now:'2026-13-03T12:00:00.000Z'}),'manager_availability').reason,'evaluation_clock_invalid');
 assert.equal(at(evaluateOperationalSlos(healthy(),{now:new Date(Number.NaN)}),'manager_availability').reason,'evaluation_clock_invalid');
});

test('duplicate or non-decimal series and missing queue reasons do not become zero or ok',()=>{
 const duplicated=evaluateOperationalSlos(snapshot([
  managers({leased:'1'}),managers({leased:'1'}),waits(),gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}})),
 ]),{now:NOW});
 assert.equal(at(duplicated,'queue_backlog').reason,'snapshot_incomplete');
 const badValue=evaluateOperationalSlos(snapshot([
  gauge('agent_control_managers',[{labels:{state:'leased'},value:'1.5'},{labels:{state:'stale'},value:'0'},{labels:{state:'missing'},value:'0'}]),
 ]),{now:NOW});
 assert.equal(at(badValue,'manager_availability').reason,'snapshot_incomplete');
 const negative=evaluateOperationalSlos(snapshot([
  bare(SLO_SIGNALS.dispatch_latency.metric,'-1'),managers({leased:'1'}),waits(),gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}})),
 ]),{now:NOW});
 assert.equal(at(negative,'dispatch_latency').status,'unknown');
 const droppedReason=evaluateOperationalSlos(snapshot([
  managers({leased:'1'}),
  gauge('agent_control_capacity_waits',WAIT_REASONS.filter(reason=>reason!=='other').map(reason=>({labels:{reason},value:'0'}))),
  gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}})),
 ]),{now:NOW});
 assert.equal(at(droppedReason,'queue_backlog').reason,'signal_incomplete');
 assert.equal(at(droppedReason,'queue_backlog').status,'unknown');
 const repeated=evaluateOperationalSlos(snapshot([
  gauge('agent_control_managers',[
   {labels:{state:'leased'},value:'1'},{labels:{state:'leased'},value:'1'},
   {labels:{state:'stale'},value:'0'},{labels:{state:'missing'},value:'0'},
  ]),
  waits(),gauge('agent_control_operations',closedOperations({implementation:{completed:'1'}})),
 ]),{now:NOW});
 assert.equal(at(repeated,'manager_availability').reason,'signal_incomplete');
});

test('a truncated or partial operation series is never ok',()=>{
 const durations=[
  bare(SLO_SIGNALS.dispatch_latency.metric,'0'),
  bare(SLO_SIGNALS.pending_receipt_age.metric,'0'),
 ];
 const full=closedOperations({implementation:{completed:'19',failed:'1'}});
 const expectWithheld=(samples:OperationalMetric['samples'])=>{
  const report=evaluateOperationalSlos(snapshot([
   managers({leased:'4'}),waits(),gauge('agent_control_operations',samples),...durations,
  ]),{now:NOW});
  assert.equal(statuses(report).includes('ok'),false);
  assert.equal(at(report,'infrastructure_failure_rate').status,'unknown');
  assert.equal(at(report,'infrastructure_failure_rate').reason,'signal_incomplete');
  assert.equal(at(report,'infrastructure_failure_rate').margin,null);
  for(const id of SLO_IDS){
   if(id==='infrastructure_failure_rate')continue;
   assert.equal(at(report,id).status,'unknown');
   assert.equal(at(report,id).reason,'snapshot_incomplete');
   assert.equal(at(report,id).margin,null);
  }
  assert.equal(JSON.stringify(report).includes(SECRET),false);
 };
 expectWithheld(full.filter(sample=>sample.labels.scope==='implementation'));
 for(const scope of COLLECTOR_SERIES.scopes){
  expectWithheld(full.filter(sample=>sample.labels.scope!==scope));
  for(const state of COLLECTOR_SERIES.states){
   expectWithheld(full.filter(sample=>!(sample.labels.scope===scope&&sample.labels.state===state)));
  }
 }
});

test('the same snapshot and clock always yield the same report',()=>{
 const metrics=healthy([
  bare(SLO_SIGNALS.dispatch_latency.metric,'1'),
  bare(SLO_SIGNALS.pending_receipt_age.metric,'10'),
 ]).metrics;
 const reversed:OperationalSnapshot=snapshot([...metrics].reverse().map(metric=>({...metric,samples:[...metric.samples].reverse()})));
 const first=evaluateOperationalSlos(snapshot(metrics),{now:NOW});
 const second=evaluateOperationalSlos(reversed,{now:new Date(Date.parse(NOW))});
 assert.deepEqual(first,second);
 assert.deepEqual(evaluateOperationalSlos(snapshot(metrics),{now:NOW}),first);
 const omitted=evaluateOperationalSlos(snapshot(metrics,shift(-86_400_000)));
 assert.deepEqual(omitted,evaluateOperationalSlos(snapshot(metrics),{}));
 assert.equal(at(omitted,'manager_availability').reason,'evaluation_clock_invalid');
 assert.equal(statuses(omitted).includes('ok'),false);
});

test('exact failure ratio and millisecond age decide before the displayed rounding',()=>{
 const rate=(failed:string,completed:string)=>at(evaluateOperationalSlos(snapshot([
  managers({leased:'1'}),waits(),
  gauge('agent_control_operations',closedOperations({implementation:{failed,completed}})),
 ]),{now:NOW}),'infrastructure_failure_rate');
 const exact=rate('1','19');
 assert.equal(exact.status,'ok');
 assert.equal(exact.margin?.headroom,'0');
 const hidden=rate('50001','950000');
 assert.equal(hidden.status,'violated');
 assert.equal(hidden.reason,'objective_missed');
 assert.equal(hidden.margin?.headroom,'-1');
 const under=rate('50000','950001');
 assert.equal(under.status,'ok');
 assert.equal(under.reason,'within_objective');
 assert.equal(under.margin?.headroom,'1');

 const fractional=evaluateOperationalSlos(healthy([
  bare(SLO_SIGNALS.dispatch_latency.metric,'0'),
  bare(SLO_SIGNALS.pending_receipt_age.metric,'0'),
 ]),{now:shift(300_999)});
 assert.equal(statuses(fractional).includes('ok'),false);
 assert.equal(at(fractional,'manager_availability').reason,'snapshot_stale');
 assert.equal(at(fractional,'infrastructure_failure_rate').window.ageSeconds,'300');
 const plusMillisecond=evaluateOperationalSlos(healthy(),{now:shift(300_001)});
 assert.equal(at(plusMillisecond,'queue_backlog').status,'unknown');
 assert.equal(at(plusMillisecond,'queue_backlog').reason,'snapshot_stale');
 assert.equal(at(plusMillisecond,'queue_backlog').window.ageSeconds,'300');
});
