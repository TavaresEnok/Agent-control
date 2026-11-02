import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Ledger} from '../src/ledger.ts';
import {digest} from '../src/contracts.ts';
import {SandboxBroker,signSandbox} from '../src/sandbox-broker.ts';
import {provisionCapacity} from './fixtures/provision-capacity.ts';

test('broker replay requires matching terminal job and grant evidence',{skip:!process.env.AC_SANDBOX_DATABASE_URL},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL!;
 if(!/^\/ac_managed_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);await db.migrate();const project=randomUUID(),principal='terminal-'+randomUUID(),key=Buffer.alloc(32,7);
 const probe=resolve('scripts/sandbox-probe.mjs'),hash=createHash('sha256').update(await readFile(probe)).digest('hex');
 const root=resolve('.state/terminal-fixture'),image='sha256:'+'a'.repeat(64);
 const broker=new SandboxBroker({hostRoot:root,probeHostPath:probe,probeSha256:hash,imageId:image,socketPath:'/tmp/ac-unused.sock',keyPath:'/tmp/ac-unused.key',databaseUrl:url},key);
 try{
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)',[project,'terminal replay fixture']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')",[project,principal]);
  const fixture=await provisionCapacity(db,principal,project),contextId=await db.createContext(principal,project,randomUUID());
  await fixture.service.assignPolicy(principal,contextId,fixture.revision);
  const authority=await db.acquire(principal,contextId,randomUUID(),'synthetic-manager',60);
  const intent=await db.accept(principal,{schemaVersion:1,intentId:randomUUID(),deliveryAttemptId:randomUUID(),contextId,policyRevision:1,action:'plan.start',payload:{workflow:'baseline-synthetic-v1',messageRef:'encrypted:terminal'}},authority,'api');
  const grant=await fixture.service.reserve(principal,{attemptId:randomUUID(),intentId:intent.id,contextId,role:'programmer'},authority);
  const spec=digest({profile:'synthetic-probe-v1',image,work:join(root,intent.operation_id,'work'),probe,probeSha256:hash,grant:grant.id,epoch:authority.epoch});
  const receipt={jobId:intent.operation_id,containerId:'b'.repeat(64),exitCode:0,finishedAt:'2026-11-02T00:00:00Z',synthetic:true,probe:{visible:[],network:false,uid:10001}};
  await db.pool.query("UPDATE ac_capacity_grants SET state='released',physical_receipt=$2 WHERE id=$1",[grant.id,receipt]);
  await db.pool.query("INSERT INTO ac_sandbox_jobs(id,context_id,grant_id,manager_epoch,profile,spec_digest,state,receipt) VALUES($1,$2,$3,$4,'synthetic-probe-v1',$5,'completed',$6)",[intent.operation_id,contextId,grant.id,authority.epoch,spec,receipt]);
  const request=()=>signSandbox({schemaVersion:1,action:'reconcile',jobId:intent.operation_id,grantId:grant.id,authority,profile:'synthetic-probe-v1',expiresAt:Date.now()+30000},key);
  assert.deepEqual(await broker.perform(request()),receipt);
  await db.pool.query('UPDATE ac_capacity_grants SET physical_receipt=$2 WHERE id=$1',[grant.id,{...receipt,containerId:'c'.repeat(64)}]);
  await assert.rejects(broker.perform(request()),/SANDBOX_RECEIPT_UNCONFIRMED/);
  assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1',[grant.id])).rows[0].state,'released');
 }finally{await broker.close();await db.close();}
});
