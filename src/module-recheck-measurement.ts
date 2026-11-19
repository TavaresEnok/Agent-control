import type pg from 'pg';
import type {VerificationModule} from './ledger.ts';
import type {ModuleToolCoverage} from './verification-modules.ts';

export type MeasurementScope = {projectId: string; contextId: string; module: VerificationModule; head: string};
type MeasurementRow = {runId: string; collectorImage: string | null; status: 'done' | 'failed'; usable: boolean};
type FindingLocation = {line: number | null; tool: string | null; rule: string | null};

// Consider the latest completed measurement even when it failed or used a
// different image. An older success must not hide a newer inconclusive run.
export async function latestModuleMeasurement(client: pg.Pool | pg.PoolClient, scope: MeasurementScope) {
  const {rows: [row]} = await client.query<MeasurementRow>(
    `SELECT id AS "runId", collector_image AS "collectorImage", status,
       coalesce(report_dir=report_prepared_dir AND NOT report_legacy_missing, false) AS usable FROM ac_verify_runs
     WHERE project_id=$1 AND context_id=$2 AND module=$3 AND commit_id=$4 AND status IN ('done','failed')
     ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1 FOR SHARE`,
    [scope.projectId, scope.contextId, scope.module, scope.head],
  );
  return row;
}

export async function readModuleMeasurements(client: pg.Pool, runId: string, correctedRunId: string, file: string) {
  const [coverage, findings] = await Promise.all([
    client.query<ModuleToolCoverage & {runId: string}>(
      `SELECT run_id AS "runId", tool, version, status, detail FROM ac_verify_tool_coverage
       WHERE run_id IN ($1,$2) ORDER BY seq`, [runId, correctedRunId]),
    client.query<FindingLocation>(
      `SELECT line, payload->'sources'->>0 AS tool, payload->'sources'->>1 AS rule
       FROM ac_verify_findings WHERE run_id=$1 AND file=$2`, [correctedRunId, file]),
  ]);
  return {
    original: coverage.rows.filter(row => row.runId === runId),
    corrected: coverage.rows.filter(row => row.runId === correctedRunId),
    findings: findings.rows,
  };
}
