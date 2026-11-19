import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Capacity,CapacityPolicy,programmerChain} from '../src/capacity.ts';
import {reserveYieldReason} from '../src/capacity-exclusions.ts';
import {projectCapacitySelection} from '../src/control.ts';
import {Refusal, type Command} from '../src/contracts.ts';
import {reserveSpecialistExamSeat} from '../src/exam-provider.ts';
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

test('preferredProfileId, avoidProfiles e provider selecionam perfil específico sem fallback proibido',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
 const database=await isolatedDatabase(databaseUrl!,'specprof'),db=new Ledger(database.url);
 try{
  await db.migrate();
  const principal='spec-owner',project=randomUUID(),capacity=new Capacity(db);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Specialist Reserve']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await capacity.configure(principal,{programmingLimit:10,evaluationLimit:4});
  await capacity.registerModel(principal,{provider:'claude',model:'claude-opus-5-5',efforts:['medium'],roles:['specialist'],source:'synthetic://spec'});
  await capacity.registerModel(principal,{provider:'claude',model:'claude-sonnet-5-5',efforts:['medium'],roles:['specialist'],source:'synthetic://spec'});
  await capacity.registerModel(principal,{provider:'grok',model:'grok-4.7',efforts:['medium'],roles:['specialist'],source:'synthetic://spec'});
  const claudeA=randomUUID(),grokA=randomUUID();
  await capacity.addAccount(principal,project,{id:claudeA,provider:'claude',label:'claude-a',resourceIdentity:`claude:${claudeA}`,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://spec',maxConcurrent:4});
  await capacity.addAccount(principal,project,{id:grokA,provider:'grok',label:'grok-a',resourceIdentity:`grok:${grokA}`,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://spec',maxConcurrent:4});
  await capacity.observeQuota(principal,claudeA,{status:'available',source:'synthetic://spec',ttlSeconds:3600});
  await capacity.observeQuota(principal,grokA,{status:'available',source:'synthetic://spec',ttlSeconds:3600});
  const pOpus=randomUUID(),pSonnet=randomUUID(),pGrok=randomUUID();
  await capacity.addProfile(principal,project,{id:pOpus,accountId:claudeA,model:'claude-opus-5-5',effort:'medium',role:'specialist'});
  await capacity.addProfile(principal,project,{id:pSonnet,accountId:claudeA,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  await capacity.addProfile(principal,project,{id:pGrok,accountId:grokA,model:'grok-4.7',effort:'medium',role:'specialist'});
  const rev=await capacity.publish(principal,project,0,{
   schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:2,
   roles:{specialist:{regular:[pGrok,pOpus],emergency:[pSonnet]}},
  });
  const context=await db.createContext(principal,project,randomUUID());
  await capacity.assignPolicy(principal,context,rev);
  const authority=await db.acquire(principal,context,randomUUID(),'spec-reserve',60);
  const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:rev,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'spec'}};
  const intentId=(await db.accept(principal,command,authority,'api')).id;
  const release=async(id:string)=>capacity.transition(principal,id,authority,'released',{processId:'spec',state:'not_started'});
  const selectionOf=async(id:string)=>projectCapacitySelection((await db.pool.query('SELECT * FROM ac_capacity_grants WHERE id=$1',[id])).rows[0]);

  const claudeOnly=await capacity.reserve(principal,{attemptId:randomUUID(),intentId,contextId:context,role:'specialist',provider:'claude'},authority);
  assert.equal(claudeOnly.profile_id,pOpus);
  assert.ok(await selectionOf(claudeOnly.id));
  await release(claudeOnly.id);

  const preferredReviewer=await capacity.reserve(principal,{attemptId:randomUUID(),intentId,contextId:context,role:'specialist',provider:'claude',preferredProfileId:pSonnet,avoidProfiles:[pOpus]},authority);
  assert.equal(preferredReviewer.profile_id,pSonnet);
  assert.equal(preferredReviewer.emergency,true);
  assert.ok(await selectionOf(preferredReviewer.id));
  await release(preferredReviewer.id);

  await assert.rejects(
   capacity.reserve(principal,{attemptId:randomUUID(),intentId,contextId:context,role:'specialist',provider:'claude',avoidProfiles:[pOpus,pSonnet]},authority),
   (error:unknown)=>error instanceof Refusal&&error.code==='NO_ELIGIBLE_CAPACITY',
  );
 }finally{await db.close();await database.close();}
});

test('perfil revisor preparado vence preferência por outra conta e preserva alternativa legítima',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
 const database=await isolatedDatabase(databaseUrl!,'revpref'),db=new Ledger(database.url);
 try{
  await db.migrate();
  const principal='revpref-owner',project=randomUUID(),capacity=new Capacity(db);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Reviewer Preference']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await capacity.configure(principal,{programmingLimit:10,evaluationLimit:4});
  await capacity.registerModel(principal,{provider:'claude',model:'claude-opus-5-5',efforts:['medium'],roles:['specialist'],source:'synthetic://revpref'});
  await capacity.registerModel(principal,{provider:'claude',model:'claude-sonnet-5-5',efforts:['medium'],roles:['specialist'],source:'synthetic://revpref'});
  const claudeA=randomUUID(),claudeB=randomUUID();
  for(const [id,label] of [[claudeA,'claude-a'],[claudeB,'claude-b']] as const){
   await capacity.addAccount(principal,project,{id,provider:'claude',label,resourceIdentity:`claude:${id}`,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://revpref',maxConcurrent:4});
   await capacity.observeQuota(principal,id,{status:'available',source:'synthetic://revpref',ttlSeconds:3600});
  }
  const pCreateB=randomUUID(),pExaminerA=randomUUID(),pReviewerA=randomUUID(),pReviewerB=randomUUID();
  await capacity.addProfile(principal,project,{id:pCreateB,accountId:claudeB,model:'claude-opus-5-5',effort:'medium',role:'specialist'});
  await capacity.addProfile(principal,project,{id:pExaminerA,accountId:claudeA,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  await capacity.addProfile(principal,project,{id:pReviewerA,accountId:claudeA,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  await capacity.addProfile(principal,project,{id:pReviewerB,accountId:claudeB,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  const rev1=await capacity.publish(principal,project,0,{
   schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:2,
   roles:{specialist:{regular:[pCreateB,pExaminerA],emergency:[pReviewerA]}},
  });
  const context=await db.createContext(principal,project,randomUUID());
  await capacity.assignPolicy(principal,context,rev1);
  const authority=await db.acquire(principal,context,randomUUID(),'revpref',60);
  const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:rev1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'revpref'}};
  const intentId=(await db.accept(principal,command,authority,'api')).id;
  const release=async(id:string)=>capacity.transition(principal,id,authority,'released',{processId:'revpref',state:'not_started'});

  // 1) Mesmo com pCreateB em outra conta (claudeB), o perfil revisor preparado pReviewerA (em claudeA) vence.
  const onlyPreparedA=await reserveSpecialistExamSeat({
   capacity,ledger:db,principal,authority,intentId,purpose:'reviewer',
   avoidProfileId:pExaminerA,avoidAccountId:claudeA,releaseGrant:release,
  });
  assert.equal(onlyPreparedA.profileId,pReviewerA);
  assert.equal(onlyPreparedA.accountId,claudeA);
  await release(onlyPreparedA.grantId);

  // 2) Havendo dois revisores preparados, escolhe o revisor preparado em outra conta (pReviewerB).
  const rev2=await capacity.publish(principal,project,rev1,{
   schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:2,
   roles:{specialist:{regular:[pCreateB,pExaminerA],emergency:[pReviewerA,pReviewerB]}},
  });
  await capacity.assignPolicy(principal,context,rev2);
  const preparedB=await reserveSpecialistExamSeat({
   capacity,ledger:db,principal,authority,intentId,purpose:'reviewer',
   avoidProfileId:pExaminerA,avoidAccountId:claudeA,releaseGrant:release,
  });
  assert.equal(preparedB.profileId,pReviewerB);
  assert.equal(preparedB.accountId,claudeB);
  await release(preparedB.grantId);

  // 3) Se pReviewerB ficar inelegível, cai no outro revisor preparado pReviewerA antes de usar pCreateB.
  await capacity.setEnabled(principal,project,'profile',{id:pReviewerB,enabled:false,expectedRevision:1});
  const fallbackPreparedA=await reserveSpecialistExamSeat({
   capacity,ledger:db,principal,authority,intentId,purpose:'reviewer',
   avoidProfileId:pExaminerA,avoidAccountId:claudeA,releaseGrant:release,
  });
  assert.equal(fallbackPreparedA.profileId,pReviewerA);
  await release(fallbackPreparedA.grantId);

  // 4) Sem revisor preparado elegível, mantém a alternativa legítima em outra conta (pCreateB).
  await capacity.setEnabled(principal,project,'profile',{id:pReviewerA,enabled:false,expectedRevision:1});
  const regularFallbackB=await reserveSpecialistExamSeat({
   capacity,ledger:db,principal,authority,intentId,purpose:'reviewer',
   avoidProfileId:pExaminerA,avoidAccountId:claudeA,releaseGrant:release,
  });
  assert.equal(regularFallbackB.profileId,pCreateB);
  assert.equal(regularFallbackB.accountId,claudeB);
  await release(regularFallbackB.grantId);
 }finally{await db.close();await database.close();}
});

test('reserveSpecialistExamSeat libera grant em exceção entre reserve e leitura ou validação do assento',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
 const database=await isolatedDatabase(databaseUrl!,'seatleak'),db=new Ledger(database.url);
 try{
  await db.migrate();
  const principal='leak-owner',project=randomUUID(),capacity=new Capacity(db);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Seat Leak']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await capacity.configure(principal,{programmingLimit:10,evaluationLimit:4});
  await capacity.registerModel(principal,{provider:'claude',model:'claude-sonnet-5-5',efforts:['medium'],roles:['specialist'],source:'synthetic://leak'});
  await capacity.registerModel(principal,{provider:'grok',model:'grok-4.7',efforts:['medium'],roles:['specialist'],source:'synthetic://leak'});
  const claudeId=randomUUID(),grokId=randomUUID();
  for(const [id,provider] of [[claudeId,'claude'],[grokId,'grok']] as const){
   await capacity.addAccount(principal,project,{id,provider,label:provider,resourceIdentity:`${provider}:${id}`,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://leak',maxConcurrent:4});
   await capacity.observeQuota(principal,id,{status:'available',source:'synthetic://leak',ttlSeconds:3600});
  }
  const pExaminer=randomUUID(),pReviewer=randomUUID(),pGrok=randomUUID();
  await capacity.addProfile(principal,project,{id:pExaminer,accountId:claudeId,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  await capacity.addProfile(principal,project,{id:pReviewer,accountId:claudeId,model:'claude-sonnet-5-5',effort:'medium',role:'specialist'});
  await capacity.addProfile(principal,project,{id:pGrok,accountId:grokId,model:'grok-4.7',effort:'medium',role:'specialist'});
  const rev=await capacity.publish(principal,project,0,{
   schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:2,
   roles:{specialist:{regular:[pExaminer],emergency:[pReviewer]}},
  });
  const context=await db.createContext(principal,project,randomUUID());
  await capacity.assignPolicy(principal,context,rev);
  const authority=await db.acquire(principal,context,randomUUID(),'seatleak',60);
  const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:rev,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'seatleak'}};
  const intentId=(await db.accept(principal,command,authority,'api')).id;
  const released:string[]=[];
  const releaseGrant=async(grantId:string)=>{released.push(grantId);await capacity.transition(principal,grantId,authority,'released',{processId:'seatleak',state:'not_started'});};

  const failingSeatLedger=(mode:'throw'|'empty')=>({
   pool:{
    query:async(sql:string,params?:unknown[])=>{
     if(sql.includes('FROM ac_capacity_grants g JOIN ac_profiles p')){
      if(mode==='throw')throw new Error('SEAT_LOOKUP_FAILED');
      return {rows:[{provider:'',model:''}],rowCount:1};
     }
     return db.pool.query(sql,params);
    },
   },
  } as unknown as Ledger);

  // 1) Falha na query após reserve no propósito reviewer libera o grant.
  await assert.rejects(
   ()=>reserveSpecialistExamSeat({capacity,ledger:failingSeatLedger('throw'),principal,authority,intentId,purpose:'reviewer',avoidProfileId:pExaminer,releaseGrant}),
   /SEAT_LOOKUP_FAILED/,
  );
  // 2) Falha de validação (GRANT_FORBIDDEN) após reserve no propósito examiner libera o grant.
  await assert.rejects(
   ()=>reserveSpecialistExamSeat({capacity,ledger:failingSeatLedger('empty'),principal,authority,intentId,purpose:'examiner',releaseGrant}),
   (error:unknown)=>error instanceof Refusal&&error.code==='GRANT_FORBIDDEN',
  );
  // 3) Provedor não-Claude (EXAM_PROVIDER_UNSUPPORTED) após reserve no propósito examiner libera o grant.
  const revGrok=await capacity.publish(principal,project,rev,{
   schemaVersion:1,maxProgrammersPerContext:1,maxEvaluatorsPerContext:2,
   roles:{specialist:{regular:[pGrok],emergency:[]}},
  });
  await capacity.assignPolicy(principal,context,revGrok);
  await assert.rejects(
   ()=>reserveSpecialistExamSeat({capacity,ledger:db,principal,authority,intentId,purpose:'examiner',releaseGrant}),
   (error:unknown)=>error instanceof Refusal&&error.code==='EXAM_PROVIDER_UNSUPPORTED',
  );

  assert.equal(released.length,3);
  const unreleased=(await db.pool.query("SELECT count(*)::int AS n FROM ac_capacity_grants WHERE intent_id=$1 AND state<>'released'",[intentId])).rows[0].n;
  assert.equal(unreleased,0);
 }finally{await db.close();await database.close();}
});
