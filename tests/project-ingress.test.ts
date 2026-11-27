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
   `/api/v1/runs/${b.run_id}`];
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

test('unscoped and project-scoped UI preferences stop reading once the byte limit is exceeded',async()=>{
 const project='00000000-0000-4000-8000-000000000001';
 const ledger={} as Ledger;
 const app=createApi(ledger,{projectId:project,nativeExecutionReady:false} as CezarRuntime,async()=> 'owner',()=>undefined);
 const encode=new TextEncoder();
 for(const prefix of ['/api/v1','/api/v1/p/'+project]){
  const url='http://localhost'+prefix+'/workspace/ui-state';
  const text=JSON.stringify({filter:'á'.repeat(100)});
  const valid=await app.request(url,{method:'PUT',body:text});
  assert.equal(valid.status,200);
  assert.deepEqual(await valid.json(),JSON.parse(text));
  let cancelled=false,read=0;
  const oversized=new ReadableStream({
   pull(controller){
    read++;
    if(read===8){controller.enqueue(encode.encode('"}'));controller.close();}
    else controller.enqueue(encode.encode(read===1?'{"filter":"':'á'.repeat(8192)));
   },
   cancel(){cancelled=true;},
  });
  const rejected=await app.fetch(new Request(url,{method:'PUT',body:oversized,duplex:'half'} as RequestInit));
  assert.equal(rejected.status,413);
  assert.deepEqual(await rejected.json(),{error:'UI_STATE_TOO_LARGE'});
  assert.equal(cancelled,true);
  assert.ok(read<8);
 }
});

test('run read marks use the runtime project, principal and bounded retention',async()=>{
 const project=randomUUID(),foreign=randomUUID();
 const taskIds:string[]=Array.from({length:257},()=>randomUUID());
 const foreignRun=randomUUID();
 const ledger={
  pool:{query:async(sql:string,values:string[])=>{
   if(sql.includes('ac_memberships'))return {rowCount:1,rows:[]};
   const projectId=values[0]===foreignRun?foreign:taskIds.includes(values[0]!)?project:null;
   return {rowCount:projectId?1:0,rows:projectId?[{context_id:projectId}]:[]};
  }},
  tx:async(fn:(db:unknown)=>unknown)=>fn(null),
  authorize:async(_db:unknown,_principal:string,contextId:string)=>({project_id:contextId}),
 } as unknown as Ledger;
 const runtime={projectId:project,nativeExecutionReady:false,native:{
  fetch:async(request:Request)=>Response.json({id:new URL(request.url).pathname.split('/').at(-1),title:'Test'}),
 }} as CezarRuntime;
 const app=createApi(ledger,runtime,async request=>request.headers.get('authorization')??'owner',()=>undefined);
 const path=(id:string)=>'/api/v1/p/'+project+'/runs/'+id;
 const mark=(id:string,action='read')=>app.request(path(id)+'/'+action,{method:'POST'});
 assert.equal((await mark('invalid')).status,400);
 assert.equal((await mark(foreignRun)).status,403);
 assert.equal((await mark(randomUUID())).status,403);
 const first=taskIds[0]!;
 assert.equal((await mark(first)).status,200);
 assert.equal(typeof (await (await app.request(path(first))).json() as {seenAt?:string}).seenAt,'string');
 assert.equal((await (await app.request(path(first),{headers:{authorization:'another-owner'}})).json() as {seenAt?:string}).seenAt,undefined);
 for(const id of taskIds.slice(1))assert.equal((await mark(id)).status,200);
 assert.equal((await (await app.request(path(first))).json() as {seenAt?:string}).seenAt,undefined);
 const last=taskIds.at(-1)!;
 assert.deepEqual(await (await mark(last,'unread')).json(),{id:last,seenAt:null});
});
