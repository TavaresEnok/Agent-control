import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {PoolClient} from 'pg';
import {previousPerformanceMeasurements} from '../src/module-performance-history.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

const image = 'sha256:' + 'a'.repeat(64);
const database = {skip: !process.env.AC_TEST_DATABASE_URL, timeout: 20000};

test('o cancelamento encerra a consulta e sua transação enquanto o bloqueador mantém o lock', database, async t => {
  await withModuleRecoveryFixture(process.env.AC_TEST_DATABASE_URL!, async input => {
    const {pool} = input.ledger;
    const lock = await pool.connect();
    const observer = await pool.connect();
    const otherClients: PoolClient[] = [];
    const controller = new AbortController();
    const reason = new Error('fim da autoridade sintética');
    let rejected: Promise<void> | undefined;
    try {
      await lock.query('BEGIN');
      const {rows: [blocker]} = await lock.query('SELECT pg_backend_pid() AS pid');
      await lock.query('LOCK TABLE ac_verify_runs IN ACCESS EXCLUSIVE MODE');
      const {rows: [witness]} = await observer.query('SELECT pg_backend_pid() AS pid');
      while (otherClients.length < pool.options.max - 3) otherClients.push(await pool.connect());

      const iterator = previousPerformanceMeasurements(input, randomUUID(), image, controller.signal);
      rejected = assert.rejects(iterator.next(), error => error === reason);
      void rejected.catch(() => {});
      const deadline = Date.now() + 5000;
      let blocked: {pid: number; xact: string} | undefined;
      while (!blocked && Date.now() < deadline) {
        const {rows} = await observer.query<{pid: number; xact: string}>(
          `SELECT pid, xact_start::text AS xact FROM pg_stat_activity
           WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'
             AND query LIKE 'SELECT p.id AS "examId", p.performance_measurement AS measurement,%'`,
          [blocker.pid],
        );
        blocked = rows[0];
        if (!blocked) await delay(25);
      }
      assert.ok(blocked?.xact, 'a consulta da página precisa estar bloqueada dentro de uma transação');
      assert.equal(pool.totalCount, pool.options.max);
      assert.equal(pool.idleCount, 0);
      controller.abort(reason);
      await rejected;

      assert.equal((await observer.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [blocked.pid])).rowCount, 0);
      const {rows: [held]} = await observer.query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='relation'
             AND relation='ac_verify_runs'::regclass AND mode='AccessExclusiveLock' AND granted
         ) AS holding, pg_backend_pid() AS observer`,
        [blocker.pid],
      );
      assert.deepEqual(held, {holding: true, observer: witness.pid});
      assert.equal((await lock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, blocker.pid);
      t.diagnostic(`PID ${blocked.pid} saiu de pg_stat_activity enquanto o PID ${blocker.pid} mantinha AccessExclusiveLock; observador ${witness.pid} ativo`);
    } finally {
      controller.abort(reason);
      try { await lock.query('ROLLBACK'); }
      finally {
        lock.release();
        observer.release();
        for (const client of otherClients) client.release();
      }
      await rejected?.catch(() => {});
    }
  });
});

test('a aquisição do histórico é cancelada com todos os clientes do pool ainda retidos', database, async () => {
  await withModuleRecoveryFixture(process.env.AC_TEST_DATABASE_URL!, async input => {
    const {pool} = input.ledger;
    const clients: PoolClient[] = [];
    const controller = new AbortController();
    const reason = new Error('aquisição sintética cancelada');
    let rejected: Promise<void> | undefined;
    try {
      while (clients.length < pool.options.max) clients.push(await pool.connect());
      const iterator = previousPerformanceMeasurements(input, randomUUID(), image, controller.signal);
      rejected = assert.rejects(iterator.next(), error => error === reason);
      void rejected.catch(() => {});
      await delay(50);
      controller.abort(reason);
      await Promise.race([
        rejected,
        delay(1000, undefined, {ref: false}).then(() => assert.fail('a aquisição continuou pendente no pool')),
      ]);
      assert.equal(pool.waitingCount, 0);
      assert.equal(pool.idleCount, 0);
      assert.equal(pool.totalCount, clients.length);
      for (const client of clients) await client.query('SELECT 1');
    } finally {
      controller.abort(reason);
      for (const client of clients) client.release();
      await rejected?.catch(() => {});
    }
  });
});
