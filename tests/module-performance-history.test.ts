import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {previousPerformanceMeasurements} from '../src/module-performance-history.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

test('cancelar uma página bloqueada no PostgreSQL libera a conexão antes de soltar o bloqueio', {
  skip: !process.env.AC_TEST_DATABASE_URL, timeout: 20000,
}, async () => {
  await withModuleRecoveryFixture(process.env.AC_TEST_DATABASE_URL!, async input => {
    const lock = await input.ledger.pool.connect();
    const controller = new AbortController();
    try {
      await lock.query('BEGIN');
      const {rows: [blocker]} = await lock.query('SELECT pg_backend_pid() AS pid');
      await lock.query('SELECT id FROM ac_contexts WHERE id=$1 FOR UPDATE', [input.authority.contextId]);
      const iterator = previousPerformanceMeasurements(input, randomUUID(), 'sha256:' + 'a'.repeat(64), controller.signal);
      const rejected = assert.rejects(iterator.next());
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const {rows: [state]} = await input.ledger.pool.query(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [blocker.pid],
        );
        waiting = state.waiting;
        if (!waiting) await delay(25);
      }
      assert.equal(waiting, true);
      controller.abort(new Error('fim da autoridade sintética'));
      await rejected;
      assert.equal((await input.ledger.pool.query('SELECT 1')).rowCount, 1);
    } finally {
      controller.abort();
      await lock.query('ROLLBACK');
      lock.release();
    }
  });
});
