import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const context=await ledger.createContext(principal,project,randomUUID());
  const command:z.input<typeof ControlCommand>={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,
   action:'account.add',payload:{id:randomUUID(),provider:'synthetic',label:'Fixture',resourceIdentity:'control-fixture-'+randomUUID(),
   mode:'synthetic',eligibility:'not_assessed',eligibilitySource:'synthetic://fixture',maxConcurrent:1}};
  const result=await control.execute(principal,command);
  const duplicate=await control.execute(principal,{...command,deliveryAttemptId:randomUUID()});assert.deepEqual(duplicate,result);
  await assert.rejects(control.execute(principal,{...command,payload:{...command.payload,label:'Changed'}}),/CONTROL_INTENT_CONFLICT/);
  await assert.rejects(control.execute(principal,{...command,intentId:randomUUID(),payload:{...command.payload,id:randomUUID(),resourceIdentity:'another-'+randomUUID()}}),/CONTROL_DELIVERY_CONFLICT/);
  const view=await control.view(principal,context);assert.equal(view.accounts.length,1);
  assert.equal((await ledger.pool.query('SELECT count(*) n FROM ac_control_intents WHERE context_id=$1',[context])).rows[0].n,'1');
  assert(!JSON.stringify(view).includes('resource_identity'),'private resource identifiers are not exposed in the view');
 }finally{await ledger.close();}
});
