import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Capacity, type Role} from '../src/capacity.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('programming saturation and explicit stage releases permit evaluation, with original reserve draining on recovery',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'capacityliveness'),db=new Ledger(database.url),capacity=new Capacity(db);
 try{
  await db.migrate();
  const principal='synthetic-liveness-'+randomUUID(),project=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic capacity liveness']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const roles:Role[]=['programmer','qa','reviewer','specialist'];
  await capacity.registerModel(principal,{provider:'synthetic',model:'fixture',efforts:['medium'],roles,source:'synthetic://liveness'});
  const original=randomUUID(),alternate=randomUUID();
  for(const account of [original,alternate]){
   await capacity.addAccount(principal,project,{id:account,provider:'synthetic',label:'fixture',resourceIdentity:randomUUID(),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://liveness',maxConcurrent:1});
   await capacity.observeQuota(principal,account,{status:'available',source:'synthetic://liveness',ttlSeconds:3600});
  }
  const profiles=Object.fromEntries(roles.map(role=>[role,randomUUID()])) as Record<string,string>;
  for(const role of roles)await capacity.addProfile(principal,project,{id:profiles[role]!,accountId:original,model:'fixture',effort:'medium',role});
  const alternateProgrammer=randomUUID();
  await capacity.addProfile(principal,project,{id:alternateProgrammer,accountId:alternate,model:'fixture',effort:'medium',role:'programmer'});
  await capacity.configure(principal,{programmingLimit:1,evaluationLimit:1,originalFallback:{accountId:original,programmingLimit:1,evaluationLimit:1}});
  const chain=(profile:string)=>({regular:[profile],emergency:[]});
  const policy={schemaVersion:1 as const,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{programmer:chain(profiles.programmer!),qa:chain(profiles.qa!),reviewer:chain(profiles.reviewer!),specialist:chain(profiles.specialist!)}};
  const revision=await capacity.publish(principal,project,0,policy);
  const otherRevision=await capacity.publish(principal,project,1,{...policy,roles:{programmer:chain(alternateProgrammer)}});
  const context=await db.createContext(principal,project,randomUUID()),otherContext=await db.createContext(principal,project,randomUUID());
  const authority=await db.acquire(principal,context,randomUUID(),'fixture',60),otherAuthority=await db.acquire(principal,otherContext,randomUUID(),'fixture',60);
  await capacity.assignPolicy(principal,context,revision);await capacity.assignPolicy(principal,otherContext,otherRevision);
  const createIntent=async(contextId:string,auth:typeof authority)=> (await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic-liveness'}},auth,'api')).id;
  const intentId=await createIntent(context,authority),otherIntent=await createIntent(otherContext,otherAuthority);
  const request=(role:Role)=>({attemptId:randomUUID(),intentId,contextId:context,role});
  const programming=request('programmer');
  await assert.rejects(capacity.reserve(principal,programming,authority),/ORIGINAL_RESERVE_NOT_NEEDED/);
  await capacity.observeQuota(principal,alternate,{status:'exhausted',source:'synthetic://liveness',ttlSeconds:3600});
  const grant=await capacity.reserve(principal,programming,authority);
  assert.equal(grant.account_id,original);assert.equal(grant.state,'reserved');
  const persisted=(await db.pool.query('SELECT policy_revision,config_revision FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0];
  assert.equal(persisted.policy_revision,revision);assert.equal(persisted.config_revision,1);
  await capacity.observeQuota(principal,alternate,{status:'available',source:'synthetic://liveness',ttlSeconds:3600});
  await capacity.configure(principal,{programmingLimit:1,evaluationLimit:1});
  const newAttempt=request('programmer');
  await assert.rejects(capacity.reserve(principal,newAttempt,authority),/ORIGINAL_RESERVE_NOT_NEEDED/);
  assert.deepEqual((await db.pool.query('SELECT state,policy_revision,config_revision FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0],{state:'reserved',...persisted});
  const alternateAttempt={attemptId:randomUUID(),intentId:otherIntent,contextId:otherContext,role:'programmer' as const};
  await assert.rejects(capacity.reserve(principal,alternateAttempt,otherAuthority),/CAPACITY_BUSY/);
  const qa=request('qa');
  await assert.rejects(capacity.reserve(principal,qa,authority),/CAPACITY_BUSY/);
  await capacity.transition(principal,grant.id,authority,'released',{processId:'synthetic-programmer-not-started',state:'not_started'});
  const evalGrant=await capacity.reserve(principal,qa,authority);
  assert.equal(evalGrant.role,'qa');
  const reviewer=request('reviewer');await assert.rejects(capacity.reserve(principal,reviewer,authority),/CAPACITY_BUSY/);
  await capacity.transition(principal,evalGrant.id,authority,'released',{processId:'synthetic-qa-not-started',state:'not_started'});
  const reviewGrant=await capacity.reserve(principal,reviewer,authority);assert.equal(reviewGrant.role,'reviewer');
  await capacity.transition(principal,reviewGrant.id,authority,'released',{processId:'synthetic-review-not-started',state:'not_started'});
  const specialist=await capacity.reserve(principal,request('specialist'),authority);assert.equal(specialist.role,'specialist');
  await capacity.transition(principal,specialist.id,authority,'released',{processId:'synthetic-specialist-not-started',state:'not_started'});
  const alternative=await capacity.reserve(principal,alternateAttempt,otherAuthority);assert.equal(alternative.account_id,alternate);
  const concurrentQa=await capacity.reserve(principal,request('qa'),authority);
  assert.equal(concurrentQa.role,'qa');
  await capacity.transition(principal,concurrentQa.id,authority,'released',{processId:'synthetic-concurrent-qa-not-started',state:'not_started'});
  await capacity.transition(principal,alternative.id,otherAuthority,'released',{processId:'synthetic-alternate-not-started',state:'not_started'});
 }finally{await db.close();await database.close();}
});

test('running regular and emergency grants survive recovery and policy revision without preemption',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'capacityhandoff'),db=new Ledger(database.url),capacity=new Capacity(db);
 try{
  await db.migrate();
  const principal='synthetic-handoff-'+randomUUID(),project=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic handoff']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:8,evaluationLimit:1});
  await capacity.registerModel(principal,{provider:'synthetic',model:'fixture',efforts:['medium'],roles:['programmer'],source:'synthetic://handoff'});
  const accounts=[randomUUID(),randomUUID(),randomUUID()],profiles=accounts.map(()=>randomUUID());
  for(let i=0;i<accounts.length;i++){
   await capacity.addAccount(principal,project,{id:accounts[i]!,provider:'synthetic',label:`fixture-${i}`,resourceIdentity:randomUUID(),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://handoff',maxConcurrent:3});
   await capacity.addProfile(principal,project,{id:profiles[i]!,accountId:accounts[i]!,model:'fixture',effort:'medium',role:'programmer'});
   await capacity.observeQuota(principal,accounts[i]!,{status:'available',source:'synthetic://handoff',ttlSeconds:3600});
  }
  const policy={schemaVersion:1 as const,maxProgrammersPerContext:8,maxEvaluatorsPerContext:1,roles:{programmer:{regular:profiles.slice(0,2),emergency:[profiles[2]!]}}};
  const revision=await capacity.publish(principal,project,0,policy);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'synthetic',60);
  await capacity.assignPolicy(principal,context,revision);
  const intent=(await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:handoff'}},authority,'api')).id;
  const request=()=>({attemptId:randomUUID(),intentId:intent,contextId:context,role:'programmer' as const});
  const quota=async(account:string,status:'available'|'exhausted')=>capacity.observeQuota(principal,account,{status,source:'synthetic://handoff',ttlSeconds:3600});
  const state=async(id:string)=>(await db.pool.query('SELECT state,policy_revision,profile_id FROM ac_capacity_grants WHERE id=$1',[id])).rows[0];
  const release=async(id:string)=>capacity.transition(principal,id,authority,'released',{processId:'synthetic-exit',state:'exited'});

  await quota(accounts[0]!,'exhausted');
  const regular=await capacity.reserve(principal,request(),authority);assert.equal(regular.profile_id,profiles[1]);
  await capacity.transition(principal,regular.id,authority,'running');
  await quota(accounts[0]!,'available');
  const sticky=await capacity.reserve(principal,request(),authority);
  assert.equal(sticky.profile_id,profiles[1]);assert.equal((await state(regular.id)).state,'running');
  await release(sticky.id);await release(regular.id);

  await quota(accounts[0]!,'exhausted');await quota(accounts[1]!,'exhausted');
  const emergency=await capacity.reserve(principal,request(),authority);assert.equal(emergency.profile_id,profiles[2]);assert.equal(emergency.emergency,true);
  await capacity.transition(principal,emergency.id,authority,'running');
  await quota(accounts[0]!,'available');
  const recovered=await capacity.reserve(principal,request(),authority);
  assert.equal(recovered.profile_id,profiles[0]);assert.equal(recovered.emergency,false);
  assert.equal((await state(emergency.id)).state,'running');
  await release(recovered.id);await release(emergency.id);

  const inFlight=await capacity.reserve(principal,request(),authority);
  const before=await state(inFlight.id);assert.equal(before.policy_revision,revision);assert.equal(before.state,'reserved');
  const next=await capacity.publish(principal,project,revision,{...policy,roles:{programmer:{regular:[profiles[1]!],emergency:[]}}});
  await capacity.assignPolicy(principal,context,next);
  await capacity.transition(principal,inFlight.id,authority,'running');
  assert.deepEqual(await state(inFlight.id),{...before,state:'running'});
  await release(inFlight.id);
  assert.deepEqual(await state(inFlight.id),{...before,state:'released'});
  await quota(accounts[1]!,'available');
  const newGrant=await capacity.reserve(principal,request(),authority);
  assert.equal(newGrant.profile_id,profiles[1]);assert.equal((await state(newGrant.id)).policy_revision,next);
  await release(newGrant.id);
 }finally{await db.close();await database.close();}
});
