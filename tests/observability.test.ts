import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Hono} from 'hono';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {OperationalObservability,prometheus} from '../src/observability.ts';
import {createObservabilityApi} from '../src/observability-api.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('administrator telemetry is read-only, bounded-label aggregates and distinguishes unavailable disk/quota',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'telemetry'),ledger=new Ledger(database.url),capacity=new Capacity(ledger);
 const principal='DO_NOT_EXPORT_PRINCIPAL-'+randomUUID(),project=randomUUID(),account=randomUUID(),profile=randomUUID();
 const path=await mkdtemp(join(tmpdir(),'DO_NOT_EXPORT_DISK-'));
 try{
  await ledger.migrate();await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'DO_NOT_EXPORT_PROJECT']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:2,evaluationLimit:2});
  await capacity.registerModel(principal,{provider:'synthetic-observation',model:'worker',efforts:['medium'],roles:['programmer'],source:'synthetic://fixture'});
  await capacity.addAccount(principal,project,{id:account,provider:'synthetic-observation',label:'DO_NOT_EXPORT_ACCOUNT',resourceIdentity:account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://DO_NOT_EXPORT_SOURCE',maxConcurrent:1});
  await capacity.addProfile(principal,project,{id:profile,accountId:account,model:'worker',effort:'medium',role:'programmer'});
  await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://DO_NOT_EXPORT_QUOTA',ttlSeconds:60});
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:2,maxEvaluatorsPerContext:2,roles:{programmer:{regular:[profile],emergency:[]}}});
  const context=await ledger.createContext(principal,project,randomUUID()),authority=await ledger.acquire(principal,context,randomUUID(),'DO_NOT_EXPORT_MANAGER',60);
  await capacity.assignPolicy(principal,context,revision);
  const intent=await ledger.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:DO_NOT_EXPORT_MESSAGE'}},authority,'api');
  const grant=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},authority);
  await capacity.transition(principal,grant.id,authority,'uncertain');
  await assert.rejects(capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},authority));
  // Synthetic immutable recipe and child records exercise classification without
  // launching workers or changing capacity admission.
  const children=['task','composition','waiting','unmatched'].map(kind=>({kind,id:randomUUID(),operation:randomUUID(),run:randomUUID(),attempt:randomUUID(),unit:`DO_NOT_EXPORT_UNIT_${kind}`}));
  await ledger.pool.query(`INSERT INTO ac_manager_plans(context_id,revision,manager_epoch,manager_instance_id,principal_id,digest,snapshot,compilation_digest,compilation)
   VALUES($1,1,$2,$3,$4,$5,'{}',$5,'{}')`,[context,authority.epoch,randomUUID(),principal,'0'.repeat(64)]);
  const recipe={units:children.filter(child=>child.kind!=='unmatched').map(child=>({id:child.unit,intentId:child.id,operationId:child.operation,attemptId:child.attempt,kind:child.kind==='task'?'task':'composition'}))};
  await ledger.pool.query('INSERT INTO ac_managed_executions VALUES($1,$2,1,$3,$3,$4)',[intent.id,context,'0'.repeat(64),recipe]);
  for(const child of children){
   await ledger.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id)
    VALUES($1,$2,$3,'fixture','{}',$4,$5,$6,$7,$8,$9)`,[child.id,context,principal,child.operation,child.run,authority.epoch,intent.plan_revision,intent.id,child.unit]);
   await ledger.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch,execution_attempt_id) VALUES($1,$2,'registered',$3,$4)",[child.operation,child.id,authority.epoch,child.attempt]);
  }
  for(const child of [children[0]!,children[1]!,children[3]!]){
   const childGrant=randomUUID();
   await ledger.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
    SELECT $1,$2,$3,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,'fixture',emergency,'reserved'
    FROM ac_capacity_grants WHERE id=$4`,[childGrant,child.attempt,child.id,grant.id]);
   await ledger.pool.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1',[child.operation,childGrant]);
  }
  const waiting=children[2]!;
  await ledger.pool.query(`INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,reason)
   VALUES($1,$2,$3,'programmer','fixture',$4,'CAPACITY_BUSY')`,[waiting.attempt,context,waiting.id,authority.epoch]);
  await ledger.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second'");
  await ledger.pool.query("UPDATE ac_quota_observations SET observed_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '1 minute'");
  const before=(await ledger.pool.query('SELECT count(*)::int total FROM ac_audit')).rows[0].total;
  const service=new OperationalObservability(ledger,{diskPolicy:{schemaVersion:1,paths:[path,path+'-missing'],minFreeBytes:1_000_000_000_000,estimatedWriteBytes:1024}});
  const snapshot=await service.snapshot(principal);
  const value=(name:string,labels:Record<string,string>)=>snapshot.metrics.find(row=>row.name==='agent_control_'+name)?.samples.find(row=>Object.entries(labels).every(([key,value])=>row.labels[key]===value))?.value;
  assert.equal(value('grants',{state:'uncertain'}),'1');
  assert.equal(value('managed_programmer_grants',{kind:'task_implementation',state:'reserved'}),'1');
  assert.equal(value('managed_programmer_grants',{kind:'git_composition',state:'reserved'}),'1');
  assert.equal(value('managed_programmer_grants',{kind:'unclassified',state:'reserved'}),'1');
  assert.equal(value('managed_programmer_capacity_waits',{kind:'git_composition',reason:'CAPACITY_BUSY'}),'1');
  assert.equal(value('managers',{state:'stale'}),'1');
  assert.equal(value('quota_accounts',{state:'unknown'}),'1');assert.equal(value('quota_accounts',{state:'available'}),'0');
  assert.equal(value('disk_observation_available',{volume:'configured_0'}),'1');assert.equal(value('disk_observation_available',{volume:'configured_1'}),'0');
  assert.equal(value('disk_below_admission_floor',{volume:'configured_0'}),'1');assert.equal(value('disk_available_bytes',{volume:'configured_1'}),undefined);
  assert.equal(snapshot.diskObservation,'partially_unavailable');assert.equal(snapshot.databaseReadOnly,true);
  const json=JSON.stringify(snapshot),text=prometheus(snapshot);
  for(const privateValue of ['DO_NOT_EXPORT',principal,project,account,context,grant.id,path]){assert(!json.includes(privateValue));assert(!text.includes(privateValue));}
  assert.match(text,/agent_control_grants\{state="uncertain"\} 1/);
  const app=new Hono<{Variables:{principal:string}}>();
  app.use('*',async(c,next)=>{const user=c.req.header('x-fixture-principal');if(user)c.set('principal',user);await next();});
  app.route('/api/v1/ac',createObservabilityApi(service));
  app.post('/api/v1/ac/auth/pair',c=>c.json({scope:'synthetic-public-pairing-route'}));
  assert.equal((await app.request('/api/v1/ac/auth/pair',{method:'POST'})).status,200,'mounted metrics middleware must not intercept public auth routes');
  assert.equal((await app.request('/api/v1/ac/observability')).status,401);
  assert.equal((await app.request('/api/v1/ac/metrics',{headers:{'x-fixture-principal':'viewer-fixture'}})).status,403);
  const response=await app.request('/api/v1/ac/metrics',{headers:{'x-fixture-principal':principal}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-type')!,/version=0\.0\.4/);
  assert(!(await response.text()).includes('DO_NOT_EXPORT'));
  assert.equal((await ledger.pool.query('SELECT count(*)::int total FROM ac_audit')).rows[0].total,before);
  assert.equal((await ledger.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'uncertain');
 }finally{await ledger.close();await database.close();await rm(path,{recursive:true,force:true});}
});
