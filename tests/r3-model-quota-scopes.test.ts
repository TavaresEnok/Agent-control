import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {ProviderCollectors,type ProviderProbeResult} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {projectCapacitySelection} from '../src/control.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
test('R3 shared physical account enforces exact model quota scopes and one physical capacity cap',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;assert(url);const isolated=await isolatedDatabase(url,'r3_scopes'),db=new Ledger(isolated.url),capacity=new Capacity(db);
 try{
  await db.migrate();const principal='r3-scopes-owner',project=randomUUID(),account=randomUUID(),profiles=[randomUUID(),randomUUID()],models=['gemini-fixture','sonnet-fixture'];
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'R3 shared-account synthetic scopes']);await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);await capacity.configure(principal,{programmingLimit:10,evaluationLimit:2});
  await capacity.addAccount(principal,project,{id:account,provider:'antigravity-fixture',label:'One physical fixture account',resourceIdentity:'r3-shared-'+account,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://r3-model-scopes',maxConcurrent:1});
  for(let i=0;i<2;i++){await capacity.registerModel(principal,{provider:'antigravity-fixture',model:models[i],efforts:['medium'],roles:['programmer'],source:'synthetic://r3-model-scopes'});await capacity.addProfile(principal,project,{id:profiles[i],accountId:account,model:models[i],effort:'medium',role:'programmer'});}
  const scope=(i:number,status:ProviderProbeResult['status'])=>({model:models[i],status,remainingPercent:status==='available'?50:status==='exhausted'?0:null,resetAt:null});
  let result:{status:ProviderProbeResult['status'];modelQuotas?:ReturnType<typeof scope>[]}={status:'available'};
  const adapter=createSyntheticProviderAdapter({id:'scoped-fixture',provider:'antigravity-fixture',version:'r3-v1',runner:async input=>({protocol:'ac-synthetic-quota-v1',provider:'antigravity-fixture',accountId:input.accountId,...result,remainingPercent:null,resetAt:null})});
  const collectors=new ProviderCollectors(db,[adapter]);await collectors.bind(principal,project,{accountId:account,adapterId:adapter.manifest.id,expectedRevision:0,minimumIntervalSeconds:1});
  const refresh=async()=>{await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");return collectors.collect(principal,project,account,randomUUID());};
  const revision=await capacity.publish(principal,project,0,{schemaVersion:1,maxProgrammersPerContext:10,maxEvaluatorsPerContext:2,roles:{programmer:{regular:profiles,emergency:[]}}});const context=await db.createContext(principal,project,randomUUID());await capacity.assignPolicy(principal,context,revision);const authority=await db.acquire(principal,context,randomUUID(),'scope-fixture-manager',60);const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:scopes-stable'}},authority,'api');
  const request=()=>({attemptId:randomUUID(),contextId:context,intentId:intent.id,role:'programmer' as const});const reserve=async()=>capacity.reserve(principal,request(),authority);const release=async(id:string)=>capacity.transition(principal,id,authority,'released',{state:'not_started',processId:'synthetic-not-started'});
  const statuses=async()=>(await db.pool.query('SELECT ac_profile_quota_status($1,$2) gemini,ac_profile_quota_status($1,$3) sonnet',[account,...models])).rows[0];
  await refresh();assert.deepEqual(await statuses(),{gemini:'available',sonnet:'available'});let grant=await reserve();assert.equal(grant.profile_id,profiles[0]);await release(grant.id);
  result={status:'available',modelQuotas:[scope(0,'exhausted'),scope(1,'available')]};await refresh();assert.deepEqual(await statuses(),{gemini:'exhausted',sonnet:'available'});grant=await reserve();assert.equal(grant.profile_id,profiles[1]);const row=(await db.pool.query('SELECT * FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0];assert.deepEqual(projectCapacitySelection(row)?.skippedCandidates,[{profileId:profiles[0],reason:'quota_exhausted'}]);
  await capacity.transition(principal,grant.id,authority,'running');result={status:'available',modelQuotas:[scope(0,'available'),scope(1,'available')]};await refresh();const waiting=request();await assert.rejects(capacity.reserve(principal,waiting,authority),/CAPACITY_BUSY/);await capacity.cancelWait(principal,waiting.attemptId,authority);assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_capacity_grants WHERE account_id=$1 AND state<>'released'",[account])).rows[0].n,1);await capacity.transition(principal,grant.id,authority,'released',{state:'exited',processId:'synthetic-shared-account'});
  // Updating Gemini without Sonnet expires Sonnet evidence; account availability cannot fill it.
  result={status:'available',modelQuotas:[scope(0,'available')]};await refresh();assert.deepEqual(await statuses(),{gemini:'available',sonnet:'unknown'});grant=await reserve();assert.equal(grant.profile_id,profiles[0]);await release(grant.id);
  result={status:'available'};await refresh();assert.deepEqual(await statuses(),{gemini:'unknown',sonnet:'unknown'});const blocked=request();await assert.rejects(capacity.reserve(principal,blocked,authority),/NO_ELIGIBLE_CAPACITY/);await capacity.cancelWait(principal,blocked.attemptId,authority);
  result={status:'available',modelQuotas:[]};await refresh();assert.deepEqual(await statuses(),{gemini:'unknown',sonnet:'unknown'});
  result={status:'auth_required',modelQuotas:[scope(0,'available'),scope(1,'available')]};await refresh();assert.deepEqual(await statuses(),{gemini:'auth_required',sonnet:'auth_required'});
  const authBlocked=request();await assert.rejects(capacity.reserve(principal,authBlocked,authority),/NO_ELIGIBLE_CAPACITY/);
  const authReasons=(await db.pool.query('SELECT exclusions FROM ac_capacity_waits WHERE attempt_id=$1',[authBlocked.attemptId])).rows[0].exclusions;assert(authReasons.every((x:{reason:string})=>x.reason==='authentication_required'));await capacity.cancelWait(principal,authBlocked.attemptId,authority);
  for(const [status,reason] of [['unreachable','provider_unreachable'],['rate_limited','quota_rate_limited'],['configuration_error','provider_configuration_error'],['disabled','quota_disabled']] as const){
   result={status,modelQuotas:[scope(0,'available'),scope(1,'available')]};await refresh();const denied=request();await assert.rejects(capacity.reserve(principal,denied,authority),/NO_ELIGIBLE_CAPACITY/);
   const reasons=(await db.pool.query('SELECT exclusions FROM ac_capacity_waits WHERE attempt_id=$1',[denied.attemptId])).rows[0].exclusions;assert(reasons.every((x:{reason:string})=>x.reason===reason));await capacity.cancelWait(principal,denied.attemptId,authority);
  }
  result={status:'available',modelQuotas:[scope(0,'available'),scope(1,'rate_limited')]};await refresh();assert.deepEqual(await statuses(),{gemini:'available',sonnet:'rate_limited'});
  await db.pool.query("UPDATE ac_model_quota_observations SET expires_at=observed_at+interval '1 microsecond' WHERE account_id=$1",[account]);assert.deepEqual(await statuses(),{gemini:'unknown',sonnet:'unknown'});
  await db.pool.query("UPDATE ac_provider_observations SET expires_at=completed_at+interval '1 microsecond' WHERE account_id=$1",[account]);const stale=await collectors.latest(principal,project,account);assert('modelQuotas' in stale);assert(stale.modelQuotas?.every(q=>q.status==='unknown'&&q.remainingPercent===null&&q.resetAt===null));assert('resetAt' in stale);assert.equal(stale.resetAt,null);
 }finally{await db.close();await isolated.close();}
});
