import {constants} from 'node:fs';
import {lstat, open, realpath, rm} from 'node:fs/promises';
import {join, sep} from 'node:path';
import {endRound} from './personal-artifact-hooks.ts';
import type {Ledger} from './ledger.ts';
import {fenceInstallationContext} from './installation-authority-fence.ts';

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

async function readRunningMarker(path: string): Promise<string|undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errno(error) === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return;
  let text = '';
  let handle;
  try {
    handle=await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errno(error)==='ENOENT'||errno(error)==='ELOOP') return;
    throw error;
  }
  try {
    const current=await handle.stat();
    if (!current.isFile() || current.size>128) return;
    const bytes=Buffer.alloc(129);
    const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if (bytesRead>128) return;
    text=bytes.toString('utf8',0,bytesRead).trim();
  } finally {
    await handle.close();
  }
  return text;
}

async function clearProgress(dataDirectory: string, projectId: string, runId: string): Promise<void> {
  if (!dataDirectory || dataDirectory.includes('\0') || !Uuid.test(projectId) || !Uuid.test(runId)) return;
  let dir: string;
  try {
    const root = await realpath(dataDirectory);
    dir = join(root, 'verificacoes', projectId, 'andamento');
    if (await realpath(dir) !== dir) return;
  } catch (error) {
    if (errno(error) === 'ENOENT') return;
    throw error;
  }
  const progress = join(dir, `${runId}.json`);
  const marker = join(dir, '.running');
  if (!inside(dir, progress) || !inside(dir, marker)) return;
  await removeProgress(progress);
  if (await readRunningMarker(marker) === runId) await rm(marker, {force: true});
}

const FailAbandoned = "UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp() WHERE status='running' AND NOT EXISTS (SELECT 1 FROM ac_managers m WHERE m.context_id = ac_verify_runs.context_id AND m.lease_until > clock_timestamp())";

async function clearFailedRuns(rows: readonly AbandonedRow[], dataDirectory: string) {
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    const projectId = typeof row.project_id === 'string' ? row.project_id : '';
    await clearProgress(dataDirectory, projectId, id);
    await endRound({dataDirectory,projectId,roundId:id});
  }
}

/** The periodic sweep, without the context anchor. A fenced transaction holds the manager row (`FOR UPDATE OF x,m`) and
 * gives the lease back the time it held the anchor only at commit, so the committed `lease_until` may look expired in the
 * middle of a long Docker call. Each run is therefore failed only with its manager row locked here: a row held by a fenced
 * transaction is skipped (`SKIP LOCKED`), and a row extended by a commit after this statement's snapshot is re-checked on
 * its newest version (the row lock re-evaluates the condition in READ COMMITTED). Run rows are locked the same way, so the
 * sweep never waits on a lock and cannot deadlock with the exam. A context with no manager row at all is abandoned. */
const FailAbandonedSweep = `WITH expired AS (
  SELECT r.id FROM ac_verify_runs r JOIN ac_managers m ON m.context_id = r.context_id
  WHERE r.status='running' AND m.lease_until <= clock_timestamp() FOR UPDATE OF r, m SKIP LOCKED
), unmanaged AS (
  SELECT r.id FROM ac_verify_runs r WHERE r.status='running'
  AND NOT EXISTS (SELECT 1 FROM ac_managers m WHERE m.context_id = r.context_id) FOR UPDATE OF r SKIP LOCKED
)
UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp() WHERE status='running'
  AND id IN (SELECT id FROM expired UNION SELECT id FROM unmanaged)`;

/** Runs left `running` without a live manager lease are failed, and their progress files are removed. */
export async function failAbandonedVerifyRuns(ledger: VerifyRunLedger, dataDirectory: string): Promise<void> {
  const result = await ledger.pool.query(FailAbandonedSweep + ' RETURNING id, project_id');
  await clearFailedRuns(result.rows,dataDirectory);
}

/** At CLI startup, serialize the lease check with acquisition and heartbeat. */
export async function failAbandonedVerifyContext(ledger: Ledger, dataDirectory: string, principal: string, contextId: string) {
  const result = await ledger.tx(async c=>{
    await ledger.authorize(c,principal,contextId);
    await fenceInstallationContext(c,contextId,ledger.installationAuthority,true);
    return c.query(FailAbandoned + ' AND context_id=$1 RETURNING id, project_id',[contextId]);
  });
  await clearFailedRuns(result.rows,dataDirectory);
}

/** Remove stale progress for terminal rounds even if another process finalized them. */
export async function clearTerminalVerifyProgress(ledger: VerifyRunLedger, dataDirectory: string, projectId: string, progressIds: string[]) {
  if (!Uuid.test(projectId)) return;
  const marker = await readRunningMarker(join(dataDirectory,'verificacoes',projectId,'andamento','.running'));
  const ids = [...new Set([...progressIds, ...(marker ? [marker] : [])].filter(id => Uuid.test(id)))];
  if (!ids.length) return;
  const result = await ledger.pool.query(
    "SELECT id FROM ac_verify_runs WHERE project_id=$1 AND id=ANY($2::uuid[]) AND status IN ('failed','done')",
    [projectId,ids],
  );
  for (const row of result.rows) if (typeof row.id==='string') await clearProgress(dataDirectory,projectId,row.id);
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
