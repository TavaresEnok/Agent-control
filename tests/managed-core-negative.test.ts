import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {CezarRuntime} from '../src/cezar.ts';
import {ManagerPlans, type ManagerPlan} from '../src/planning.ts';
import {digest} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const policy={schemaVersion:1 as const,requiredReviews:1,allowLowRiskQaWaiver:false,requireJudge:true,requireHumanIntegration:true,verifierDigest:'a'.repeat(64)};

test('managed children cannot change identity or cross contexts, and are never enqueued independently',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'core_negative'),db=new Ledger(isolated.url);
 try{
  await db.migrate();const project=randomUUID(),principal=`core-${randomUUID()}`;
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'isolated managed negative']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID());
  const other=await db.createContext(principal,project,randomUUID());
  const authority=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)',[project,policy,digest(policy)]);
  const plan:ManagerPlan={schemaVersion:1,contextId,objectiveRef:'message:objective',sourceMessageRef:'message:request',constraintRefs:[],tasks:[{
   id:'one',objectiveRef:'message:one',acceptanceRefs:['acceptance:synthetic-effect-v1'],inputRefs:[],outputRefs:['output:one'],dependsOn:[],writePaths:['src/one'],qualityRevision:1,targetRef:'refs/heads/main',maxCorrections:0}]};
  const proposal=await new ManagerPlans(db).publish(principal,authority,0,plan);
  const parent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'managed-synthetic-v1',messageRef:'message:request',proposalRevision:proposal.revision,proposalDigest:proposal.digest}},authority,'api');
  const children=(await db.pool.query('SELECT * FROM ac_intents WHERE parent_intent_id=$1',[parent.id])).rows;
  assert.equal(children.length,1);const child=children[0];assert.equal(child.context_id,contextId);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_outbox WHERE intent_id=$1',[child.id])).rows[0].n,0);
  const boundary={executionEnabled:true,running:true,lock:{},ledger:db} as unknown as CezarRuntime;
  await assert.rejects(CezarRuntime.prototype.dispatch.call(boundary,child,authority),/SUBDELIVERY_DISPATCH_FORBIDDEN/);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE intent_id=$1',[child.id])).rows[0].n,0);
  await assert.rejects(db.pool.query('UPDATE ac_intents SET parent_unit_id=$2 WHERE id=$1',[child.id,'rebound']),/SUBDELIVERY_IDENTITY_IMMUTABLE/);
  await assert.rejects(db.pool.query('UPDATE ac_intents SET parent_intent_id=NULL,parent_unit_id=NULL WHERE id=$1',[child.id]),/SUBDELIVERY_IDENTITY_IMMUTABLE/);
  await assert.rejects(db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id)
   SELECT $1,$2,principal_id,digest,command,$3,$4,manager_epoch,plan_revision,parent_intent_id,$5 FROM ac_intents WHERE id=$6`,
   [randomUUID(),other,randomUUID(),randomUUID(),'cross-context',child.id]),/SUBDELIVERY_PARENT_MISMATCH/);
 }finally{await db.close();await isolated.close();}
});
