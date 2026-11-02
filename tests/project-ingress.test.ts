import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {serve} from '@hono/node-server';
import type {AddressInfo} from 'node:net';
import {Ledger} from '../src/ledger.ts';
import {createApi} from '../src/api.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Command,Authority} from '../src/contracts.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('HTTP runtime project boundary rejects a foreign context even when principal owns both projects',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(base,'ingress'),db=new Ledger(isolated.url);
 let server:ReturnType<typeof serve>|undefined;
 try{
  await db.migrate();const principal='owner-'+randomUUID(),projects=[randomUUID(),randomUUID()];
  const contexts:string[]=[],authorities:Authority[]=[];
  for(const project of projects){
   await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic ingress']);
   await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
   const context=await db.createContext(principal,project,randomUUID());contexts.push(context);
   authorities.push(await db.acquire(principal,context,randomUUID(),'synthetic'));
  }
  const command=(contextId:string):Command=>({schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,
   policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic'}});
  const a=await db.accept(principal,command(contexts[0]),authorities[0],'api');
  const b=await db.accept(principal,command(contexts[1]),authorities[1],'api');
  let nativeCalls=0,managerCalls=0;
  const runtime={projectId:projects[0],executionMode:'administration-only',native:{fetch:async()=>{nativeCalls++;return Response.json({synthetic:true});}},
   store:{listRuns:()=>[]}} as unknown as CezarRuntime;
  const app=createApi(db,runtime,async()=>principal,id=>{managerCalls++;return authorities[contexts.indexOf(id)];});
  server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
  if(!server.listening)await new Promise<void>(resolve=>server!.once('listening',resolve));
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  const fetchPath=(path:string,init?:RequestInit)=>fetch(origin+path,{...init,headers:{authorization:'Bearer synthetic','content-type':'application/json',...init?.headers}});
  const snapshot=async()=>({intents:(await db.pool.query('SELECT id,context_id,state FROM ac_intents ORDER BY id')).rows,
   controls:(await db.pool.query('SELECT * FROM ac_control_intents ORDER BY id')).rows,
   deliveries:(await db.pool.query('SELECT * FROM ac_control_deliveries ORDER BY id')).rows,
   contexts:(await db.pool.query('SELECT id,paused,pause_revision FROM ac_contexts ORDER BY id')).rows});
  const before=await snapshot();
  const foreignPaths=[`/api/v1/ac/contexts/${contexts[1]}`,`/api/v1/ac/contexts/${contexts[1]}/resources`,
   `/api/v1/ac/contexts/${contexts[1]}/usage`,`/api/v1/ac/contexts/${contexts[1]}/events`,
   `/api/v1/ac/runs/${b.run_id}/conversation`,`/api/v1/runs/${b.run_id}`];
  for(const path of foreignPaths){const response=await fetchPath(path);assert.equal(response.status,403,path);assert.equal((await response.json()).error,'PROJECT_RUNTIME_MISMATCH',path);}
  const crossCommand=await fetchPath('/api/v1/ac/commands',{method:'POST',body:JSON.stringify(command(contexts[1]))});
  assert.equal(crossCommand.status,403);assert.equal((await crossCommand.json()).error,'PROJECT_RUNTIME_MISMATCH');
  const proof=Buffer.from(JSON.stringify({deviceId:randomUUID(),expiresAt:Date.now()+60000,signature:'0'.repeat(128)})).toString('base64url');
  const crossControl=await fetchPath('/api/v1/ac/control',{method:'POST',headers:{'x-ac-operator-proof':proof},body:JSON.stringify({schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:contexts[1],action:'context.pause',payload:{paused:true,expectedRevision:0}})});
  assert.equal(crossControl.status,403);assert.equal((await crossControl.json()).error,'PROJECT_RUNTIME_MISMATCH');
  assert.equal(nativeCalls,0);assert.equal(managerCalls,0);assert.deepEqual(await snapshot(),before);
  for(const path of [`/api/v1/ac/contexts/${contexts[0]}`,`/api/v1/ac/contexts/${contexts[0]}/events`,`/api/v1/ac/contexts/${contexts[0]}/usage`,`/api/v1/runs/${a.run_id}`])
   assert.equal((await fetchPath(path)).status,200,path);
  assert.equal(nativeCalls,1);
  const positive=await fetchPath('/api/v1/ac/commands',{method:'POST',body:JSON.stringify(command(contexts[0]))});
  assert.equal(positive.status,202);assert.equal(managerCalls,1);
 }finally{
  if(server)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));
  await db.close();await isolated.close();
 }
});
