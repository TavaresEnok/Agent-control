import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Capacity,CapacityPolicy,programmerChain} from '../src/capacity.ts';
import {reserveYieldReason} from '../src/capacity-exclusions.ts';
import type {Command} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {applyPersonalCombo,writeOwnerCombo,type PersonalCombo} from '../src/personal-combos.ts';
import {reserveAssumptionNotices,reserveAssumptionText} from '../src/personal-team-feed.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('reserve yield is quota exhaustion or a required login',()=>{
 assert.equal(reserveYieldReason('quota_exhausted'),true);
 assert.equal(reserveYieldReason('authentication_required'),true);
 assert.equal(reserveYieldReason('quota_unknown'),false);
 assert.equal(reserveYieldReason(null),false);
 assert.equal(reserveAssumptionText('claude','manager','gpt-6.1-sol'),'Cota de claude esgotada: Gerente segue com gpt-6.1-sol.');
 assert.equal(reserveAssumptionText('grok','programmer','gpt-6.1-sol'),'Cota de grok esgotada: Programador segue com gpt-6.1-sol.');
 assert.equal(reserveAssumptionText('codex','reviewer','grok-4.7'),'Cota de codex esgotada: Revisor segue com grok-4.7.');
});

test('each programmer level keeps its own reserve chain',()=>{
 const standard=randomUUID(),basic=randomUUID(),standardReserve=randomUUID(),basicReserve=randomUUID();
 const chain={regular:[standard,basic],emergency:[standardReserve,basicReserve]};
 const policy:CapacityPolicy={schemaVersion:1,maxProgrammersPerContext:4,maxEvaluatorsPerContext:1,roles:{programmer:chain},
  programmerTiers:{standard:[standard],basic:[basic],standardReserve:[standardReserve],basicReserve:[basicReserve]}};
 assert.deepEqual(programmerChain(policy,'programmer',chain,'standard'),{regular:[standard],emergency:[standardReserve]});
 assert.deepEqual(programmerChain(policy,'programmer',chain,'basic'),{regular:[basic],emergency:[basicReserve]});
 const legacy=CapacityPolicy.parse({schemaVersion:1,maxProgrammersPerContext:2,maxEvaluatorsPerContext:1,roles:{programmer:chain},programmerTiers:{standard:[standard],basic:[basic]}});
 assert.deepEqual(programmerChain(legacy,'programmer',chain).emergency,[]);
});

const proved:PersonalCombo={
 name:'reserva-prova',
 roles:{
  manager:{provider:'claude',model:'claude-opus-5-5',effort:'high',count:1,reserve:{provider:'codex',model:'gpt-6.1-sol',effort:'high'}},
  reviewer:{provider:'claude',model:'claude-opus-5-5',effort:'high',count:1,reserve:{provider:'grok',model:'grok-4.7',effort:'high'}},
  programmer:{
   standard:[{provider:'codex',model:'gpt-6.1-sol',effort:'high',count:3,reserve:{provider:'grok',model:'grok-4.7',effort:'high'}}],
   basic:[{provider:'grok',model:'grok-4.7',effort:'high',count:1,reserve:{provider:'codex',model:'gpt-6.1-sol',effort:'high'}}],
  },
  qa:{provider:'grok',model:'grok-4.7',effort:'high',count:1,reserve:{provider:'claude',model:'claude-sonnet-5-5',effort:'medium'}},
 },
};

