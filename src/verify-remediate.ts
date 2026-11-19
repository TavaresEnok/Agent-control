import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, open, readdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import type pg from 'pg';
import {z} from 'zod';
import {digest, Refusal, type Authority} from './contracts.ts';
import {enqueuePersonalOwner, readPersonalOwnerText} from './conversation-transport.ts';
import type {Ledger} from './ledger.ts';
import {finishExamIntent} from './exam-intent.ts';
import {acceptSecurityVerification, assertPersonalActivation} from './verify-intent.ts';
import {isSecretClassBasename, redactUnknownSecrets} from './verify-redact.ts';
import {REMEDIATION_ACCEPTANCE, VerifyWorkerCall, type VerifyWorker} from './verify-types.ts';

export const VERIFY_RECHECK_NEW_EXAM_REQUIRED = 'VERIFY_RECHECK_NEW_EXAM_REQUIRED';
export const VERIFY_RECHECK_NEW_EXAM_GUIDANCE =
  'Não é possível comprovar a independência da reverificação porque o achado histórico não possui perfil examinador original registrado. O achado foi preservado; execute um novo exame de segurança.';

export class VerifyRecheckRefusal extends Refusal {
  constructor(code: string, public readonly guidance: string, status: 400 | 401 | 403 | 404 | 409 | 503 = 409) {
    super(code, status);
  }
}

const AchadoId = z.string().regex(/^ACH-\d{3}$/);
const Uuid = z.uuid();
const RecheckVerdict = z.object({
  kind: z.literal('confirmacao'),
  status: z.enum(['descartado', 'confirmado']),
  reason: z.string().min(1).max(2000),
  proof: z.string().max(2000),
}).strict();
const RepoPath = /^[A-Za-z0-9._@+\/-]+$/;
const ControlChar = /[\u0000-\u001F\u007F-\u009F]/;
const CweToken = /^CWE-\d{1,5}$/;
const AsvsToken = /^ASVS(?:-\d+){1,4}$/;
const EXCERPT_LIMIT = 4000;

type OpenFinding = {
  id: string;
  status: string;
  file: string;
  line: number | null;
  title: string;
  reference: string | null;
  severity: string;
  snippet: string;
  examinerProfileId: string | null;
  examinerAccountId: string | null;
};
type ReviewerCall = VerifyWorkerCall & {reviewerProvider?: unknown; reviewerAccountId?: unknown; reviewerSessionId?: unknown};
export type HighReview = {
  status: 'descartado' | 'confirmado';
  provider: string;
  accountId: string;
  sessionId: string;
};
type RunRef = {id: string; intentId: string; commitId: string};
type ReportUpdate = {id: string; status: 'fechado' | 'reaberto'; file: string; line: number | null; title: string};
type MatchedReport = {dir: string; runRaw: string; achadosRaw: string | null};

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

const LOWER_FORBIDDEN = new Set(['.mcp.json', '.claude', '.husky', '.codex', '.grok']);
const PROOF_BYTES = 1_000_000;
const PROOF_SNIPPET = 12;
const CommitId = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const execGit = promisify(execFile);

function normalizeIds(ids: readonly string[]): string[] {
  if (ids.length === 0) throw new Refusal('VERIFY_NOTHING_TO_FIX', 400);
  const unique = uniqueIds(ids);
  if (unique.length > 20) throw new Refusal('VERIFY_TOO_MANY', 400);
  if (unique.some(id => !AchadoId.safeParse(id).success)) throw new Refusal('VERIFY_FINDING_MISSING', 404);
  return unique;
}

function forbiddenSegment(part: string): boolean {
  return part === '' || part === '.' || part === '..' || part === '.git' || part === '.github' || part === '.ai' || part === 'node_modules' || part.startsWith('.env') || LOWER_FORBIDDEN.has(part.toLowerCase());
}

