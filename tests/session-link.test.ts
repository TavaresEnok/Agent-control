import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {BrowserSessions} from '../src/sessions.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('Happier session linking requires same principal, confirmed E2EE and idempotent project scope',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,'sessionlink'),db=new Ledger(isolated.url),originalFetch=globalThis.fetch;
 try{
  await db.migrate();const project=randomUUID(),principal='owner-'+randomUUID(),sessionId='synthetic/session-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Session link fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  let verifyFailure=false,requests=0,reply:unknown={session:{id:sessionId,encryptionMode:'e2ee'}},status=200;
  const verify=async(request:Request)=>{if(verifyFailure)throw Error('SYNTHETIC_AUTH_NETWORK_FAILURE');return request.headers.get('authorization')==='Bearer synthetic-account-session'?principal:null;};
  const sessions=new BrowserSessions(db,randomBytes(32),verify,{origin:'http://127.0.0.1:18405',secure:false,maxAgeSeconds:60});
  const issued=await sessions.issue(new Request('http://127.0.0.1:18405/api/v1/ac/auth/session',{method:'POST',headers:{authorization:'Bearer synthetic-account-session',origin:'http://127.0.0.1:18405'}}));
  const cookie=issued.headers.get('set-cookie')!.split(';')[0];
  const request=new Request('http://127.0.0.1:18405/api/v1/ac/contexts',{method:'POST',headers:{cookie,origin:'http://127.0.0.1:18405'}});
  globalThis.fetch=async(input,init)=>{requests++;assert.equal(String(input),'https://happier.fixture/v2/sessions/'+encodeURIComponent(sessionId));
   assert.equal(new Headers(init?.headers).get('authorization'),'Bearer synthetic-account-session');return Response.json(reply,{status});};
  assert.equal(await sessions.verifyHappierSession(request,principal,sessionId,'https://happier.fixture'),true);
  const before=requests;assert.equal(await sessions.verifyHappierSession(request,'another-principal',sessionId,'https://happier.fixture'),false);assert.equal(requests,before);
  for(const session of [{id:sessionId,encryptionMode:'plain'},{id:sessionId},{id:'wrong',encryptionMode:'e2ee'}]){
   reply={session};assert.equal(await sessions.verifyHappierSession(request,principal,sessionId,'https://happier.fixture'),false);
  }
  status=403;assert.equal(await sessions.verifyHappierSession(request,principal,sessionId,'https://happier.fixture'),false);status=200;
  verifyFailure=true;assert.equal(await sessions.verifyHappierSession(request,principal,sessionId,'https://happier.fixture'),false);verifyFailure=false;
  assert.equal(await sessions.verifyHappierSession(request,principal,sessionId,'http://public.fixture'),false);
  const contexts=await Promise.all([db.createContext(principal,project,sessionId),db.createContext(principal,project,sessionId)]);
  assert.equal(contexts[0],contexts[1]);
  assert.equal(Number((await db.pool.query('SELECT count(*) n FROM ac_contexts WHERE project_id=$1',[project])).rows[0].n),1);
  const otherProject=randomUUID();await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[otherProject,'Different project']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[otherProject,principal]);
  await assert.rejects(db.createContext(principal,otherProject,sessionId),/SESSION_LINK_CONFLICT/);
 }finally{globalThis.fetch=originalFetch;await db.close();await isolated.close();}
});
