import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { Ledger } from '../src/ledger.ts';
import { ContextKeys,keyFingerprint } from '../src/context-keys.ts';

test('key rotation revokes the endpoint and its effect authority without removing the human pause',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.includes('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const keys=new ContextKeys(db);
 const project=randomUUID(),principal='keys-'+randomUUID();
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Keys fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,randomUUID()),key1=randomBytes(32),key2=randomBytes(32);
  await keys.authorize(principal,context,1,'dataKey',keyFingerprint(key1));
  const manager=await db.acquire(principal,context,randomUUID(),'fixture');
  await db.pause(principal,context,true);
  await keys.validate(context,1,'dataKey',key1);
  await keys.authorize(principal,context,2,'dataKey',keyFingerprint(key2));
  await assert.rejects(keys.validate(context,1,'dataKey',key1),/CONTEXT_KEY_UNAUTHORIZED/);
  await assert.rejects(db.heartbeat(manager),/STALE_MANAGER/);
  await keys.validate(context,2,'dataKey',key2);
  assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused,true);
  const successor=await db.acquire(principal,context,randomUUID(),'fixture');assert.equal(successor.epoch,manager.epoch+1);
  await keys.revoke(principal,context,2);
  await assert.rejects(keys.validate(context,2,'dataKey',key2),/CONTEXT_KEY_UNAUTHORIZED/);
  await assert.rejects(db.heartbeat(successor),/STALE_MANAGER/);
 }finally{await db.close();}
});
