import {randomUUID} from 'node:crypto';
import {chmod, lstat, readdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import type pg from 'pg';
import {z} from 'zod';
import {digest, Refusal, type Authority} from './contracts.ts';
import {enqueuePersonalOwner, readPersonalOwnerText} from './conversation-transport.ts';
import type {Ledger} from './ledger.ts';
import {assertPersonalActivation} from './verify-intent.ts';
import {REMEDIATION_ACCEPTANCE, VerifyWorkerCall, type VerifyWorker} from './verify-types.ts';

const AchadoId = z.string().regex(/^ACH-\d{3}$/);
const Uuid = z.uuid();
const RecheckVerdict = z.object({
  kind: z.literal('confirmacao'),
  status: z.enum(['descartado', 'confirmado']),
  reason: z.string().min(1).max(2000),
  proof: z.string().max(2000),
}).strict();

type OpenFinding = {id: string; status: string; file: string; line: number | null; title: string};
type RunRef = {id: string; intentId: string};

function uniqueIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique;
}

function normalizeIds(ids: readonly string[]): string[] {
  if (ids.length === 0) throw new Refusal('VERIFY_NOTHING_TO_FIX', 400);
  const unique = uniqueIds(ids);
  if (unique.some(id => !AchadoId.safeParse(id).success)) throw new Refusal('VERIFY_FINDING_MISSING', 404);
  return unique;
}

function assertRepoRelative(file: string): string {
  const normalized = file.replaceAll('\\', '/').trim();
  if (!normalized || normalized.length > 400 || normalized.includes('\0') || normalized.startsWith('/') || normalized.startsWith('~') || /^[A-Za-z]:/.test(normalized)) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  return parts.join('/');
}

function lineOf(value: unknown): number | null {
  if (value == null) return null;
  const line = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(line) || line <= 0) return null;
  return line;
}

function titleOf(payload: unknown, id: string): string {
  let title = '';
  if (payload && typeof payload === 'object' && 'title' in payload) {
    const value = (payload as {title: unknown}).title;
    if (typeof value === 'string') title = value.replace(/[\r\n]+/g, ' ').trim();
  }
  return (title || id).slice(0, 200);
}

function regressionPath(id: string): string {
  return `tests/seguranca/${id.toLowerCase()}.test.ts`;
}

function regressionText(ids: readonly string[]): string {
  return ids.map(id => `O teste ${regressionPath(id)} tem de falhar antes da correção e passar depois.`).join('\n');
}

