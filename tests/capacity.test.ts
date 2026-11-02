import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../src/ledger.ts';
import { Capacity, type CapacityPolicy } from '../src/capacity.ts';
import type { Authority, Command } from '../src/contracts.ts';
const url=process.env.AC_TEST_DATABASE_URL;
if (!url?.includes('/ac_implementation_test')) throw Error('ISOLATED_DATABASE_REQUIRED');
const db=new Ledger(url), other=new Ledger(url), service=new Capacity(db), second=new Capacity(other);
const principal='capacity-'+randomUUID(), project=randomUUID();
let context:string, authority:Authority, intentId:string;
const accounts=[randomUUID(),randomUUID(),randomUUID()], profiles=accounts.map(()=>randomUUID());
const policy:CapacityPolicy={schemaVersion:1,maxProgrammersPerContext:10,maxEvaluatorsPerContext:2,
  roles:{programmer:{regular:profiles.slice(0,2),emergency:[profiles[2]]}}};
before(async()=>{
 await db.migrate();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Capacity fixture']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,'reader','viewer')",[project,principal]);
 await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
 await service.configure(principal,{programmingLimit:128,evaluationLimit:128});
 await service.registerModel(principal,{provider:'synthetic-provider',model:'fixture-model',efforts:['medium'],roles:['programmer'],source:'synthetic://fixture'});
 for(let i=0;i<3;i++){
  await service.addAccount(principal,project,{id:accounts[i],provider:'synthetic-provider',label:'Fixture '+i,
   resourceIdentity:'fixture-resource-'+accounts[i],mode:'synthetic',eligibility:'documented_supported',
   eligibilitySource:'synthetic://test-fixture',maxConcurrent:1});
  await service.addProfile(principal,project,{id:profiles[i],accountId:accounts[i],model:'fixture-model',effort:'medium',role:'programmer'});
  await service.observeQuota(principal,accounts[i],{status:'available',source:'synthetic-fixture',ttlSeconds:3600});
 }
 const revision=await service.publish(principal,project,0,policy);
 context=await db.createContext(principal,project,randomUUID());
 authority=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
 await service.assignPolicy(principal,context,revision);
 const cmd:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
 action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:capacity-fixture'}};
 intentId=(await db.accept(principal,cmd,authority,'api')).id;
});
after(async()=>{await db.close();await other.close();});
const request=()=>({attemptId:randomUUID(),intentId,contextId:context,role:'programmer' as const});
const release=(id:string)=>service.transition(principal,id,authority,'released',{processId:'synthetic-never-started',state:'not_started'});

test('same subscription cannot be registered under another account alias; read-only members cannot change it',async()=>{
 await assert.rejects(service.addAccount(principal,project,{id:randomUUID(),provider:'synthetic-provider',label:'Alias',
 resourceIdentity:'fixture-resource-'+accounts[0],mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://fixture',maxConcurrent:1}),
 (e:unknown)=>typeof e==='object'&&e!==null&&'code' in e&&e.code==='23505');
 await assert.rejects(service.configure('reader',{programmingLimit:128,evaluationLimit:128}),/CONTROL_ADMIN_REQUIRED/);
 await assert.rejects(service.publish('reader',project,1,policy),/PROJECT_OWNER_REQUIRED/);
});
test('concurrent reservations across two PG clients share one account slot; same attempt deduplicates',async()=>{
 const requests=[request(),request()];
 const result=await Promise.allSettled([service.reserve(principal,requests[0],authority),second.reserve(principal,requests[1],authority)]);
 const successes=result.filter(r=>r.status==='fulfilled');assert.equal(successes.length,1);
 const index=result.findIndex(r=>r.status==='fulfilled');const success=successes[0];assert(success.status==='fulfilled');
 assert.equal((await second.reserve(principal,requests[index],authority)).id,success.value.id);
 await assert.rejects(service.reserve(principal,{...requests[index],role:'reviewer'},authority),/ATTEMPT_PAYLOAD_CONFLICT/);
 await release(success.value.id);
});
test('unknown quota is not availability; fallback stays regular after the earlier account recovers',async()=>{
 await service.observeQuota(principal,accounts[0],{status:'exhausted',source:'synthetic-fixture',ttlSeconds:3600});
 const fallback=await service.reserve(principal,request(),authority);assert.equal(fallback.account_id,accounts[1]);await release(fallback.id);
 await service.observeQuota(principal,accounts[0],{status:'available',source:'synthetic-fixture',ttlSeconds:3600});
 const sticky=await service.reserve(principal,request(),authority);assert.equal(sticky.account_id,accounts[1]);await release(sticky.id);
 for(const account of accounts)await service.observeQuota(principal,account,{status:'unknown',source:'synthetic-fixture',ttlSeconds:3600});
 await assert.rejects(service.reserve(principal,request(),authority),/NO_ELIGIBLE_CAPACITY/);
});
test('emergency yields future attempts when a regular account recovers, without disturbing an existing grant',async()=>{
 await service.observeQuota(principal,accounts[2],{status:'available',source:'synthetic-fixture',ttlSeconds:3600});
 const emergency=await service.reserve(principal,request(),authority);assert(emergency.emergency);
 await service.observeQuota(principal,accounts[0],{status:'available',source:'synthetic-fixture',ttlSeconds:3600});
 const regular=await service.reserve(principal,request(),authority);assert.equal(regular.account_id,accounts[0]);assert(!regular.emergency);
 assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[emergency.id])).rows[0].state,'reserved');
 await release(regular.id);await release(emergency.id);
});
test('uncertain processes hold their capacity, cannot be released on timeout, and require a trusted exit receipt',async()=>{
 const grant=await service.reserve(principal,request(),authority);
 await service.transition(principal,grant.id,authority,'running');
 await service.transition(principal,grant.id,authority,'uncertain');
 await assert.rejects(service.reserve(principal,request(),authority),/CAPACITY_BUSY/);
 await assert.rejects(service.transition(principal,grant.id,authority,'released'),/PHYSICAL_RECEIPT_REQUIRED/);
 await assert.rejects(service.transition(principal,grant.id,authority,'released',{processId:'fixture',state:'not_started'}),/PROCESS_MUST_EXIT/);
 await service.transition(principal,grant.id,authority,'released',{processId:'fixture-exited',state:'exited'});
});
test('published revisions remain immutable and an in-flight grant keeps its original policy',async()=>{
 const grant=await service.reserve(principal,request(),authority);
 const revision=await service.publish(principal,project,1,{...policy,maxProgrammersPerContext:1});
 assert.equal(revision,2);await service.assignPolicy(principal,context,revision);
 assert.equal((await db.pool.query('SELECT policy_revision FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].policy_revision,1);
 await assert.rejects(service.publish(principal,project,1,policy),/POLICY_CONFLICT/);
 await assert.rejects(db.pool.query("UPDATE ac_policy_revisions SET digest='forged' WHERE project_id=$1",[project]),/POLICY_REVISION_IMMUTABLE/);
 await release(grant.id);
});
test('old manager cannot reserve; successor cannot release an unreconciled old grant',async()=>{
 const grant=await service.reserve(principal,request(),authority);
 await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
 const successor=await db.acquire(principal,context,randomUUID(),'fixture-manager',60);
 await assert.rejects(service.reserve(principal,request(),authority),/STALE_MANAGER/);
 await assert.rejects(service.transition(principal,grant.id,successor,'released',{processId:'fixture',state:'exited'}),/GRANT_RECONCILIATION_REQUIRED/);
});
