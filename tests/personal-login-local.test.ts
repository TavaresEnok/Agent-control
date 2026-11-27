import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {createApi} from '../src/api.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import {BrowserSessions,type BearerVerifier} from '../src/sessions.ts';
import {personalCodeLogin,personalOwnerPrincipal,personalPasswordLogin} from '../src/personal-login.ts';
import {createPairCode} from '../src/personal-pair.ts';
import {panelSessionSeconds,savePanelLogin} from '../src/personal-password.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const origin='http://127.0.0.1:8080';
function loginConfig(folder:string,project:string,owner:string,principal:string){
 return {dataDirectory:folder,project:{id:project,owner},
  managerTransport:{principal}};
}

test('password and code login issue a cookie without any network call or bearer',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'locallogin'),db=new Ledger(fixture.url);
 const folder=await realpath(await mkdtemp(join(tmpdir(),'ac-local-login-')));
 const originalFetch=globalThis.fetch;let fetches=0;
 globalThis.fetch=async()=>{fetches++;throw Error('NETWORK_FETCH_FORBIDDEN');};
 let verifies=0;
 const verify:BearerVerifier=async request=>{verifies++;return request.headers.get('authorization')==='Bearer old-token'?'counted':null;};
 try{
  await db.migrate();
  const project=randomUUID(),principal='owner-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Login']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.createContext(principal,project,randomUUID());
  await savePanelLogin(folder,'alice','correct-horse-12');
  const config=loginConfig(folder,project,'config-owner',principal);
  const sessions=new BrowserSessions(db,randomBytes(32),verify,{origin,secure:false,maxAgeSeconds:300});
  const password=personalPasswordLogin(config,db,sessions);
  const issued=await password(new Request(origin+'/api/v1/ac/auth/password',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({user:'alice',password:'correct-horse-12'})}));
  assert.equal(issued.status,200);
  const cookie=issued.headers.get('set-cookie')??'';
  assert.match(cookie,new RegExp('Max-Age='+panelSessionSeconds));
  assert.equal(await sessions.authenticate(new Request(origin+'/api/v1/ac/health',{headers:{cookie:cookie.split(';')[0]!}})),principal);
  const stored=(await db.pool.query('SELECT token_ciphertext,nonce,tag FROM ac_browser_sessions WHERE principal_id=$1',[principal])).rows[0];
  assert.equal(stored.token_ciphertext,null);
  assert.equal(stored.nonce,null);
  assert.equal(stored.tag,null);
  const {code}=await createPairCode(folder);
  const coded=await personalCodeLogin(config,db,sessions)(new Request(origin+'/api/v1/ac/auth/code',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({code})}));
  assert.equal(coded.status,200);
  assert.match(coded.headers.get('set-cookie')??'',/Max-Age=300/);
  assert.equal(fetches,0);
  assert.equal(verifies,0);
  const old=await sessions.issue(new Request(origin+'/api/v1/ac/auth/session',{method:'POST',headers:{authorization:'Bearer old-token',origin}}));
  const oldCookie=(old.headers.get('set-cookie')??'').split(';')[0]!;
  assert.equal(await sessions.authenticate(new Request(origin+'/api/v1/ac/health',{headers:{cookie:oldCookie}})),'counted');
  assert.equal(verifies,2);
  assert.equal(fetches,0);
  const cipher=(await db.pool.query('SELECT token_ciphertext FROM ac_browser_sessions WHERE principal_id=$1 AND token_ciphertext IS NOT NULL',['counted'])).rows[0];
  assert.equal(typeof cipher.token_ciphertext,'string');
  assert.equal(cipher.token_ciphertext.includes('old-token'),false);
 }finally{globalThis.fetch=originalFetch;await db.close();await fixture.close();await rm(folder,{recursive:true,force:true});}
});

test('local login prefers the conversation owner over the project owner record',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'loginowner'),db=new Ledger(fixture.url);
 try{
  await db.migrate();
  const project=randomUUID(),linked='linked-'+randomUUID(),record='record-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Login']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,linked]);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,record]);
  await db.createContext(linked,project,randomUUID());
  const config=loginConfig('/tmp/ac-local-login',project,record,'not-a-member');
  assert.equal(await personalOwnerPrincipal(db,config),linked);
 }finally{await db.close();await fixture.close();}
});

test('public login refuses excess or slow bodies before taking a database connection',async t=>{
 const folder=await realpath(await mkdtemp(join(tmpdir(),'ac-local-admission-')));
 t.after(()=>rm(folder,{recursive:true,force:true}));
 const project=randomUUID(),config=loginConfig(folder,project,'owner','owner');
 let queries=0;
 const ledger={pool:{query:async()=>{queries++;return {rows:[{}],rowCount:1};}}} as unknown as Ledger;
 const sessions=new BrowserSessions(ledger,randomBytes(32),async()=>null,{origin,secure:false,maxAgeSeconds:300});
 const app=createApi(ledger,{projectId:project,nativeExecutionReady:false} as CezarRuntime,async()=> 'owner',()=>undefined,{
  sessions,passwordLogin:personalPasswordLogin(config,ledger,sessions),pairCodeLogin:personalCodeLogin(config,ledger,sessions),
 });
 const login=(route:string,body:BodyInit,ip='192.0.2.1')=>app.fetch(new Request(origin+'/api/v1/ac/auth/'+route,{
  method:'POST',headers:{'content-type':'application/json',origin,'x-agent-control-remote-address':ip},body,duplex:'half',
 } as RequestInit));
 const password=(body:BodyInit,ip?:string)=>login('password',body,ip);
 const code=(body:BodyInit,ip?:string)=>login('code',body,ip);
 let cancelled=0;
 const slow=()=>new ReadableStream<Uint8Array>({cancel(){cancelled++;}});
 const pending=[password(slow()),code(slow())];
 assert.equal((await code('{"code":"ABCDEFGH"}')).status,429);
 for(let index=2;index<=7;index++)pending.push(code(slow(),'192.0.2.'+index));
 assert.equal((await password('{"user":"alice","password":"correct-horse-12"}','192.0.2.9')).status,429);
 assert.equal((await app.request('/api/v1/ac/auth/status')).status,200);
 assert.deepEqual((await Promise.all(pending)).map(response=>response.status),Array(8).fill(408));
 assert.equal(cancelled,8);
 assert.equal((await code(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4097));}}))).status,413);
 for(let attempt=0;attempt<5;attempt++)assert.equal((await code('{"code":"INVALID"}')).status,401);
 assert.equal((await code('{"code":"INVALID"}')).status,429);
 assert.equal(queries,0);
 const issued=await createPairCode(folder);
 assert.equal((await code(JSON.stringify({code:issued.code}),'192.0.2.10')).status,200);
 assert.equal(queries,3);
});
