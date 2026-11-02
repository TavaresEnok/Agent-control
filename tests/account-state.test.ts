import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Control,type ControlCommand} from '../src/control.ts';
import {Operators,operatorMessage} from '../src/operator.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import type {Command} from '../src/contracts.ts';
import type {z} from 'zod';
test('signed account/profile state changes stop new grants, preserve uncertain work and reject stale revisions',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const project=randomUUID(),principal='account-state-'+randomUUID();
 let admissionSnapshot:{enabled:boolean;reason:string}|undefined;
 const restoreFixture=async()=>{
  if(!admissionSnapshot)return;
  // Restore only this test's global fixture setting, never release a grant or
  // claim that the product reconciliation gate allowed reopening.
  await db.pool.query('UPDATE ac_admission_control SET enabled=$1,reason=$2,revision=revision+1,updated_at=now() WHERE id=1',
   [admissionSnapshot.enabled,admissionSnapshot.reason]);admissionSnapshot=undefined;
 };
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Account state fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const capacity=await provisionCapacity(db,principal,project),contextId=await db.createContext(principal,project,randomUUID());
  await capacity.service.assignPolicy(principal,contextId,capacity.revision);
  const authority=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:account-state'}} satisfies Command,authority,'api');
  const request=()=>({attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer' as const});
  const grant=await capacity.service.reserve(principal,request(),authority);
  await capacity.service.transition(principal,grant.id,authority,'running');await capacity.service.transition(principal,grant.id,authority,'uncertain');
  const keys=generateKeyPairSync('ed25519'),deviceId=randomUUID(),control=new Control(db);
  await new Operators(db).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const apply=(command:z.input<typeof ControlCommand>)=>{const data={deviceId,expiresAt:Date.now()+120000};return control.execute(principal,command,
   {...data,signature:sign(null,Buffer.from(operatorMessage(principal,command,data,installationId)),keys.privateKey).toString('hex')});};
  const command=(action:'account.state'|'profile.state',id:string,enabled:boolean,expectedRevision:number)=>({schemaVersion:1 as const,intentId:randomUUID(),
   deliveryAttemptId:randomUUID(),contextId,action,payload:{id,enabled,expectedRevision}});
  const admission=async(enabled:boolean)=>{const revision=(await db.pool.query('SELECT revision FROM ac_admission_control WHERE id=1')).rows[0].revision;
   return apply({schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'admission.set',
    payload:{enabled,expectedRevision:revision,reason:'synthetic-account-state-test'}});};
  admissionSnapshot=(await db.pool.query('SELECT enabled,reason FROM ac_admission_control WHERE id=1')).rows[0];
  await admission(false);
  const disable=command('account.state',grant.account_id,false,1),first=await apply(disable);
  assert.deepEqual(await apply({...disable,deliveryAttemptId:randomUUID()}),first);
  await assert.rejects(apply(command('account.state',grant.account_id,true,2)),/ADMISSION_CLOSED/);
  await assert.rejects(admission(true),/RECONCILIATION_REQUIRED/);
  await restoreFixture();
  await assert.rejects(apply(command('account.state',grant.account_id,true,1)),/ACCOUNT_PROFILE_REVISION_CONFLICT/);
  await assert.rejects(capacity.service.reserve(principal,request(),authority),/NO_ELIGIBLE_CAPACITY/);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'uncertain');
  await apply(command('account.state',grant.account_id,true,2));
  await apply(command('profile.state',grant.profile_id,false,1));
  await assert.rejects(capacity.service.reserve(principal,request(),authority),/NO_ELIGIBLE_CAPACITY/);
  await apply(command('profile.state',grant.profile_id,true,2));
  const next=await capacity.service.reserve(principal,request(),authority);assert.equal(next.profile_id,grant.profile_id);
  await capacity.service.transition(principal,next.id,authority,'released',{processId:'synthetic-not-started',state:'not_started'});
  await capacity.service.transition(principal,grant.id,authority,'released',{processId:'synthetic-exited',state:'exited'});
  const view=await control.view(principal,contextId);
  assert.equal(view.accounts[0].revision,3);assert.equal(view.profiles[0].revision,3);
  assert.equal(view.accounts[0].can_manage,true);assert.equal(view.profiles[0].can_manage,true);
  const viewer='state-viewer-'+randomUUID();await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[project,viewer]);
  const read=await control.view(viewer,contextId);assert.equal(read.accounts[0].can_manage,false);assert.equal(read.profiles[0].can_manage,false);
 }finally{await restoreFixture();await db.close();}
});
