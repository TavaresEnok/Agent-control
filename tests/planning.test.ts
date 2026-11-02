import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {compileManagerPlan,ManagerPlans,type ManagerPlan,type ManagerTask} from '../src/planning.ts';
import {digest} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {Hono} from 'hono';
import {createPlanningApi} from '../src/planning-api.ts';
import {Refusal} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {graphIssues,forkShape} from '../upstream/cezar/packages/cezar/dist/workflows/graph.js';
const policy={schemaVersion:1 as const,requiredReviews:2,allowLowRiskQaWaiver:false,requireJudge:true,requireHumanIntegration:true,
 verifierDigest:'a'.repeat(64)};
const task=(id:string,dependsOn:string[]=[],writePaths=[`src/${id}`]):ManagerTask=>({id,objectiveRef:`message:${id}`,acceptanceRefs:[`acceptance:${id}`],
 inputRefs:dependsOn.map(dep=>`output:${dep}`),outputRefs:[`output:${id}`],dependsOn,writePaths,qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:2});
const plan=(contextId:string=randomUUID()):ManagerPlan=>({schemaVersion:1,contextId,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:['message:no-deploy'],
 tasks:[task('api'),task('web'),task('docs'),task('release',['api','web','docs'])]});

test('manager contracts compile deterministic native fork/join with all quality stages and no shell capability',()=>{
 const original=plan(),compiled=compileManagerPlan(original,[{qualityRevision:1,policy}]);
 assert.deepEqual(compiled,compileManagerPlan({...original,tasks:[...original.tasks]},[{qualityRevision:1,policy}]));
 assert.equal(compiled.admission,'managed-delivery-adapter-required');
 assert.deepEqual(compiled.batches,[['api','docs','web'],['release']]);
 assert.deepEqual(graphIssues(compiled.workflow.graph!),[]);
 const fork=forkShape(compiled.workflow.graph!,'ac-fork-0');assert.notEqual(typeof fork,'string');
 if(typeof fork!=='string'){assert.equal(fork.wait,'all');assert.equal(fork.branches.length,3);}
 for(const task of original.tasks){const binding=compiled.bindings.filter(b=>b.taskId===task.id);
  assert.deepEqual(binding.map(b=>b.role),['programmer','qa','reviewer','reviewer','judge','integrator']);
  assert.equal(new Set(binding.map(b=>b.nodeId)).size,6);assert(binding.every(b=>b.freshSession&&b.qualityRevision===1&&b.artifactSource===`task-${task.id}-programmer`));
 }
 assert(!compiled.workflow.graph!.nodes.some(n=>'command' in n||'runner' in n||'session' in n));
 const wide={...original,tasks:Array.from({length:8},(_,i)=>task(`task${i}`))};
 assert.deepEqual(compileManagerPlan(wide,[{qualityRevision:1,policy}]).batches.map(b=>b.length),[4,4]);
 const collision={...original,tasks:[task('api',[],['src']),task('web',[],['src/web'])]};
 assert.deepEqual(compileManagerPlan(collision,[{qualityRevision:1,policy}]).batches,[['api'],['web']]);
});

test('manager proposals reject cycles, omitted data dependencies, missing policies and arbitrary capabilities',()=>{
 const initial=plan();
 assert.throws(()=>compileManagerPlan({...initial,tasks:[task('a',['b']),task('b',['a'])]},[{qualityRevision:1,policy}]),/PLAN_DEPENDENCY_CYCLE/);
 assert.throws(()=>compileManagerPlan({...initial,tasks:[task('a'),{...task('b'),inputRefs:['output:a']}]},[{qualityRevision:1,policy}]),/PLAN_UNDECLARED_INPUT_DEPENDENCY/);
 assert.throws(()=>compileManagerPlan({...initial,tasks:[task('a'),{...task('b'),outputRefs:['output:a']}]},[{qualityRevision:1,policy}]),/PLAN_AMBIGUOUS_OUTPUT/);
 assert.throws(()=>compileManagerPlan({...initial,tasks:[task('a',['missing'])]},[{qualityRevision:1,policy}]),/PLAN_INVALID_DEPENDENCY/);
 assert.throws(()=>compileManagerPlan(initial,[]),/QUALITY_POLICY_REQUIRED/);
 assert.throws(()=>compileManagerPlan({...initial,tasks:[{...task('a'),command:'touch /outside'}]},[{qualityRevision:1,policy}]));
 assert.throws(()=>compileManagerPlan({...initial,tasks:[{...task('a'),writePaths:['../outside']}]},[{qualityRevision:1,policy}]));
 assert.throws(()=>compileManagerPlan({...initial,tasks:[{...task('a'),maxCorrections:6}]},[{qualityRevision:1,policy}]));
});

