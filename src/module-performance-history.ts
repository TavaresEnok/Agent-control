import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import type {PreviousPerformanceMeasurement} from '../deploy/modules/desempenho/orchestrator.mjs';
import type {VerificationModuleRunInput} from './verification-modules.ts';

async function acquirePageClient(pool: pg.Pool, signal: AbortSignal): Promise<pg.PoolClient> {
  // pg does not support removing a cancelled checkout from its FIFO. Wait
  // outside it when saturated and let already queued callers go first.
  while (!pool.ending && (pool.waitingCount > 0 || (pool.idleCount === 0 && pool.totalCount >= pool.options.max))) {
    try { await delay(25, undefined, {signal}); }
    catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    pool.connect((error, client) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        client?.release();
        abort();
      } else if (client) {
        resolve(client);
      } else {
        reject(error);
      }
    });
  });
}

type HistoryBackend = {pid: number; started: string};

async function terminatePageBackend(pool: pg.Pool, backend: HistoryBackend) {
  // Use a separate connection even when all pool slots are checked out.
  const control = new pg.Client({...pool.options, password: pool.options.password,
    connectionTimeoutMillis: 2000, query_timeout: 2500});
  control.on('error', () => {}); // The connection/query promise handles transport errors.
  try {
    await control.connect();
    await control.query(
      `SELECT pg_catalog.pg_terminate_backend(pid, 1000)
       FROM pg_catalog.pg_stat_activity
       WHERE pid=$1 AND backend_start::text=$2 AND datname=current_database() AND usename=session_user`,
      [backend.pid, backend.started],
    );
  } finally {
    await control.end();
  }
}

export async function* previousPerformanceMeasurements(input: VerificationModuleRunInput, runId: string, image: string, signal: AbortSignal) {
  type HistoricalRow = PreviousPerformanceMeasurement & {finishedAt: string};
  const {pool} = input.ledger;
  let cursor: HistoricalRow | undefined;
  const pageSize = 8;
  while (true) {
    const client = await acquirePageClient(pool, signal);
    const onDisconnect = () => {}; // Termination can emit an error on the checked-out client.
    client.on('error', onDisconnect);
    let interrupt: (() => void) | undefined;
    let cancellation: Promise<void> | undefined;
    let page: HistoricalRow[];
    let reusable = true;
    try {
      signal.throwIfAborted();
      reusable = false;
      await client.query('BEGIN');
      signal.throwIfAborted();
      const {rows: [backend]} = await client.query<HistoryBackend>(
        `SELECT pid, backend_start::text AS started FROM pg_catalog.pg_stat_activity
         WHERE pid=pg_catalog.pg_backend_pid()`,
      );
      signal.throwIfAborted();
      if (!backend?.started) throw new Error('backend da página de histórico não identificado');
      interrupt = () => {
        // Hold the checkout while signalling PostgreSQL. A socket close
        // alone can leave the server in a lock wait.
        cancellation = terminatePageBackend(pool, backend)
          .catch(() => {}) // Still discard the local checkout if the control connection fails.
          .finally(() => client.release(true));
      };
      signal.addEventListener('abort', interrupt, {once: true});
      await input.ledger.authorize(client, input.principal, input.authority.contextId);
      signal.throwIfAborted();
      await input.ledger.fence(client, input.authority);
      signal.throwIfAborted();
      page = (await client.query<HistoricalRow>(
        `SELECT p.id AS "examId", p.performance_measurement AS measurement, p.finished_at::text AS "finishedAt"
         FROM ac_verify_runs p JOIN ac_verify_runs current_run ON current_run.id=$1
         WHERE current_run.context_id=$2 AND current_run.project_id=$3 AND current_run.module='desempenho'
           AND p.project_id=current_run.project_id AND p.context_id=current_run.context_id
           AND p.module='desempenho' AND p.status='done' AND p.collector_image=$4
           AND p.report_dir=p.report_prepared_dir AND NOT p.report_legacy_missing
           AND p.performance_measurement IS NOT NULL AND p.finished_at < current_run.created_at
           AND ($5::timestamptz IS NULL OR (p.finished_at, p.id) < ($5::timestamptz, $6::uuid))
         ORDER BY p.finished_at DESC, p.id DESC LIMIT $7`,
        [runId, input.authority.contextId, input.projectId, image, cursor?.finishedAt ?? null, cursor?.examId ?? null, pageSize],
      )).rows;
      signal.throwIfAborted();
      await client.query('COMMIT');
      reusable = true;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      if (interrupt) signal.removeEventListener('abort', interrupt);
      if (cancellation) await cancellation;
      else client.release(!reusable);
      client.removeListener('error', onDisconnect);
    }
    signal.throwIfAborted();
    yield* page;
    if (page.length < pageSize) return;
    cursor = page[page.length - 1];
  }
}
