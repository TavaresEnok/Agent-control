import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('real-provider metadata remains dormant despite eligible quota observations',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'dormant'),db=new Ledger(isolated.url),capacity=new Capacity(db);
 try{
  await db.migrate();const principal='synthetic-test-'+randomUUID(),project=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'dormant metadata fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:4,evaluationLimit:1});
  const accounts=[];
  for(const mode of ['synthetic','subscription_cli','api'] as const){
   const id=randomUUID(),profile=randomUUID(),provider=`fixture-${mode}`,model=`model-${mode}`;
   await capacity.registerModel(principal,{provider,model,efforts:['medium'],roles:['programmer'],source:'synthetic://metadata-fixture'});
   await capacity.addAccount(principal,project,{id,provider,label:'fixture',resourceIdentity:randomUUID(),mode,eligibility:'documented_supported',eligibilitySource:'synthetic://metadata-fixture',maxConcurrent:1});
   await capacity.addProfile(principal,project,{id:profile,accountId:id,model,effort:'medium',role:'programmer'});
   await capacity.observeQuota(principal,id,{status:'available',source:'synthetic://observation-fixture',ttlSeconds:300});
   accounts.push({id,profile,mode});
  }
  for(const account of accounts){
   const row=(await db.pool.query('SELECT a.enabled account_enabled,p.enabled profile_enabled FROM ac_accounts a JOIN ac_profiles p ON p.account_id=a.id WHERE a.id=$1',[account.id])).rows[0];
   assert.equal(row.account_enabled,account.mode==='synthetic');assert.equal(row.profile_enabled,account.mode==='synthetic');
   if(account.mode==='synthetic')continue;
   await assert.rejects(capacity.setEnabled(principal,project,'account',{id:account.id,enabled:true,expectedRevision:1}),/PROVIDER_RUNTIME_NOT_ACTIVATED/);
   await assert.rejects(capacity.setEnabled(principal,project,'profile',{id:account.profile,enabled:true,expectedRevision:1}),/PROVIDER_RUNTIME_NOT_ACTIVATED/);
   await assert.rejects(db.pool.query('UPDATE ac_accounts SET enabled=true WHERE id=$1',[account.id]),/ac_accounts_dormant_check/);
   await assert.rejects(db.pool.query('UPDATE ac_profiles SET enabled=true WHERE id=$1',[account.profile]),/PROVIDER_RUNTIME_NOT_ACTIVATED/);
   await assert.rejects(db.pool.query("UPDATE ac_accounts SET mode='synthetic' WHERE id=$1",[account.id]),/PROVIDER_ACCOUNT_MODE_IMMUTABLE/);
  }
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'fixture-manager',60);
  const policy=(profiles:string[])=>({schemaVersion:1 as const,maxProgrammersPerContext:2,maxEvaluatorsPerContext:1,roles:{programmer:{regular:profiles,emergency:[]}}});
  const revision=await capacity.publish(principal,project,0,policy([accounts[1]!.profile,accounts[2]!.profile,accounts[0]!.profile]));
  await capacity.assignPolicy(principal,contextId,revision);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:fixture'}},authority,'api');
  const grant=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},authority);
  assert.equal(grant.account_id,accounts[0]!.id);
  await capacity.transition(principal,grant.id,authority,'released',{processId:'synthetic-never-started',state:'not_started'});
  const realOnly=await capacity.publish(principal,project,1,policy([accounts[1]!.profile,accounts[2]!.profile]));
  await capacity.assignPolicy(principal,contextId,realOnly);
  await assert.rejects(capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},authority),/NO_ELIGIBLE_CAPACITY/);
 }finally{await db.close();await isolated.close();}
});
