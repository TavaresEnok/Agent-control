/**
 * Reads the completed examiner jobs of earlier security runs of one project at one commit from the native job store, so the
 * journal can keep their judgments instead of paying for them again. A job counts only when its ledger row, its signed
 * receipt and its saved answer agree: same job, intent, account, profile, grant and session, a valid signature from the
 * execution key, exit code 0 and an answer whose digest is the one the receipt signed. Anything else is skipped.
 */
import {createPublicKey, verify, type KeyObject} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonical, digest} from './contracts.ts';
import {Result} from './native-execution-shared.ts';
import type {ImportedExamJob} from './security-exam-journal.ts';

export const SECURITY_WORKFLOW = 'security-verify-readonly-v1';
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

type Row = {
  id: string; intent_id: string; session_id: string; account_id: string; profile_id: string; grant_id: string;
  receipt: {payload?: Record<string, unknown>; signature?: unknown} | null; model: string; provider: string;
};

export type JobStoreQuery = {query: (text: string, values?: unknown[]) => Promise<{rows: unknown[]}>};

async function readOwnFile(path: string, max: number): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > max) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function signedBy(key: KeyObject, receipt: Row['receipt']): Record<string, unknown> | undefined {
  const payload = receipt?.payload;
  const signature = receipt?.signature;
  if (!payload || typeof signature !== 'string' || !/^[a-f0-9]{128}$/.test(signature)) return undefined;
  try {
    return verify(null, Buffer.from('agent-control:native-execution-receipt:v1\n' + canonical(payload)), key, Buffer.from(signature, 'hex')) ? payload : undefined;
  } catch {
    return undefined;
  }
}

export async function securityExamJobsFromStore(input: {
  pool: JobStoreQuery;
  hostRoot: string;
  signingKeyPem: string;
  projectId: string;
  commit: string;
}): Promise<ImportedExamJob[]> {
  const key = createPublicKey(input.signingKeyPem);
  const rows = (await input.pool.query(
    `SELECT j.id::text AS id, j.intent_id::text AS intent_id, j.session_id::text AS session_id, j.account_id::text AS account_id,
            j.profile_id::text AS profile_id, j.grant_id::text AS grant_id, j.receipt, p.model, a.provider
       FROM ac_native_execution_jobs j
       JOIN ac_profiles p ON p.id=j.profile_id
       JOIN ac_accounts a ON a.id=p.account_id
       JOIN ac_intents i ON i.id=j.intent_id
      WHERE j.state='completed' AND j.role='specialist' AND j.base_id=$2
        AND i.command->'payload'->>'workflow'=$3
        AND i.command->'payload'->>'projectId'=$1
        AND i.command->'payload'->>'commit'=$2
      ORDER BY j.created_at`,
    [input.projectId, input.commit, SECURITY_WORKFLOW],
  )).rows as Row[];
  const jobs: ImportedExamJob[] = [];
  for (const row of rows) {
    if (!JOB_ID.test(row.id)) continue;
    const payload = signedBy(key, row.receipt);
    if (!payload || payload.jobId !== row.id || payload.intentId !== row.intent_id || payload.accountId !== row.account_id
      || payload.profileId !== row.profile_id || payload.grantId !== row.grant_id || payload.sessionId !== row.session_id
      || payload.exitCode !== 0) continue;
    const directory = join(input.hostRoot, row.id);
    const resultText = await readOwnFile(join(directory, 'output', 'execution-result.json'), MAX_OUTPUT_BYTES);
    const requestText = await readOwnFile(join(directory, 'request.json'), MAX_REQUEST_BYTES);
    if (resultText === undefined || requestText === undefined) continue;
    let result, request;
    try {
      result = Result.safeParse(JSON.parse(resultText));
      request = JSON.parse(requestText) as {jobId?: unknown; intentId?: unknown; task?: unknown};
    } catch {
      continue;
    }
    if (!result.success || result.data.jobId !== row.id || result.data.exitCode !== 0 || result.data.failureCode !== null
      || digest(result.data.output) !== payload.outputDigest) continue;
    if (request.jobId !== row.id || request.intentId !== row.intent_id || typeof request.task !== 'string') continue;
    jobs.push({
      jobId: row.id,
      intentId: row.intent_id,
      task: request.task,
      output: result.data.output,
      seat: {provider: row.provider, model: row.model, accountId: row.account_id, profileId: row.profile_id, grantId: row.grant_id},
      sessionId: row.session_id,
    });
  }
  return jobs;
}
