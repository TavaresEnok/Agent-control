import {constants} from 'node:fs';
import {lstat, open, rm} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {endRound} from './personal-artifact-hooks.ts';

const Uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AbandonedRow = {id?: unknown; project_id?: unknown};

export type VerifyRunLedger = {
  pool: {
    query(sql: string, params?: unknown[]): Promise<{rows: readonly AbandonedRow[]}>;
  };
};

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as {code: unknown}).code) : undefined;
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

async function removeProgress(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errno(error) === 'ENOENT') return;
    throw error;
  }
  if (info.isDirectory()) return;
  await rm(path, {force: true});
}

async function removeRunningMarker(path: string, runId: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errno(error) === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return;
  let text = '';
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    text = (await handle.readFile({encoding: 'utf8'})).trim();
  } finally {
    await handle.close();
  }
  if (text !== runId) return;
  await rm(path, {force: true});
}

async function clearProgress(dataDirectory: string, projectId: string, runId: string): Promise<void> {
  if (!dataDirectory || dataDirectory.includes('\0') || !Uuid.test(projectId) || !Uuid.test(runId)) return;
  const root = resolve(dataDirectory);
  const dir = resolve(root, 'verificacoes', projectId, 'andamento');
  if (!inside(root, dir)) return;
  const progress = join(dir, `${runId}.json`);
  const marker = join(dir, '.running');
  if (!inside(dir, progress) || !inside(dir, marker)) return;
  await removeProgress(progress);
  await removeRunningMarker(marker, runId);
}

/** Runs left `running` without a live manager lease are failed, and their progress files are removed. */
export async function failAbandonedVerifyRuns(ledger: VerifyRunLedger, dataDirectory: string): Promise<void> {
  const result = await ledger.pool.query(
    "UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp() WHERE status='running' AND NOT EXISTS (SELECT 1 FROM ac_managers m WHERE m.context_id = ac_verify_runs.context_id AND m.lease_until > clock_timestamp()) RETURNING id, project_id",
  );
  for (const row of result.rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    const projectId = typeof row.project_id === 'string' ? row.project_id : '';
    await clearProgress(dataDirectory, projectId, id);
    await endRound({dataDirectory,projectId,roundId:id});
  }
}

/** Repeats the sweep. A still-valid lease matches nothing; a sweep error stays in the timer. */
export function watchAbandonedVerifyRuns(ledger: VerifyRunLedger, dataDirectory: string, everyMs = 60_000): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    void failAbandonedVerifyRuns(ledger, dataDirectory).catch(() => { console.error('VERIFY_ABANDON_FAILED'); });
  }, everyMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
