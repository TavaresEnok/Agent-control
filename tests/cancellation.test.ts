import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Control} from '../src/control.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {Cancellations} from '../src/cancellation.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import {SandboxClient} from '../src/sandbox-client.ts';

test('signed cancellation blocks effects and confirms only never-started or physically reconciled grants',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const principal='cancel-'+randomUUID(),project=randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Cancellation fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  const fixture=await provisionCapacity(db,principal,project);await fixture.service.assignPolicy(principal,contextId,fixture.revision);
  const deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');await db.pool.query('INSERT INTO ac_control_admins VALUES($1) ON CONFLICT DO NOTHING',[principal]);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installation=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const proof=(command:Record<string,unknown>)=>{const p={deviceId,expiresAt:Date.now()+120000};return {...p,signature:sign(null,Buffer.from(operatorMessage(principal,command,p,installation)),keys.privateKey).toString('hex')};};
  const control=new Control(db),service=new Cancellations(db);let cancelCalls=0;
  for(const uncertain of [false,true]){
   const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',
    payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:cancellation-fixture'}},authority,'api');
   const grant=await fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},authority);
   await fixture.service.observeQuota(principal,grant.account_id,{status:'exhausted',source:'synthetic://cancel-wait-fixture',ttlSeconds:3600});
   await assert.rejects(fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},authority),/NO_ELIGIBLE_CAPACITY/);
   await fixture.service.observeQuota(principal,grant.account_id,{status:'available',source:'synthetic://cancel-wait-fixture',ttlSeconds:3600});
   await db.pool.query('UPDATE ac_operations SET grant_id=$2 WHERE id=$1',[intent.operation_id,grant.id]);
   if(uncertain){
    await db.pool.query("UPDATE ac_operations SET state='uncertain' WHERE id=$1",[intent.operation_id]);
    await db.pool.query("UPDATE ac_capacity_grants SET state='uncertain' WHERE id=$1",[grant.id]);
   }
   const command={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'plan.cancel' as const,
    payload:{intentId:intent.id,planRevision:intent.plan_revision}};
   const wrong={...command,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{...command.payload,planRevision:intent.plan_revision+1}};
   await assert.rejects(control.execute(principal,wrong,proof(wrong)),/PLAN_REVISION_MISMATCH/);
   const result=await control.execute(principal,command,proof(command));
   assert.equal((await db.pool.query('SELECT count(*) n FROM ac_capacity_waits WHERE intent_id=$1',[intent.id])).rows[0].n,'0','canceled waits cannot strand the FIFO while physical work remains uncertain');
   assert.deepEqual(await control.execute(principal,{...command,deliveryAttemptId:randomUUID()},proof(command)),result);
   await assert.rejects(fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},authority),/PLAN_CANCELLATION_REQUESTED/);
   await service.reconcile(authority,()=>{cancelCalls++;});
   const state=(await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[intent.id])).rows[0].state;
   assert.equal(state,uncertain?'requested':'confirmed');
   const physical=(await db.pool.query('SELECT state,physical_receipt FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0];
   assert.equal(physical.state,uncertain?'uncertain':'released');
   if(uncertain){
    assert.equal(physical.physical_receipt,null,'a stop request cannot fabricate physical exit');
    await db.pool.query(`INSERT INTO ac_sandbox_jobs(id,context_id,grant_id,manager_epoch,profile,spec_digest,state)
     VALUES($1,$2,$3,$4,'synthetic-probe-v1',$5,'uncertain')`,[intent.operation_id,contextId,grant.id,authority.epoch,'synthetic-cancel-fixture']);
    const receipt={jobId:intent.operation_id,containerId:'a'.repeat(64),exitCode:137,synthetic:true};
    class ForgedStop extends SandboxClient{override async perform(){return receipt;}}
    await assert.rejects(service.reconcileSandbox(authority,new ForgedStop()),/CANCELLATION_PHYSICAL_RECEIPT_UNCONFIRMED/);
    assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'uncertain');
    // Contract stub, not a Docker proof: only the trusted broker may persist these receipts.
    class ConfirmedStop extends SandboxClient{override async perform(){
     await db.pool.query("UPDATE ac_sandbox_jobs SET state='failed',receipt=$2 WHERE id=$1",[intent.operation_id,receipt]);
     await db.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[grant.id,receipt]);
     return receipt;
    }}
    await service.reconcileSandbox(authority,new ConfirmedStop());await service.reconcile(authority,()=>{});
    assert.equal((await db.pool.query('SELECT state FROM ac_plan_cancellations WHERE intent_id=$1',[intent.id])).rows[0].state,'confirmed');
    assert.equal((await db.pool.query('SELECT receipt FROM ac_operations WHERE id=$1',[intent.operation_id])).rows[0].receipt.cancellation,true);
   }
   const viewer='viewer-'+randomUUID();await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[project,viewer]);
   await assert.rejects(control.execute(viewer,command,proof(command)),/CONTEXT_FORBIDDEN/);
  }
  assert.equal(cancelCalls,2);
 }finally{await db.close();}
});
