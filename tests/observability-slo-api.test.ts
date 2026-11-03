import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import type {OperationalMetric,OperationalSnapshot} from '../src/observability.ts';
import {createObservabilityApi} from '../src/observability-api.ts';
import {SLO_IDS,type SloEvaluationReport} from '../src/slo-evaluation.ts';

const MANAGER_STATES=['leased','stale','missing'] as const;
const WAIT_REASONS=['NO_ELIGIBLE_CAPACITY','CAPACITY_QUEUED','CAPACITY_BUSY','ORIGINAL_RESERVE_NOT_NEEDED','GLOBAL_CAPACITY_LIMIT','CONTEXT_CAPACITY_LIMIT','ACCOUNT_CAPACITY_LIMIT','other'] as const;
const OPERATION_STATES=['registered','running','uncertain','completed','failed','integrated','rejected','canceled_confirmed','other'] as const;
const OPERATION_SCOPES=['implementation','stage','sandbox','remote','integration'] as const;

function gauge(name:string,samples:OperationalMetric['samples']):OperationalMetric{
 return {name,help:'fixture',type:'gauge',samples};
}
function labeled(name:string,key:string,labels:readonly string[],values:Record<string,string>={}){
 return gauge(name,labels.map(label=>({labels:{[key]:label},value:values[label]??'0'})));
}
function operations(scopes:readonly string[],byScope:Record<string,Record<string,string>>={}){
 return scopes.flatMap(scope=>OPERATION_STATES.map(state=>({labels:{scope,state},value:byScope[scope]?.[state]??'0'})));
}
function complete(observedAt:string,scopes:readonly string[]=OPERATION_SCOPES):OperationalSnapshot{
 return {
  schemaVersion:1,scope:'installation_aggregate',observedAt,databaseReadOnly:true,diskObservation:'not_configured',
  metrics:[
   labeled('agent_control_managers','state',MANAGER_STATES,{leased:'4'}),
   labeled('agent_control_capacity_waits','reason',WAIT_REASONS),
   gauge('agent_control_operations',operations(scopes,{implementation:{completed:'19',failed:'1'}})),
   gauge('agent_control_dispatch_oldest_pending_seconds',[{labels:{},value:'2'}]),
   gauge('agent_control_pending_receipt_oldest_seconds',[{labels:{},value:'3600'}]),
  ],
 };
}

function mount(snapshot:(principal:string)=>Promise<OperationalSnapshot|null>){
 const calls:string[]=[];
 const service={async snapshot(principal:string){calls.push(principal);return snapshot(principal) as Promise<OperationalSnapshot>;}};
 const app=new Hono<{Variables:{principal:string}}>();
 app.use('*',async(c,next)=>{const user=c.req.header('x-fixture-principal');if(user)c.set('principal',user);await next();});
 app.route('/api/v1/ac',createObservabilityApi(service));
 app.post('/api/v1/ac/auth/pair',c=>c.json({scope:'synthetic-public-pairing-route'}));
 return {app,calls};
}
function headers(principal?:string){return principal?{headers:{'x-fixture-principal':principal}}:{};}
async function bodyOf(response:Response){return await response.json() as SloEvaluationReport & {error?:string};}

test('SLO read requires a principal and does not call the service or intercept public pairing',async()=>{
 const {app,calls}=mount(async()=>complete(new Date().toISOString()));
 const denied=await app.request('/api/v1/ac/observability/slo');
 assert.equal(denied.status,401);
 assert.deepEqual(await denied.json(),{error:'AUTH_REQUIRED'});
 assert.equal(denied.headers.get('cache-control'),'no-store');
 assert.equal(denied.headers.get('x-content-type-options'),'nosniff');
 assert.equal(calls.length,0);
 assert.equal((await app.request('/api/v1/ac/auth/pair',{method:'POST'})).status,200);
});

test('a fresh complete snapshot returns the fixed evaluation report and is read-only',async()=>{
 const observedAt=new Date().toISOString();
 const {app,calls}=mount(async principal=>{assert.equal(principal,'admin-fixture');return complete(observedAt);});
 const response=await app.request('/api/v1/ac/observability/slo',headers('admin-fixture'));
 assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 assert.match(response.headers.get('content-type')??'',/application\/json/);
 const report=await bodyOf(response);
 assert.equal(report.schemaVersion,1);
 assert.equal(report.catalogVersion,1);
 assert.equal(report.scope,'installation_aggregate');
 assert.deepEqual(report.results.map(result=>result.id),[...SLO_IDS]);
 assert.deepEqual(report.results.map(result=>result.status),['ok','ok','ok','ok','ok']);
 for(const result of report.results){
  assert.equal(result.version,1);
  assert.equal(result.reason,'within_objective');
  assert.equal(result.window.kind,'snapshot_point');
  assert.equal(result.window.observedAt,observedAt);
  assert.ok(result.margin);
 }
 assert.deepEqual(calls,['admin-fixture']);
 for(const method of ['POST','PUT','PATCH','DELETE'] as const){
  const rejected=await app.request('/api/v1/ac/observability/slo',{method,headers:{'x-fixture-principal':'admin-fixture'}});
  assert.equal(rejected.status,404);
 }
 assert.deepEqual(calls,['admin-fixture']);
});

test('a partial or stale snapshot is unknown and never ok',async()=>{
 const partial=mount(async()=>complete(new Date().toISOString(),OPERATION_SCOPES.filter(scope=>scope!=='integration')));
 const partialResponse=await partial.app.request('/api/v1/ac/observability/slo',headers('admin-fixture'));
 assert.equal(partialResponse.status,200);
 const partialReport=await bodyOf(partialResponse);
 assert.deepEqual(partialReport.results.map(result=>result.status),['unknown','unknown','unknown','unknown','unknown']);
 assert.ok(partialReport.results.every(result=>result.status!=='ok'));
 assert.equal(partialReport.results.find(result=>result.id==='infrastructure_failure_rate')?.reason,'signal_incomplete');

 const stale=mount(async()=>complete(new Date(Date.now()-301_000).toISOString()));
 const staleResponse=await stale.app.request('/api/v1/ac/observability/slo',headers('admin-fixture'));
 assert.equal(staleResponse.status,200);
 const staleReport=await bodyOf(staleResponse);
 assert.deepEqual(staleReport.results.map(result=>result.status),['unknown','unknown','unknown','unknown','unknown']);
 assert.ok(staleReport.results.every(result=>result.reason==='snapshot_stale'&&result.margin===null&&result.status!=='ok'));
});

test('a snapshot failure is a generic 500 and never an ok report',async()=>{
 const thrown=mount(async()=>{throw new Error('DO_NOT_LEAK_DATABASE');});
 const failed=await thrown.app.request('/api/v1/ac/observability/slo',headers('admin-fixture'));
 const failedText=await failed.text();
 assert.equal(failed.status,500);
 assert.deepEqual(JSON.parse(failedText),{error:'OBSERVABILITY_UNAVAILABLE'});
 assert.equal(failed.headers.get('cache-control'),'no-store');
 assert.equal(failed.headers.get('x-content-type-options'),'nosniff');
 assert.equal(failedText.includes('DO_NOT_LEAK_DATABASE'),false);
 assert.equal(failedText.includes('"ok"'),false);

 const missing=mount(async()=>null);
 const empty=await missing.app.request('/api/v1/ac/observability/slo',headers('admin-fixture'));
 assert.equal(empty.status,500);
 assert.deepEqual(await empty.json(),{error:'OBSERVABILITY_UNAVAILABLE'});
});
