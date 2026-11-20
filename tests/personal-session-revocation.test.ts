import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {BrowserSessions,type BearerVerifier} from '../src/sessions.ts';
import {personalCodeLogin,personalPasswordLogin} from '../src/personal-login.ts';
import {createPairCode} from '../src/personal-pair.ts';
import {removePanelLogin,savePanelLogin} from '../src/personal-password.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const origin='http://127.0.0.1:8080';
const verify:BearerVerifier=async()=>null;
const cookieOf=(response:Response)=>(response.headers.get('set-cookie')??'').split(';')[0]!;
const probe=(cookie:string)=>new Request(origin+'/api/v1/ac/health',{headers:{cookie}});

test('a password change or removal ends the sessions issued under the old credential',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'sessionrevoke'),db=new Ledger(fixture.url);
 const folder=await realpath(await mkdtemp(join(tmpdir(),'ac-session-revoke-')));
 try{
  await db.migrate();
  const project=randomUUID(),principal='happier-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Revoke']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  await db.createContext(principal,project,randomUUID());
  const config={dataDirectory:folder,project:{id:project,owner:'config-owner'},
   managerTransport:{principal,transport:'local' as const,tokenFile:join(folder,'token')},
   happier:{upstreamOrigin:'http://127.0.0.1:8081'},http:{publicOrigin:origin}};
  const sessions=new BrowserSessions(db,randomBytes(32),verify,{origin,secure:false,maxAgeSeconds:300});
  const login=personalPasswordLogin(config,db,sessions,verify);
  const attempt=(user:string,password:string)=>login(new Request(origin+'/api/v1/ac/auth/password',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({user,password})}));

  await savePanelLogin(folder,'alice','correct-horse-12');
  const first=await attempt('alice','correct-horse-12');assert.equal(first.status,200);
  const old=cookieOf(first);
  assert.equal(await sessions.authenticate(probe(old)),principal);

  // Change of password: the old cookie is refused, the new password issues a working one.
  await savePanelLogin(folder,'alice','another-horse-34');
  assert.equal(await sessions.authenticate(probe(old)),null);
  assert.equal((await attempt('alice','correct-horse-12')).status,401);
  const second=await attempt('alice','another-horse-34');assert.equal(second.status,200);
  const renewed=cookieOf(second);
  assert.equal(await sessions.authenticate(probe(renewed)),principal);

  // Removal of the password: the cookie issued under it is refused too.
  await removePanelLogin(folder);
  assert.equal(await sessions.authenticate(probe(renewed)),null);
  assert.equal(await sessions.authenticate(probe(old)),null);

  // A pair-code session issued after the removal is a new credential and works.
  const {code}=await createPairCode(folder);
  const coded=await personalCodeLogin(config,db,sessions,verify)(new Request(origin+'/api/v1/ac/auth/code',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({code})}));
  assert.equal(coded.status,200);
  assert.equal(await sessions.authenticate(probe(cookieOf(coded))),principal);
 }finally{await db.close();await fixture.close();await rm(folder,{recursive:true,force:true});}
});