const databaseUrl=process.env.AC_TEST_DATABASE_URL;
test('exhausted titular yields to the reserve and the reviewer stays on another provider',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
 const database=await isolatedDatabase(databaseUrl!,'reserve'),db=new Ledger(database.url),dir=await mkdtemp(join(tmpdir(),'ac-reserve-'));
 try{
  await db.migrate();
  const principal='reserve-owner',project=randomUUID(),capacity=new Capacity(db);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Reserve']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await capacity.configure(principal,{programmingLimit:10,evaluationLimit:4});
  for(const provider of ['claude','grok','codex'] as const){
   await capacity.addAccount(principal,project,{id:randomUUID(),provider,label:provider,resourceIdentity:provider+':'+randomUUID(),mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://reserve',maxConcurrent:4});
  }
  await writeOwnerCombo(dir,proved);
  const applied=await applyPersonalCombo(db,principal,project,proved.name,dir);
  const snapshot=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project,applied.revision])).rows[0].snapshot;
  const managerModel=async(id:string)=>String((await db.pool.query('SELECT model FROM ac_profiles WHERE id=$1',[id])).rows[0].model);
  assert.equal(await managerModel(snapshot.roles.manager.regular[0]),'claude-opus-5-5');
  assert.equal(await managerModel(snapshot.roles.manager.emergency[0]),'gpt-6.1-sol');
  assert.equal(snapshot.programmerTiers.standard.length,3);
  assert.equal(snapshot.programmerTiers.basic.length,1);
  assert.equal(snapshot.programmerTiers.standardReserve.length,1);
  assert.equal(snapshot.programmerTiers.basicReserve.length,1);
  const account=async(provider:string)=>String((await db.pool.query('SELECT id FROM ac_accounts WHERE provider=$1',[provider])).rows[0].id);
  const claude=await account('claude'),grok=await account('grok'),codex=await account('codex');
  for(const id of [claude,grok,codex])await capacity.observeQuota(principal,id,{status:'available',source:'synthetic://reserve',ttlSeconds:3600});
  const context=await db.createContext(principal,project,randomUUID());
  await capacity.assignPolicy(principal,context,applied.revision);
  const authority=await db.acquire(principal,context,randomUUID(),'reserve',60);
  const open=async()=>{
   const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:applied.revision,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:reserve'}};
   return (await db.accept(principal,command,authority,'api')).id;
  };
  const providerOf=async(profileId:string)=>String((await db.pool.query('SELECT a.provider FROM ac_profiles p JOIN ac_accounts a ON a.id=p.account_id WHERE p.id=$1',[profileId])).rows[0].provider);
  const intent=await open();
  const reserve=(role:'manager'|'programmer'|'reviewer',taskLevel?:'basic'|'standard')=>capacity.reserve(principal,{attemptId:randomUUID(),intentId:intent,contextId:context,role,...(taskLevel?{taskLevel}:{})},authority);
  const release=async(id:string)=>capacity.transition(principal,id,authority,'released',{processId:'synthetic-reserve',state:'not_started'});
  const titular=await reserve('manager');
  assert.equal(titular.emergency,false);
  assert.equal(await providerOf(titular.profile_id),'claude');
  await release(titular.id);
  await capacity.observeQuota(principal,claude,{status:'exhausted',source:'synthetic://reserve',ttlSeconds:3600});
  const fallen=await reserve('manager');
  assert.equal(fallen.emergency,true);
  assert.equal(await managerModel(fallen.profile_id),'gpt-6.1-sol');
  const notices=await reserveAssumptionNotices(db.pool,context);
  assert.deepEqual(notices,[{localId:'cota-claude-manager-gpt-6.1-sol',text:'Cota de claude esgotada: Gerente segue com gpt-6.1-sol.'}]);
  const writer=await reserve('programmer','standard');
  assert.equal(writer.emergency,false);
  assert.equal(await providerOf(writer.profile_id),'codex');
  const reviewer=await reserve('reviewer');
  assert.equal(reviewer.emergency,true);
  assert.equal(await providerOf(reviewer.profile_id),'grok');
  assert.notEqual(await providerOf(reviewer.profile_id),await providerOf(writer.profile_id));
  const other=await open();
  const basic=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:other,contextId:context,role:'programmer',taskLevel:'basic'},authority);
  assert.equal(await providerOf(basic.profile_id),'grok');
  await assert.rejects(capacity.reserve(principal,{attemptId:randomUUID(),intentId:other,contextId:context,role:'reviewer'},authority),/NO_ELIGIBLE_CAPACITY/);
  await release(fallen.id);
  await capacity.observeQuota(principal,claude,{status:'auth_required',source:'synthetic://reserve',ttlSeconds:3600});
  const login=await reserve('manager');
  assert.equal(login.emergency,true);
  assert.equal(await managerModel(login.profile_id),'gpt-6.1-sol');
  // A verdict retry skips the reviewer that answered without a usable verdict, and falls back to it when nothing else is left.
  await capacity.observeQuota(principal,claude,{status:'available',source:'synthetic://reserve',ttlSeconds:3600});
  const retried=await open();
  await capacity.reserve(principal,{attemptId:randomUUID(),intentId:retried,contextId:context,role:'programmer',taskLevel:'standard'},authority);
  const first=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:retried,contextId:context,role:'reviewer'},authority);
  assert.equal(await providerOf(first.profile_id),'claude');
  await release(first.id);
  const avoided=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:retried,contextId:context,role:'reviewer',avoidAccounts:[claude]},authority);
  assert.equal(await providerOf(avoided.profile_id),'grok');
  await release(avoided.id);
  const fallback=await capacity.reserve(principal,{attemptId:randomUUID(),intentId:retried,contextId:context,role:'reviewer',avoidAccounts:[claude,grok]},authority);
  assert.equal(await providerOf(fallback.profile_id),'claude');
 }finally{await db.close();await database.close();await rm(dir,{recursive:true,force:true});}
});
