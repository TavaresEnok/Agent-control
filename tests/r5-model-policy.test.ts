import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {Projects} from '../src/projects.ts';
import {Capacity} from '../src/capacity.ts';
import {digest} from '../src/contracts.ts';
import {assertModelAllowed,modelDisabledByPolicy} from '../src/model-policy.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
test('explicit Astra aliases are blocked and unrelated names remain distinct',()=>{
 for(const model of ['astra','GPT-6-ASTRA','gpt-6.1-astra','OpenAI/GPT-6-ASTRA','codex:astra']){assert(modelDisabledByPolicy(model));assert.throws(()=>assertModelAllowed(model),/ModelDisabledByPolicy/);}
 for(const model of ['astral','gpt-6.1-sol','unknown-astra-alias'])assert(!modelDisabledByPolicy(model));
});
test('legacy prohibited models, unapproved effort and removed accounts fail policy and admission without changing quota',async()=>{
 const url=process.env.AC_R5_GRAPH_DATABASE_URL;if(!url?.endsWith('/ac_r5_mobile_graph'))throw Error('DISPOSABLE_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const root=await mkdtemp('/tmp/ac-r5-policy-'),repo=join(root,'repo');
 try{
  await mkdir(repo,{mode:0o700});execFileSync('git',['init',repo],{stdio:'ignore'});await chmod(join(repo,'.git'),0o700);
  const project=randomUUID(),principal='policy-'+randomUUID();await new Projects(db).register([{id:project,label:'policy',repo,owner:principal}],principal);
  await provisionCapacity(db,principal,project);const capacity=new Capacity(db);
  await assert.rejects(capacity.registerModel('synthetic-capacity-administrator',{provider:'synthetic',model:'OpenAI/GPT-6-ASTRA',efforts:['medium'],roles:['programmer'],source:'synthetic://fixture'}),/ModelDisabledByPolicy/);
  const account=(await db.pool.query('SELECT account_id FROM ac_account_access WHERE project_id=$1',[project])).rows[0].account_id;
  const originalQuota=(await db.pool.query('SELECT * FROM ac_quota_observations WHERE account_id=$1',[account])).rows[0];
  // Simulate rows accepted by an older release, without enabling a real account.
  await db.pool.query("INSERT INTO ac_model_catalog VALUES('synthetic','GPT-6-ASTRA',ARRAY['medium'],ARRAY['programmer'],'synthetic://legacy')");
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$4,'GPT-6-ASTRA','medium','programmer',true),($2,$4,'fixed-worker-v1','high','programmer',true),($3,$4,'fixed-worker-v1','medium','programmer',true)",[...ids,account]);
  await assert.rejects(capacity.addProfile(principal,project,{id:randomUUID(),accountId:account,model:'codex:astra',effort:'medium',role:'programmer'}),/ModelDisabledByPolicy/);
  const makePolicy=(id:string)=>({schemaVersion:1 as const,maxProgrammersPerContext:1,maxEvaluatorsPerContext:1,roles:{programmer:{regular:[id],emergency:[]}}});
  await assert.rejects(capacity.publish(principal,project,1,makePolicy(ids[0])),/ModelDisabledByPolicy/);
  await assert.rejects(capacity.publish(principal,project,1,makePolicy(ids[1])),/MODEL_EFFORT_NOT_IN_CATALOG/);
  // Insert old policy snapshots to check admission remains closed after upgrade.
  for(let i=0;i<3;i++)await db.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,$2,$3,$4,$5)',[project,i+2,digest(makePolicy(ids[i])),makePolicy(ids[i]),principal]);
  for(let i=0;i<3;i++){
   const context=await db.createContext(principal,project,randomUUID());await db.pool.query('UPDATE ac_contexts SET capacity_policy_revision=$2 WHERE id=$1',[context,i+2]);
   const authority=await db.acquire(principal,context,randomUUID(),'policy-fixture',60);
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'synthetic:policy'}},authority,'api');
   if(i===2){await db.pool.query('DELETE FROM ac_account_access WHERE account_id=$1 AND project_id=$2',[account,project]);await assert.rejects(capacity.publish(principal,project,4,makePolicy(ids[i])),/POLICY_PROFILE_FORBIDDEN/);}
   const attemptId=randomUUID();await assert.rejects(capacity.reserve(principal,{attemptId,contextId:context,intentId:intent.id,role:'programmer'},authority),/NO_ELIGIBLE_CAPACITY/);
   const wait=(await db.pool.query('SELECT exclusions FROM ac_capacity_waits WHERE attempt_id=$1',[attemptId])).rows[0];assert.equal(wait.exclusions[0].reason,['model_disabled_by_policy','model_effort_not_in_catalog','access_removed'][i]);
   assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE attempt_id=$1',[attemptId])).rows[0].n,0);
  }
  assert.deepEqual((await db.pool.query('SELECT * FROM ac_quota_observations WHERE account_id=$1',[account])).rows[0],originalQuota);
 }finally{await db.pool.end();await rm(root,{recursive:true,force:true});}
});
