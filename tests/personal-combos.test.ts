import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Capacity} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {applyPersonalCombo,builtinCombos,findPersonalCombo,writeOwnerCombo} from '../src/personal-combos.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('megapoderoso asks for four standard programmers and two basic ones',()=>{
 const combo=builtinCombos.find(item=>item.name==='megapoderoso');
 assert.ok(combo);
 assert.equal(combo.roles.manager.effort,'xhigh');
 assert.equal(combo.roles.programmer.standard[0]?.count,4);
 assert.equal(combo.roles.programmer.standard[0]?.provider,'codex');
 assert.equal(combo.roles.programmer.basic?.[0]?.count,2);
 assert.equal(combo.roles.programmer.basic?.[0]?.provider,'grok');
 assert.equal(combo.roles.qa?.effort,'medium');
 assert.equal(findPersonalCombo('Megapoderoso',[]).name,'megapoderoso');
 const names=builtinCombos.map(item=>item.name).sort();
 assert.deepEqual(names,['econômico','megapoderoso','padrão','superfoda'].sort());
});

test('owner combo file is mode 600 and overrides a built-in name',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ac-combos-'));
 try{
  const custom=builtinCombos[0]!;
  await writeOwnerCombo(dir,{...custom,name:'padrão',roles:{...custom.roles,programmer:{standard:[{provider:'grok',model:'grok-4.7',effort:'low',count:1}]}}});
  assert.equal((await stat(join(dir,'combos.json'))).mode&0o777,0o600);
  assert.equal(findPersonalCombo('padrão',[{...custom,roles:{...custom.roles,programmer:{standard:[{provider:'grok',model:'grok-4.7',effort:'low',count:1}]}}}]).roles.programmer.standard[0]?.count,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const databaseUrl=process.env.AC_TEST_DATABASE_URL;
test('megapoderoso refuses without Codex and publishes six programmers with Codex',{skip:databaseUrl?false:'AC_TEST_DATABASE_URL is unset'},async()=>{
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
  await assert.rejects(applyPersonalCombo(db,principal,project,'megapoderoso',dir),(error:unknown)=>error instanceof Refusal&&error.code==='CODEX_ACCOUNT_REQUIRED');
  assert.deepEqual(await counts(),before);
  assert.equal((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1',[context])).rows[0].capacity_policy_revision,null);
  await add('codex');
  const applied=await applyPersonalCombo(db,principal,project,'megapoderoso',dir);
  assert.equal(applied.maxProgrammersPerContext,6);
  assert.equal(applied.programmerStandard.length,4);
  assert.equal(applied.programmerBasic.length,2);
  assert.equal(applied.qaModel,true);
  const snapshot=(await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=$2',[project,applied.revision])).rows[0].snapshot;
  assert.equal(snapshot.combo,'megapoderoso');
  assert.equal(snapshot.maxProgrammersPerContext,6);
  assert.equal(snapshot.programmerTiers.standard.length,4);
  assert.equal(snapshot.programmerTiers.basic.length,2);
  assert.equal(snapshot.roles.programmer.regular.length,6);
  assert.deepEqual(snapshot.roles.programmer.regular,[...applied.programmerStandard,...applied.programmerBasic]);
  assert.equal(Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1',[context])).rows[0].capacity_policy_revision),applied.revision);
  const enabled=Number((await db.pool.query("SELECT count(*)::int n FROM ac_profiles WHERE role='programmer' AND enabled")).rows[0].n);
  assert.equal(enabled,6);
 }finally{await db.close();await database.close();await rm(dir,{recursive:true,force:true});}
});
