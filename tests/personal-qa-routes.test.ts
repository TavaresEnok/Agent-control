import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import type {Control} from '../src/control.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Ledger} from '../src/ledger.ts';

const projectId='00000000-0000-4000-8000-000000000001';
const primaryProjectId='00000000-0000-4000-8000-000000000010';
const valid={prepare:['corepack','pnpm','install','--frozen-lockfile'],test:['corepack','pnpm','test'],timeoutSeconds:600,services:{postgres:{image:'postgres:16-alpine',database:'qa_test'}}};

function api(root:string,ownerOf:'primary'|'selected'|'none',restarted?:{n:number}){
 const ledger={pool:{query:async(_sql:string,params?:unknown[])=>{
  const asked=params?.[0];
  const rowCount=ownerOf==='primary'&&asked===primaryProjectId||ownerOf==='selected'&&asked===projectId?1:0;
  return {rowCount,rows:[]};
 }}} as unknown as Ledger;
 return createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>undefined,{
  configurationControl:{ledger} as Control,
  personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){if(restarted)restarted.n++;}},
 });
}

test('project QA rejects an invalid configuration and anyone who is not the installation owner',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-qa-route-')));
 try{
  const restarted={n:0};
  const app=api(root,'primary',restarted);
  const headers={authorization:'Bearer owner','content-type':'application/json'};
  assert.equal((await app.request('/api/v1/ac/personal/qa')).status,401);
  assert.equal((await api(root,'none').request('/api/v1/ac/personal/qa',{headers})).status,403);
  assert.equal((await api(root,'selected').request('/api/v1/ac/personal/qa',{method:'PUT',headers,body:JSON.stringify(valid)})).status,403);
  const shell=await app.request('/api/v1/ac/personal/qa',{method:'PUT',headers,body:JSON.stringify({test:'npm test'})});
  assert.equal(shell.status,409);
  assert.equal((await shell.json() as {error:string}).error,'QA_CONFIG_NOT_A_LIST');
  const denied=await app.request('/api/v1/ac/personal/qa',{method:'PUT',headers,body:JSON.stringify({test:['bash','-lc','npm test']})});
  assert.equal(denied.status,409);
  assert.equal((await denied.json() as {error:string}).error,'QA_COMMAND_NOT_ALLOWED');
  assert.equal((await app.request('/api/v1/ac/personal/qa',{headers})).status,200);
  const saved=await app.request('/api/v1/ac/personal/qa',{method:'PUT',headers,body:JSON.stringify(valid)});
  assert.equal(saved.status,200);
  const body=await saved.json() as {appliesOnRestart:boolean;config:{test:string[]}};
  assert.equal(body.appliesOnRestart,true);
  assert.deepEqual(body.config.test,valid.test);
  assert.equal(restarted.n,0);
  const listed=await (await app.request('/api/v1/ac/personal/qa',{headers})).json() as {config:{services:{postgres:{database:string}}}};
  assert.equal(listed.config.services.postgres.database,'qa_test');
  const previous=process.env.INVOCATION_ID;
  process.env.INVOCATION_ID='test';
  try{
   const restart=await app.request('/api/v1/ac/personal/qa/restart',{method:'POST',headers});
   assert.equal(restart.status,200);
   assert.equal((await restart.json() as {restarting:boolean}).restarting,true);
   assert.equal(restarted.n,1);
  }finally{if(previous===undefined)delete process.env.INVOCATION_ID;else process.env.INVOCATION_ID=previous;}
 }finally{await rm(root,{recursive:true,force:true});}
});
