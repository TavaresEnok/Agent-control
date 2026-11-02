import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {ManagerRegistry,type ManagerEndpointInput} from '../src/managers.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import type {Command} from '../src/contracts.ts';

test('manager registry owns one endpoint, fences takeover and isolates key cleanup without changing work',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'managers'),db=new Ledger(isolated.url);
 const registries:ManagerRegistry[]=[];
 try{
  await db.migrate();const project=randomUUID(),principal='manager-'+randomUUID(),shared=randomBytes(32),initial=Buffer.from(shared);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Manager registry synthetic fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contexts=await Promise.all([db.createContext(principal,project,randomUUID()),db.createContext(principal,project,randomUUID())]);
  const links=(await db.pool.query('SELECT context_id,session_id FROM ac_session_links WHERE context_id=ANY($1::uuid[])',[contexts])).rows;
  const keys=new ContextKeys(db);for(const context of contexts)await keys.authorize(principal,context,1,'legacy',keyFingerprint(shared));
  const records:{input:ManagerEndpointInput;closed:number;starts:number}[]=[],factory=async(input:ManagerEndpointInput)=>{
   const record={input,closed:0,starts:0};records.push(record);
   return {async start(){record.starts++;if(input.contextId===contexts[1]&&records.filter(r=>r.input.contextId===contexts[1]).length===1)throw Error('SYNTHETIC_START_FAILED');},close(){record.closed++;}};
  };
  const registry=new ManagerRegistry(db,project,factory);registries.push(registry);
  const request=(contextId:string)=>({principal,contextId,sessionId:links.find(row=>row.context_id===contextId)!.session_id,
   profileId:'synthetic-same-profile',keyVersion:1,encryptionVariant:'legacy' as const,key:shared});
  const first=await Promise.all([registry.start(request(contexts[0])),registry.start(request(contexts[0]))]);
  assert.deepEqual(first[0],first[1]);assert.equal(records.length,1);assert.notEqual(records[0].input.key,shared);
  assert.equal((await registry.status(contexts[0])).state,'running');
  await assert.rejects(registry.start({...request(contexts[0]),sessionId:'wrong-session'}),/MANAGER_CONFIGURATION_CONFLICT/);
  await assert.rejects(registry.start(request(contexts[1])),/MANAGER_ENDPOINT_START_FAILED/);
  const failed=records.find(r=>r.input.contextId===contexts[1])!;assert(failed.closed>0);assert(failed.input.key.every(byte=>byte===0));
  assert.deepEqual(shared,initial);assert(records[0].input.key.some(byte=>byte!==0));
  const recovered=await registry.start(request(contexts[1]));assert.equal(recovered.epoch,2);
  const capacity=await provisionCapacity(db,principal,project);await capacity.service.assignPolicy(principal,contexts[0],capacity.revision);
  const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:contexts[0],policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic-manager-registry'}};
  const intent=await db.accept(principal,command,first[0],'api');
  const grant=await capacity.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:contexts[0],role:'programmer'},first[0]);
  await capacity.service.transition(principal,grant.id,first[0],'uncertain');
  await db.pause(principal,contexts[0],true);
  const checkpoint=(await db.pool.query('SELECT snapshot FROM ac_checkpoints WHERE context_id=$1',[contexts[0]])).rows[0].snapshot;
  // Simulate lease loss only in this disposable database. Same profile must get a new epoch.
  await db.pool.query('UPDATE ac_managers SET lease_until=clock_timestamp() WHERE context_id=$1',[contexts[0]]);
  const successor=new ManagerRegistry(db,project,factory);registries.push(successor);
  const next=await successor.start(request(contexts[0]));assert.equal(next.epoch,first[0].epoch+1);
  await assert.rejects(db.heartbeat(first[0]),/STALE_MANAGER/);
  await registry.stop(contexts[0]);await db.heartbeat(next);
  const newRecord=records.at(-1)!;assert(newRecord.input.key.some(byte=>byte!==0));assert.deepEqual(shared,initial);
  const preserved=(await db.pool.query('SELECT x.paused,k.snapshot checkpoint FROM ac_contexts x LEFT JOIN ac_checkpoints k ON k.context_id=x.id WHERE x.id=$1',[contexts[0]])).rows[0];
  assert.equal(preserved.paused,true);assert.deepEqual(preserved.checkpoint,checkpoint);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'uncertain');
  await keys.revoke(principal,contexts[0],1);
  assert.equal((await successor.status(contexts[0])).state,'revoked');assert.equal(successor.authority(contexts[0]),undefined);
  assert(newRecord.input.key.every(byte=>byte===0));assert.deepEqual(shared,initial);
  assert(records.filter(r=>r.input.contextId===contexts[1]).at(-1)!.input.key.some(byte=>byte!==0));
  await registry.close();assert(records.filter(r=>r.input.contextId===contexts[1]).at(-1)!.input.key.every(byte=>byte===0));assert.deepEqual(shared,initial);
  let unblock!:()=>void,closing!:()=>void;const entered=new Promise<void>(resolve=>{closing=resolve;});
  const blocked=new Promise<void>(resolve=>{unblock=resolve;});let slowKey!:Uint8Array;
  const slow=new ManagerRegistry(db,project,input=>{slowKey=input.key;return {async start(){},async close(){closing();await blocked;}};});registries.push(slow);
  const slowAuthority=await slow.start(request(contexts[1]));
  const stopping=slow.stop(contexts[1]);assert(slowKey.every(byte=>byte===0));
  await entered;await assert.rejects(db.heartbeat(slowAuthority),/STALE_MANAGER/);
  assert.deepEqual(shared,initial);unblock();await stopping;
 }finally{for(const registry of registries)await registry.close();await db.close();await isolated.close();}
});

