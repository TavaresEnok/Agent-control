import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Notifications} from '../src/notifications.ts';
import {loadHappier,HappierEndpoint} from '../src/happier.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Socket} from 'socket.io-client';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('durable completion batching and immediate blockers use one encrypted outbox with fenced retry receipts',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const database=await isolatedDatabase(base,'notices'),ledger=new Ledger(database.url),native=await loadHappier();
 const principal='notification-fixture-'+randomUUID(),project=randomUUID(),session='synthetic-notifications-'+randomUUID(),key=randomBytes(32);
 try{
  await ledger.migrate();await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Notification fixture']);
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await ledger.createContext(principal,project,session),authority=await ledger.acquire(principal,context,randomUUID(),'synthetic-manager',60);
  const notices=new Notifications(ledger,{completionWindowMs:1000,maxBatchSize:20,maxDeliveriesPerTick:10});
  const seal=(value:unknown)=>native.encodeBase64(native.encrypt(key,'legacy',value));
  const decode=(ciphertext:string)=>native.decrypt(key,'legacy',native.decodeBase64(ciphertext)) as {content:{data:{message:{content:{text:string}[]}}}};
  const first={entityId:randomUUID(),source:'runtime' as const,planRevision:1,seq:4,status:'done' as const};
  const second={...first,entityId:randomUUID(),planRevision:2};
  await notices.observe(principal,authority,session,first);await notices.observe(principal,authority,session,second);
  assert.equal((await notices.observe(principal,authority,session,{...first,seq:5})).duplicate,true);
  assert.deepEqual(await notices.flush(principal,authority,session,seal),{messages:0,observations:0});
  await notices.observe(principal,authority,session,{entityId:randomUUID(),source:'runtime',planRevision:3,seq:1,status:'waiting',reason:'STORAGE_LOW_SPACE'});
  assert.deepEqual(await notices.flush(principal,authority,session,seal),{messages:1,observations:1});
  const blocker=(await ledger.pool.query('SELECT * FROM ac_chat_messages')).rows[0];
  assert.equal(blocker.priority,50);assert.match(decode(blocker.ciphertext).content.data.message.content[0].text,/espaço em disco/);
  await new Promise(resolve=>setTimeout(resolve,1050));
  assert.deepEqual(await notices.flush(principal,authority,session,seal),{messages:1,observations:2});
  assert.deepEqual(await notices.flush(principal,authority,session,seal),{messages:0,observations:0});
  const messages=(await ledger.pool.query('SELECT * FROM ac_chat_messages ORDER BY priority DESC,sequence')).rows;
  assert.equal(messages.length,2);assert.match(decode(messages[1].ciphertext).content.data.message.content[0].text,/2 conclusão/);
  const pending=(await ledger.pool.query('SELECT * FROM ac_notification_items')).rows;
  assert.equal(pending.length,3);assert.equal(new Set(pending.filter(item=>item.kind==='completion').map(item=>item.message_id)).size,1);
  const durable=JSON.stringify({messages,pending,cursors:(await ledger.pool.query('SELECT * FROM ac_notification_cursors')).rows});
  assert(!durable.includes('Atualização agrupada'));assert(!durable.includes('aguardando espaço em disco'));assert(!durable.includes('execução concluída'));
  await ledger.pause(principal,context,true);
  const provider=new Map<string,{ciphertext:string;id:string;seq:number}>();let deliveryCalls=0;
  const publication=async(message:{localId:string;ciphertext:string})=>{
   deliveryCalls++;let receipt=provider.get(message.localId),didWrite=false;
   if(!receipt){receipt={ciphertext:message.ciphertext,id:randomUUID(),seq:provider.size+1};provider.set(message.localId,receipt);didWrite=true;}
   assert.equal(receipt.ciphertext,message.ciphertext);
   return {ok:true as const,id:receipt.id,seq:receipt.seq,localId:message.localId,didWrite};
  };
  await assert.rejects(notices.deliver(principal,authority,session,async message=>{await publication(message);return {};}),/HAPPIER_PUBLICATION_UNCONFIRMED/);
  assert.equal((await ledger.pool.query('SELECT count(*)::int total FROM ac_chat_publication_receipts')).rows[0].total,0);
  await assert.rejects(notices.deliver(principal,authority,session,async message=>{await publication(message);throw Error('SYNTHETIC_ACK_LOST_AFTER_NATIVE_IDEMPOTENT_WRITE');}),/SYNTHETIC_ACK_LOST/);
  assert.equal((await ledger.pool.query('SELECT count(*)::int total FROM ac_chat_messages WHERE sent')).rows[0].total,0);
  assert.deepEqual(await notices.deliver(principal,authority,session,publication),{sent:2});
  assert.equal(provider.size,2);assert.equal(deliveryCalls,4);
  assert.equal((await ledger.pool.query('SELECT count(*)::int total FROM ac_chat_publication_receipts')).rows[0].total,2);
  assert.deepEqual(await notices.deliver(principal,authority,session,publication),{sent:0});
  await assert.rejects(ledger.pool.query('UPDATE ac_chat_publication_receipts SET provider_seq=999'),/POLICY_REVISION_IMMUTABLE/);
  assert.equal((await ledger.pool.query('SELECT ciphertext FROM ac_chat_messages WHERE id=$1',[blocker.id])).rows[0].ciphertext,blocker.ciphertext);
  await assert.rejects(notices.flush(principal,authority,'wrong-session',seal),/SESSION_CONTEXT_MISMATCH/);
  await ledger.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[context]);
  // Authorizing a key deliberately expires the current manager lease.
  await new ContextKeys(ledger).authorize(principal,context,1,'legacy',keyFingerprint(key));
  const successor=await ledger.acquire(principal,context,randomUUID(),'synthetic-successor',60);
  await assert.rejects(notices.observe(principal,authority,session,{...first,seq:6,status:'failed'}),/STALE_MANAGER/);
  await assert.rejects(notices.deliver(principal,authority,session,publication),/STALE_MANAGER/);
  await notices.observe(principal,successor,session,{entityId:context,source:'manager',planRevision:0,seq:0,status:'blocked',reason:'RECONCILIATION_REQUIRED'});
  assert.deepEqual(await notices.flush(principal,successor,session,seal),{messages:1,observations:1});
  // Exercise the actual existing heartbeat without a network/account/model:
  // the native crypto boundary remains real; only transport/runtime dispatch
  // are intercepted. There are no execution intents in this fixture.
  const socket={connected:true,onAny(){},on(){return this;},emit(){},disconnect(){}} as unknown as Socket;
  const runtime={repo:'/tmp/notification-fixture',async reconcileCancellations(){},async recoverManaged(){}} as unknown as CezarRuntime;
  const endpoint=new HappierEndpoint(ledger,runtime,{...native,
   createSessionSocketTransport:()=>({socket,transport:{async connect(){}}}),
   materializeNextPendingQueueV2Message:async()=>({didMaterialize:false})},
   {baseUrl:'http://127.0.0.1:1',token:'synthetic-unused-transport-token',key,principal,sessionId:session,machineId:randomUUID(),authority:successor});
  // Match the existing Happier wire property to the intercepted publisher.
  endpoint.ack=async(event,data)=>{
   if(event!=='message')return {status:'unchanged',projection:{revision:1}};
   const wire=data as {sid:string;localId:string;message:string};assert.equal(wire.sid,session);
   return publication({localId:wire.localId,ciphertext:wire.message});
  };
  try{await endpoint.tick();}finally{endpoint.close();}
  assert.equal(provider.size,3);
  assert.equal((await ledger.pool.query('SELECT count(*)::int total FROM ac_chat_messages WHERE NOT sent')).rows[0].total,0);
  assert.equal((await ledger.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused,true);
 }finally{key.fill(0);await ledger.close();await database.close();}
});
