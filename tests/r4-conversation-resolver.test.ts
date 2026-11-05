import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Ledger} from '../src/ledger.ts';
import {Projects} from '../src/projects.ts';
import {createProjectGateway} from '../src/projects-api.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('conversation resolver checks upstream access, original principal, membership and active link across projects',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('AC_TEST_DATABASE_URL_REQUIRED');
 const db=await isolatedDatabase(base,'r4entry');const ledger=new Ledger(db.url);
 try{
  await ledger.migrate();const a=randomUUID(),b=randomUUID();
  for(const project of [a,b]){
   await ledger.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'synthetic']);
   await ledger.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)',[project,'/synthetic/'+project]);
   await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,'owner','owner'),($1,'colleague','operator')",[project]);
  }
  const context=await ledger.createContext('owner',b,'synthetic-session');
  let upstream=true,checks=0;
  const gateway=createProjectGateway({projects:new Projects(ledger),runtimes:{} as never,defaultProjectId:a,
   authenticate:async r=>r.headers.get('x-principal'),publicFetch:async()=>{throw Error('public');},appFor:()=>{throw Error('runtime');},
   verifyConversationAccess:async()=>{checks++;return upstream;}});
  const request=(principal?:string,session='synthetic-session',method='GET')=>new Request('http://localhost/api/v1/ac/conversation-entry?sessionId='+encodeURIComponent(session),{method,headers:principal?{'x-principal':principal}:{}});
  assert.equal((await gateway(request())).status,401);assert.equal(checks,0);
  assert.equal((await gateway(request('owner','\u0000'))).status,400);assert.equal(checks,0);
  assert.equal((await gateway(request('owner','synthetic-session','POST'))).status,405);
  const result=await gateway(request('owner'));assert.equal(result.headers.get('cache-control'),'no-store');
  assert.deepEqual(await result.json(),{matches:[{projectId:b,contextId:context}]});
  for(const principal of ['colleague','outsider'])assert.deepEqual(await (await gateway(request(principal))).json(),{matches:[]});
  upstream=false;assert.deepEqual(await (await gateway(request('owner'))).json(),{matches:[]});upstream=true;
  await ledger.pool.query("DELETE FROM ac_memberships WHERE project_id=$1 AND principal_id='owner'",[b]);
  assert.deepEqual(await (await gateway(request('owner'))).json(),{matches:[]});
  await ledger.pool.query("INSERT INTO ac_memberships VALUES($1,'owner','owner')",[b]);
  await ledger.pool.query('UPDATE ac_contexts SET archived=true WHERE id=$1',[context]);
  assert.deepEqual(await (await gateway(request('owner'))).json(),{matches:[]});
 }finally{await ledger.close();await db.close();}
});
