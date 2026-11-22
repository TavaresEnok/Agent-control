import {lstat, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {z} from 'zod';
import {Id, Refusal, type Authority} from './contracts.ts';
import {VERIFICATION_MODULES, type Ledger, type VerificationModule} from './ledger.ts';
import type {CollectorProcess} from './module-container-cleanup.ts';
import type {ModuleExamResult} from './module-exam.ts';
import type {ModuleExamCollectorContext} from './module-exam-collector-proof.ts';
import {assembleDocumentationArtifacts} from './module-documentation-artifacts.ts';
import type {ProntidaoPassiveEvidence} from './prontidao-target.ts';
import {hasKnownSecret, isSecretClassBasename} from './verify-redact.ts';
import {Achado, CoverageRow, VerifySeverity, type VerifyWorker} from './verify-types.ts';

export const MODULE_CONTAINER_USER = '65532:65532';
export const MAX_COLLECTOR_STDOUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 1_200_000;
export const COLLECTOR_DAEMON_TIMEOUT_MS = 10_000;
export const MODULE_MEMORY_BYTES = 2_147_483_648;
export const MODULE_NANO_CPUS = 2_000_000_000;
export const MODULE_PIDS_LIMIT = 256;

export const MODULE_TITLES: Readonly<Record<VerificationModule, string>> = Object.freeze({
  qa: 'QA pesado',
  arquitetura: 'Arquitetura e dívida técnica',
  dependencias: 'Dependências e atualizações',
  banco: 'Banco de dados',
  prontidao: 'Prontidão para produção',
  desempenho: 'Desempenho',
  documentacao: 'Documentação viva',
  conformidade: 'Conformidade (LGPD e licenças)',
});

const MODULE_SET: ReadonlySet<string> = new Set(VERIFICATION_MODULES);
export const DIGEST = /(?:^|@)sha256:[a-f0-9]{64}$/;
export const MUTABLE_LATEST = /(^|[/:])latest($|@)/i;
export const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;
export const MULTILINE_CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const REPO_PATH = /^[\p{L}\p{M}\p{N} ._@+\/()[\]-]+$/u;
const PROTECTED_REPO_PATH = /^[\p{L}\p{M}\p{N} ._@+\/-]+$/u;
const LOWER_FORBIDDEN = new Set(['.mcp.json', '.claude', '.husky', '.codex', '.grok']);
export const ACHADO_ID = z.string().regex(/^ACH-\d{3}$/);
export const ACHADO_FILE = /^ACH-\d{3}\.md$/;
export const MODULE_REPORT_DIR = /^\d{8}-\d{6}-(?:[a-f0-9]{8}|[a-f0-9]{32})-(qa|arquitetura|dependencias|banco|prontidao|desempenho|documentacao|conformidade)$/;
export const EXCERPT_LIMIT = 4000;
export const ARCHIVE_TIMEOUT_MS = 60_000;

export const ModuleToolStatus = z.enum(['ok', 'failed', 'skipped']);
export type ModuleToolStatus = z.infer<typeof ModuleToolStatus>;

export const ModuleToolCoverage = z.object({
  tool: z.string().min(1).max(120),
  version: z.string().min(1).max(120),
  status: ModuleToolStatus,
  detail: z.string().min(1).max(2000),
  files: z.array(z.string()).max(100000).optional(),
}).strict();
export type ModuleToolCoverage = z.infer<typeof ModuleToolCoverage>;

export const ModuleRawFinding = z.object({
  tool: z.string().min(1).max(120),
  rule: z.string().min(1).max(200),
  file: z.string().min(1).max(400),
  line: z.number().int().min(1).max(10_000_000),
  severity: VerifySeverity,
  message: z.string().min(1).max(2000),
  evidence: z.string().min(1).max(2000),
}).strict();
export type ModuleRawFinding = z.infer<typeof ModuleRawFinding>;

// Existing collectors emit per-file measurements in tool-specific detail rows.
// Aggregate, skipped and failure messages do not establish file coverage.
export function collectorMeasuredDetailFile(row: ModuleToolCoverage): string | null {
  if (row.status !== 'ok') return null;
  const metrics: Record<string, string[]> = {
    'ast-complexity:file': ['loc'], 'jscpd:file': ['linhas'],
    'dependency-cruiser:file': ['deps'], 'knip:file': ['papel'],
    'ast-grep': ['achados'], 'jscodeshift': ['reescritas'],
    'npm-check-updates': ['dependencias', 'manifesto_invalido'],
    'sbom-lockfile': ['dependencias_verificadas'],
    'typedoc:markdown': ['assinaturas_conferidas'], 'typedoc:file': ['simbolos'],
    'dependency-cruiser:diagrama': ['arestas_doc_conferidas'],
    'mermaid:file': ['blocos_mermaid'],
  };
  const allowed = metrics[row.tool] ?? [];
  let file: string | undefined;
  const match = /^arquivo=([^;]+); ([a-z_]+)=([^;]*)(?:;|$)/.exec(row.detail);
  if (match && allowed.includes(match[2]!)) {
    const [, candidate, metric, value] = match;
    const valid = metric === 'papel' ? ['entrada', 'modulo', 'nao_alcancado'].includes(value!)
      : metric === 'manifesto_invalido' ? value === 'true'
        : /^(?:0|[1-9]\d*)$/.test(value!) && Number.isSafeInteger(Number(value));
    if (valid) file = candidate;
  }
  if (row.tool === 'hadolint:arquivo') file = /^(.+): \d+ achado\(s\)\.$/.exec(row.detail)?.[1];
  if (row.tool === 'trivy:arquivo') file = /^(.+): \d+ achado\(s\) de configuração\.$/.exec(row.detail)?.[1];
  if (!file) return null;
  try { return assertModuleRepoRelativePath(file); } catch { return null; }
}

export const ModuleCollectorOutput = z.object({
  coverage: z.array(ModuleToolCoverage).min(1).max(5000),
  findings: z.array(ModuleRawFinding).max(999),
}).strict();
export type ModuleCollectorOutput = z.infer<typeof ModuleCollectorOutput>;

export const ModuleReportSummary = z.object({
  id: Id,
  module: z.enum(VERIFICATION_MODULES),
  directoryName: z.string().regex(MODULE_REPORT_DIR),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  image: z.string().optional(),
  previousPerformanceRunId: Id.optional(),
  createdAt: z.string().min(1).max(40),
  counts: z.object({
    alta: z.number().int().nonnegative(),
    media: z.number().int().nonnegative(),
    baixa: z.number().int().nonnegative(),
    informativa: z.number().int().nonnegative(),
  }).strict(),
  toolFailures: z.number().int().nonnegative(),
  note: z.string().max(500),
}).strict();
export type ModuleReportSummary = z.infer<typeof ModuleReportSummary>;

export type CollectorRunnerSpec = {
  module: VerificationModule;
  image: string | undefined;
  repoPath: string;
  commit: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  signal?: AbortSignal;
  passiveTlsEvidence?: ProntidaoPassiveEvidence;
};

export type VerificationModuleRunInput = {
  module: VerificationModule;
  ledger: Ledger;
  principal: string;
  authority: Authority;
  projectId: string;
  repoPath: string;
  dataDirectory: string;
  commit: string;
  image?: string;
  rootDir?: string;
  runId?: string;
  createdAt?: Date;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  signal?: AbortSignal;
  passiveTlsEvidence?: ProntidaoPassiveEvidence;
  collectorOutput?: unknown;
  runCollector?: (spec: CollectorRunnerSpec) => Promise<string | Buffer | ModuleCollectorOutput>;
  executeCollectorProcess?: CollectorProcess;
  examinar?: (request: {intentId: string; snapshot: string; module: VerificationModule;
    findings: readonly ModuleRawFinding[]; collector?: ModuleExamCollectorContext; signal?: AbortSignal}) => Promise<ModuleExamResult>;
  /** Optional independent reviewer worker. When present, findings are confirmed without passing author conclusions. */
  worker?: VerifyWorker;
  allowedAccountIds?: readonly string[];
  notes?: readonly string[];
};

export type VerificationModuleRunResult = {
  runId: string;
  intentId: string;
  module: VerificationModule;
  directory: string;
  directoryName: string;
  achados: Achado[];
  coverage: CoverageRow[];
  toolCoverage: ModuleToolCoverage[];
  hasToolFailure: boolean;
  summary: ModuleReportSummary;
  /** The examiner stopped (the run is failed) or left files not judged by a failure code (the run stays done); the report is partial. */
  examIncomplete?: {code: string; unjudged: number; total: number} | null;
  /** Findings whose review failed, with their distinct codes. */
  unreviewed?: {count: number; codes: string[]} | null;
};

export function isVerificationModule(value: unknown): value is VerificationModule {
  return typeof value === 'string' && MODULE_SET.has(value);
}

export function assertVerificationModule(value: unknown): VerificationModule {
  if (!isVerificationModule(value)) throw new Refusal('INVALID_CONTRACT', 400);
  return value;
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

export function assertSafeSegment(value: string): void {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 240
    || value === '.'
    || value === '..'
    || value.includes('..')
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\0')
    || isAbsolute(value)
  ) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
}

export function assertInside(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
}

function forbiddenSegment(part: string): boolean {
  return (
    part === ''
    || part !== part.trim()
    || part === '.'
    || part === '..'
    || part === '.git'
    || part === '.ai'
    || part === 'node_modules'
    || part.startsWith('.env')
    || LOWER_FORBIDDEN.has(part.toLowerCase())
  );
}

/** Validates a relative repository path from a collector finding or remediation request. */
export function assertModuleRepoRelativePath(file: string): string {
  if (typeof file !== 'string') throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  if (file.includes('\\') || CONTROL_CHAR.test(file)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  const trimmed = file.trim();
  if (
    !trimmed
    || file !== trimmed
    || trimmed.length > 400
    || trimmed.startsWith('/')
    || trimmed.startsWith('~')
    || /^[A-Za-z]:/.test(trimmed)
    || !REPO_PATH.test(trimmed)
  ) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  const parts = trimmed.split('/');
  if (parts.some(part => forbiddenSegment(part) || isSecretClassBasename(part)) || hasKnownSecret(trimmed)) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  return parts.join('/');
}

// Only the basename of a secret-class file may cross this boundary, and only
// for a structured readiness secret finding. All parent segments remain strict.
export function protectedLocation(file: string): string {
  if (typeof file !== 'string' || file !== file.trim() || file.includes('\\') || CONTROL_CHAR.test(file)
    || file.length > 400 || !PROTECTED_REPO_PATH.test(file) || file.startsWith('/') || file.startsWith('~')) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  const parts = file.split('/');
  const name = parts.pop()!;
  if (!isSecretClassBasename(name) || name.includes('..') || name === '.' || name === '..'
    || (forbiddenSegment(name) && !name.toLowerCase().startsWith('.env'))
    || parts.some(part => forbiddenSegment(part) || isSecretClassBasename(part))
    || hasKnownSecret(file)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  return file;
}

export function isProtectedFindingSource(tool: unknown, rule: unknown): boolean {
  return typeof rule === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(rule)
    && (tool === 'gitleaks' || tool === 'trivy'
      || (tool === 'prontidao-audit' && (rule === 'PRONTIDAO-SEGREDO-ARQUIVO-ENV' || rule === 'PRONTIDAO-CHAVE-PRIVADA-NO-REPOSITORIO')));
}

export function isProtectedLocation(file: string): boolean {
  try { protectedLocation(file); return true; } catch { return false; }
}

export function documentationCoverage(coverage: readonly ModuleToolCoverage[]) {
  if (coverage.some(row => row.tool.endsWith(':artefato') && row.files !== undefined)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const artifacts = assembleDocumentationArtifacts(coverage);
  const tools = new Set(['typedoc:artefato', 'dependency-cruiser:artefato']);
  const result = coverage.filter(row => !tools.has(row.tool));
  for (const [name, artifact] of Object.entries(artifacts)) {
    const rows = coverage.filter(row => row.tool === (name === 'api.json' ? 'typedoc:artefato' : 'dependency-cruiser:artefato'));
    if (!rows.length) continue;
    result.push({tool: rows[0]!.tool, version: rows[0]!.version,
      status: artifact.status === 'omitted' ? 'skipped' : 'ok',
      detail: artifact.status === 'present'
        ? `Artefato ${name} validado (${Buffer.byteLength(artifact.content)} bytes).`
        : `Artefato ${name} omitido por limite de tamanho.`});
  }
  return {artifacts, coverage: result};
}

export async function assertReportOutsideRepo(repoPath: string, dataDirectory: string): Promise<void> {
  const repo = await realpath(repoPath);
  const data = await realpath(dataDirectory);
  const rel = relative(repo, data);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (rel === '' || !outside) throw new Refusal('VERIFY_REPORT_INSIDE_REPO', 403);
}

function escapesRepo(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === '';
}

export async function resolveInsideRepo(repo: string, relativeFile: string): Promise<string> {
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
  const real = await realpath(current);
  if (escapesRepo(relative(root, real))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  return real;
}

export async function locateRepoFile(repo: string, relativeFile: string): Promise<string | null> {
  try {
    return await resolveInsideRepo(repo, relativeFile);
  } catch (error) {
    if (error instanceof Refusal) return null;
    throw error;
  }
}
