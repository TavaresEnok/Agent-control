import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,generateKeyPairSync,sign } from 'node:crypto';
import { Operators,operatorMessage } from '../src/operator.ts';
import { Ledger } from '../src/ledger.ts';
import { Control, type ControlCommand } from '../src/control.ts';
import type { z } from 'zod';

test('control intent, mutation and delivery are atomic across retries and conflicts',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.includes('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const ledger=new Ledger(url);await ledger.migrate();const control=new Control(ledger);
 const project=randomUUID(),principal='control-'+randomUUID();
 try{
  await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Control fixture']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const operator=new Operators(ledger),deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');
  await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await operator.enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installationId=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const proof=(value:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,value,data,installationId)),keys.privateKey).toString('hex')};};
  const context=await ledger.createContext(principal,project,randomUUID());
  const command:z.input<typeof ControlCommand>={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,
   action:'account.add',payload:{id:randomUUID(),provider:'synthetic',label:'Fixture',resourceIdentity:'control-fixture-'+randomUUID(),
   mode:'synthetic',eligibility:'not_assessed',eligibilitySource:'synthetic://fixture',maxConcurrent:1}};
  const result=await control.execute(principal,command,proof(command));
  const duplicate=await control.execute(principal,{...command,deliveryAttemptId:randomUUID()},proof(command));assert.deepEqual(duplicate,result);
  const altered={...command,payload:{...command.payload,label:'Changed'}};
  await assert.rejects(control.execute(principal,altered,proof(altered)),/CONTROL_INTENT_CONFLICT/);
  const conflicting={...command,intentId:randomUUID(),payload:{...command.payload,id:randomUUID(),resourceIdentity:'another-'+randomUUID()}};
  await assert.rejects(control.execute(principal,conflicting,proof(conflicting)),/CONTROL_DELIVERY_CONFLICT/);
  const view=await control.view(principal,context);assert.equal(view.accounts.length,1);
  assert.equal(view.canConfigureCapacity,true);
  const viewer='viewer-'+randomUUID();await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'viewer')",[project,viewer]);
  const readonly=await control.view(viewer,context);assert.equal(readonly.canConfigureCapacity,false);
  assert.equal(readonly.capacity?.originalFallback??null,null);
  assert.equal((await ledger.pool.query('SELECT count(*) n FROM ac_control_intents WHERE context_id=$1',[context])).rows[0].n,'1');
  assert(!JSON.stringify(view).includes('resource_identity'),'private resource identifiers are not exposed in the view');
 }finally{await ledger.close();}
});

test('signed pause is deduplicated and stale commands cannot undo a newer decision',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const ledger=new Ledger(url);await ledger.migrate();const control=new Control(ledger),project=randomUUID(),principal='pause-'+randomUUID();
 try{
  await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Pause fixture']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const deviceId=randomUUID(),keys=generateKeyPairSync('ed25519');await ledger.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await new Operators(ledger).enroll(principal,principal,deviceId,keys.publicKey.export({format:'der',type:'spki'}).toString('base64'));
  const installationId=(await ledger.pool.query('SELECT id FROM ac_installation_identity WHERE singleton=true')).rows[0].id;
  const contextId=await ledger.createContext(principal,project,randomUUID());
  const proof=(value:Record<string,unknown>)=>{const data={deviceId,expiresAt:Date.now()+120000};return {...data,signature:sign(null,Buffer.from(operatorMessage(principal,value,data,installationId)),keys.privateKey).toString('hex')};};
  const pause={schemaVersion:1 as const,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,action:'context.pause' as const,payload:{paused:true,expectedRevision:0}};
  const first=await control.execute(principal,pause,proof(pause));
  assert.deepEqual(await control.execute(principal,{...pause,deliveryAttemptId:randomUUID()},proof(pause)),first);
  const resume={...pause,intentId:randomUUID(),deliveryAttemptId:randomUUID(),payload:{paused:false,expectedRevision:1}};
  await control.execute(principal,resume,proof(resume));
  const stale={...pause,intentId:randomUUID(),deliveryAttemptId:randomUUID()};
  await assert.rejects(control.execute(principal,stale,proof(stale)),/PAUSE_REVISION_CONFLICT/);
  const row=(await ledger.pool.query('SELECT paused,pause_revision FROM ac_contexts WHERE id=$1',[contextId])).rows[0];
  assert.deepEqual(row,{paused:false,pause_revision:2});
 }finally{await ledger.close();}
});
