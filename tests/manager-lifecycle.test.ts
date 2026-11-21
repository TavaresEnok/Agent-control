import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {ManagerRegistry} from '../src/managers.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('stuck manager start times out or stops; successor remains fenced and keys isolated',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(url,'lifecycle'),db=new Ledger(fixture.url);const registries:ManagerRegistry[]=[];
 try{
  await db.migrate();const project=randomUUID(),principal='lifecycle-'+randomUUID(),key=randomBytes(32),original=Buffer.from(key);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic lifecycle']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,randomUUID());
  const session=(await db.pool.query('SELECT session_id FROM ac_session_links WHERE context_id=$1',[context])).rows[0].session_id;
  await new ContextKeys(db).authorize(principal,context,1,'legacy',keyFingerprint(key));
  const request={principal,contextId:context,sessionId:session,profileId:'synthetic',keyVersion:1,encryptionVariant:'legacy' as const,key};
  const prior=await db.acquire(principal,context,randomUUID(),'fixture'),capacity=await provisionCapacity(db,principal,project);
  await capacity.service.assignPolicy(principal,context,capacity.revision);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic'}},prior,'api');
  const grant=await capacity.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},prior);
  await capacity.service.transition(principal,grant.id,prior,'uncertain');await db.pause(principal,context,true);
  await db.pool.query('UPDATE ac_managers SET lease_until=clock_timestamp() WHERE context_id=$1',[context]);
  let resolveFactory!:(v:{start():Promise<void>;close():void})=>void,lateCloses=0;
  const pending=new Promise<{start():Promise<void>;close():void}>(resolve=>{resolveFactory=resolve;});
  const registry=new ManagerRegistry(db,project,()=>pending,{startupTimeoutMs:50,closeTimeoutMs:100});registries.push(registry);
  await assert.rejects(registry.start(request),/MANAGER_START_TIMEOUT/);
  const successor=new ManagerRegistry(db,project,()=>({async start(){},close(){}}),{startupTimeoutMs:100});registries.push(successor);
  const next=await successor.start(request);resolveFactory({async start(){},close(){lateCloses++;}});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(lateCloses,1);await db.heartbeat(next);
  assert.deepEqual(key,original);assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused,true);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'uncertain');
  await successor.stop(context);
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});let localKey!:Uint8Array;
  const blocked=new ManagerRegistry(db,project,input=>{localKey=input.key;return {start(){began();return new Promise<void>(()=>{});},close(){}};},{startupTimeoutMs:1000});registries.push(blocked);
  const starting=blocked.start(request),rejected=assert.rejects(starting,/MANAGER_STOPPED/);await started;await blocked.stop(context);
  await rejected;assert(localKey.every(byte=>byte===0));assert.deepEqual(key,original);
  const after=await successor.start(request);await db.heartbeat(after);assert(after.epoch>next.epoch);
  await successor.stop(context);
  const acquire=db.acquire.bind(db);let resumeAcquire!:()=>void,enteredAcquire!:()=>void;
  const gate=new Promise<void>(resolve=>{resumeAcquire=resolve;}),entered=new Promise<void>(resolve=>{enteredAcquire=resolve;});
  db.acquire=async(...args:Parameters<Ledger['acquire']>)=>{enteredAcquire();await gate;return acquire(...args);};
  const waiting=new ManagerRegistry(db,project,()=>({async start(){},close(){}}));registries.push(waiting);
  const first=waiting.start(request),firstRejected=assert.rejects(first,/MANAGER_STOPPED/);await entered;
  await waiting.stop(context);const duplicate=waiting.start(request);assert.equal(duplicate,first);
  resumeAcquire();await firstRejected;db.acquire=acquire;
  const final=await waiting.start(request);await db.heartbeat(final);
 }finally{for(const registry of registries)await registry.close();await db.close();await fixture.close();}
});
