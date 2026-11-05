import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Admission} from '../src/admission.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('global closed admission refuses new effects while allowing reconciliation and preserves context pause',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.includes('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const project=randomUUID(),principal='admission-'+randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Admission fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  const context=await db.createContext(principal,project,randomUUID()),authority=await db.acquire(principal,context,randomUUID(),'manager',60);
  const admission=new Admission(db);const current=(await db.pool.query('SELECT revision FROM ac_admission_control WHERE id=1')).rows[0].revision;
  const closed=await admission.set(principal,{enabled:false,expectedRevision:current,reason:'synthetic-backup'});
  await assert.rejects(db.tx(c=>db.fence(c,authority)),/ADMISSION_CLOSED/);
  await db.tx(c=>db.fence(c,authority,true));
  await db.pause(principal,context,true);
  // Explicit test cleanup avoids touching any capacity objects from other fixtures.
  await db.pool.query('UPDATE ac_admission_control SET enabled=true,revision=revision+1 WHERE id=1');
  await assert.rejects(db.tx(c=>db.fence(c,authority)),/HUMAN_PAUSED/);
  assert.equal(closed.enabled,false);
 }finally{await db.close();}
});

test('restored admission cannot be reopened or relabelled using only the older database',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'restoregate'),db=new Ledger(fixture.url),principal='synthetic-restore-admin';
 try{
  await db.migrate();await db.pool.query('INSERT INTO ac_control_admins VALUES($1)',[principal]);
  await db.pool.query("UPDATE ac_admission_control SET enabled=false,reason='r3-restored-awaiting-reconciliation' WHERE id=1");
  const revision=(await db.pool.query('SELECT revision FROM ac_admission_control WHERE id=1')).rows[0].revision,admission=new Admission(db);
  await assert.rejects(admission.set(principal,{enabled:true,expectedRevision:revision,reason:'resume'}),/RESTORE_PHYSICAL_RECONCILIATION_REQUIRED/);
  await assert.rejects(admission.set(principal,{enabled:false,expectedRevision:revision,reason:'replace marker'}),/RESTORE_PHYSICAL_RECONCILIATION_REQUIRED/);
  assert.deepEqual((await db.pool.query('SELECT enabled,reason,revision FROM ac_admission_control WHERE id=1')).rows[0],{enabled:false,reason:'r3-restored-awaiting-reconciliation',revision});
 }finally{await db.close();await fixture.close();}
});
