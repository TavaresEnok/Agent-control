import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import type {Control} from '../src/control.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Ledger} from '../src/ledger.ts';

const projectId='00000000-0000-4000-8000-000000000010';
const claude='11111111-1111-4111-8111-111111111111',codex='22222222-2222-4222-8222-222222222222';
const until=new Date(Date.now()+3600_000);

test('the owner sees each account and ends a quota pause; nobody else does',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-accounts-route-')));
 const released:string[]=[];
 try{
  await mkdir(join(root,'accounts',claude),{recursive:true});
  await writeFile(join(root,'accounts',claude,'.credentials.json'),JSON.stringify({claudeAiOauth:{refreshToken:'r',refreshTokenExpiresAt:Date.now()+30*86400_000}}));
  const ledger={pool:{query:async(sql:string,params?:unknown[])=>{
   if(sql.includes('FROM ac_accounts a JOIN ac_account_access'))return {rowCount:2,rows:[
    {id:claude,provider:'claude',label:'Claude',exhausted_until:null},
    {id:codex,provider:'codex',label:'Codex',exhausted_until:until},
   ]};
   if(sql.startsWith('UPDATE ac_accounts')){
    assert.equal(params?.[1],projectId);
    if(params?.[0]!==codex)return {rowCount:0,rows:[]};
    released.push(String(params[0]));return {rowCount:1,rows:[{id:codex}]};
   }
   return {rowCount:params?.[0]===projectId?1:0,rows:[]};
  }}} as unknown as Ledger;
  const app=createApi(ledger,{projectId,nativeExecutionReady:false} as CezarRuntime,async request=>request.headers.get('authorization')==='Bearer owner'?'owner':null,()=>undefined,{
   configurationControl:{ledger} as Control,
   personalPanel:{roots:[],projectRepos:[],installationPath:join(root,'installation.json'),dataDirectory:root,projectId,scheduleRestart(){}},
  });
  const headers={authorization:'Bearer owner'};
  assert.equal((await app.request('/api/v1/ac/personal/accounts')).status,401);
  const listed=await app.request('/api/v1/ac/personal/accounts',{headers});
  assert.equal(listed.status,200);
  const body=await listed.json() as {accounts:{id:string;exhaustedUntil:string|null;login:string|null}[]};
  assert.deepEqual(body.accounts.map(a=>[a.id,a.exhaustedUntil]),[[claude,null],[codex,until.toISOString()]]);
  assert.equal(body.accounts[0]!.login,null);
  assert.match(body.accounts[1]!.login!,/^O Codex está sem login válido\./);
  assert.equal((await app.request(`/api/v1/ac/personal/accounts/${codex}/release`,{method:'POST'})).status,401);
  assert.equal((await app.request(`/api/v1/ac/personal/accounts/${codex}/release`,{method:'POST',headers})).status,200);
  assert.deepEqual(released,[codex]);
  assert.equal((await app.request(`/api/v1/ac/personal/accounts/${claude}/release`,{method:'POST',headers})).status,404);
  assert.equal((await app.request('/api/v1/ac/personal/accounts/not-an-id/release',{method:'POST',headers})).status>=400,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
