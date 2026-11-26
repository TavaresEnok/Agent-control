import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import type pg from 'pg';
import {Ledger} from '../src/ledger.ts';
import {executeRemoteDevelopmentAdmin} from '../src/remote-development-admin.ts';
import type {ProjectAdmin} from '../src/project-admin.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

// Fourth review (low): the human authority transaction of remote development runs on its own pool built from the ledger's
// options, so it inherits the 10 min idle-in-transaction timeout, but had no error listener. If its transaction waited that
// long behind slow fenced adapter steps, the server ended the session (25P03), the unhandled 'error' event took the whole
// process down, and the catch replaced the transaction's error with the ROLLBACK's.
test('a remote development admin transaction ended by the idle timeout fails alone; the process goes on', async () => {
  const url = process.env.AC_TEST_DATABASE_URL; if (!url) throw Error('ISOLATED_DATABASE_REQUIRED');
  const isolated = await isolatedDatabase(url, 'remote_idle'), ledger = new Ledger(isolated.url);
  const errors = console.error; const logged: unknown[][] = []; console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    assert.ok(Number((ledger.pool.options as {idle_in_transaction_session_timeout?: number}).idle_in_transaction_session_timeout) > 0,
      'the copied options carry the timeout');
    const admin = {ledger, options: {remoteDevelopment: {resolve: async () => { throw Error('NOT_REACHED'); }}}} as unknown as ProjectAdmin;
    const command = {schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), action: 'project.launchRemoteDevelopment',
      payload: {projectId: randomUUID(), contextId: randomUUID(), workspaceId: randomUUID()}};
    // The wait behind the adapter steps, shortened: the session goes idle in the transaction past a 300 ms timeout.
    const authorize = async (c: pg.PoolClient) => { await c.query("SET LOCAL idle_in_transaction_session_timeout='300ms'"); await sleep(1000); };
    await assert.rejects(executeRemoteDevelopmentAdmin(admin, 'owner', command, 'a'.repeat(64), authorize, async () => {}),
      (error: Error) => !/ROLLBACK/i.test(error.message));
    // This line runs: the process is alive, and the ledger itself still works.
    assert.equal((await ledger.pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
    assert.ok(logged.some(args => String(args[0]).includes('LEDGER_SESSION_ERROR')), JSON.stringify(logged));
  } finally { console.error = errors; await ledger.close(); await isolated.close(); }
});