function groupFindings(findings: readonly OpenFinding[]): {file: string; items: OpenFinding[]}[] {
  const sorted = [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
  const groups: {file: string; items: OpenFinding[]}[] = [];
  for (const finding of sorted) {
    const last = groups.at(-1);
    if (last?.file === finding.file) last.items.push(finding);
    else groups.push({file: finding.file, items: [finding]});
  }
  return groups;
}

function managerText(groups: readonly {file: string; items: OpenFinding[]}[], writePaths: readonly string[], regression: string): string {
  const body = groups.map(group => [
    `Arquivo: ${group.file}`,
    ...group.items.map(item => `- ${item.id} (linha ${item.line ?? 'não informada'}): ${item.title}`),
  ].join('\n')).join('\n');
  return [
    'Corrija os achados de segurança selecionados.',
    '',
    'O que corrigir:',
    body,
    '',
    'Caminhos de escrita:',
    ...writePaths.map(file => `- ${file}`),
    '',
    'Teste de regressão exigido:',
    regression,
    '',
    'Critério de aceite:',
    REMEDIATION_ACCEPTANCE,
  ].join('\n');
}

async function loadRun(client: pg.PoolClient, runId: string, projectId: string, contextId: string): Promise<RunRef> {
  if (!Uuid.safeParse(runId).success || !Uuid.safeParse(projectId).success) throw new Refusal('VERIFY_RUN_MISSING', 404);
  const row = (await client.query(
    'SELECT id, intent_id FROM ac_verify_runs WHERE id=$1 AND project_id=$2 AND context_id=$3',
    [runId, projectId, contextId],
  )).rows[0] as {id: string; intent_id: string} | undefined;
  if (!row) throw new Refusal('VERIFY_RUN_MISSING', 404);
  return {id: String(row.id), intentId: String(row.intent_id)};
}

async function loadFindings(client: pg.PoolClient, runId: string, ids: readonly string[], eligibleOnly: boolean): Promise<OpenFinding[]> {
  const rows = (await client.query(
    'SELECT achado_id, status, file, line, payload FROM ac_verify_findings WHERE run_id=$1 AND achado_id = ANY($2::text[])',
    [runId, ids],
  )).rows as {achado_id: string; status: string; file: string; line: number | null; payload: unknown}[];
  const byId = new Map(rows.map(row => [String(row.achado_id), row]));
  return ids.map(id => {
    const row = byId.get(id);
    if (!row || (eligibleOnly && row.status !== 'confirmado' && row.status !== 'reaberto')) throw new Refusal('VERIFY_FINDING_MISSING', 404);
    return {id, status: String(row.status), file: assertRepoRelative(String(row.file)), line: lineOf(row.line), title: titleOf(row.payload, id)};
  });
}

function recheckTask(finding: OpenFinding): string {
  return [
    'Reverifique somente este ponto já corrigido.',
    `Arquivo: ${finding.file}`,
    `Linha: ${finding.line ?? 'não informada'}`,
    `Título: ${finding.title}`,
    `Achado: ${finding.id}`,
    'Responda só com JSON {"kind":"confirmacao","status":"descartado"|"confirmado","reason":"...","proof":"..."}.',
    'Use descartado se o ponto não reproduz e confirmado se a falha continua.',
  ].join('\n');
}

function parseVerdict(raw: string): z.infer<typeof RecheckVerdict> {
  const trimmed = raw.trim();
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Refusal('VERIFY_RECHECK_INVALID', 503);
    try {
      value = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new Refusal('VERIFY_RECHECK_INVALID', 503);
    }
  }
  const parsed = RecheckVerdict.safeParse(value);
  if (!parsed.success) throw new Refusal('VERIFY_RECHECK_INVALID', 503);
  return parsed.data;
}

function replaceSituacao(markdown: string, status: 'fechado' | 'reaberto'): string {
  const pattern = /^([ \t]*-[ \t]*Situação:[ \t]*)(\S+)/m;
  if (!pattern.test(markdown)) return markdown;
  return markdown.replace(pattern, `$1${status}`);
}

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as {code: unknown}).code) : undefined;
}

function runJsonMatches(parsed: unknown, runId: string): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const record = parsed as {id?: unknown; runId?: unknown; run?: {id?: unknown}};
  return record.id === runId || record.runId === runId || record.run?.id === runId;
}

