import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';
import { Refusal } from '../src/contracts.ts';
import type { Ledger } from '../src/ledger.ts';
import { isolatedDatabase } from './fixtures/isolated-database.ts';

const skip = process.env.AC_TEST_DATABASE_URL ? false : 'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado';

describe('worktree writer lease', { skip }, () => {
  let db: Ledger;
  let closeDatabase: (() => Promise<void>) | undefined;
  let claimWorktreeWriter: typeof import('../src/worktree-lease.ts').claimWorktreeWriter;
  let neutralizeWorktreeWriter: typeof import('../src/worktree-lease.ts').neutralizeWorktreeWriter;

  test.before(async () => {
    const base = process.env.AC_TEST_DATABASE_URL;
    if (!base) throw new Error('ISOLATED_DATABASE_REQUIRED');
    ({ claimWorktreeWriter, neutralizeWorktreeWriter } = await import('../src/worktree-lease.ts'));
    const { Ledger } = await import('../src/ledger.ts');
    const fixture = await isolatedDatabase(base, 'wtlease');
    closeDatabase = fixture.close;
    db = new Ledger(fixture.url);
    await db.migrate();
  });
  test.after(async () => {
    await db?.close();
    await closeDatabase?.();
  });

  test('a copy is never reassigned, even after a legacy neutralization', async () => {
    const key = { parentIntentId: randomUUID(), runId: randomUUID(), intentId: randomUUID(), epoch: 3 };
    assert.deepEqual(await db.tx(c => claimWorktreeWriter(c, key)), { state: 'held', acquired: 'new' });
    assert.deepEqual(await db.tx(c => claimWorktreeWriter(c, key)), { state: 'held', acquired: 'same' });
    const other = { ...key, intentId: randomUUID(), epoch: 4 };
    await assert.rejects(db.tx(c => claimWorktreeWriter(c, other)), (error: unknown) => error instanceof Refusal && error.code === 'WORKTREE_WRITER_BUSY');
    await assert.rejects(db.pool.query('UPDATE ac_worktree_writers SET holder_intent_id=$3 WHERE parent_intent_id=$1 AND run_id=$2',[key.parentIntentId,key.runId,other.intentId]),/WORKTREE_WRITER_IMMUTABLE/);
    await assert.rejects(db.tx(c => neutralizeWorktreeWriter(c, other)), (error: unknown) => error instanceof Refusal && error.code === 'WORKTREE_WRITER_NOT_HELD');
    await assert.rejects(db.tx(c => neutralizeWorktreeWriter(c, key)), (error: unknown) => error instanceof Refusal && error.code === 'WORKTREE_TERMINAL_PROOF_REQUIRED');
    await assert.rejects(db.pool.query("UPDATE ac_worktree_writers SET state='neutralized' WHERE parent_intent_id=$1 AND run_id=$2",[key.parentIntentId,key.runId]),(error:unknown)=>(error as {code?:string}).code==='23514');
    await assert.rejects(db.pool.query("UPDATE ac_worktree_writers SET state='neutralized',proof_digest=$3,revocation_job_id=$4 WHERE parent_intent_id=$1 AND run_id=$2",[key.parentIntentId,key.runId,'a'.repeat(64),randomUUID()]),(error:unknown)=>(error as {code?:string}).code==='23514');
    await db.pool.query("UPDATE ac_worktree_writers SET state='neutralized',proof_digest=$3,revocation_job_id=$4,revocation_proof=$5 WHERE parent_intent_id=$1 AND run_id=$2", [key.parentIntentId,key.runId,'a'.repeat(64),randomUUID(),{fixture:true}]);
    await assert.rejects(db.tx(c => claimWorktreeWriter(c, other)), (error: unknown) => error instanceof Refusal && error.code === 'WORKTREE_WRITER_BUSY');
    await assert.rejects(db.tx(c => claimWorktreeWriter(c, key)), (error: unknown) => error instanceof Refusal && error.code === 'WORKTREE_WRITER_BUSY');
    await assert.rejects(db.pool.query('UPDATE ac_worktree_writers SET proof_digest=$3 WHERE parent_intent_id=$1 AND run_id=$2',[key.parentIntentId,key.runId,'b'.repeat(64)]),/WORKTREE_WRITER_IMMUTABLE/);
    const newCopy={...other,runId:randomUUID()};
    assert.deepEqual(await db.tx(c => claimWorktreeWriter(c,newCopy)), {state:'held',acquired:'new'});
  });

  test('a live old writer keeps the same copy blocked across epochs and neutralization attempts',async()=>{
    const area=await mkdtemp(join(tmpdir(),'ac-live-writer-')),file=join(area,'writes');
    const child=spawn(process.execPath,['-e',"const fs=require('fs');fs.appendFileSync(process.argv[1],'started\\n');process.stdout.write('started\\n');setInterval(()=>fs.appendFileSync(process.argv[1],'write\\n'),20)",file],{stdio:['ignore','pipe','pipe']});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    try{
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('WRITER_START_TIMEOUT')),5000);
        child.stdout.once('data',()=>{clearTimeout(timer);resolve();});
        child.once('error',error=>{clearTimeout(timer);reject(error);});
      });
      const key={parentIntentId:randomUUID(),runId:randomUUID(),intentId:randomUUID(),epoch:1};
      await db.tx(c=>claimWorktreeWriter(c,key));
      const successor={...key,intentId:randomUUID(),epoch:2};
      await assert.rejects(db.tx(c=>claimWorktreeWriter(c,successor)),(error:unknown)=>error instanceof Refusal&&error.code==='WORKTREE_WRITER_BUSY');
      await assert.rejects(db.tx(c=>neutralizeWorktreeWriter(c,key)),(error:unknown)=>error instanceof Refusal&&error.code==='WORKTREE_TERMINAL_PROOF_REQUIRED');
      assert.equal(child.exitCode,null);
      await new Promise(resolve=>setTimeout(resolve,100));
      assert.match(await readFile(file,'utf8'),/write/);
      await assert.rejects(db.tx(c=>claimWorktreeWriter(c,successor)),(error:unknown)=>error instanceof Refusal&&error.code==='WORKTREE_WRITER_BUSY');
    }finally{child.kill('SIGTERM');await closed;await rm(area,{recursive:true,force:true});}
  });

  test('legacy neutralized rows survive additive migration without becoming reusable',async()=>{
    const c=await db.pool.connect(),key={parentIntentId:randomUUID(),runId:randomUUID(),intentId:randomUUID(),epoch:1};
    try{
      await c.query('BEGIN');await c.query('CREATE SCHEMA ac_retirement_legacy_fixture');await c.query('SET LOCAL search_path TO ac_retirement_legacy_fixture');
      await c.query(await readFile(new URL('../db/migrations/061_worktree_writers.sql',import.meta.url),'utf8'));
      await c.query("INSERT INTO ac_worktree_writers VALUES($1,$2,$3,$4,'neutralized')",[key.parentIntentId,key.runId,key.intentId,key.epoch]);
      await c.query(await readFile(new URL('../db/migrations/062_worktree_writer_proof.sql',import.meta.url),'utf8'));
      await c.query('CREATE TABLE ac_sandbox_jobs(id uuid PRIMARY KEY)');
      await c.query(await readFile(new URL('../db/migrations/063_sandbox_writer_retirement.sql',import.meta.url),'utf8'));
      await assert.rejects(claimWorktreeWriter(c,{...key,intentId:randomUUID(),epoch:2}),(error:unknown)=>error instanceof Refusal&&error.code==='WORKTREE_WRITER_BUSY');
      const row=(await c.query('SELECT state,holder_intent_id,proof_digest,revocation_proof FROM ac_worktree_writers')).rows[0];
      assert.deepEqual(row,{state:'neutralized',holder_intent_id:key.intentId,proof_digest:null,revocation_proof:null});
    }finally{await c.query('ROLLBACK');c.release();}
  });
});
