import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Ledger} from '../src/ledger.ts';
import {ManagerRegistry} from '../src/managers.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {HappierEndpoint,recoverHistory,type HappierBoundary} from '../src/happier.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('history bounds fetch and response body even if transport ignores abort',async()=>{
 const boundary={} as HappierBoundary;let signal:AbortSignal|undefined;
 const hung=(async(_url:unknown,init?:RequestInit)=>{signal=init?.signal??undefined;return new Response(new ReadableStream({start(){}}));}) as typeof fetch;
 await assert.rejects(recoverHistory('http://localhost','synthetic','token',new Uint8Array(32),boundary,hung,'legacy',async()=>{},{timeoutMs:30}),/HAPPIER_TRANSPORT_TIMEOUT/);
 assert.equal(signal?.aborted,true);
});

test('late synthetic transport connection is disconnected after startup timeout',async()=>{
 const originalFetch=globalThis.fetch;let resolveConnect!:()=>void,disconnects=0;
 const connecting=new Promise<void>(resolve=>{resolveConnect=resolve;});
 class Socket extends EventEmitter {onAny(){} disconnect(){disconnects++;return this;}}
 const socket=new Socket();
 class Rpc {onSocketConnect(){} onSocketDisconnect(){} async handleRequest(){} async invokeLocal(){} async waitForRegisteredHandlers(){return {status:'ready'};}}
 const boundary={createSessionSocketTransport:()=>({socket,transport:{connect:()=>connecting}}),RpcHandlerManager:Rpc,
  registerSessionUserMessageSendHandler:()=>{}} as unknown as HappierBoundary;
 const ledger={recoverCheckpoint:async()=>null} as unknown as Ledger;
 const endpoint=new HappierEndpoint(ledger,{repo:'/synthetic'} as CezarRuntime,boundary,{baseUrl:'http://localhost',token:'synthetic',key:new Uint8Array(32),principal:'owner',sessionId:'session',machineId:'machine',authority:{contextId:randomUUID(),instanceId:randomUUID(),epoch:1},transportTimeoutMs:30});
 endpoint.validateLink=async()=>{};endpoint.validateKey=async()=>{};
 globalThis.fetch=async input=>String(input).includes('/profile')?Response.json({id:'owner'}):Response.json({messages:[],hasMore:false,nextBeforeSeq:null});
 try{
  await assert.rejects(endpoint.start(),/HAPPIER_TRANSPORT_TIMEOUT/);const before=disconnects;
  resolveConnect();await new Promise(resolve=>setTimeout(resolve,10));assert(disconnects>before);
  socket.emit('connect');assert(disconnects>before+1);
  class HungRpc extends Rpc {override async waitForRegisteredHandlers():Promise<{status:string}>{return new Promise(()=>{});}}
  const rpcBoundary={...boundary,RpcHandlerManager:HungRpc,createSessionSocketTransport:()=>({socket,transport:{connect:async()=>{}}})} as unknown as HappierBoundary;
  const rpcEndpoint=new HappierEndpoint(ledger,{repo:'/synthetic'} as CezarRuntime,rpcBoundary,{...endpoint.options,transportTimeoutMs:30});
  rpcEndpoint.validateLink=async()=>{};rpcEndpoint.validateKey=async()=>{};
  try{await assert.rejects(rpcEndpoint.start(),/HAPPIER_TRANSPORT_TIMEOUT/);}finally{rpcEndpoint.close();}
 }finally{globalThis.fetch=originalFetch;endpoint.close();}
});

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
