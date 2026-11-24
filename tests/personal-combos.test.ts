import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Capacity} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {applyPersonalCombo,builtinCombos,findPersonalCombo,readOwnerCombos,setPersonalEvaluators,writeOwnerCombo} from '../src/personal-combos.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('complexo keeps Opus regular, Sol emergency and four programmers',()=>{
 const combo=builtinCombos.find(item=>item.name==='complexo');
 assert.ok(combo);
 assert.equal(combo.roles.manager.model,'claude-opus-5-5');
 assert.equal(combo.roles.manager.effort,'high');
 assert.deepEqual(combo.roles.manager.reserve,{provider:'codex',model:'gpt-6.1-sol',effort:'high'});
 assert.equal(combo.roles.programmer.standard[0]?.count,3);
 assert.equal(combo.roles.programmer.standard[0]?.model,'gpt-6.1-sol');
 assert.equal(combo.roles.programmer.standard[0]?.reserve?.model,'grok-4.7');
 assert.equal(combo.roles.programmer.basic?.[0]?.count,1);
 assert.equal(combo.roles.programmer.basic?.[0]?.model,'grok-4.7');
 assert.equal(combo.roles.programmer.basic?.[0]?.reserve?.model,'gpt-6.1-sol');
 assert.equal(combo.roles.reviewer.reserve?.model,'grok-4.7');
 assert.equal(combo.roles.qa?.model,'grok-4.7');
 assert.equal(combo.roles.qa?.reserve?.model,'claude-sonnet-5-5');
 assert.equal(combo.roles.qa?.reserve?.effort,'medium');
 const middle=builtinCombos.find(item=>item.name==='intermediário')!;
 assert.equal(middle.roles.programmer.standard[0]?.count,2);
 assert.equal(middle.roles.programmer.standard[0]?.reserve?.model,'gpt-6.1-sol');
 assert.equal(middle.roles.programmer.standard[1]?.count,1);
 assert.equal(middle.roles.programmer.standard[1]?.reserve?.model,'grok-4.7');
 const cheap=builtinCombos.find(item=>item.name==='economia')!;
 assert.equal(cheap.roles.qa,undefined);
 assert.equal(cheap.roles.programmer.standard[1]?.model,'gpt-6.1-terra');
 assert.equal(cheap.roles.reviewer.reserve?.effort,'low');
 assert.equal(findPersonalCombo('Complexo',[]).name,'complexo');
 assert.deepEqual(builtinCombos.map(item=>item.name).sort(),['complexo','economia','intermediário'].sort());
});

test('owner combo file is mode 600 and overrides a built-in name',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-combos-'));
 try{
  const custom=builtinCombos.find(item=>item.name==='intermediário')!;
  const overridden={...custom,roles:{...custom.roles,manager:{...custom.roles.manager,effort:'medium' as const}}};
  await writeOwnerCombo(dir,overridden);
  assert.equal((await stat(join(dir,'combos.json'))).mode&0o777,0o600);
  assert.equal(findPersonalCombo('intermediário',[overridden]).roles.manager.effort,'medium');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('an owner combo with two programmers or without a reserve is refused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-combos-'));
 try{
  const base=builtinCombos.find(item=>item.name==='economia')!;
  const short={...base,name:'curto',roles:{...base.roles,programmer:{standard:[{...base.roles.programmer.standard[0]!,count:2}]}}};
  await assert.rejects(writeOwnerCombo(dir,short),(error:unknown)=>error instanceof Refusal&&error.code==='COMBO_MINIMUM_REQUIRED');
  const {reserve:_omit,...manager}=base.roles.manager;
  await assert.rejects(writeOwnerCombo(dir,{...base,name:'sem-reserva',roles:{...base.roles,manager}}),(error:unknown)=>error instanceof Refusal&&error.code==='COMBO_MINIMUM_REQUIRED');
  await writeFile(join(dir,'combos.json'),JSON.stringify({schemaVersion:1,combos:[short]})+'\n');
  assert.equal((await readOwnerCombos(dir))[0]?.name,'curto');
 }finally{await rm(dir,{recursive:true,force:true});}
});

