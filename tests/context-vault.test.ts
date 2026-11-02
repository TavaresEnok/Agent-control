import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {ContextVault} from '../src/context-vault.ts';
import {ManagerRegistry} from '../src/managers.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

test('vault custody requires active owner, detects tampering and transfers only private key copies',async()=>{
 const base=process.env.AC_TEST_DATABASE_URL;if(!base)throw Error('ISOLATED_DATABASE_REQUIRED');
 const fixture=await isolatedDatabase(base,'vault'),db=new Ledger(fixture.url),folder=await mkdtemp(join(tmpdir(),'ac-vault-'));
 let registry:ManagerRegistry|undefined;
 try{
  await db.migrate();const root=join(folder,'vault'),master=join(folder,'master');await mkdir(root,{mode:0o700});await writeFile(master,randomBytes(32),{mode:0o600});
  const installationId=(await db.pool.query('SELECT id FROM ac_installation_identity')).rows[0].id,project=randomUUID(),principal='vault-'+randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic vault']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const contextId=await db.createContext(principal,project,randomUUID());
  const sessionId=(await db.pool.query('SELECT session_id FROM ac_session_links WHERE context_id=$1',[contextId])).rows[0].session_id;
  const key=randomBytes(32),original=Buffer.from(key),keys=new ContextKeys(db);await keys.authorize(principal,contextId,1,'legacy',keyFingerprint(key));
  const request={principal,contextId,sessionId,profileId:'synthetic',keyVersion:1,encryptionVariant:'legacy' as const};
  const vault=new ContextVault(db,installationId,root,master,[]);await vault.importKey(request,key);assert.deepEqual(key,original);
  await assert.rejects(vault.importKey(request,key),/VAULT_ENTRY_EXISTS/);
  await assert.rejects(vault.load({...request,sessionId:'wrong'}),/SESSION_CONTEXT_MISMATCH/);
  const loaded=await vault.load(request);assert.deepEqual(Buffer.from(loaded),original);loaded.fill(0);
  let storedKey!:Uint8Array;registry=new ManagerRegistry(db,project,input=>{storedKey=input.key;return {async start(){},close(){}};});
  const authority=await registry.startFromKeySource(request,vault);await db.heartbeat(authority);assert.deepEqual(Buffer.from(storedKey),original);
  const path=join(root,`${contextId}-1.vault`),stored=JSON.parse(await readFile(path,'utf8'));stored.tag='0'.repeat(32);await writeFile(path,JSON.stringify(stored));
  await assert.rejects(vault.load(request),/VAULT_AUTHENTICATION_FAILED/);
  await keys.revoke(principal,contextId,1);await assert.rejects(vault.load(request),/CONTEXT_KEY_UNAUTHORIZED/);
 }finally{await registry?.close();await db.close();await fixture.close();await rm(folder,{recursive:true,force:true});}
});

test('timed out and stopped key sources cannot start a manager and late keys are wiped',async()=>{
 let factoryCalls=0;const registry=new ManagerRegistry({} as Ledger,randomUUID(),()=>{factoryCalls++;throw Error('NOT_EXPECTED');},{startupTimeoutMs:30});
 const request={principal:'synthetic',contextId:randomUUID(),sessionId:'session',profileId:'fixture',keyVersion:1,encryptionVariant:'legacy' as const};
 try{
  let resolve!: (key:Uint8Array)=>void;const source={load:()=>new Promise<Uint8Array>(done=>{resolve=done;})};
  await assert.rejects(registry.startFromKeySource(request,source),/MANAGER_START_TIMEOUT/);
  const late=randomBytes(32);resolve(late);await new Promise(done=>setTimeout(done,0));assert(late.every(byte=>byte===0));
  let resolveStop!: (key:Uint8Array)=>void,entered!:()=>void;const called=new Promise<void>(done=>{entered=done;});
  const stopped=registry.startFromKeySource(request,{load:()=>{entered();return new Promise<Uint8Array>(done=>{resolveStop=done;});}});
  const rejection=assert.rejects(stopped,/MANAGER_STOPPED/);await called;await registry.stop(request.contextId);await rejection;
  const lateStop=randomBytes(32);resolveStop(lateStop);await new Promise(done=>setTimeout(done,0));assert(lateStop.every(byte=>byte===0));assert.equal(factoryCalls,0);
 }finally{await registry.close();}
});
