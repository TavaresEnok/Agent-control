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

test('provider login gives each CLI its own home and clears temporary pairing data on exit or expiry',async t=>{
 const {providerLogin,startDeviceLogin}=await import('../src/account-add.ts');
 const {randomUUID}=await import('node:crypto');
 const root=await realpath(await mkdtemp(join(tmpdir(),'ac-provider-login-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const bin=join(root,'bin');await mkdir(bin);
 for(const provider of ['codex','claude','grok']){
  await writeFile(join(bin,provider),[
   '#!/bin/sh',
   'test -z "$AC_SYNTHETIC_SECRET" || exit 4',
   'test "$HOME" = "$PWD" || test "$HOME" != "/host-home" || exit 5',
   'case "$0" in',
   ' */codex) test "$CODEX_HOME" = "$HOME/.codex" && test -z "$CLAUDE_CONFIG_DIR" || exit 6;;',
   ' */claude) test "$CLAUDE_CONFIG_DIR" = "$HOME" && test -z "$CODEX_HOME" || exit 7;;',
   ' */grok) test -z "$CODEX_HOME$CLAUDE_CONFIG_DIR" || exit 8;;',
   'esac',
   'echo "https://login.example.test/device code: ABCD-1234"',
   'if test -f "$HOME/long"; then echo "$$" > "$HOME/pid"; exec /bin/sleep 15; fi',
   '/bin/sleep 0.2',
  ].join('\n')+'\n',{mode:0o700});
 }
 const env={...process.env};
 t.after(()=>{for(const key of ['PATH','HOME','AC_SYNTHETIC_SECRET'])if(env[key]===undefined)delete process.env[key];else process.env[key]=env[key];});
 process.env.PATH=bin;
 process.env.HOME='/host-home';
 process.env.AC_SYNTHETIC_SECRET='SYNTHETIC';
 const long=join(root,'long-session');await mkdir(long);await writeFile(join(long,'long'),'');
 const providers=['codex','claude','grok'] as const;
 const logins=providers.map(provider=>({accountId:randomUUID(),provider,label:'Test',state:'pending' as const}));
 const jobs=logins.map(login=>startDeviceLogin(login,login.provider==='grok'?long:root,{keepAlive:true,timeoutMs:500}));
 assert.throws(()=>startDeviceLogin({...logins[0]!,accountId:randomUUID()},root),/PROVIDER_LOGIN_LIMIT/);
 const first=logins[0]!;
 for(let count=0;count<50&&!providerLogin(first.accountId)?.url;count++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(providerLogin(first.accountId)?.url,'https://login.example.test/device');
 assert.equal(providerLogin(first.accountId)?.userCode,'ABCD-1234');
 await Promise.all(jobs);
 for(const login of logins)assert.deepEqual(providerLogin(login.accountId),{...login,state:login.provider==='grok'?'error':'active'});
 const {readFile}=await import('node:fs/promises');
 const pid=Number(await readFile(join(long,'pid'),'utf8'));
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
