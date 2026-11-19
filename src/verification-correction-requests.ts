import {randomUUID} from 'node:crypto';
import {lstat, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import type pg from 'pg';
import {digest, Refusal} from './contracts.ts';
import {enqueuePersonalOwner, readPersonalOwnerText} from './conversation-transport.ts';
import {REMEDIATION_ACCEPTANCE} from './verify-types.ts';

export type CorrectionReceipt = {messageLocalId: string; writePaths: string[]; messageLocalIds?: string[]};

type CorrectionRequest = {
  messageLocalId: string;
  writePaths: string[];
  regressionTest: string;
  acceptance: string;
};

export function groupCorrectionFindings<T extends {file: string; id: string}>(findings: readonly T[], separateByFinding = false) {
  const groups: {file: string; items: T[]}[] = [];
  const sorted = [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
  for (const finding of sorted) {
    const last = groups.at(-1);
    if (!separateByFinding && last?.file === finding.file) last.items.push(finding);
    else groups.push({file: finding.file, items: [finding]});
  }
  return groups;
}

function findingSetKey(ids: readonly string[]): string {
  return [...ids].sort().join(',');
}

/** The caller holds the run lock for both lookup and insertion. */
export async function loadCorrectionRequests(client: pg.PoolClient, runId: string, ids: readonly string[]) {
  const {rows} = await client.query<{
    message_local_id: string; write_paths: string[]; finding_ids: string[]; regression_test: string; acceptance: string;
  }>(`SELECT message_local_id, write_paths, finding_ids, regression_test, acceptance FROM ac_verify_remediations
      WHERE run_id=$1 AND finding_ids <@ $2::text[] ORDER BY created_at, id`, [runId, ids]);
  const requests = new Map<string, CorrectionRequest>();
  for (const row of rows) {
    const key = findingSetKey(row.finding_ids);
    if (!requests.has(key)) requests.set(key, {
      messageLocalId: row.message_local_id, writePaths: row.write_paths,
      regressionTest: row.regression_test, acceptance: row.acceptance,
    });
  }
  return (selected: readonly string[]) => requests.get(findingSetKey(selected));
}

export async function saveCorrectionRequest(client: pg.PoolClient, input: {
  runId: string; prefix: string; ids: string[]; writePaths: string[]; regressionTest: string;
  text: string; contextIds: readonly string[];
}): Promise<CorrectionRequest> {
  const {runId, prefix, ids, writePaths, regressionTest, text, contextIds} = input;
  const messageLocalId = `${prefix}-${runId}-${digest(ids).slice(0, 12)}`;
  await client.query(
    `INSERT INTO ac_verify_remediations(id,run_id,finding_ids,message_local_id,write_paths,regression_test,acceptance)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), runId, ids, messageLocalId, writePaths, regressionTest, REMEDIATION_ACCEPTANCE],
  );
  for (const contextId of contextIds) {
    await enqueuePersonalOwner(client, contextId, messageLocalId, text);
    if (await readPersonalOwnerText(client, contextId, messageLocalId) !== text) throw new Refusal('CHAT_MESSAGE_CONFLICT');
  }
  return {messageLocalId, writePaths, regressionTest, acceptance: REMEDIATION_ACCEPTANCE};
}

export function correctionReceipt(requests: readonly CorrectionRequest[]): CorrectionReceipt {
  const messageLocalIds = requests.map(request => request.messageLocalId);
  return {
    messageLocalId: messageLocalIds[0]!,
    writePaths: [...new Set(requests.flatMap(request => request.writePaths))],
    ...(messageLocalIds.length > 1 ? {messageLocalIds} : {}),
  };
}

/** Validate a canonical repository-relative path, including parents of a test that does not exist yet. */
export async function assertNoSymlinkAlongPath(repo: string, relativeFile: string): Promise<void> {
  const forbidden = () => new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  let current: string;
  try {
    const root = await lstat(repo);
    if (root.isSymbolicLink() || !root.isDirectory()) throw forbidden();
    current = await realpath(repo);
  } catch {
    throw forbidden();
  }
  const parts = relativeFile.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw forbidden();
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw forbidden();
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw forbidden();
  }
}
