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
const subscription={endpoint:'https://fcm.googleapis.com/wp/phone',expirationTime:null,keys:{p256dh:'A'.repeat(40),auth:'B'.repeat(24)}};

function api(root:string,ownerOf:'primary'|'selected'|'none'){
 const ledger={pool:{query:async(_sql:string,params?:unknown[])=>{
  const asked=params?.[0];
  const rowCount=ownerOf==='primary'&&asked===primaryProjectId||ownerOf==='selected'&&asked===projectId?1:0;
  return {rowCount,rows:[]};
 }}} as unknown as Ledger;
 return createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>undefined,{
  configurationControl:{ledger} as Control,
  personalPanel:{roots:[],projectRepos:[],installationPath:root,dataDirectory:root,projectId:primaryProjectId,scheduleRestart(){}},
 });
}

test('the owner can list, save and delete a push subscription without seeing the endpoint',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-push-route-')));
 try{
  const app=api(root, 'primary');
  const headers={authorization:'Bearer owner','content-type':'application/json'};
  assert.equal((await app.request('/api/v1/ac/personal/push')).status,401);
  const listed=await app.request('/api/v1/ac/personal/push',{headers});
  assert.equal(listed.status,200);
  const page=await listed.json() as {publicKey:string;subscriptions:unknown[]};
  assert.equal(typeof page.publicKey,'string');
  assert.deepEqual(page.subscriptions,[]);
  const created=await app.request('/api/v1/ac/personal/push/subscribe',{method:'POST',headers,body:JSON.stringify({subscription,label:'celular'})});
  assert.equal(created.status,201);
  const saved=await created.json() as {id:string};
  const visible=await (await app.request('/api/v1/ac/personal/push',{headers})).json() as {subscriptions:{id:string;label:string;createdAt:string}[]};
  assert.deepEqual(visible.subscriptions.map(item=>item.label),['celular']);
  assert.equal(JSON.stringify(visible).includes('fcm.googleapis.com'),false);
  assert.equal(JSON.stringify(visible).includes(page.publicKey),true);
  assert.equal((await app.request('/api/v1/ac/personal/push/subscribe/'+saved.id,{method:'DELETE',headers})).status,200);
  assert.equal((await app.request('/api/v1/ac/personal/push/test',{method:'POST',headers})).status,200);
  assert.equal((await api(root,'none').request('/api/v1/ac/personal/push',{headers})).status,403);
  assert.equal((await api(root,'selected').request('/api/v1/ac/personal/push',{headers})).status,403);
  const ledger={pool:{query:async()=>({rowCount:1,rows:[]})}} as unknown as Ledger;
  const locked=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async()=>'owner',()=>undefined,{configurationControl:{ledger} as Control});
  assert.equal((await locked.request('/api/v1/ac/personal/push',{headers})).status,404);
 }finally{await rm(root,{recursive:true,force:true});}
});
