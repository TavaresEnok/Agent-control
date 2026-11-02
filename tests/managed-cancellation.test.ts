import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Cancellations} from '../src/cancellation.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('managed cancellation waits for an uncertain child and rejects a stale manager',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const principal='managed-cancel-'+randomUUID(),project=randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Managed cancellation fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  const fixture=await provisionCapacity(db,principal,project);await fixture.service.assignPolicy(principal,contextId,fixture.revision);
  const parent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:managed-cancel'}},authority,'api');
  const child=randomUUID(),operation=randomUUID();
  await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,parent_intent_id,parent_unit_id)
   SELECT $2,context_id,principal_id,digest,command,$3,$4,manager_epoch,plan_revision,id,'unit' FROM ac_intents WHERE id=$1`,[parent.id,child,operation,randomUUID()]);
  await db.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch) VALUES($1,$2,'registered',$3)",[operation,child,authority.epoch]);
  const grant=await fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:child,contextId,role:'programmer'},authority);
  await db.pool.query("UPDATE ac_operations SET state='uncertain',grant_id=$2 WHERE id=$1",[operation,grant.id]);
  await db.pool.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[grant.id]);
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[parent.id,contextId,principal,parent.plan_revision]);
  const service=new Cancellations(db);await service.reconcile(authority,()=>{});
  let states=(await db.pool.query('SELECT intent_id,state FROM ac_plan_cancellations WHERE intent_id=ANY($1::uuid[])',[[parent.id,child]])).rows;
  assert.deepEqual(states.map(x=>x.state),['requested','requested']);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'uncertain');
  await assert.rejects(service.reconcile({...authority,epoch:authority.epoch-1},()=>{}));
  // Fixture simulates already reconciled physical evidence; no broker stop is claimed here.
  await db.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[grant.id,{state:'physical_exit'}]);
  await db.pool.query("UPDATE ac_operations SET state='completed',receipt=$2 WHERE id=$1",[operation,{state:'physical_exit'}]);
  await service.reconcile(authority,()=>{});await service.reconcile(authority,()=>{});
  states=(await db.pool.query('SELECT intent_id,state FROM ac_plan_cancellations WHERE intent_id=ANY($1::uuid[])',[[parent.id,child]])).rows;
  assert.deepEqual(states.map(x=>x.state),['confirmed','confirmed']);
  const prepared=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:prepared-cancel'}},authority,'api');
  const preparedGrant=await fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:prepared.id,contextId,role:'programmer'},authority);
  await db.pool.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1',[prepared.operation_id,preparedGrant.id]);
  await db.pool.query('INSERT INTO ac_execution_launches(operation_id,context_id,manager_epoch,snapshot,digest) VALUES($1,$2,$3,$4,$5)',
   [prepared.operation_id,contextId,authority.epoch,{fixture:'persisted-launch'},'fixture-digest']);
  await db.pool.query('INSERT INTO ac_plan_cancellations(intent_id,context_id,requested_by,plan_revision) VALUES($1,$2,$3,$4)',[prepared.id,contextId,principal,prepared.plan_revision]);
  await service.reconcile(authority,()=>{});
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[preparedGrant.id])).rows[0].state,'reserved');
  assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[prepared.id])).rows[0].state,'requested');
 }finally{await db.close();}
});
