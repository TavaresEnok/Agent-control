import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {ConversationEndpoint} from '../src/conversation.ts';
import {LocalConversationTransport} from '../src/conversation-transport.ts';
import {Refusal} from '../src/contracts.ts';
import {personalPanelLocalId} from '../src/personal-panel-conversation.ts';
import type {CezarRuntime} from '../src/cezar.ts';
import type {PersonalManagerChat} from '../src/personal-manager-chat.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('a tick cut by the shutdown records no manager.blocked audit and sends no blocked notice',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'convshutdown'),db=new Ledger(fixture.url);
 const folder=await mkdtemp(join(tmpdir(),'ac-shutdown-repo-'));
 const key=randomBytes(32);let endpoint:ConversationEndpoint|undefined;
 const errors:string[]=[];const originalError=console.error;
 try{
  await db.migrate();
  const project=randomUUID(),principal='owner-'+randomUUID(),sessionId=randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Shutdown']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const context=await db.createContext(principal,project,sessionId);
  await new ContextKeys(db).authorize(principal,context,1,'legacy',keyFingerprint(key));
  const authority=await db.acquire(principal,context,randomUUID(),'personal-manager',60);
  let entered!:()=>void,release!:()=>void;
  const inside=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const managerChat={async decide(){entered();await gate;throw new Refusal('STALE_MANAGER');}} as unknown as PersonalManagerChat;
  const runtime={repo:folder,projectId:project,executionMode:'administration-only',async reconcileCancellations(){},async recoverManaged(){},store:{listRuns:()=>[],updateRun(){},flush(){}}} as unknown as CezarRuntime;
  const transport=new LocalConversationTransport({ledger:db,contextId:context,principal});
  endpoint=new ConversationEndpoint(db,runtime,{key,principal,sessionId,authority,personalConversation:true,managerChat},transport);
  await transport.start();
  await endpoint.enqueueOwnerMessage('pergunta durante o desligamento',personalPanelLocalId('shutdown1'));
  console.error=(...args:unknown[])=>{errors.push(args.map(String).join(' '));};
  (endpoint as unknown as {armTick():void}).armTick();
  await inside;
  // The gateway stops: the endpoint closes while its tick is still running, and the tick then fails.
  endpoint.close();
  release();
  await new Promise(resolve=>setTimeout(resolve,500));
  const audits=await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE context_id=$1 AND kind='manager.blocked'",[context]);
  assert.equal(audits.rows[0].n,0);
  assert.equal(errors.some(line=>/MANAGER_BLOCKED_(AUDIT_NOT_RECORDED|NOTICE_DEFERRED)/.test(line)),false);
 }finally{console.error=originalError;key.fill(0);endpoint?.close();await db.close();await fixture.close();await rm(folder,{recursive:true,force:true});}
});
