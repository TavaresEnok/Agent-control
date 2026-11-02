import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {BrowserSessions} from '../src/sessions.ts';

test('browser session stores encrypted bearer, limits origin and revokes access',async()=>{
 const url=process.env.AC_TEST_DATABASE_URL;if(!url?.endsWith('/ac_implementation_test'))throw Error('ISOLATED_DATABASE_REQUIRED');
 const ledger=new Ledger(url);await ledger.migrate();
 const bearer='synthetic-'+randomUUID(),principal='browser-'+randomUUID(),origin='http://127.0.0.1:18402';
 const sessions=new BrowserSessions(ledger,randomBytes(32),async req=>req.headers.get('authorization')==='Bearer '+bearer?principal:null,{origin,secure:false,maxAgeSeconds:300});
 try{
  const issue=await sessions.issue(new Request(origin+'/api/v1/ac/auth/session',{method:'POST',headers:{authorization:'Bearer '+bearer,origin}}));
  const setCookie=issue.headers.get('set-cookie')!;assert.match(setCookie,/Path=\/api\//);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Strict/);
  const cookie=setCookie.split(';')[0];const req=new Request(origin+'/api/v1/ac/health',{headers:{cookie}});
  assert.equal(await sessions.authenticate(req),principal);
  const row=(await ledger.pool.query('SELECT token_ciphertext FROM ac_browser_sessions WHERE principal_id=$1',[principal])).rows[0];assert(!row.token_ciphertext.includes(bearer));
  assert.throws(()=>sessions.checkOrigin(new Request(origin+'/api/v1/ac/control',{method:'POST',headers:{cookie,origin:'http://evil.invalid'}})));
  await sessions.revoke(new Request(origin+'/api/v1/ac/auth/logout',{method:'POST',headers:{cookie,origin}}));assert.equal(await sessions.authenticate(req),null);
  assert.throws(()=>new BrowserSessions(ledger,randomBytes(32),async()=>null,{origin,secure:true,maxAgeSeconds:300}));
 }finally{await ledger.close();}
});
