import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

  test('a second intent cannot take a held worktree until the holder neutralizes it', async () => {
    const key = { parentIntentId: randomUUID(), runId: randomUUID(), intentId: randomUUID(), epoch: 3 };
    assert.deepEqual(await db.tx(c => claimWorktreeWriter(c, key)), { state: 'held', acquired: 'new' });
    assert.deepEqual(await db.tx(c => claimWorktreeWriter(c, key)), { state: 'held', acquired: 'same' });
    const other = { ...key, intentId: randomUUID(), epoch: 4 };
    await assert.rejects(db.tx(c => claimWorktreeWriter(c, other)), (error: unknown) => error instanceof Refusal && error.code === 'WORKTREE_WRITER_BUSY');
    await assert.rejects(db.tx(c => neutralizeWorktreeWriter(c, other)), (error: unknown) => error instanceof Refusal && error.code === 'WORKTREE_WRITER_NOT_HELD');
    assert.deepEqual(await db.tx(c => neutralizeWorktreeWriter(c, key)), { state: 'neutralized' });
    assert.deepEqual(await db.tx(c => claimWorktreeWriter(c, other)), { state: 'held', acquired: 'reclaimed' });
    await assert.rejects(db.tx(c => claimWorktreeWriter(c, key)), (error: unknown) => error instanceof Refusal && error.code === 'WORKTREE_WRITER_BUSY');
  });
});