async function updateSituacao(dataDirectory: string, projectId: string, runId: string, achadoId: string, status: 'fechado' | 'reaberto') {
  if (!dataDirectory || dataDirectory.includes('\0') || !Uuid.safeParse(projectId).success) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  const root = resolve(dataDirectory);
  const base = resolve(root, 'verificacoes', projectId);
  if (base !== root && !base.startsWith(root + sep)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  let entries;
  try {
    entries = await readdir(base, {withFileTypes: true});
  } catch (error) {
    if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(base, entry.name);
    if (!dir.startsWith(base + sep)) continue;
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) continue;
    let raw: string;
    try {
      raw = await readFile(join(dir, 'run.json'), 'utf8');
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') continue;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!runJsonMatches(parsed, runId)) continue;
    const achadosDir = join(dir, 'achados');
    let achadosInfo;
    try {
      achadosInfo = await lstat(achadosDir);
    } catch (error) {
      if (errno(error) === 'ENOENT') continue;
      throw error;
    }
    if (achadosInfo.isSymbolicLink() || !achadosInfo.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    const achadoPath = join(achadosDir, `${achadoId}.md`);
    if (!achadoPath.startsWith(dir + sep)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    let fileInfo;
    try {
      fileInfo = await lstat(achadoPath);
    } catch (error) {
      if (errno(error) === 'ENOENT') continue;
      throw error;
    }
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    const markdown = await readFile(achadoPath, 'utf8');
    await writeFile(achadoPath, replaceSituacao(markdown, status), {mode: 0o600});
    await chmod(achadoPath, 0o600);
  }
}

export async function requestCorrection(ledger: Ledger, principal: string, authority: Authority, input: {
  runId: string; achadoIds: string[]; dataDirectory: string; projectId: string;
}): Promise<{messageLocalId: string; writePaths: string[]}> {
  await assertPersonalActivation(ledger);
  const requested = normalizeIds(input.achadoIds);
  return ledger.tx(async client => {
    await ledger.authorize(client, principal, authority.contextId);
    const run = await loadRun(client, input.runId, input.projectId, authority.contextId);
    const findings = (await loadFindings(client, run.id, requested, true)).sort((a, b) => a.id.localeCompare(b.id));
    const groups = groupFindings(findings);
    const writePaths = groups.map(group => group.file);
    const ids = findings.map(finding => finding.id);
    const regression = regressionText(ids);
    const text = managerText(groups, writePaths, regression);
    const messageLocalId = `verify-fix-${run.id}-${digest(ids).slice(0, 12)}`;
    await client.query(
      `INSERT INTO ac_verify_remediations(id,run_id,finding_ids,message_local_id,write_paths,regression_test,acceptance)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), run.id, ids, messageLocalId, writePaths, regression, REMEDIATION_ACCEPTANCE],
    );
    await enqueuePersonalOwner(client, authority.contextId, messageLocalId, text);
    if (await readPersonalOwnerText(client, authority.contextId, messageLocalId) !== text) throw new Refusal('CHAT_MESSAGE_CONFLICT');
    return {messageLocalId, writePaths};
  });
}

export async function recheckFindings(ledger: Ledger, principal: string, authority: Authority, input: {
  runId: string; achadoIds: string[]; dataDirectory: string; projectId: string; worker: VerifyWorker;
}): Promise<{results: {id: string; status: 'fechado' | 'reaberto'}[]}> {
  await assertPersonalActivation(ledger);
  const requested = normalizeIds(input.achadoIds);
  const loaded = await ledger.tx(async client => {
    await ledger.authorize(client, principal, authority.contextId);
    const run = await loadRun(client, input.runId, input.projectId, authority.contextId);
    return {run, findings: await loadFindings(client, run.id, requested, false)};
  });
  const decided: {id: string; status: 'fechado' | 'reaberto'}[] = [];
  // a reverificação de produção passa pelo mesmo VerifyWorker do exame, que reserva reviewer.
  for (const finding of loaded.findings) {
    const call = VerifyWorkerCall.parse({
      role: 'reviewer',
      provider: 'recheck',
      accountId: '00000000-0000-4000-8000-000000000001',
      profileId: '00000000-0000-4000-8000-000000000002',
      model: 'recheck',
      grantId: '00000000-0000-4000-8000-000000000003',
      intentId: loaded.run.intentId,
      task: recheckTask(finding),
      repo: 'sem-repositorio',
      writePaths: [],
    });
    const verdict = parseVerdict(await input.worker.run(call));
    decided.push({id: finding.id, status: verdict.status === 'descartado' ? 'fechado' : 'reaberto'});
  }
  for (const result of decided) {
    const updated = await ledger.pool.query(
      'UPDATE ac_verify_findings SET status=$3 WHERE run_id=$1 AND achado_id=$2',
      [loaded.run.id, result.id, result.status],
    );
    if (!updated.rowCount) throw new Refusal('VERIFY_FINDING_MISSING', 404);
    await updateSituacao(input.dataDirectory, input.projectId, loaded.run.id, result.id, result.status);
  }
  return {results: decided};
}
