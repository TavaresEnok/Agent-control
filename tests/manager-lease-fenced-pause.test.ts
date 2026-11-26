import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {Ledger} from '../src/ledger.ts';
import {ContextKeys,keyFingerprint} from '../src/context-keys.ts';
import {keepPersonalVerifyLease} from '../src/personal-verify-cli.ts';
import {failAbandonedVerifyRuns} from '../src/verify-abandon.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionCapacity} from './fixtures/provision-capacity.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

// VERIFY_LEASE_LOST of 25/11/2026 00:36 UTC: the native supervisor calls Docker (create, start, stop, remove, logs) inside
// transactions that ran `fence`, so they hold the context anchor and the manager row. With the disk saturated by the watch's
// cleanup, one of those calls outlived the 15 s lease. The heartbeat waited behind it on the same rows, found the lease expired
// once the transaction committed and every later heartbeat failed with STALE_MANAGER: the exam stopped as VERIFY_LEASE_LOST.
// Nobody could take the lease over during that pause (acquire, orphan recovery and key changes all take the anchor first), so
// the time a fenced transaction holds the anchor must not consume the lease. A lease that is really lost still fails.
async function setup(name:string){
 const url=process.env.AC_TEST_DATABASE_URL;if(!url)throw Error('ISOLATED_DATABASE_REQUIRED');
 const isolated=await isolatedDatabase(url,name),db=new Ledger(isolated.url);
 await db.migrate();
 const project=randomUUID(),principal='lease-'+randomUUID();
 await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'Synthetic fenced lease pause']);
 await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
 const context=await db.createContext(principal,project,randomUUID());
 await new ContextKeys(db).authorize(principal,context,1,'legacy',keyFingerprint(randomBytes(32)));
 return {db,isolated,principal,context,project};
}

test('a fenced transaction longer than the lease does not cost the heartbeat its lease',async()=>{
 const {db,isolated,principal,context}=await setup('lease_pause');
 try{
  const authority=await db.acquire(principal,context,randomUUID(),'personal-verify',1);
  let aborted=0;
  const stop=keepPersonalVerifyLease(db,authority,150,()=>{aborted++;});
  let fenced!:()=>void;const entered=new Promise<void>(resolve=>{fenced=resolve;});
  // A Docker call slower than the lease, made under the fence, as in effect() and the reconcile/retirement transactions.
  const slowEffect=db.tx(async c=>{await db.fence(c,authority,true);fenced();await sleep(1800);});
  await entered;
  const blocked=db.heartbeat(authority);
  await slowEffect;
  await blocked;
  await sleep(800);
  stop();
  assert.equal(aborted,0,'the lease renewal survived the pause');
  await db.heartbeat(authority);
 }finally{await db.close();await isolated.close();}
});

test('a real lease loss is still refused after the change',async()=>{
 const {db,isolated,principal,context}=await setup('lease_loss');
 try{
  // Expiry with nobody holding the anchor.
  const idle=await db.acquire(principal,context,randomUUID(),'personal-verify',1);
  await sleep(1300);
  await assert.rejects(db.heartbeat(idle),/STALE_MANAGER/);
  // A successor took the lease: the old epoch stays fenced.
  const next=await db.acquire(principal,context,randomUUID(),'personal-verify',1);
  assert.equal(next.epoch,idle.epoch+1);
  await assert.rejects(db.heartbeat(idle),/STALE_MANAGER/);
  // A fenced transaction that ends its own lease (release, key change) is not extended at commit.
  await db.tx(async c=>{await db.fence(c,next,true);await sleep(300);
   await c.query('UPDATE ac_managers SET lease_until=clock_timestamp() WHERE context_id=$1',[context]);});
  await assert.rejects(db.heartbeat(next),/STALE_MANAGER/);
  // A long fenced transaction that rolls back does not extend the lease either.
  const third=await db.acquire(principal,context,randomUUID(),'personal-verify',1);
  await assert.rejects(db.tx(async c=>{await db.fence(c,third,true);await sleep(1300);throw Error('SYNTHETIC_DOCKER_FAILURE');}),/SYNTHETIC_DOCKER_FAILURE/);
  await assert.rejects(db.heartbeat(third),/STALE_MANAGER/);
 }finally{await db.close();await isolated.close();}
});

// The review's high finding: the server sweeps abandoned verifications every 60 s without the context anchor. During the
// pause the committed lease looks expired, so the old sweep failed the run that the heartbeat later kept alive.
test('the abandoned-run sweep does not fail a run whose manager is inside a long fenced transaction',async()=>{
 const {db,isolated,principal,context,project}=await setup('lease_sweep');
 const data=await mkdtemp(join(tmpdir(),'ac-lease-sweep-'));
 try{
  const authority=await db.acquire(principal,context,randomUUID(),'personal-verify',1);
  const capacity=await provisionCapacity(db,principal,project);await capacity.service.assignPolicy(principal,context,capacity.revision);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId:context,policyRevision:1,
   action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:synthetic-lease-sweep'}},authority,'api');
  const run=randomUUID();
  await db.pool.query(`INSERT INTO ac_verify_runs(id,project_id,context_id,intent_id,principal_id,commit_id,status,report_dir)
   VALUES($1,$2,$3,$4,$5,$6,'running','pending')`,[run,project,context,intent.id,principal,'0'.repeat(40)]);
  const status=async()=>(await db.pool.query('SELECT status FROM ac_verify_runs WHERE id=$1',[run])).rows[0].status;
  await db.heartbeat(authority);
  // Back to a 1 s lease, then a fenced Docker call of 1.8 s with the sweep in the middle and right after the commit.
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()+interval '1 second' WHERE context_id=$1",[context]);
  let fenced!:()=>void;const entered=new Promise<void>(resolve=>{fenced=resolve;});
  const slowEffect=db.tx(async c=>{await db.fence(c,authority,true);fenced();await sleep(1800);});
  await entered;await sleep(1300);
  await failAbandonedVerifyRuns(db,data);
  assert.equal(await status(),'running','the sweep during the pause keeps the run');
  await slowEffect;
  await failAbandonedVerifyRuns(db,data);
  assert.equal(await status(),'running','the sweep after the commit sees the lease given back');
  await db.heartbeat(authority);
  // A real loss still fails the run: the lease expires with nobody holding the anchor.
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp() WHERE context_id=$1",[context]);
  await failAbandonedVerifyRuns(db,data);
  assert.equal(await status(),'failed');
 }finally{await rm(data,{recursive:true,force:true});await db.close();await isolated.close();}
});
