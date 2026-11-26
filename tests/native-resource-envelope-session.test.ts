import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Ledger} from '../src/ledger.ts';
import {NativeResourceDockerDaemon} from '../src/native-resource-envelope.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

// Last review (note): the dedicated client of the resource envelope copies the ledger's options, so it inherits the
// idle-in-transaction timeout, and holds a transaction while the physical operation runs. Without its error listener, a
// session the server ends during that operation was an unhandled 'error' event that took the whole process down.
test('the envelope client ended by the idle timeout during a physical operation fails alone; the process goes on', async () => {
  const url = process.env.AC_TEST_DATABASE_URL; if (!url) throw Error('ISOLATED_DATABASE_REQUIRED');
  const isolated = await isolatedDatabase(url, 'envelope_idle'), ledger = new Ledger(isolated.url);
  const spool = await mkdtemp(join(tmpdir(), 'ac-envelope-idle-'));
  const errors = console.error; const logged: unknown[][] = []; console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await ledger.migrate();
    // The ledger the envelope binds, with the idle timeout shortened to 300 ms for its dedicated client.
    const short = {pool: {options: {...ledger.pool.options, idle_in_transaction_session_timeout: 300}}} as unknown as Ledger;
    const daemon = new NativeResourceDockerDaemon({stateRoot: spool, installationId: 'envelope-idle-fixture', authorityEpoch: 1,
      resourceAuthority: {authorityId: 'ac-r3-resources-envelope-idle', anchorId: 'a'.repeat(64), cpuQuotaMicros: 50000,
        cpuPeriodMicros: 100000, memoryBytes: 16777216, pidsLimit: 16, maxJobs: 4}});
    daemon.bindRecoveryLedger(short);
    // The physical operation, shortened: it outlives the timeout while the envelope's transaction stays open and idle.
    let ran = false;
    (daemon as unknown as {callResourceFenced: () => Promise<unknown>}).callResourceFenced = async () => { await sleep(1000); ran = true; return {ok: true}; };
    await assert.rejects(daemon.callResource('admit', {}), /idle-in-transaction|terminat|not queryable|Connection/i);
    assert.equal(ran, true, 'the operation ran inside the envelope transaction');
    // This line runs: the process is alive, and the ledger still works.
    assert.equal((await ledger.pool.query('SELECT 1 AS ok')).rows[0].ok, 1);
    assert.ok(logged.some(args => String(args[0]).includes('LEDGER_SESSION_ERROR')), JSON.stringify(logged));
  } finally { console.error = errors; await rm(spool, {recursive: true, force: true}); await ledger.close(); await isolated.close(); }
});
