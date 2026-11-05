import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {createProviderCollectorAdapter} from '../src/provider-collector-adapter.ts';
import {projectCapacitySelection} from '../src/control.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
test('R3 named synthetic chain records actual handoff causes, eligibility and healthy reserve drain in one context',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;assert(url);
 const database=await isolatedDatabase(url,'r3_chain'),db=new Ledger(database.url),capacity=new Capacity(db);
 try{
  await db.migrate();const principal='r3-chain-owner',project=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Explicit synthetic provider chain']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:10,evaluationLimit:2});
  const names=['grok','codex-programmer','gemini-antigravity','sonnet-antigravity','reserve'];
  const accounts=names.map(()=>randomUUID()),profiles=names.map(()=>randomUUID());
  let statuses=['available','available','available','available','available'];
  const adapters=names.map((provider,i)=>createSyntheticProviderAdapter({id:'fixture-'+provider,provider,version:'r3-v1',runner:async input=>({protocol:'ac-synthetic-quota-v1',provider,accountId:input.accountId,status:statuses[i],remainingPercent:statuses[i]==='available'?75:statuses[i]==='exhausted'?0:null,resetAt:null})}));
  const collectors=new ProviderCollectors(db,adapters);
  for(let i=0;i<names.length;i++){
   await capacity.registerModel(principal,{provider:names[i],model:'fixture-model',efforts:['medium'],roles:['programmer'],source:'synthetic://r3-chain'});
   await capacity.addAccount(principal,project,{id:accounts[i],provider:names[i],label:'Synthetic '+names[i],resourceIdentity:'r3-chain-'+accounts[i],mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://r3-chain',maxConcurrent:1});
   await capacity.addProfile(principal,project,{id:profiles[i],accountId:accounts[i],model:'fixture-model',effort:'medium',role:'programmer'});
   await collectors.bind(principal,project,{accountId:accounts[i],adapterId:adapters[i].manifest.id,expectedRevision:0,minimumIntervalSeconds:1});
  }
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:10,maxEvaluatorsPerContext:2,roles:{programmer:{regular:profiles.slice(0,4),emergency:[profiles[4]]}}});
  const context=await db.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,context,revision);
  const authority=await db.acquire(principal,context,randomUUID(),'synthetic-chain-manager',60),messageRef='encrypted:r3-provider-chain-stable';
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef}},authority,'api');
  const refresh=async()=>{await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");for(let i=0;i<accounts.length;i++)await collectors.collect(principal,project,accounts[i],randomUUID());};
  const reserve=async()=>capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},authority);
  const release=async(id:string)=>capacity.transition(principal,id,authority,'released',{state:'not_started',processId:'explicit-synthetic-task'});
  const evidence=async(id:string)=>{const row=(await db.pool.query('SELECT * FROM ac_capacity_grants WHERE id=$1',[id])).rows[0];return projectCapacitySelection(row)!;};
  await refresh();let grant=await reserve();assert.equal(grant.profile_id,profiles[0]);await release(grant.id);
  statuses[0]='exhausted';await refresh();grant=await reserve();assert.equal(grant.profile_id,profiles[1]);assert.deepEqual((await evidence(grant.id)).skippedCandidates,[{profileId:profiles[0],reason:'quota_exhausted'}]);await release(grant.id);
  // Exhaustion, authentication and transport are distinct fresh observations and causes.
  statuses[1]='auth_required';await refresh();grant=await reserve();assert.equal(grant.profile_id,profiles[2]);assert.deepEqual((await evidence(grant.id)).skippedCandidates,[{profileId:profiles[1],reason:'authentication_required'},{profileId:profiles[0],reason:'quota_exhausted'}]);await release(grant.id);
  statuses[2]='unreachable';await refresh();grant=await reserve();assert.equal(grant.profile_id,profiles[3]);assert.equal((await evidence(grant.id)).skippedCandidates?.[0].reason,'provider_unreachable');await release(grant.id);
  // A plausible official Antigravity success/usage capture must remain unknown.
  const unproven=createProviderCollectorAdapter({provider:'antigravity',runner:async()=>JSON.stringify({success:true,remaining:100})});
  const unknown=await unproven.probe({accountId:accounts[2],signal:new AbortController().signal});assert.equal(unknown.status,'unknown');assert.equal(unknown.remainingPercent,null);
  statuses[2]='unknown';statuses[3]='rate_limited';await refresh();
  const emergency=await reserve();assert.equal(emergency.profile_id,profiles[4]);assert.equal(emergency.emergency,true);
  const decision=await evidence(emergency.id);assert.equal(decision.chain,'emergency');assert.equal(decision.skippedCandidates?.[0].reason,'quota_rate_limited');assert(decision.skippedCandidates?.some(x=>x.profileId===profiles[2]&&x.reason==='quota_unknown'));
  await capacity.transition(principal,emergency.id,authority,'running');
  statuses[0]='available';await refresh();
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[emergency.id])).rows[0].state,'running');
  grant=await reserve();assert.equal(grant.profile_id,profiles[0]);assert.equal(grant.emergency,false);await release(grant.id);
  // Recovery never revokes a healthy running reserve; it only affects future work.
  await capacity.transition(principal,emergency.id,authority,'released',{state:'exited',processId:'synthetic-reserve'});
  statuses[1]='available';await refresh();grant=await reserve();assert.equal(grant.profile_id,profiles[0]);await release(grant.id);
  // Fresh quota does not override incompatible eligibility or rewrite its status to exhausted.
  await db.pool.query("UPDATE ac_accounts SET eligibility='requires_clarification' WHERE id=$1",[accounts[0]]);
  grant=await reserve();assert.equal(grant.profile_id,profiles[1]);assert.deepEqual((await evidence(grant.id)).skippedCandidates,[{profileId:profiles[0],reason:'ineligible'}]);await release(grant.id);
  assert.equal((await db.pool.query('SELECT status FROM ac_quota_observations WHERE account_id=$1',[accounts[0]])).rows[0].status,'available');
  const persisted=(await db.pool.query('SELECT command FROM ac_intents WHERE id=$1',[intent.id])).rows[0].command;assert.equal(persisted.payload.messageRef,messageRef);
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_capacity_grants WHERE context_id=$1 AND state<>'released'",[context])).rows[0].n,0);
 }finally{await db.close();await database.close();}
});
