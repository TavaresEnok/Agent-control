import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, scryptSync} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApi} from '../src/api.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {Ledger} from '../src/ledger.ts';
import {pairClientIp} from '../src/personal-pair.ts';
import {panelLoginDenied, panelPasswordConfigured, panelSessionSeconds, promptPanelPassword, removePanelLogin, savePanelLogin, verifyPanelLogin} from '../src/personal-password.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {BrowserSessions} from '../src/sessions.ts';

const password='correct-horse-12';
const scryptOptions={N:32768,r:8,p:1,maxmem:64*1024*1024};

async function directory(){return realpath(await mkdtemp(join(tmpdir(),'ac-password-')));}
function restoreEnv(name:string,previous:string|undefined){
 if(previous===undefined)delete process.env[name];
 else process.env[name]=previous;
}

describe('panel password', {concurrency: false}, () => {
test('the right password is accepted and the file keeps only the scrypt hash',async()=>{
 const root=await directory();
 try{
  await assert.rejects(savePanelLogin(root,'Ab',password),/INVALID_PANEL_USER/);
  await assert.rejects(savePanelLogin(root,'alice','short-pass'),/INVALID_PANEL_PASSWORD/);
  await assert.rejects(savePanelLogin(root,'alice','a'.repeat(201)),/INVALID_PANEL_PASSWORD/);
  assert.equal(await panelPasswordConfigured(root),false);
  const saved=await savePanelLogin(root,'Alice',password,1_700_000_000_000);
  assert.equal(saved.user,'alice');
  const fileName=join(root,'panel-login.json');
  const file=await readFile(fileName,'utf8');
  assert.equal(file.includes(password),false);
  assert.equal((await stat(fileName)).mode&0o777,0o600);
  const parsed=JSON.parse(file) as {user:string;salt:string;hash:string;params:{N:number;r:number;p:number;length:number};updatedAt:string};
  assert.equal('password' in parsed,false);
  assert.equal(parsed.user,'alice');
  assert.equal(parsed.updatedAt,new Date(1_700_000_000_000).toISOString());
  assert.deepEqual(parsed.params,{N:32768,r:8,p:1,length:64});
  assert.equal(Buffer.from(parsed.salt,'hex').length,16);
  const expected=scryptSync(password,Buffer.from(parsed.salt,'hex'),64,scryptOptions);
  assert.equal(Buffer.from(parsed.hash,'hex').equals(expected),true);
  assert.equal(await panelPasswordConfigured(root),true);
  assert.equal(await verifyPanelLogin(root,'ALICE',password,1_700_000_000_001),'accepted');
  const wrong=await verifyPanelLogin(root,'alice','incorrect-password',1_700_000_000_002);
  const missing=await verifyPanelLogin(root,'bob','incorrect-password',1_700_000_000_003);
  assert.equal(wrong,'invalid');
  assert.equal(missing,'invalid');
  const again=await readFile(fileName,'utf8');
  assert.equal(again.includes(password),false);
  assert.equal(again.includes('incorrect-password'),false);
  const attempts=await readFile(join(root,'panel-login-attempts.json'),'utf8');
  assert.equal(attempts.includes(password),false);
  assert.equal(attempts.includes('incorrect-password'),false);
  assert.equal((await stat(join(root,'panel-login-attempts.json'))).mode&0o777,0o600);
  await removePanelLogin(root);
  assert.equal(await panelPasswordConfigured(root),false);
  const removed=JSON.parse(await readFile(fileName,'utf8'));
  assert.deepEqual(Object.keys(removed),['changedAt']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a wrong user and a wrong password produce the same denial',async()=>{
 const wrong=panelLoginDenied('invalid');
 const other=panelLoginDenied('invalid');
 assert.equal(wrong.status,401);
 assert.equal(other.status,401);
 assert.equal(wrong.headers.get('cache-control'),'no-store');
 assert.deepEqual(await wrong.json(),await other.json());
 assert.deepEqual(await panelLoginDenied('limited').json(),{error:'LOGIN_LIMIT'});
});

test('one blocked address does not block another, and a hundred errors close the window',{timeout:180_000},async()=>{
 const root=await directory();
 try{
  await savePanelLogin(root,'alice',password,5_000_000);
  for(let index=0;index<5;index++)assert.equal(await verifyPanelLogin(root,'alice','incorrect-password',5_000_000+index,'203.0.113.5'),'invalid');
  const lockedAt=5_000_004;
  assert.equal(await verifyPanelLogin(root,'alice',password,lockedAt+10,'203.0.113.5'),'limited');
  assert.equal(await verifyPanelLogin(root,'alice',password,lockedAt+11,'203.0.113.9'),'accepted');
  assert.equal(await verifyPanelLogin(root,'alice',password,lockedAt+60_000-1,'203.0.113.5'),'limited');
  assert.equal(await verifyPanelLogin(root,'alice',password,lockedAt+60_000,'203.0.113.5'),'accepted');
  for(let index=0;index<100;index++)assert.equal(await verifyPanelLogin(root,'bob','incorrect-password',8_000_000,`198.51.100.${index+1}`),'invalid');
  assert.equal(await verifyPanelLogin(root,'alice',password,8_000_010,'203.0.113.20'),'limited');
  assert.equal(await verifyPanelLogin(root,'alice',password,8_000_000+60_000,'203.0.113.20'),'accepted');
  const file=await readFile(join(root,'panel-login.json'),'utf8');
  assert.equal(file.includes(password),false);
  assert.equal(file.includes('incorrect-password'),false);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('password login is public, identical for unknown user and password, and lasts thirty days',async()=>{
 const root=await directory();
 const origin='http://127.0.0.1:18402';
 const project='00000000-0000-4000-8000-000000000001';
 try{
  await savePanelLogin(root,'alice',password);
  const sessions=new BrowserSessions({pool:{query:async()=>({rows:[]})}} as unknown as Ledger,randomBytes(32),async()=>'owner',{origin,secure:false,maxAgeSeconds:300});
  let authenticated=false;
  const login=async(request:Request)=>{
   sessions.checkOrigin(request);
   const body=await request.json() as {user?:string;password?:string};
   const verdict=await verifyPanelLogin(root,String(body.user??''),String(body.password??''),Date.now(),pairClientIp(request.headers.get('x-forwarded-for'),request.headers.get('x-agent-control-remote-address')));
   if(verdict!=='accepted')return panelLoginDenied(verdict);
   return Response.json({state:'authenticated'},{headers:{'cache-control':'no-store'}});
  };
  const app=createApi({pool:{query:async()=>({rowCount:0,rows:[]})}} as unknown as Ledger,{projectId:project,nativeExecutionReady:false} as CezarRuntime,async()=>{authenticated=true;return 'owner';},()=>undefined,{
   personalPanel:{roots:[],projectRepos:[],installationPath:join(root,'installation.json'),dataDirectory:root,projectId:project,scheduleRestart(){}},
   passwordLogin:login,
  });
  const headers={'content-type':'application/json',origin};
  const snapshot=async(response:Response)=>({status:response.status,cache:response.headers.get('cache-control'),retry:response.headers.get('retry-after'),body:await response.json()});
  const ok=await app.request('/api/v1/ac/auth/password',{method:'POST',headers,body:JSON.stringify({user:'alice',password})});
  assert.equal(ok.status,200);
  assert.equal(authenticated,false);
  assert.deepEqual(await ok.json(),{state:'authenticated'});
  const wrong=await snapshot(await app.request('/api/v1/ac/auth/password',{method:'POST',headers,body:JSON.stringify({user:'alice',password:'incorrect-password'})}));
  const missing=await snapshot(await app.request('/api/v1/ac/auth/password',{method:'POST',headers,body:JSON.stringify({user:'bob',password:'incorrect-password'})}));
  assert.deepEqual(wrong,missing);
  assert.deepEqual(wrong,{status:401,cache:'no-store',retry:null,body:{error:'LOGIN_INVALID'}});
  const closed=await app.request('/api/v1/ac/auth/config');
  assert.deepEqual(await closed.json(),{enabled:false,passwordLogin:true});
  const gateway=createProjectGateway({
   projects:undefined as never,runtimes:undefined as never,defaultProjectId:project,
   authenticate:async()=>{authenticated=true;return null;},
   publicFetch:async request=>app.fetch(request),
   appFor:()=>{throw new Error('APP');},
  });
  const crossed=await gateway(new Request(origin+'/api/v1/ac/auth/password',{method:'POST',headers:{'content-type':'application/json',origin:'http://evil.invalid'},body:JSON.stringify({user:'alice',password})}));
  assert.equal(crossed.status,403);
  assert.equal(authenticated,false);
  const absent=createApi({pool:{query:async()=>({rowCount:0,rows:[]})}} as unknown as Ledger,{projectId:project,nativeExecutionReady:false} as CezarRuntime,async()=>null,()=>undefined);
  assert.equal((await absent.request('/api/v1/ac/auth/password',{method:'POST',headers,body:JSON.stringify({user:'alice',password})})).status,404);
  assert.deepEqual(await (await absent.request('/api/v1/ac/auth/config')).json(),{enabled:false,passwordLogin:false});
  const secureOrigin='https://panel.example';
  const secureSessions=new BrowserSessions({pool:{query:async()=>({rows:[]})}} as unknown as Ledger,randomBytes(32),async()=>'owner',{origin:secureOrigin,secure:true,maxAgeSeconds:300});
  const issued=await secureSessions.issue(new Request(secureOrigin+'/api/v1/ac/auth/password',{method:'POST',headers:{authorization:'Bearer token',origin:secureOrigin}}),panelSessionSeconds);
  const cookie=issued.headers.get('set-cookie')??'';
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/SameSite=Strict/);
  assert.match(cookie,/Secure/);
  assert.match(cookie,/Max-Age=2592000/);
  assert.equal(panelSessionSeconds,2592000);
  const ordinary=await secureSessions.issue(new Request(secureOrigin+'/api/v1/ac/auth/session',{method:'POST',headers:{authorization:'Bearer token',origin:secureOrigin}}));
  assert.match(ordinary.headers.get('set-cookie')??'',/HttpOnly/);
  assert.match(ordinary.headers.get('set-cookie')??'',/SameSite=Strict/);
  assert.match(ordinary.headers.get('set-cookie')??'',/Secure/);
  assert.match(ordinary.headers.get('set-cookie')??'',/Max-Age=300/);
  assert.doesNotMatch(ordinary.headers.get('set-cookie')??'',/Max-Age=2592000/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('the prompt uses the environment password once, or rejects two different entries',async()=>{
 const previous=process.env.AC_PANEL_PASSWORD;
 try{
  let asked=0;
  process.env.AC_PANEL_PASSWORD=password;
  assert.equal(await promptPanelPassword(async()=>{asked+=1;return 'other-password-xx';}),password);
  assert.equal(asked,0);
  delete process.env.AC_PANEL_PASSWORD;
  const mismatch=['correct-horse-12','correct-horse-13'];
  await assert.rejects(promptPanelPassword(async()=>mismatch.shift()??''),/PANEL_PASSWORD_MISMATCH/);
  const matched=['correct-horse-12','correct-horse-12'];
  const labels:string[]=[];
  assert.equal(await promptPanelPassword(async label=>{labels.push(label);return matched.shift()??'';}),password);
  assert.deepEqual(labels,['Senha: ','Repita a senha: ']);
 }finally{restoreEnv('AC_PANEL_PASSWORD',previous);}
});
});
