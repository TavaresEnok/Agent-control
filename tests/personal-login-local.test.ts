import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {BrowserSessions,type BearerVerifier} from '../src/sessions.ts';
import {apiBearerVerifier,happierProfileVerifier,personalCodeLogin,personalOwnerPrincipal,personalPasswordLogin} from '../src/personal-login.ts';
import {createPairCode} from '../src/personal-pair.ts';
import {panelSessionSeconds,savePanelLogin} from '../src/personal-password.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const origin='http://127.0.0.1:8080';
function loginConfig(folder:string,project:string,owner:string,principal:string){
 return {dataDirectory:folder,project:{id:project,owner},
  managerTransport:{principal,transport:'local' as const,tokenFile:join(folder,'token')},
  happier:{upstreamOrigin:'http://127.0.0.1:8081'},http:{publicOrigin:origin}};
}

test('local password and code login issue a cookie without calling Happier',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'locallogin'),db=new Ledger(fixture.url);
 const folder=await realpath(await mkdtemp(join(tmpdir(),'ac-local-login-')));
 const originalFetch=globalThis.fetch;let fetches=0;
 globalThis.fetch=async()=>{fetches++;throw Error('HAPPIER_FETCH_FORBIDDEN');};
 let verifies=0;
 const verify:BearerVerifier=async request=>{verifies++;return request.headers.get('authorization')==='Bearer old-token'?'counted':null;};
 try{
  await db.migrate();
  const project=randomUUID(),principal='happier-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Login']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.createContext(principal,project,randomUUID());
  await savePanelLogin(folder,'alice','correct-horse-12');
  const config=loginConfig(folder,project,'config-owner',principal);
  const sessions=new BrowserSessions(db,randomBytes(32),verify,{origin,secure:false,maxAgeSeconds:300});
  const password=personalPasswordLogin(config,db,sessions,verify);
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
  const coded=await personalCodeLogin(config,db,sessions,verify)(new Request(origin+'/api/v1/ac/auth/code',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({code})}));
  assert.equal(coded.status,200);
  assert.match(coded.headers.get('set-cookie')??'',/Max-Age=300/);
  assert.equal(await apiBearerVerifier(config)(new Request(origin+'/',{headers:{authorization:'Bearer old-token'}})),null);
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

test('a happier bearer still resolves through the profile, and a local verifier does not',async()=>{
 let calls=0;
 const fetchPage:typeof fetch=async()=>{calls++;return new Response(JSON.stringify({id:'acct'}),{status:200});};
 const verify=happierProfileVerifier('http://127.0.0.1:8081',fetchPage);
 assert.equal(await verify(new Request(origin+'/',{headers:{authorization:'Bearer token'}})),'acct');
 assert.equal(calls,1);
 const local=apiBearerVerifier({managerTransport:{transport:'local'},happier:{upstreamOrigin:'http://127.0.0.1:8081'}},fetchPage);
 assert.equal(await local(new Request(origin+'/',{headers:{authorization:'Bearer token'}})),null);
 assert.equal(calls,1);
});
