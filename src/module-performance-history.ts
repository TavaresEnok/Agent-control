import type {PreviousPerformanceMeasurement} from '../deploy/modules/desempenho/orchestrator.mjs';
import type {VerificationModuleRunInput} from './verification-modules.ts';

export async function* previousPerformanceMeasurements(input: VerificationModuleRunInput, runId: string, image: string, signal: AbortSignal) {
  type HistoricalRow = PreviousPerformanceMeasurement & {finishedAt: string};
  let cursor: HistoricalRow | undefined;
  const pageSize = 8;
  while (true) {
    signal.throwIfAborted();
    const client = await input.ledger.pool.connect();
    if (signal.aborted) {
      client.release();
      signal.throwIfAborted();
    }
    // A history page owns this connection. Closing it interrupts an in-flight
    // query and rolls back the read transaction even when the server is locked.
    const interrupt = () => client.release(true);
    signal.addEventListener('abort', interrupt, {once: true});
    let page: HistoricalRow[];
    let committed = false;
    try {
      await client.query('BEGIN');
      await input.ledger.authorize(client, input.principal, input.authority.contextId);
      await input.ledger.fence(client, input.authority);
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
      await client.query('COMMIT');
      committed = true;
    } finally {
      signal.removeEventListener('abort', interrupt);
      if (!signal.aborted) client.release(!committed);
    }
    signal.throwIfAborted();
    yield* page;
    if (page.length < pageSize) return;
    cursor = page[page.length - 1];
  }
}