test('PG proposals are fenced, versioned, immutable, idempotent and never enqueue effects',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'planning'),db=new Ledger(isolated.url);
 try{
  await db.migrate();const project=randomUUID(),principal='plan-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Manager planning synthetic fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[project,policy,digest(policy)]);
  const service=new ManagerPlans(db),original=plan(contextId),first=await service.publish(principal,authority,0,original);
  assert.equal(first.revision,1);assert.deepEqual(await service.publish(principal,authority,0,original),first);
  const changed={...original,constraintRefs:[...original.constraintRefs,'decision:updated']};
  await assert.rejects(service.publish(principal,authority,0,changed),/MANAGER_PLAN_REVISION_CONFLICT/);
  assert.equal((await service.publish(principal,authority,1,changed)).revision,2);
  const saved=await service.read(principal,contextId,2);assert.equal(saved.parentRevision,1);assert.equal(saved.epoch,authority.epoch);
  assert.equal(saved.digest,digest(changed));assert.equal(saved.compilation.admission,'managed-delivery-adapter-required');
  await assert.rejects(db.pool.query('UPDATE ac_manager_plans SET snapshot=$2 WHERE context_id=$1',[contextId,original]),/FROZEN_PLAN_IMMUTABLE/);
  await assert.rejects(service.read('stranger',contextId,1),/CONTEXT_FORBIDDEN/);
  const viewer='viewer-'+randomUUID();await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[project,viewer]);
  assert.equal((await service.read(viewer,contextId,1)).revision,1);
  await assert.rejects(service.publish(viewer,authority,2,changed),/CONTEXT_FORBIDDEN/);
  await db.pause(principal,contextId,true);await assert.rejects(service.publish(principal,authority,2,changed),/HUMAN_PAUSED/);
  await db.pause(principal,contextId,false);
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[contextId]);
  const successor=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  await assert.rejects(service.publish(principal,authority,2,changed),/STALE_MANAGER/);
  const next=await service.publish(principal,successor,2,changed);assert.equal(next.revision,3);
  const http=new Hono<{Variables:{principal:string}}>();
  http.use('*',async(c,next)=>{if(c.req.header('authorization')==='Bearer fixture-only')c.set('principal',principal);await next();});
  http.onError((error,c)=>error instanceof Refusal?c.json({error:error.code},error.status):c.json({error:'INVALID_CONTRACT'},400));
  http.route('/api/v1/ac',createPlanningApi(db,project,id=>id===contextId?successor:undefined));
  http.post('/api/v1/ac/auth/session',c=>c.json({publicFixture:true}));
  assert.equal((await http.request('/api/v1/ac/auth/session',{method:'POST'})).status,200,'proposal middleware must not intercept the public login ingress');
  const path=`/api/v1/ac/contexts/${contextId}/manager-plans`,headers={authorization:'Bearer fixture-only','content-type':'application/json'};
  assert.equal((await http.request(path)).status,401);
  const listed=await http.request(path,{headers});assert.equal(listed.status,200);
  assert.equal((await listed.json()).proposals.length,3);assert.equal(listed.headers.get('cache-control'),'no-store');
  const viewed=await http.request(path+'/1',{headers});assert.equal(viewed.status,200);
  assert.equal((await viewed.json()).compilation.admission,'managed-delivery-adapter-required');
  const submitted=await http.request(path,{method:'POST',headers,body:JSON.stringify({expectedRevision:3,plan:changed})});
  assert.equal(submitted.status,201);assert.equal((await submitted.json()).revision,4);
  assert.equal((await http.request(path,{method:'POST',headers,body:JSON.stringify({expectedRevision:4,plan:changed,authority:successor})})).status,400);
  assert.equal((await http.request(path,{method:'POST',headers,body:' '.repeat(128*1024+1)})).status,400);
  const comparison=await http.request(path+'/1/compare/4',{headers});assert.equal(comparison.status,200);
  const difference=await comparison.json();assert.equal(difference.executionImpact,'proposal-only');assert.equal(difference.constraintsChanged,true);
  const restored=await http.request(path+'/1/restore',{method:'POST',headers,body:JSON.stringify({expectedRevision:4})});
  assert.equal(restored.status,201);assert.equal((await restored.json()).revision,5);
  assert.equal((await service.read(principal,contextId,5)).digest,first.digest);
  assert.equal((await service.restore(principal,successor,4,1)).revision,5);
  await assert.rejects(service.restore(principal,successor,4,2),/MANAGER_PLAN_REVISION_CONFLICT/);
  const changedTasks={...changed,tasks:changed.tasks.map(task=>task.id==='api'?{...task,objectiveRef:'message:new-api',writePaths:['src/api-v2']}:task)};
  assert.equal((await service.publish(principal,successor,5,changedTasks)).revision,6);
  const contractDiff=await service.compare(principal,contextId,1,6);
  assert.deepEqual(contractDiff.changed,[{taskId:'api',fields:['objectiveRef','writePaths']}]);
  assert.equal((await db.pool.query("SELECT detail->>'restoredFromRevision' source FROM ac_audit WHERE context_id=$1 AND kind='manager.plan.proposed' AND detail->>'revision'='5'",[contextId])).rows[0].source,'1');
  await db.pause(principal,contextId,true);await assert.rejects(service.restore(principal,successor,6,1),/HUMAN_PAUSED/);await db.pause(principal,contextId,false);

  const stranger=randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[stranger,'Other project fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[stranger,principal]);
  const foreignContext=await db.createContext(principal,stranger,randomUUID());
  assert.equal((await http.request(`/api/v1/ac/contexts/${foreignContext}/manager-plans`,{headers})).status,403);

  for(const table of ['ac_intents','ac_operations','ac_capacity_grants','ac_outbox'])assert.equal(Number((await db.pool.query(`SELECT count(*) count FROM ${table}`)).rows[0].count),0);
 }finally{await db.close();await isolated.close();}
});