test('explicit restart validates fresh credentials, advances epoch and preserves successor and uncertain work',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'restart'),db=new Ledger(isolated.url);const registries:ManagerRegistry[]=[];
 try{
  await db.migrate();const project=randomUUID(),principal='restart-'+randomUUID(),key=randomBytes(32),original=Buffer.from(key);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic restart']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,randomUUID());
  const sessionId=(await db.pool.query('SELECT session_id FROM ac_session_links WHERE context_id=$1',[context])).rows[0].session_id;
  await new ContextKeys(db).authorize(principal,context,1,'legacy',keyFingerprint(key));
  const input={principal,contextId:context,sessionId,profileId:'synthetic',keyVersion:1,encryptionVariant:'legacy' as const,key};
  const records:{key:Uint8Array;closed:number}[]=[];let duringClose:(()=>Promise<void>)|undefined;
  const registry=new ManagerRegistry(db,project,options=>{
   const record={key:options.key,closed:0};records.push(record);
   return {async start(){},async close(){record.closed++;await duringClose?.();}};
  });registries.push(registry);
  const first=await registry.start(input);
  await assert.rejects(registry.restart({...input,key:randomBytes(32)}),/CONTEXT_KEY_UNAUTHORIZED/);
  assert.equal(records[0].closed,0);await db.heartbeat(first);
  const capacity=await provisionCapacity(db,principal,project);await capacity.service.assignPolicy(principal,context,capacity.revision);
  const command:Command={schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:restart'}};
  const intent=await db.accept(principal,command,first,'api');
  const grant=await capacity.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId:context,role:'programmer'},first);
  await capacity.service.transition(principal,grant.id,first,'uncertain');await db.pause(principal,context,true);
  const restarted=await registry.restart(input);assert.equal(restarted.epoch,first.epoch+1);
  assert(records[0].key.every(value=>value===0));assert(records[1].key.some(value=>value!==0));assert.deepEqual(key,original);
  assert.equal((await db.pool.query('SELECT paused FROM ac_contexts WHERE id=$1',[context])).rows[0].paused,true);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'uncertain');
  const successor=new ManagerRegistry(db,project,()=>({async start(){},close(){}}));registries.push(successor);
  let other:Awaited<ReturnType<ManagerRegistry['start']>>|undefined;
  duringClose=async()=>{duringClose=undefined;other=await successor.start(input);};
  await assert.rejects(registry.restart(input),/MANAGER_ACTIVE/);assert(other);await db.heartbeat(other);
  assert(records[1].key.every(value=>value===0));assert.deepEqual(key,original);
 }finally{for(const registry of registries)await registry.close();await db.close();await isolated.close();}
});

test('manager status distinguishes disconnected transport from fenced authority',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'status'),db=new Ledger(isolated.url);let registry:ManagerRegistry|undefined;
 try{
  await db.migrate();const project=randomUUID(),principal='status-'+randomUUID(),key=randomBytes(32);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic status']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID());
  const sessionId=(await db.pool.query('SELECT session_id FROM ac_session_links WHERE context_id=$1',[contextId])).rows[0].session_id;
  const keys=new ContextKeys(db);await keys.authorize(principal,contextId,1,'legacy',keyFingerprint(key));
  let connected=true,closed=0;
  registry=new ManagerRegistry(db,project,()=>({async start(){},close(){closed++;},connectionState:()=>connected?'connected':'disconnected'}));
  const authority=await registry.start({principal,contextId,sessionId,profileId:'synthetic',keyVersion:1,encryptionVariant:'legacy',key});
  assert.equal((await registry.status(contextId)).state,'running');connected=false;
  const offline=await registry.status(contextId);assert.equal(offline.state,'disconnected');assert.deepEqual(registry.authority(contextId),authority);
  await db.heartbeat(authority);connected=true;assert.equal((await registry.status(contextId)).state,'running');
  await keys.revoke(principal,contextId,1);connected=false;
  assert.equal((await registry.status(contextId)).state,'revoked');assert.equal(registry.authority(contextId),undefined);assert.equal(closed,1);
 }finally{await registry?.close();await db.close();await isolated.close();}
});
