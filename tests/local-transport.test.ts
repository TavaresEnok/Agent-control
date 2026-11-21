import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Installation} from '../src/installation.ts';
import {Ledger} from '../src/ledger.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {ConversationEndpoint} from '../src/conversation.ts';
import {LocalConversationTransport} from '../src/conversation-transport.ts';
import {personalPanelLocalId} from '../src/personal-panel-conversation.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {PersonalManagerChat} from '../src/personal-manager-chat.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const data='/tmp/ac-local-schema';
function installation(extra:Record<string,unknown>={}){
 const project=randomUUID();
 return {schemaVersion:1,mode:'administration-only',databaseUrl:'postgresql://localhost/ac',dataDirectory:data,
  project:{id:project,label:'Local',repo:'/srv/ac-local-repo',owner:'owner'},
  contextVault:{directory:data+'/vault',masterFile:data+'/vault-master'},
  managerTransport:{principal:'owner',contexts:[{projectId:project,contextId:randomUUID(),sessionId:'session',profileId:'profile',keyVersion:1,encryptionVariant:'legacy'}]},
  http:{listen:'127.0.0.1',port:8080,publicOrigin:'http://127.0.0.1:8080'},
  ...extra};
}

test('an installation without a transport field is local',()=>{
 const parsed=Installation.parse(installation());
 assert.equal(parsed.managerTransport?.transport,'local');
 assert.equal(parsed.activation,'locked');
});

test('only the local transport is accepted; legacy token and machine fields still load',()=>{
 const transport=installation().managerTransport as object;
 assert.throws(()=>Installation.parse(installation({managerTransport:{...transport,transport:'remote'}})));
 const legacy=Installation.parse(installation({activation:'personal',managerTransport:{...transport,transport:'local',tokenFile:data+'/token',machineId:'machine'}}));
 assert.equal(legacy.managerTransport?.transport,'local');
 assert.equal(legacy.activation,'personal');
});

test('one local owner message is accepted once and a repeated clientId does not duplicate',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'localtransport'),db=new Ledger(fixture.url);
 const folder=await mkdtemp(join(tmpdir(),'ac-local-repo-'));
 const key=randomBytes(32);let endpoint:ConversationEndpoint|undefined;
 const originalFetch=globalThis.fetch;let fetches=0;
 globalThis.fetch=async()=>{fetches++;throw Error('NETWORK_FETCH_FORBIDDEN');};
 try{
  await db.migrate();
  const project=randomUUID(),principal='owner-'+randomUUID(),sessionId=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Local transport']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,sessionId);
  await new ContextKeys(db).authorize(principal,context,1,'legacy',keyFingerprint(key));
  const authority=await db.acquire(principal,context,randomUUID(),'personal-manager',60);
  let decisions=0;
  const managerChat={async decide(){decisions++;return {kind:'answer' as const,answer:'Resposta local do gerente.'};}} as unknown as PersonalManagerChat;
  const runtime={repo:folder,projectId:project,executionMode:'administration-only',async reconcileCancellations(){},async recoverManaged(){},store:{listRuns:()=>[],updateRun(){},flush(){}}} as unknown as CezarRuntime;
  const transport=new LocalConversationTransport({ledger:db,contextId:context,principal});
  endpoint=new ConversationEndpoint(db,runtime,{key,principal,sessionId,authority,personalConversation:true,managerChat},transport);
  await transport.start();
  const localId=personalPanelLocalId('clientId1');
  await endpoint.enqueueOwnerMessage('qual é o estado deste projeto?',localId);
  await endpoint.enqueueOwnerMessage('texto repetido que não pode entrar',localId);
  await endpoint.tick();
  assert.equal(decisions,1);
  assert.equal(fetches,0);
  const page=await endpoint.readPanelConversation(undefined,50);
  assert.deepEqual(page.messages.map(message=>[message.role,message.text]),[
   ['owner','qual é o estado deste projeto?'],
   ['manager','Resposta local do gerente.'],
  ]);
  assert.match(page.messages[0]!.createdAt,/^\d{4}-\d{2}-\d{2}T/);
  const rows=await db.pool.query('SELECT role,local_id,text,accepted FROM ac_personal_messages WHERE context_id=$1 ORDER BY seq',[context]);
  assert.equal(rows.rowCount,2);
  assert.equal(rows.rows[0].accepted,true);
  assert.equal(rows.rows[0].local_id,localId);
  await endpoint.enqueueOwnerMessage('ainda outro texto',localId);
  await endpoint.tick();
  assert.equal(decisions,1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_personal_messages WHERE context_id=$1 AND role=$2',[context,'owner'])).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT text FROM ac_personal_messages WHERE context_id=$1 AND role=$2',[context,'owner'])).rows[0].text,'qual é o estado deste projeto?');
  assert.equal(fetches,0);
 }finally{globalThis.fetch=originalFetch;key.fill(0);endpoint?.close();await db.close();await fixture.close();await rm(folder,{recursive:true,force:true});}
});
