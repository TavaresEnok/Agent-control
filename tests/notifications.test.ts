import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Notifications} from '../src/notifications.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('durable completion batching and immediate blockers land once in the personal transcript, fenced by the manager lease',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'notices'),ledger=new Ledger(database.url);
 const principal='notification-fixture-'+randomUUID(),project=randomUUID(),session='synthetic-notifications-'+randomUUID(),key=randomBytes(32);
 try{
  await ledger.migrate();await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Notification fixture']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await ledger.createContext(principal,project,session),authority=await ledger.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const notices=new Notifications(ledger,{completionWindowMs:1000,maxBatchSize:20,maxDeliveriesPerTick:10});
  const said:{localId:string;text:string}[]=[];const onText=(localId:string,text:string)=>{said.push({localId,text});};
  const transcript=async()=>(await ledger.pool.query("SELECT local_id,text,accepted FROM ac_personal_messages WHERE context_id=$1 AND role='manager' ORDER BY seq",[context])).rows;
  const first={entityId:randomUUID(),source:'runtime' as const,planRevision:1,seq:4,status:'done' as const};
  const second={...first,entityId:randomUUID(),planRevision:2};
  await notices.observe(principal,authority,session,first);await notices.observe(principal,authority,session,second);
  assert.equal((await notices.observe(principal,authority,session,{...first,seq:5})).duplicate,true);
  // Completions wait for their window; nothing is written yet.
  assert.deepEqual(await notices.flushToPersonal(principal,authority,session,onText),{messages:0,observations:0});
  await notices.observe(principal,authority,session,{entityId:randomUUID(),source:'runtime',planRevision:3,seq:1,status:'waiting',reason:'STORAGE_LOW_SPACE'});
  // A blocker is published immediately, alone.
  assert.deepEqual(await notices.flushToPersonal(principal,authority,session,onText),{messages:1,observations:1});
  let rows=await transcript();assert.equal(rows.length,1);assert.match(rows[0].text,/espaço em disco/);assert.equal(rows[0].accepted,true);
  await new Promise(resolve=>setTimeout(resolve,1050));
  assert.deepEqual(await notices.flushToPersonal(principal,authority,session,onText),{messages:1,observations:2});
  assert.deepEqual(await notices.flushToPersonal(principal,authority,session,onText),{messages:0,observations:0});
  rows=await transcript();assert.equal(rows.length,2);assert.match(rows[1].text,/2 conclusão/);
  assert.deepEqual(said.map(item=>item.localId),rows.map(row=>row.local_id));
  const pending=(await ledger.pool.query('SELECT * FROM ac_notification_items')).rows;
  assert.equal(pending.length,3);assert(pending.every(item=>item.local_message_id&&!item.message_id));
  assert.equal(new Set(pending.filter(item=>item.kind==='completion').map(item=>item.local_message_id)).size,1);
  await assert.rejects(notices.flushToPersonal(principal,authority,'wrong-session',onText),/SESSION_CONTEXT_MISMATCH/);
  await ledger.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  // Authorizing a key deliberately expires the current manager lease.
  await new ContextKeys(ledger).authorize(principal,context,1,'legacy',keyFingerprint(key));
  const successor=await ledger.acquire(principal,context,randomUUID(),'synthetic-successor',60);
  await assert.rejects(notices.observe(principal,authority,session,{...first,seq:6,status:'failed'}),/STALE_MANAGER/);
  await assert.rejects(notices.flushToPersonal(principal,authority,session,onText),/STALE_MANAGER/);
  await notices.observe(principal,successor,session,{entityId:context,source:'manager',planRevision:0,seq:0,status:'blocked',reason:'RECONCILIATION_REQUIRED'});
  assert.deepEqual(await notices.flushToPersonal(principal,successor,session,onText),{messages:1,observations:1});
  assert.equal((await transcript()).length,3);
 }finally{key.fill(0);await ledger.close();await database.close();}
});