function assertRepoRelative(file: string): string {
  const normalized = file.replaceAll('\\', '/');
  if (ControlChar.test(normalized)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  const trimmed = normalized.trim();
  if (!trimmed || trimmed.length > 400 || trimmed.startsWith('/') || trimmed.startsWith('~') || /^[A-Za-z]:/.test(trimmed) || !RepoPath.test(trimmed)) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  const parts = trimmed.split('/');
  if (parts.some(forbiddenSegment)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  return parts.join('/');
}

function escapesRepo(rel: string): boolean {
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || rel === '';
}

function lineOf(value: unknown): number | null {
  if (value == null) return null;
  const line = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(line) || line <= 0) return null;
  return line;
}

function textField(payload: unknown, key: 'severity' | 'snippet'): string {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return '';
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function severityOf(column: unknown, payload: unknown): string {
  if (typeof column === 'string' && column.trim()) return column.trim().toLowerCase();
  return textField(payload, 'severity').trim().toLowerCase();
}

function titleOf(payload: unknown, id: string): string {
  let title = '';
  if (payload && typeof payload === 'object' && 'title' in payload) {
    const value = (payload as {title: unknown}).title;
    if (typeof value === 'string') title = value.replace(/[\r\n]+/g, ' ').trim();
  }
  return (title || id).slice(0, 200);
}

function closedReference(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as {cwe?: unknown; reference?: unknown};
  const parts: string[] = [];
  if (typeof record.cwe === 'string' && CweToken.test(record.cwe)) parts.push(record.cwe);
  if (typeof record.reference === 'string' && AsvsToken.test(record.reference)) parts.push(record.reference);
  return parts.length ? parts.join(' ') : null;
}

function regressionPath(id: string): string {
  return `tests/seguranca/${id.toLowerCase()}.test.ts`;
}

function regressionText(ids: readonly string[]): string {
  return ids.map(id => `O teste ${regressionPath(id)} tem de falhar antes da correção e passar depois.`).join('\n');
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].map(String).sort((x, y) => x.localeCompare(y));
  const b = [...right].map(String).sort((x, y) => x.localeCompare(y));
  return a.every((id, index) => id === b[index]);
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
    ...group.items.map(item => `- ${item.id} linha ${item.line ?? 'não informada'}${item.reference ? ` ${item.reference}` : ''}`),
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

function isSecretBasename(file: string): boolean {
  return isSecretClassBasename(file);
}

async function loadRun(client: pg.PoolClient, runId: string, projectId: string, contextId: string): Promise<RunRef> {
  if (!Uuid.safeParse(runId).success || !Uuid.safeParse(projectId).success) throw new Refusal('VERIFY_RUN_MISSING', 404);
  const row = (await client.query(
    'SELECT id, intent_id, commit_id FROM ac_verify_runs WHERE id=$1 AND project_id=$2 AND context_id=$3',
    [runId, projectId, contextId],
  )).rows[0] as {id: string; intent_id: string; commit_id: string} | undefined;
  if (!row) throw new Refusal('VERIFY_RUN_MISSING', 404);
  return {id: String(row.id), intentId: String(row.intent_id), commitId: String(row.commit_id)};
}

async function projectRepo(client: pg.PoolClient, projectId: string): Promise<string | null> {
  const row = (await client.query('SELECT repo FROM ac_project_repositories WHERE project_id=$1', [projectId])).rows[0] as {repo: string} | undefined;
  return row ? String(row.repo) : null;
}

function optionalUuid(value: unknown): string | null {
  return typeof value === 'string' && Uuid.safeParse(value).success ? value : null;
}

async function loadFindings(client: pg.PoolClient, runId: string, ids: readonly string[], eligibleOnly: boolean): Promise<OpenFinding[]> {
  const coveredRows = (await client.query('SELECT file FROM ac_verify_coverage WHERE run_id=$1', [runId])).rows as {file: string}[];
  const covered = new Set(coveredRows.map(row => String(row.file)));
  const rows = (await client.query(
    `SELECT achado_id, status, file, line, severity, payload,
      examiner_profile_id::text AS examiner_profile_id,
      examiner_account_id::text AS examiner_account_id
     FROM ac_verify_findings WHERE run_id=$1 AND achado_id = ANY($2::text[])`,
    [runId, ids],
  )).rows as {
    achado_id: string; status: string; file: string; line: number | null; severity?: unknown; payload: unknown;
    examiner_profile_id?: unknown; examiner_account_id?: unknown;
  }[];
  const byId = new Map(rows.map(row => [String(row.achado_id), row]));
  return ids.map(id => {
    const row = byId.get(id);
    if (!row || (eligibleOnly && row.status !== 'confirmado' && row.status !== 'reaberto')) throw new Refusal('VERIFY_FINDING_MISSING', 404);
    const file = assertRepoRelative(String(row.file));
    if (!covered.has(file)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    return {
      id,
      status: String(row.status),
      file,
      line: lineOf(row.line),
      title: titleOf(row.payload, id),
      reference: closedReference(row.payload),
      severity: severityOf(row.severity, row.payload),
      snippet: textField(row.payload, 'snippet'),
      examinerProfileId: optionalUuid(row.examiner_profile_id),
      examinerAccountId: optionalUuid(row.examiner_account_id),
    };
  });
}

async function resolveInsideRepo(repo: string, relativeFile: string): Promise<string> {
  let rootStat;
  try {
    rootStat = await lstat(repo);
  } catch {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  let root: string;
  try {
    root = await realpath(repo);
  } catch {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  const parts = relativeFile.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? '';
    const last = index === parts.length - 1;
    if (part === '' || part === '.' || part === '..') throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    current = join(current, part);
    if (escapesRepo(relative(root, current))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    }
    if (info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    if (!last && !info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    if (last && !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  let real: string;
  try {
    real = await realpath(current);
  } catch {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  if (escapesRepo(relative(root, real))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  return real;
}

async function locateRepoFile(repo: string, relativeFile: string): Promise<string | null> {
  try {
    return await resolveInsideRepo(repo, relativeFile);
  } catch (error) {
    if (error instanceof Refusal) return null;
    throw error;
  }
}

async function readBounded(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return (await handle.readFile({encoding: 'utf8'})).slice(0, 64_000);
  } finally {
    await handle.close();
  }
}

async function excerptFor(repo: string | null, finding: OpenFinding): Promise<{text: string; seen: boolean}> {
  const unseen = {text: 'codigo-nao-visto', seen: false};
  if (!repo) return unseen;
  const located = await locateRepoFile(repo, finding.file);
  if (!located) return unseen;
  if (isSecretBasename(finding.file)) return {text: `nome: ${finding.file}\nlinha: ${finding.line ?? ''}\n`, seen: true};
  try {
    return {text: redactUnknownSecrets(await readBounded(located)).slice(0, EXCERPT_LIMIT), seen: true};
  } catch {
    return unseen;
  }
}

function recheckTask(finding: OpenFinding, excerpt: string): string {
  return [
    'Reverifique somente este ponto já corrigido.',
    `Arquivo: ${finding.file}`,
    `Linha: ${finding.line ?? 'não informada'}`,
    `Título: ${finding.title}`,
    `Achado: ${finding.id}`,
    'Trecho:',
    excerpt,
    'Responda só com JSON {"kind":"confirmacao","status":"descartado"|"confirmado","reason":"...","proof":"..."}.',
    'Use descartado se o ponto não reproduz e confirmado se a falha continua.',
  ].join('\n');
}

function reviewerText(call: ReviewerCall, key: 'reviewerProvider' | 'reviewerAccountId' | 'reviewerSessionId'): string {
  const value = call[key];
  return typeof value === 'string' ? value : '';
}

function avoidAccount(accountId: string): string[] | undefined {
  if (accountId.length < 1 || accountId.length > 80) return undefined;
  return [accountId];
}

function reviewIdsDiffer(left: string, right: string): boolean {
  return left.length > 0 && right.length > 0 && left !== right;
}

/** Fecha achado alto. Exames de leitura só usam Claude, então provedores distintos deixam de ser exigência. Dois Claude em contas ou sessões diferentes, ou a prova de diff, fecham o achado. */
export function highFindingCloses(input: {
  seen: boolean;
  snippetGone: boolean;
  first: HighReview;
  second: HighReview;
}): boolean {
  const discarded = input.first.status === 'descartado' || input.second.status === 'descartado';
  const proof = input.seen && discarded && input.snippetGone;
  const agreed = input.seen
    && input.first.status === 'descartado'
    && input.second.status === 'descartado'
    && input.first.provider === 'claude'
    && input.second.provider === 'claude'
    && (reviewIdsDiffer(input.first.accountId, input.second.accountId) || reviewIdsDiffer(input.first.sessionId, input.second.sessionId));
  return proof || agreed;
}

async function reviewFinding(
  worker: VerifyWorker,
  finding: OpenFinding,
  excerpt: string,
  intentId: string,
  avoid?: {avoidProviders?: readonly string[]; avoidAccounts?: readonly string[]},
): Promise<HighReview> {
  if (!finding.examinerProfileId) {
    throw new VerifyRecheckRefusal(VERIFY_RECHECK_NEW_EXAM_REQUIRED, VERIFY_RECHECK_NEW_EXAM_GUIDANCE, 409);
  }
  const avoidProfiles = [finding.examinerProfileId];
  const avoidExaminerAccounts = finding.examinerAccountId ? [finding.examinerAccountId] : [];
  const avoidAccounts = uniqueIds([
    ...(avoid?.avoidAccounts ?? []),
    ...(avoid?.avoidProviders ?? []),
  ].filter(id => Uuid.safeParse(id).success));
  if (avoidAccounts.length > 8) throw new Refusal('EXAM_EXCLUSION_LIMIT', 400);
  const call: ReviewerCall = VerifyWorkerCall.parse({
    role: 'reviewer',
    provider: 'recheck',
    accountId: '00000000-0000-4000-8000-000000000001',
    profileId: '00000000-0000-4000-8000-000000000002',
    model: 'recheck',
    grantId: '00000000-0000-4000-8000-000000000003',
    intentId,
    task: recheckTask(finding, excerpt),
    repo: 'sem-repositorio',
    writePaths: [],
    ...(avoid?.avoidProviders?.length ? {avoidProviders: [...avoid.avoidProviders]} : {}),
    avoidProfiles,
    ...(avoidExaminerAccounts.length ? {avoidExaminerAccounts} : {}),
    ...(avoidAccounts.length ? {avoidAccounts} : {}),
  });
  const verdict = parseVerdict(await worker.run(call));
  return {
    status: verdict.status,
    provider: reviewerText(call, 'reviewerProvider'),
    accountId: reviewerText(call, 'reviewerAccountId'),
    sessionId: reviewerText(call, 'reviewerSessionId'),
  };
}

function correctionDiffInvocation(examinedCommit: string, relativeFile: string): {args: string[]; env: Record<string, string>} {
  const path = typeof process.env.PATH === 'string' && process.env.PATH.length > 0 ? process.env.PATH : '/usr/bin:/bin';
  return {
    args: [
      '-c', 'core.hooksPath=/dev/null',
      '--no-pager',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=0',
      examinedCommit,
      'HEAD',
      '--',
      relativeFile,
    ],
    env: {
      PATH: path,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '0',
      HOME: '/nonexistent',
    },
  };
}

function diffDropsSnippet(diff: string, snippet: string): boolean {
  const removed = diff.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).map(line => line.slice(1)).join('\n');
  return removed.includes(snippet);
}

async function snippetChangedSince(repo: string, examinedCommit: string, relativeFile: string, snippet: string): Promise<boolean> {
  const invocation = correctionDiffInvocation(examinedCommit, relativeFile);
  let stdout = '';
  try {
    const result = await execGit('git', invocation.args, {
      cwd: repo,
      timeout: 8000,
      maxBuffer: 2_000_000,
      encoding: 'utf8',
      env: invocation.env,
    });
    const raw: unknown = result.stdout;
    stdout = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as {code?: unknown}).code : undefined;
    const raw = error && typeof error === 'object' && 'stdout' in error ? (error as {stdout?: unknown}).stdout : '';
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : '';
    if (code !== 1) return false;
    stdout = text;
  }
  return diffDropsSnippet(stdout, snippet);
}

async function snippetGone(repo: string | null, finding: OpenFinding, examinedCommit: string): Promise<boolean> {
  const snippet = finding.snippet.trim();
  if (snippet.length < PROOF_SNIPPET || !repo || isSecretBasename(finding.file) || !CommitId.test(examinedCommit)) return false;
  const located = await locateRepoFile(repo, finding.file);
  if (!located) return false;
  try {
    const handle = await open(located, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > PROOF_BYTES) return false;
      if ((await handle.readFile({encoding: 'utf8'})).includes(snippet)) return false;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
  return snippetChangedSince(repo, examinedCommit, finding.file, snippet);
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

function achadoRecord(update: ReportUpdate) {
  return {id: update.id, status: update.status, file: update.file, line: update.line, title: update.title};
}

function achadosBody(raw: string | null, updates: readonly ReportUpdate[]): string {
  if (raw == null) return `${JSON.stringify({achados: updates.map(achadoRecord)}, null, 2)}\n`;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  const record = body as {achados?: unknown};
  const list = Array.isArray(record.achados) ? [...record.achados] : [];
  const pending = new Map(updates.map(item => [item.id, item]));
  const next = list.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const id = 'id' in item ? String((item as {id: unknown}).id) : '';
    const update = pending.get(id);
    if (!update) return item;
    pending.delete(id);
    return {...(item as Record<string, unknown>), status: update.status};
  });
  for (const update of updates) {
    if (!pending.has(update.id)) continue;
    next.push(achadoRecord(update));
  }
  record.achados = next;
  return `${JSON.stringify(record, null, 2)}\n`;
}

async function replacePrivate(directory: string, name: string, body: string) {
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  if (!target.startsWith(directory + sep) || !temporary.startsWith(directory + sep)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  try {
    let existing = null;
    try {
      existing = await lstat(target);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    await writeFile(temporary, body, {mode: 0o600, flag: 'wx'});
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

async function markdownTargets(dir: string, updates: readonly ReportUpdate[]): Promise<{path: string; status: 'fechado' | 'reaberto'}[]> {
  const achadosDir = join(dir, 'achados');
  let info;
  try {
    info = await lstat(achadosDir);
  } catch (error) {
    if (errno(error) === 'ENOENT') return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  const targets: {path: string; status: 'fechado' | 'reaberto'}[] = [];
  for (const update of updates) {
    const achadoPath = join(achadosDir, `${update.id}.md`);
    if (!achadoPath.startsWith(dir + sep)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    let fileInfo;
    try {
      fileInfo = await lstat(achadoPath);
    } catch (error) {
      if (errno(error) === 'ENOENT') continue;
      throw error;
    }
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    targets.push({path: achadoPath, status: update.status});
  }
  return targets;
}

async function updateReports(dataDirectory: string, projectId: string, runId: string, updates: readonly ReportUpdate[]) {
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
  const matches: {report: MatchedReport; markdown: {path: string; status: 'fechado' | 'reaberto'}[]}[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(base, entry.name);
    if (!dir.startsWith(base + sep)) continue;
    const dirInfo = await lstat(dir);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) continue;
    const runPath = join(dir, 'run.json');
    let runInfo;
    try {
      runInfo = await lstat(runPath);
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') continue;
      throw error;
    }
    if (runInfo.isSymbolicLink() || !runInfo.isFile()) continue;
    const runRaw = await readFile(runPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(runRaw);
    } catch {
      continue;
    }
    if (!runJsonMatches(parsed, runId)) continue;
    const achadosPath = join(dir, 'achados.json');
    let achadosRaw: string | null;
    try {
      const info = await lstat(achadosPath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      achadosRaw = await readFile(achadosPath, 'utf8');
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (errno(error) === 'ENOENT') achadosRaw = null;
      else throw error;
    }
    const markdown = await markdownTargets(dir, updates);
    matches.push({report: {dir, runRaw, achadosRaw}, markdown});
  }
  for (const match of matches) {
    await replacePrivate(match.report.dir, 'achados.json', achadosBody(match.report.achadosRaw, updates));
    await replacePrivate(match.report.dir, 'run.json', match.report.runRaw.endsWith('\n') ? match.report.runRaw : `${match.report.runRaw}\n`);
    for (const target of match.markdown) {
      const markdown = replaceSituacao(await readFile(target.path, 'utf8'), target.status);
      await replacePrivate(dirname(target.path), basename(target.path), markdown);
    }
  }
}

async function existingRemediation(client: pg.PoolClient, runId: string, ids: readonly string[]): Promise<{messageLocalId: string; writePaths: string[]} | null> {
  const rows = (await client.query(
    'SELECT message_local_id, write_paths, finding_ids FROM ac_verify_remediations WHERE run_id=$1 FOR UPDATE',
    [runId],
  )).rows as {message_local_id: string; write_paths: string[]; finding_ids: string[]}[];
  const match = rows.find(row => sameIdSet(row.finding_ids ?? [], ids));
  if (!match) return null;
  return {messageLocalId: String(match.message_local_id), writePaths: [...match.write_paths].map(String)};
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
    const repo = await projectRepo(client, input.projectId);
    if (!repo) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    for (const finding of findings) {
      if (!(await locateRepoFile(repo, finding.file))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    }
    const groups = groupFindings(findings);
    const writePaths = groups.map(group => group.file);
    const ids = findings.map(finding => finding.id);
    const existing = await existingRemediation(client, run.id, ids);
    if (existing) return existing;
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
    const intentRow = (await client.query<{state: string; policy_revision: number}>(
      `SELECT i.state, x.policy_revision
       FROM ac_contexts x
       LEFT JOIN ac_intents i ON i.id = $1 AND i.context_id = x.id
       WHERE x.id = $2`,
      [run.intentId, authority.contextId],
    )).rows[0];
    const state = intentRow?.state ? String(intentRow.state) : 'done';
    const intentTerminal = ['done', 'review', 'failed', 'canceled', 'cancelled'].includes(state);
    return {
      run,
      intentTerminal,
      policyRevision: Number(intentRow?.policy_revision ?? 1),
      findings: await loadFindings(client, run.id, requested, false),
      repo: await projectRepo(client, input.projectId),
    };
  });
  if (loaded.findings.some(finding => !finding.examinerProfileId)) {
    throw new VerifyRecheckRefusal(VERIFY_RECHECK_NEW_EXAM_REQUIRED, VERIFY_RECHECK_NEW_EXAM_GUIDANCE, 409);
  }
  let activeIntentId = loaded.run.intentId;
  let ownIntentId: string | undefined;
  if (loaded.intentTerminal) {
    const commit = /^[a-f0-9]{40}$/.test(loaded.run.commitId) ? loaded.run.commitId : '0'.repeat(40);
    const created = await acceptSecurityVerification(ledger, principal, authority, {
      projectId: input.projectId,
      commit,
      policyRevision: loaded.policyRevision,
    });
    activeIntentId = created.id;
    ownIntentId = created.id;
  }
  const decided: ReportUpdate[] = [];
  let succeeded = false;
  try {
    // Provedor, conta e sessão vêm da reserva, não do texto do modelo.
    for (const finding of loaded.findings) {
      const excerpt = await excerptFor(loaded.repo, finding);
      const first = await reviewFinding(input.worker, finding, excerpt.text, activeIntentId);
      let status: 'fechado' | 'reaberto';
      if (finding.severity !== 'alta') {
        status = first.status === 'descartado' && excerpt.seen ? 'fechado' : 'reaberto';
      } else {
        const avoid = avoidAccount(first.accountId);
        const second = await reviewFinding(input.worker, finding, excerpt.text, activeIntentId, avoid ? {avoidProviders: avoid, avoidAccounts: avoid} : undefined);
        const discarded = first.status === 'descartado' || second.status === 'descartado';
        const gone = excerpt.seen && discarded ? await snippetGone(loaded.repo, finding, loaded.run.commitId) : false;
        status = highFindingCloses({seen: excerpt.seen, snippetGone: gone, first, second}) ? 'fechado' : 'reaberto';
      }
      decided.push({id: finding.id, status, file: finding.file, line: finding.line, title: finding.title});
    }
    await ledger.tx(async client => {
      await ledger.authorize(client, principal, authority.contextId);
      await ledger.fence(client, authority);
      for (const result of decided) {
        const updated = await client.query(
          'UPDATE ac_verify_findings SET status=$3 WHERE run_id=$1 AND achado_id=$2',
          [loaded.run.id, result.id, result.status],
        );
        if (!updated.rowCount) throw new Refusal('VERIFY_FINDING_MISSING', 404);
      }
    });
    await updateReports(input.dataDirectory, input.projectId, loaded.run.id, decided);
    succeeded = true;
  } finally {
    if (ownIntentId) {
      try {
        await finishExamIntent(ledger, {intentId: ownIntentId, contextId: authority.contextId}, succeeded ? 'done' : 'failed');
      } catch (error) {
        if (succeeded) throw error;
      }
    }
  }
  return {results: decided.map(({id, status}) => ({id, status}))};
}
