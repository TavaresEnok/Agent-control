import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Usage} from '../src/usage.ts';
import {createApi} from '../src/api.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {UsageReport} from '../src/usage-report.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('authenticated usage report/export compares period deltas, preserves unknowns and paginates exact timestamps',async()=>{
 const url=process.env.AC_R3_USAGE_DATABASE_URL;if(!url?.endsWith('/ac_r3_usage'))throw Error('DISPOSABLE_R3_USAGE_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();
 try{
  const project=randomUUID(),principal='usage-'+randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Disposable usage']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const fixture=await provisionCapacity(db,principal,project),context=await db.createContext(principal,project,randomUUID());await fixture.service.assignPolicy(principal,context,fixture.revision);
  const a=await db.acquire(principal,context,randomUUID(),'synthetic-manager',60),usage=new Usage(db);
  const profile=(await db.pool.query('SELECT p.* FROM ac_profiles p JOIN ac_account_access x ON x.account_id=p.account_id WHERE x.project_id=$1',[project])).rows[0];
  const second=randomUUID();await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,'second-fixture','medium','reviewer')",[second,profile.account_id]);
  const make=async(created:string,profileId=profile.id)=>{
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:r3-usage-fixture'}},a,'api');
   const id=randomUUID();await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$11,$8,$9,1,'usage-fixture',false,'released',$10)`,[id,randomUUID(),intent.id,context,a.epoch,profile.account_id,profileId,project,fixture.revision,created,profileId===second?'reviewer':'programmer']);return {id,intent};
  };
  const observe=async(grantId:string,seq:number,at:string,input:number|null,output:number|null=0,cache:number|null=0,reasoning:number|null=null)=>{
   const event={grantId,eventId:randomUUID(),seq,counters:{input,output,cache,reasoning}};await usage.record(principal,a,event);assert.equal((await usage.record(principal,a,event)).duplicate,true);
   await db.pool.query('UPDATE ac_usage_observations SET observed_at=$3 WHERE grant_id=$1 AND seq=$2',[grantId,seq,at]);
  };
  const spanning=await make('2025-12-30T00:00:00Z');
  await observe(spanning.id,1,'2025-12-31T23:00:00Z',10,2,5,1);
  await observe(spanning.id,2,'2026-01-01T23:00:00Z',30,6,9,3);
  await observe(spanning.id,3,'2026-01-02T23:00:00Z',70,14,15,7);
  // Exact to boundary belongs to the next period, never this report.
  await observe(spanning.id,4,'2026-01-03T00:00:00Z',900,100,100,100);
  const created=await make('2026-01-02T01:00:00.123456Z');await observe(created.id,1,'2026-01-02T02:00:00Z',5,1,3,null);
  const missingBaseline=await make('2025-12-30T01:00:00Z',second);await observe(missingBaseline.id,1,'2026-01-02T02:00:00Z',50,5,1,null);
  await db.pool.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state,grant_id,started_at,finished_at) VALUES($1,$2,'review',$3,$4,1,'completed',$5,'2026-01-01T12:00:00Z','2026-01-02T12:00:00Z')`,[randomUUID(),missingBaseline.intent.id,randomUUID(),randomUUID(),missingBaseline.id]);
  const unreported=await make('2026-01-02T01:00:00.123457Z',second);
  // Persist an actual correction-decision relation in the fixture database.
  const artifact=randomUUID();await db.pool.query("INSERT INTO ac_quality_policies(project_id,revision,snapshot,digest) VALUES($1,1,'{}','fixture')",[project]);
  await db.pool.query(`INSERT INTO ac_artifacts(id,context_id,intent_id,implementation_grant_id,implementation_session_id,project_id,policy_revision,commit_id,tree_id,base_id,identity_digest,risk)
   VALUES($1,$2,$3,$4,$5,$6,1,$7,$7,$7,'fixture','low')`,[artifact,context,spanning.intent.id,spanning.id,randomUUID(),project,'a'.repeat(40)]);
  await db.pool.query(`INSERT INTO ac_managed_correction_decisions(parent_intent_id,context_id,task_id,revision,prior_intent_id,prior_artifact_id,failed_evidence_ids,prior_commit,prior_tree,base_id,next_intent_id,manager_epoch,decision_digest)
   VALUES($1,$2,'task',1,$1,$3,$4,$5,$5,$5,$6,1,$7)`,[spanning.intent.id,context,artifact,[randomUUID()],'a'.repeat(40),created.intent.id,'b'.repeat(64)]);
  await db.pool.query('UPDATE ac_profiles SET model=$2 WHERE id=$1',[profile.id,'\t=HYPERLINK("fixture")']);
  const runtime={projectId:project,executionMode:'synthetic',nativeExecutionReady:false} as unknown as CezarRuntime;
  const api=createApi(db,runtime,async request=>request.headers.get('authorization')==='Bearer fixture'?principal:request.headers.get('authorization')==='Bearer stranger'?'stranger':null,()=>undefined);
  const path=`/api/v1/ac/contexts/${context}/usage/report`,params=new URLSearchParams({from:'2026-01-02T00:00:00Z',to:'2026-01-03T00:00:00Z',limit:'1'});
  const get=(path:string,auth='Bearer fixture')=>api.request(path,{headers:{authorization:auth}});
  assert.equal((await api.request(path+'?'+params)).status,401);assert.equal((await get(path+'?'+params,'Bearer stranger')).status,403);
  const first=await get(path+'?'+params);assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
  const report=await first.json() as UsageReport;
  assert.equal(report.scope,'reported_attempt_usage_deltas');assert.equal(report.monetaryCost,'unknown');assert.equal(report.subscriptionBalance,'unknown');assert.equal(report.overlappingCounters,true);
  assert.equal(report.attempts.length,1);assert.ok(report.nextCursor);assert.equal(report.page.complete,false);
  assert.deepEqual(report.periods.previous,{from:'2026-01-01T00:00:00.000Z',to:'2026-01-02T00:00:00.000Z'});
  const base=report.comparison.find(row=>row.profileId===profile.id&&!row.rework)!;
  assert.equal(base.current.counters.input.completeTotal,'40');assert.equal(base.previous.counters.input.completeTotal,'20');assert.equal(base.delta.input,'20');
  const correction=report.comparison.find(row=>row.profileId===profile.id&&row.rework)!;
  assert.equal(correction.current.counters.input.completeTotal,'5');assert.equal(correction.current.counters.reasoning.completeTotal,null);
  const unknown=report.comparison.find(row=>row.profileId===second)!;
  assert.equal(unknown.current.counters.input.completeTotal,null);assert.equal(unknown.current.counters.input.unknownAttempts,2);assert.equal(unknown.delta.input,null);assert.equal(unknown.current.wallMilliseconds.knownSubtotal,'43200000');assert.equal(unknown.current.wallMilliseconds.unknownAttempts,1);assert.equal(unknown.previous.wallMilliseconds.completeTotal,'43200000');assert.equal(unknown.deltaWallMilliseconds,null);
  const ids:string[]=[],attempts=[];let current=report;
  for(let page=0;page<8;page++){
   ids.push(...current.attempts.map(row=>row.grantId));attempts.push(...current.attempts);
   if(!current.nextCursor)break;
   const next=new URLSearchParams(params);next.set('cursor',current.nextCursor);const response=await get(path+'?'+next);assert.equal(response.status,200);current=await response.json() as UsageReport;
   assert.deepEqual(current.comparison,report.comparison,'summaries cover full period independently of page');
  }
  assert.equal(current.page.complete,true);assert.equal(ids.length,4);assert.equal(new Set(ids).size,4);assert.ok(ids.includes(unreported.id));
  assert.equal(attempts.find(row=>row.grantId===missingBaseline.id)!.baseline,'missing');
  assert.deepEqual(attempts.find(row=>row.grantId===missingBaseline.id)!.time,{wallMilliseconds:'43200000',source:'stage_lifecycle_timestamps',activeModelMilliseconds:null});
  assert.equal(attempts.find(row=>row.grantId===created.id)!.counters.input,'5');
  const only=new URLSearchParams(params);only.set('rework','only');const onlyReport=await (await get(path+'?'+only)).json() as UsageReport;assert.deepEqual(onlyReport.attempts.map(row=>row.grantId),[created.id]);assert.equal(onlyReport.comparison.length,1);
  const profileFilter=new URLSearchParams(params);profileFilter.set('profileId',second);const filtered=await (await get(path+'?'+profileFilter)).json() as UsageReport;assert.equal(filtered.comparison.length,1);assert.equal(filtered.comparison[0].profileId,second);
  const altered=new URLSearchParams(params);altered.set('cursor',report.nextCursor!);altered.set('rework','only');assert.equal((await get(path+'?'+altered)).status,400);
  const csv=await get(path+'.csv?'+params),body=await csv.text();assert.equal(csv.status,200);assert.equal(csv.headers.get('x-usage-page-complete'),'false');assert.ok(csv.headers.get('x-next-cursor'));assert.match(csv.headers.get('content-disposition')!,/usage-page/);assert.match(body,/"'\t=HYPERLINK\(""fixture""\)"/);assert.match(body,/page_complete/);assert(!body.includes('subscription balance,'));
  for(const invalid of [new URLSearchParams({from:'2026-01-03T00:00:00Z',to:'2026-01-02T00:00:00Z'}),new URLSearchParams({from:'2025-01-01T00:00:00Z',to:'2026-01-03T00:00:00Z'}),new URLSearchParams({...Object.fromEntries(params),limit:'201'}),new URLSearchParams({...Object.fromEntries(params),profileId:"' OR 1=1 --"}),new URLSearchParams({...Object.fromEntries(params),cursor:'invalid'}),new URLSearchParams({...Object.fromEntries(params),unexpected:'field'})])assert.equal((await get(path+'?'+invalid)).status,400);
  // A second stage sharing one grant makes lifecycle time ambiguous; an old
  // running stage remains visible without any new usage observation.
  await db.pool.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state,grant_id,started_at,finished_at) VALUES($1,$2,'review',$3,$4,1,'completed',$5,'2026-01-02T01:00:00Z','2026-01-02T02:00:00Z')`,[randomUUID(),missingBaseline.intent.id,randomUUID(),randomUUID(),missingBaseline.id]);
  const running=await make('2025-12-01T00:00:00Z',second);
  await db.pool.query(`INSERT INTO ac_stage_operations(id,intent_id,node_id,session_id,attempt_id,manager_epoch,state,grant_id,started_at) VALUES($1,$2,'review',$3,$4,1,'running',$5,'2026-01-01T12:00:00Z')`,[randomUUID(),running.intent.id,randomUUID(),randomUUID(),running.id]);
  const openUnreported=await make('2025-12-01T00:00:00Z',second);await db.pool.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[openUnreported.id]);
  const allParams=new URLSearchParams(params);allParams.set('limit','200');const finalReport=await (await get(path+'?'+allParams)).json() as UsageReport;
  assert.equal(finalReport.attempts.find(row=>row.grantId===openUnreported.id)!.counters.input,null);
  assert.equal(finalReport.consistency,'per_request_snapshot');
  assert.equal(finalReport.attempts.find(row=>row.grantId===missingBaseline.id)!.time.wallMilliseconds,null);
  assert.deepEqual(finalReport.attempts.find(row=>row.grantId===running.id)!.time,{wallMilliseconds:null,source:'unknown',activeModelMilliseconds:null});
  const wrongProject=createApi(db,{...runtime,projectId:randomUUID()} as CezarRuntime,async()=>principal,()=>undefined);assert.equal((await wrongProject.request(path+'?'+params)).status,403);
 }finally{await db.close();}
});