const databaseUrl=process.env.AC_TEST_DATABASE_URL;
test('complexo refuses without Codex and publishes Opus regular, Sol emergency and four programmers',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
 const database=await isolatedDatabase(databaseUrl!,'combos'),db=new Ledger(database.url),dir=await mkdtemp(join(tmpdir(),'ac-combos-'));
 try{
  await db.migrate();
  const principal='combo-owner',project=randomUUID(),capacity=new Capacity(db);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Combos']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:10,evaluationLimit:4});
  const add=async(provider:'claude'|'grok'|'codex')=>{
   const id=randomUUID();
   await capacity.addAccount(principal,project,{id,provider,label:provider,resourceIdentity:provider+':'+id,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://combos',maxConcurrent:4});
   return id;
  };
  await add('claude');await add('grok');
  const context=await db.createContext(principal,project,randomUUID());
  const counts=async()=>{
   const profiles=Number((await db.pool.query('SELECT count(*)::int n FROM ac_profiles')).rows[0].n);
   const policies=Number((await db.pool.query('SELECT count(*)::int n FROM ac_policy_revisions')).rows[0].n);
   const catalog=Number((await db.pool.query('SELECT count(*)::int n FROM ac_model_catalog')).rows[0].n);
   return {profiles,policies,catalog};
  };
  const before=await counts();
  const base=builtinCombos.find(item=>item.name==='economia')!;
  const short={...base,name:'curto',roles:{...base.roles,programmer:{standard:[{...base.roles.programmer.standard[0]!,count:2}]}}};
  await writeFile(join(dir,'combos.json'),JSON.stringify({schemaVersion:1,combos:[short]})+'\n');
  await assert.rejects(applyPersonalCombo(db,principal,project,'curto',dir),(error:unknown)=>error instanceof Refusal&&error.code==='COMBO_MINIMUM_REQUIRED');
  await assert.rejects(applyPersonalCombo(db,principal,project,'complexo',dir),(error:unknown)=>error instanceof Refusal&&error.code==='CODEX_ACCOUNT_REQUIRED');
  assert.deepEqual(await counts(),before);
  assert.equal((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1',[context])).rows[0].capacity_policy_revision,null);
  await add('codex');
  const applied=await applyPersonalCombo(db,principal,project,'complexo',dir);
  assert.equal(applied.maxProgrammersPerContext,4);
  assert.equal(applied.programmerStandard.length,3);
  assert.equal(applied.programmerBasic.length,1);
  assert.equal(applied.qaModel,true);
  const snapshot=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project,applied.revision])).rows[0].snapshot;
  const model=async(id:string)=>String((await db.pool.query('SELECT model FROM ac_profiles WHERE id=$1',[id])).rows[0].model);
  assert.equal(snapshot.combo,'complexo');
  assert.equal(await model(snapshot.roles.manager.regular[0]),'claude-opus-5-5');
  assert.equal(await model(snapshot.roles.manager.emergency[0]),'gpt-6.1-sol');
  assert.equal(snapshot.maxProgrammersPerContext,4);
  assert.equal(snapshot.programmerTiers.standard.length,3);
  assert.equal(snapshot.programmerTiers.basic.length,1);
  assert.equal(snapshot.programmerTiers.standardReserve.length,1);
  assert.equal(snapshot.programmerTiers.basicReserve.length,1);
  assert.equal(snapshot.roles.programmer.regular.length,4);
  assert.deepEqual(snapshot.roles.programmer.regular,[...applied.programmerStandard,...applied.programmerBasic]);
  assert.equal(Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1',[context])).rows[0].capacity_policy_revision),applied.revision);
  // Only the evaluator limit changes; roles and the rest of the policy stay, and the open context moves to the new revision.
  await assert.rejects(setPersonalEvaluators(db,principal,project,5),(error:unknown)=>error instanceof Refusal&&error.code==='COMBO_USAGE');
  await assert.rejects(setPersonalEvaluators(db,'outro',project,4),(error:unknown)=>error instanceof Refusal&&error.code==='PROJECT_OWNER_REQUIRED');
  const set=await setPersonalEvaluators(db,principal,project,4);
  assert.equal(set.revision,applied.revision+1);
  const after=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project,set.revision])).rows[0].snapshot;
  assert.equal(after.maxEvaluatorsPerContext,4);
  assert.deepEqual({...after,maxEvaluatorsPerContext:snapshot.maxEvaluatorsPerContext},snapshot);
  assert.equal(Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1',[context])).rows[0].capacity_policy_revision),set.revision);
 }finally{await db.close();await database.close();await rm(dir,{recursive:true,force:true});}
});

test('applying a combo on one project leaves a profile that another project still uses enabled',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
 const database=await isolatedDatabase(databaseUrl!,'share'),db=new Ledger(database.url),dir=await mkdtemp(join(tmpdir(),'ac-combos-'));
 try{
  await db.migrate();
  const principal='combo-owner',projectA=randomUUID(),projectB=randomUUID(),capacity=new Capacity(db);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[projectA,'A']);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[projectB,'B']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[projectA,principal]);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[projectB,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await capacity.configure(principal,{programmingLimit:10,evaluationLimit:4});
  for(const provider of ['claude','grok','codex'] as const){
   const id=randomUUID();
   await capacity.addAccount(principal,projectA,{id,provider,label:provider,resourceIdentity:provider+':'+id,mode:'synthetic',eligibility:'documented_supported',eligibilitySource:'synthetic://combos',maxConcurrent:4});
   await capacity.shareAccount(principal,id,projectB);
  }
  await db.createContext(principal,projectB,randomUUID());
  const onA=await applyPersonalCombo(db,principal,projectA,'complexo',dir);
  const onB=await applyPersonalCombo(db,principal,projectB,'complexo',dir);
  assert.equal(onB.manager[0],onA.manager[0]);
  const opus=onA.manager[0]!;
  const enabled=async(id:string)=>Boolean((await db.pool.query('SELECT enabled FROM ac_profiles WHERE id=$1',[id])).rows[0].enabled);
  await applyPersonalCombo(db,principal,projectA,'economia',dir);
  assert.equal(await enabled(opus),true);
  const left=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',[projectA])).rows[0].snapshot;
  assert.equal(left.combo,'economia');
  assert.equal(left.roles.manager.regular.includes(opus),false);
  await applyPersonalCombo(db,principal,projectB,'economia',dir);
  assert.equal(await enabled(opus),false);
 }finally{await db.close();await database.close();await rm(dir,{recursive:true,force:true});}
});
