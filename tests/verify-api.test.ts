import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import {readVerificationProgress} from '../src/verify-command.ts';
import type {Control} from '../src/control.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Ledger} from '../src/ledger.ts';

const projectId='00000000-0000-4000-8000-000000000001';
const primaryProjectId='00000000-0000-4000-8000-000000000010';

function api(root:string,ownerOf:'primary'|'selected'|'none',start?:(principal:string,panel:{dataDirectory:string;projectId:string;installationPath:string},body:{url?:string})=>Promise<{id:string;status:'running';phase:string}>){
 const ledger={pool:{query:async(_sql:string,params?:unknown[])=>{
  const asked=params?.[0];
  const rowCount=ownerOf==='primary'&&asked===primaryProjectId||ownerOf==='selected'&&asked===projectId?1:0;
  return {rowCount,rows:[]};
 }}} as unknown as Ledger;
 return createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>undefined,{
  configurationControl:{ledger} as Control,
  personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
  ...(start?{personalVerification:{start}}:{}),
 });
}

test('the installation owner lists verifications and a stranger cannot',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-route-')));
 try{
  const app=api(root,'primary');
  const headers={authorization:'Bearer owner'};
  assert.equal((await app.request('/api/v1/ac/personal/verificacoes')).status,401);
  const listed=await app.request('/api/v1/ac/personal/verificacoes',{headers});
  assert.equal(listed.status,200);
  assert.equal(listed.headers.get('cache-control'),'no-store');
  assert.deepEqual(await listed.json(),{verificacoes:[]});
  assert.equal((await api(root,'none').request('/api/v1/ac/personal/verificacoes',{headers})).status,403);
  assert.equal((await api(root,'selected').request('/api/v1/ac/personal/verificacoes',{headers})).status,403);
  const ledger={pool:{query:async()=>({rowCount:1,rows:[]})}} as unknown as Ledger;
  const locked=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async()=>'owner',()=>undefined,{configurationControl:{ledger} as Control});
  assert.equal((await locked.request('/api/v1/ac/personal/verificacoes',{headers})).status,404);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the installation owner starts a verification and strangers cannot',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-start-')));
 try{
  const seen:{projectId?:string;url?:string}={};
  const start=async(_principal:string,panel:{projectId:string},body:{url?:string})=>{
   seen.projectId=panel.projectId;seen.url=body.url;
   return {id:'00000000-0000-4000-8000-0000000000aa',status:'running' as const,phase:'mapa'};
  };
  const app=api(root,'primary',start);
  const headers={authorization:'Bearer owner','content-type':'application/json'};
  assert.equal((await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  const started=await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:'{}'});
  assert.equal(started.status,202);
  assert.equal(started.headers.get('cache-control'),'no-store');
  assert.deepEqual(await started.json(),{id:'00000000-0000-4000-8000-0000000000aa',status:'running',phase:'mapa'});
  assert.equal(seen.projectId,primaryProjectId);
  assert.equal(seen.url,undefined);
  const withUrl=await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:JSON.stringify({url:'http://127.0.0.1:9'})});
  assert.equal(withUrl.status,202);
  assert.equal(seen.url,'http://127.0.0.1:9');
  const extra=await app.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:JSON.stringify({url:'http://127.0.0.1:9',extra:true})});
  assert.equal(extra.status,400);
  assert.equal((await api(root,'none',start).request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:'{}'})).status,403);
  const unavailable=await api(root,'primary').request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:'{}'});
  assert.equal(unavailable.status,503);
  assert.deepEqual(await unavailable.json(),{error:'VERIFY_WORKER_UNAVAILABLE'});
  const ledger={pool:{query:async()=>({rowCount:1,rows:[]})}} as unknown as Ledger;
  const locked=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async()=>'owner',()=>undefined,{configurationControl:{ledger} as Control,personalVerification:{start}});
  assert.equal((await locked.request('/api/v1/ac/personal/verificacoes',{method:'POST',headers,body:'{}'})).status,404);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('verification progress is the literal andamento route',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-progress-')));
 try{
  const app=api(root,'primary');
  const headers={authorization:'Bearer owner'};
  const missing=await app.request('/api/v1/ac/personal/verificacoes/andamento',{headers});
  assert.equal(missing.status,200);
  assert.notEqual(missing.status,400);
  assert.deepEqual(await missing.json(),{runs:[]});
  const id='00000000-0000-4000-8000-0000000000bb';
  const dir=join(root,'verificacoes',primaryProjectId,'andamento');
  await mkdir(dir,{recursive:true});
  await chmod(join(root,'verificacoes'),0o700);
  await chmod(join(root,'verificacoes',primaryProjectId),0o700);
  await chmod(dir,0o700);
  const record={id,status:'running',phase:'mapa',startedAt:'2026-11-17T03:04:05.000Z'};
  await writeFile(join(dir,`${id}.json`),JSON.stringify(record),{mode:0o600});
  await chmod(join(dir,`${id}.json`),0o600);
  const listed=await app.request('/api/v1/ac/personal/verificacoes/andamento',{headers});
  assert.equal(listed.status,200);
  const expected=await readVerificationProgress(root,primaryProjectId);
  assert.deepEqual(await listed.json(),{runs:expected});
  assert.equal(expected.some(run=>run.id===id),true);
  assert.equal((await app.request('/api/v1/ac/personal/verificacoes/andamento')).status,401);
  assert.equal((await api(root,'none').request('/api/v1/ac/personal/verificacoes/andamento',{headers})).status,403);
  const ledger={pool:{query:async()=>({rowCount:1,rows:[]})}} as unknown as Ledger;
  const locked=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async()=>'owner',()=>undefined,{configurationControl:{ledger} as Control});
  assert.equal((await locked.request('/api/v1/ac/personal/verificacoes/andamento',{headers})).status,404);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('reverificar chama o worker injetado e não existe sem ele',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-verify-recheck-')));
 try{
  const runId='00000000-0000-4000-8000-0000000000cc';
  const contextId='00000000-0000-4000-8000-0000000000dd';
  const authority={contextId,instanceId:'00000000-0000-4000-8000-0000000000ee',epoch:1};
  const ledger={pool:{query:async(sql:string,params?:unknown[])=>{
   if(sql.includes('ac_verify_runs'))return {rowCount:1,rows:[{context_id:contextId}]};
   const asked=params?.[0];
   return {rowCount:asked===primaryProjectId?1:0,rows:[]};
  }}} as unknown as Ledger;
  const seen:{achadoIds?:string[];epoch?:number}={};
  const recheck=async(_principal:string,auth:{epoch:number},input:{achadoIds:string[]})=>{
   seen.achadoIds=input.achadoIds;seen.epoch=auth.epoch;
   return {results:[{id:'ACH-001',status:'fechado' as const}]};
  };
  const runtime={projectId,nativeExecutionReady:false} as CezarRuntime;
  const headers={authorization:'Bearer owner','content-type':'application/json'};
  const body=JSON.stringify({achadoIds:['ACH-001']});
  const path=`/api/v1/ac/personal/verificacoes/${runId}/reverificar`;
  const absent=createApi(ledger,runtime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>authority,{
   configurationControl:{ledger} as Control,
   personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
  });
  const hidden=await absent.request(path,{method:'POST',headers,body});
  assert.equal(hidden.status,403);
  assert.deepEqual(await hidden.json(),{error:'CANONICAL_HAPPIER_REQUIRED'});
  const app=createApi(ledger,runtime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>authority,{
   configurationControl:{ledger} as Control,
   personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
   personalVerification:{recheck},
  });
  const done=await app.request(path,{method:'POST',headers,body});
  assert.equal(done.status,200);
  assert.equal(done.headers.get('cache-control'),'no-store');
  assert.deepEqual(await done.json(),{results:[{id:'ACH-001',status:'fechado'}]});
  assert.deepEqual(seen.achadoIds,['ACH-001']);
  assert.equal(seen.epoch,1);
  assert.equal((await app.request(path,{method:'POST',headers,body:'{}'})).status,400);
 }finally{await rm(root,{recursive:true,force:true});}
});
