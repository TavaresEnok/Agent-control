import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Ledger} from '../src/ledger.ts';
import {SandboxClient} from '../src/sandbox-client.ts';
import {canonical,digest} from '../src/contracts.ts';

test('a new manager reconciles retirement after the broker disappeared after removal',
 {timeout:30000,skip:process.env.AC_MANAGED_RETIREMENT_RESTART!=='1'},async()=>{
 const url=process.env.AC_SANDBOX_DATABASE_URL;
 if(!url||!/^\/ac_managed_test_[a-f0-9]+$/.test(new URL(url).pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
 const db=new Ledger(url);
 try{
  const rows=(await db.pool.query(`SELECT r.*,w.state writer_state,i.context_id,i.principal_id,o.grant_id,l.snapshot,
   m.instance_id,m.epoch,m.profile_id FROM ac_sandbox_writer_retirements r
   JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id
   JOIN ac_intents i ON i.id=r.holder_intent_id JOIN ac_operations o ON o.id=r.job_id
   JOIN ac_execution_launches l ON l.operation_id=r.job_id JOIN ac_managers m ON m.context_id=i.context_id
   WHERE r.state='prepared'`)).rows;
  assert(rows.length>=1&&rows.length<=2);const first=rows[0]!;
  assert(rows.every(row=>row.writer_state==='held'&&row.context_id===first.context_id&&row.epoch===first.epoch));
  const old={contextId:first.context_id,instanceId:first.instance_id,epoch:Number(first.epoch)};
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1",[first.context_id]);
  const authority=await db.acquire(first.principal_id,first.context_id,randomUUID(),first.profile_id,60);
  assert(authority.epoch>old.epoch);
  const client=new SandboxClient();
  const key=await readFile('/run/ac-broker/key');
  for(const row of rows){
  await assert.rejects(client.perform('cleanup',row.job_id,row.grant_id,old,row.snapshot),/STALE_MANAGER/);
  assert.deepEqual(await client.perform('cleanup',row.job_id,row.grant_id,authority,row.snapshot),{jobId:row.job_id,state:'cleaned'});
  assert.deepEqual(await client.perform('cleanup',row.job_id,row.grant_id,authority,row.snapshot),{jobId:row.job_id,state:'cleaned'});
  const saved=(await db.pool.query(`SELECT r.state retirement_state,r.proof,w.state writer_state,w.proof_digest
   FROM ac_sandbox_writer_retirements r JOIN ac_worktree_writers w ON w.parent_intent_id=r.parent_intent_id AND w.run_id=r.run_id
   WHERE r.job_id=$1`,[row.job_id])).rows[0];
  assert.equal(saved.retirement_state,'revoked');assert.equal(saved.writer_state,'neutralized');assert.equal(saved.proof_digest,digest(saved.proof));
  assert.equal(saved.proof.payload.jobId,row.job_id);assert.equal(saved.proof.payload.writerEpoch,Number(row.writer_epoch));
  assert.equal(saved.proof.signature,createHmac('sha256',key).update('agent-control:sandbox-writer-retirement:v1\n').update(canonical(saved.proof.payload)).digest('hex'));
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='worktree.writer_revoked' AND detail->>'jobId'=$1",[row.job_id])).rows[0].n,1);
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_sandbox_jobs WHERE id=$1',[row.job_id])).rows[0].n,1);
  }
  console.log(`Reconciled ${rows.length} prepared synthetic retirements without replaying a worker.`);
 }finally{await db.close();}
});
