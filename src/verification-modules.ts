import {spawn} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type pg from 'pg';
import {z} from 'zod';
import {Capacity} from './capacity.ts';
import {digest, Id, Refusal, type Authority} from './contracts.ts';
import {finishExamIntentTx} from './exam-intent.ts';
import {reserveSpecialistExamSeat} from './exam-provider.ts';
import {VERIFICATION_MODULES, type Ledger, type VerificationModule} from './ledger.ts';
import {
  COLLECTOR_CAPTURE_DIR, COLLECTOR_HEADER_BYTES, COLLECTOR_WRAPPER_PATH, collectorOutputWrapper, verifyCollectorOutput,
} from './module-collector-output.ts';
import {
  MODULE_CONTAINER_LABEL, MODULE_RUNTIME_BIN, assertOwnedModuleContainer, createdContainerId, moduleContainerJournal, moduleContainerName,
  runBoundedCollectorProcess, type CollectorProcess,
} from './module-container-cleanup.ts';
import {moduleCollectorCandidate, moduleExamReviewEvidence, type ModuleExamCollectorReview, type ModuleExamResult} from './module-exam.ts';
import {mapModuleSnapshot, readModuleExamFile} from './module-exam-map.ts';
import {isPublicModuleRule, type ModuleExamCollectorContext} from './module-exam-collector-proof.ts';
import {hasModuleReviewProof, moduleCollectorHypothesis, moduleReviewObservationTitle, moduleReviewTask, readModuleReviewVerdict} from './module-exam-proof.ts';
import {readRecheckBlob, recheckHead, sameRecheckHistory} from './module-recheck-git.ts';
import {moduleMeasurementCriterion} from './module-recheck-criteria.ts';
import {measureLocalRegression} from './module-recheck-local.ts';
import {latestModuleMeasurement, RECHECK_PROOF_VERSION, type MeasurementScope} from './module-recheck-measurement.ts';
import {COVERAGE_REVIEW_INSTRUCTION, FUNCTION_COVERAGE_CRITERION, measureRecheckRegression,
  readFunctionalRecheckVerdict, recheckCorrectionMatches, supportsFunctionalRecheck,
  type BoundScope, type FunctionalRegression} from './module-recheck-regression.ts';
import {assembleDocumentationArtifacts} from './module-documentation-artifacts.ts';
import {validatePassiveTlsEvidence, type ProntidaoPassiveEvidence} from './prontidao-target.ts';
import {
  assertNoSymlinkAlongPath, correctionReceipt, groupCorrectionFindings, loadCorrectionRequests, saveCorrectionRequest,
  type CorrectionReceipt,
} from './verification-correction-requests.ts';
import {assertPersonalActivation} from './verify-intent.ts';
import {hasKnownSecret, isSecretClassBasename, redactUnknownSecrets} from './verify-redact.ts';
import {
  Achado,
  CoverageRow,
  REMEDIATION_ACCEPTANCE,
  VerifySeverity,
  VerifyWorkerCall,
  type VerifyWorker,
} from './verify-types.ts';
import {lockWorkflowProjectShared} from './workflow-generations.ts';

/** Container runtime binary. Tests compare against this constant and do not quote the name. */
export {MODULE_RUNTIME_BIN, runBoundedCollectorProcess, type BoundedProcessResult} from './module-container-cleanup.ts';
export const MODULE_CONTAINER_USER = '65532:65532';
export const MAX_COLLECTOR_STDOUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 1_200_000;
const COLLECTOR_DAEMON_TIMEOUT_MS = 10_000;
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
const DIGEST = /(?:^|@)sha256:[a-f0-9]{64}$/;
const MUTABLE_LATEST = /(^|[/:])latest($|@)/i;
const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;
const MULTILINE_CONTROL_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const REPO_PATH = /^[\p{L}\p{M}\p{N} ._@+\/-]+$/u;
const LOWER_FORBIDDEN = new Set(['.mcp.json', '.claude', '.husky', '.codex', '.grok']);
const ACHADO_ID = z.string().regex(/^ACH-\d{3}$/);
const ACHADO_FILE = /^ACH-\d{3}\.md$/;
const MODULE_REPORT_DIR = /^\d{8}-\d{6}-(?:[a-f0-9]{8}|[a-f0-9]{32})-(qa|arquitetura|dependencias|banco|prontidao|desempenho|documentacao|conformidade)$/;
const EXCERPT_LIMIT = 4000;
const ARCHIVE_TIMEOUT_MS = 60_000;

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
};

export function isVerificationModule(value: unknown): value is VerificationModule {
  return typeof value === 'string' && MODULE_SET.has(value);
}

export function assertVerificationModule(value: unknown): VerificationModule {
  if (!isVerificationModule(value)) throw new Refusal('INVALID_CONTRACT', 400);
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function assertSafeSegment(value: string): void {
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

function assertInside(root: string, target: string): void {
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
  if (parts.some(forbiddenSegment) || isSecretClassBasename(trimmed)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  return parts.join('/');
}

// Only the basename of a secret-class file may cross this boundary, and only
// for a structured readiness secret finding. All parent segments remain strict.
function protectedLocation(file: string): string {
  if (typeof file !== 'string' || file !== file.trim() || file.includes('\\') || CONTROL_CHAR.test(file)
    || file.length > 400 || !REPO_PATH.test(file) || file.startsWith('/') || file.startsWith('~')) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  const parts = file.split('/');
  const name = parts.pop()!;
  if (!isSecretClassBasename(name) || name.includes('..') || name === '.' || name === '..'
    || (forbiddenSegment(name) && !name.startsWith('.env')) || parts.some(forbiddenSegment)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  return file;
}

function isProtectedFindingSource(tool: unknown, rule: unknown): boolean {
  return typeof rule === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(rule)
    && (tool === 'gitleaks' || tool === 'trivy'
      || (tool === 'prontidao-audit' && (rule === 'PRONTIDAO-SEGREDO-ARQUIVO-ENV' || rule === 'PRONTIDAO-CHAVE-PRIVADA-NO-REPOSITORIO')));
}

function isProtectedLocation(file: string): boolean {
  try { protectedLocation(file); return true; } catch { return false; }
}

function documentationCoverage(coverage: readonly ModuleToolCoverage[]) {
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

function assertNoForeignNetwork(value: string): void {
  if (/(?:--network|--net)(?:=|\s+)(?!none\b)\S+/i.test(value)) throw new Refusal('VERIFY_NETWORK_FORBIDDEN');
}

function isSocket(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('.sock') || lower.includes('docker.sock');
}

export function assertPinnedModuleImage(image: string): string {
  if (typeof image !== 'string') throw new Refusal('VERIFY_IMAGE_UNPINNED');
  assertNoForeignNetwork(image);
  if (isSocket(image)) throw new Refusal('VERIFY_SOCKET_FORBIDDEN');
  if (image.split('/').includes('..')) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  if (
    image.length === 0
    || image.length > 512
    || /[\s\u0000-\u001f]/.test(image)
    || MUTABLE_LATEST.test(image)
    || !DIGEST.test(image)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(image)
  ) {
    throw new Refusal('VERIFY_IMAGE_UNPINNED');
  }
  return image;
}

export function parsePinnedModuleImage(text: string): string {
  if (typeof text !== 'string') throw new Refusal('VERIFY_IMAGE_UNPINNED');
  const line = text.trim().split(/\s+/u)[0] ?? '';
  return assertPinnedModuleImage(line);
}

export function moduleDigestPath(module: VerificationModule, rootDir?: string): string {
  assertVerificationModule(module);
  const base = resolve(rootDir ?? resolve(import.meta.dirname, '..'));
  return join(base, 'deploy', 'modules', module, 'digest.txt');
}

export async function readPinnedModuleImage(module: VerificationModule, rootDir?: string): Promise<string> {
  const path = moduleDigestPath(module, rootDir);
  let text: string;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (isErrno(error, 'ENOENT')) throw new Refusal('VERIFY_IMAGE_UNPINNED');
    throw error;
  }
  return parsePinnedModuleImage(text);
}

/** In laboratory runs (`AC_MODULE_LAB=1`), resolves the immutable Docker image from `deploy/modules/<modulo>/digest.txt`. */
export async function resolveModuleLabImage(module: VerificationModule, rootDir?: string): Promise<string | null> {
  assertVerificationModule(module);
  if (process.env.AC_MODULE_LAB !== '1') return null;
  return readPinnedModuleImage(module, rootDir);
}

function assertHostPath(path: string): string {
  if (typeof path !== 'string') throw new Refusal('VERIFY_PATH_FORBIDDEN');
  assertNoForeignNetwork(path);
  if (isSocket(path)) throw new Refusal('VERIFY_SOCKET_FORBIDDEN');
  if (
    path.length === 0
    || path.length > 4096
    || path.includes('\0')
    || path.includes('\\')
    || /\s/.test(path)
    || !path.startsWith('/')
    || !/^\/[A-Za-z0-9._/-]+$/.test(path)
  ) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN');
  }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (normalized.split('/').includes('..') || normalized.split('/').includes('.')) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN');
  }
  return normalized;
}

function assertLimit(value: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Refusal('VERIFY_LIMITS_INVALID');
}

function cpusFromNano(nanoCpus: number): string {
  const whole = Math.floor(nanoCpus / 1_000_000_000);
  const fraction = nanoCpus % 1_000_000_000;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(9, '0').replace(/0+$/, '')}`;
}

/**
 * Collector container invocation for modules 2 to 9.
 * Starts via the image's default ENTRYPOINT with `/repo` mounted read-only,
 * read-only rootfs, unprivileged user 65532:65532, writable `/tmp`, no socket,
 * no login and network disabled (`--network none`).
 */
export function moduleCollectorArguments(input: {
  image: string;
  repository: string;
  evidenceFile?: string;
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
}): readonly string[] {
  assertPinnedModuleImage(input.image);
  const source = assertHostPath(input.repository);
  const evidence = input.evidenceFile !== undefined ? assertHostPath(input.evidenceFile) : undefined;
  if (evidence !== undefined && (evidence === source || evidence.startsWith(`${source}/`))) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  const memoryBytes = input.memoryBytes ?? MODULE_MEMORY_BYTES;
  const nanoCpus = input.nanoCpus ?? MODULE_NANO_CPUS;
  const pidsLimit = input.pidsLimit ?? MODULE_PIDS_LIMIT;
  assertLimit(memoryBytes, 68_719_476_736);
  assertLimit(nanoCpus, 1_024_000_000_000);
  assertLimit(pidsLimit, 512);
  const memory = String(memoryBytes);
  return [
    MODULE_RUNTIME_BIN,
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    MODULE_CONTAINER_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(pidsLimit),
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    cpusFromNano(nanoCpus),
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m',
    '--env',
    'HOME=/tmp',
    '--env',
    'TMPDIR=/tmp',
    '--workdir',
    '/tmp',
    '--mount',
    `type=bind,src=${source},dst=/repo,readonly`,
    ...(evidence !== undefined ? ['--mount', `type=bind,src=${evidence},dst=/run/prontidao-evidence.json,readonly`] : []),
    input.image,
  ];
}

function shannonEntropy(value: string): number {
  const chars = [...value];
  const total = chars.length;
  if (total === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const REMOVED_HIGH_ENTROPY = '[removido: alta entropia]';
const BASE64_SECRET = /[A-Za-z0-9+]{40,}={0,2}/;
const SNAKE_IDENTIFIER = /^[a-z][a-z0-9_]{31,}$/;
const SHORT_FILE_EXTENSION = /\.[A-Za-z0-9]{1,5}$/;

function isSnakeToken(token: string): boolean {
  if (SNAKE_IDENTIFIER.test(token)) return true;
  const pieces = token.split(/[^A-Za-z0-9_]+/).filter(piece => piece.length > 0);
  if (pieces.length === 0 || pieces.some(piece => !/^[a-z][a-z0-9_]*$/.test(piece))) return false;
  return pieces.some(piece => SNAKE_IDENTIFIER.test(piece));
}

function isPathToken(token: string): boolean {
  if (token.startsWith('/') || token.startsWith('./') || token.startsWith('../')) return true;
  const segments = token.split('/');
  if (segments.length <= 1) return false;
  if (!segments.every(segment => segment.length < 32)) return false;
  return segments.some(segment => SHORT_FILE_EXTENSION.test(segment));
}

function isMaskToken(token: string): boolean {
  return /^\(sha256:[a-f0-9]{64}\)$/.test(token);
}

function isSecretToken(token: string): boolean {
  if (!token || isMaskToken(token) || isPathToken(token) || isSnakeToken(token)) return false;
  if (!token.includes('/')) {
    if (BASE64_SECRET.test(token)) return true;
    return token.length >= 32 && shannonEntropy(token) >= 3.5;
  }
  return token.split('/').some(segment => {
    if (!segment || SNAKE_IDENTIFIER.test(segment)) return false;
    if (BASE64_SECRET.test(segment)) return true;
    return segment.length >= 32 && shannonEntropy(segment) >= 3.5;
  });
}

async function independentVerifier(snapshot: string, module: VerificationModule, exam: ModuleExamResult,
  finding: ModuleExamResult['findings'][number], raw?: ModuleRawFinding, collectorReview?: ModuleExamCollectorReview): Promise<Achado['verifier']> {
  if (exam.mode !== 'exame' || finding.status === 'provavel' || !finding.verifier || !finding.binding || isProtectedLocation(finding.file)) return null;
  const examiner = exam.coverage.find(row => row.file === finding.file && row.status === 'lido')?.examiner;
  const verifier = finding.verifier;
  if (!examiner || !verifier.accountId || !verifier.profileId || examiner.provider === verifier.provider ||
      examiner.accountId === verifier.accountId || examiner.profileId === verifier.profileId) return null;
  if (finding.examiner && (finding.examiner.profileId !== examiner.profileId || finding.examiner.accountId !== examiner.accountId ||
      finding.examiner.provider !== examiner.provider)) return null;
  const located = await locateRepoFile(snapshot, finding.file);
  if (!located) return null;
  const {code} = await readModuleExamFile(located, finding.file);
  const evidence = code === null ? null : moduleExamReviewEvidence(module, finding, code, raw, collectorReview);
  if (!evidence || !hasModuleReviewProof(evidence, finding)) return null;
  return {provider: verifier.provider, model: verifier.model};
}

function sanitizeText(value: string): string {
  return redactUnknownSecrets(value).replace(/\S+/g, token => (isSecretToken(token) ? REMOVED_HIGH_ENTROPY : token));
}

function validateSingleLineString(value: unknown, min: number, max: number, sanitize = false): string {
  if (typeof value !== 'string') throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  if (CONTROL_CHAR.test(value)) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const cleaned = sanitize ? sanitizeText(trimmed).slice(0, max) : trimmed;
  if (cleaned.length < min) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  return cleaned;
}

function validateTextBlock(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  if (MULTILINE_CONTROL_CHAR.test(value)) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (normalized.length < min || normalized.length > max) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const cleaned = sanitizeText(normalized).slice(0, max);
  if (cleaned.length < min) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  return cleaned;
}

/**
 * Validates and normalizes the collector's UTF-8 JSON stdout before persistence.
 * Enforces stdout byte limits, strict object keys, path safety, line >= 1,
 * allowed statuses/severities, and string bounds.
 */
export function parseModuleCollectorOutput(
  rawStdout: string | Buffer,
  options?: {maxStdoutBytes?: number; module?: VerificationModule},
): ModuleCollectorOutput {
  const maxStdoutBytes = options?.maxStdoutBytes ?? MAX_COLLECTOR_STDOUT_BYTES;
  if (!Number.isInteger(maxStdoutBytes) || maxStdoutBytes < 1) throw new Refusal('VERIFY_LIMITS_INVALID', 400);
  let text: string;
  if (Buffer.isBuffer(rawStdout)) {
    if (rawStdout.byteLength > maxStdoutBytes) throw new Refusal('VERIFY_STDOUT_LIMIT', 400);
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(rawStdout);
    } catch {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
  } else if (typeof rawStdout === 'string') {
    if (Buffer.byteLength(rawStdout, 'utf8') > maxStdoutBytes) throw new Refusal('VERIFY_STDOUT_LIMIT', 400);
    text = rawStdout;
  } else {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  if (text.includes('\0') || text.trim().length === 0) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  return validateModuleCollectorObject(parsed, options?.module);
}

export function validateModuleCollectorObject(parsed: unknown, module?: VerificationModule): ModuleCollectorOutput {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('coverage') || !keys.includes('findings')) {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  const root = parsed as {coverage: unknown; findings: unknown};
  if (!Array.isArray(root.coverage) || root.coverage.length < 1 || root.coverage.length > 5000) {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  if (!Array.isArray(root.findings) || root.findings.length > 999) {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  const coverage: ModuleToolCoverage[] = root.coverage.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const itemKeys = Object.keys(item);
    if (
      (itemKeys.length !== 4 && itemKeys.length !== 5)
      || itemKeys.some(key => !['tool', 'version', 'status', 'detail', 'files'].includes(key))
      || !itemKeys.includes('tool')
      || !itemKeys.includes('version')
      || !itemKeys.includes('status')
      || !itemKeys.includes('detail')
    ) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const row = item as Record<string, unknown>;
    if (row.files !== undefined && (!Array.isArray(row.files) || row.files.length > 100000)) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const statusParsed = ModuleToolStatus.safeParse(row.status);
    if (!statusParsed.success) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    return ModuleToolCoverage.parse({
      tool: validateSingleLineString(row.tool, 1, 120, false),
      version: validateSingleLineString(row.version, 1, 120, false),
      status: statusParsed.data,
      detail: validateTextBlock(row.detail, 1, 2000).replace(/\s*\n\s*/g, ' '),
      ...(Array.isArray(row.files) ? {files: row.files.map(file => module === 'prontidao' && typeof file === 'string' && isProtectedLocation(file) ? protectedLocation(file) : assertModuleRepoRelativePath(file))} : {}),
    });
  });

  const findings: ModuleRawFinding[] = root.findings.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const itemKeys = Object.keys(item);
    if (
      itemKeys.length !== 7
      || !itemKeys.includes('tool')
      || !itemKeys.includes('rule')
      || !itemKeys.includes('file')
      || !itemKeys.includes('line')
      || !itemKeys.includes('severity')
      || !itemKeys.includes('message')
      || !itemKeys.includes('evidence')
    ) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const row = item as Record<string, unknown>;
    const candidate = typeof row.file === 'string' ? row.file : '';
    const protectedFile = module === 'prontidao' && isProtectedLocation(candidate);
    const file = protectedFile ? protectedLocation(candidate) : assertModuleRepoRelativePath(candidate);
    if (typeof row.line !== 'number' || !Number.isInteger(row.line) || row.line < 1 || row.line > 10_000_000) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const severityParsed = VerifySeverity.safeParse(row.severity);
    if (!severityParsed.success) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    if (protectedFile) {
      if (!isProtectedFindingSource(row.tool, row.rule) || typeof row.message !== 'string'
        || hasKnownSecret(row.message) || typeof row.evidence !== 'string'
        || !(((row.message === 'Possível segredo em arquivo protegido.' || (row.tool === 'prontidao-audit'
          && row.rule === 'PRONTIDAO-CHAVE-PRIVADA-NO-REPOSITORIO' && row.message === 'Possível chave privada em arquivo protegido.'))
          && row.evidence === 'Localização informada pelo coletor; conteúdo protegido.')
          || (row.tool === 'gitleaks' ? row.evidence === `${row.rule}: match em ${file}:${row.line} [REDACTED]`
          : row.tool === 'trivy' && row.evidence === `${row.rule} em ${file}:${row.line} [REDACTED]`))) {
        throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
      }
      return ModuleRawFinding.parse({tool: row.tool, rule: row.rule, file, line: row.line, severity: severityParsed.data,
        message: 'Possível segredo em arquivo protegido.', evidence: 'Localização informada pelo coletor; conteúdo protegido.'});
    }
    return ModuleRawFinding.parse({
      tool: validateSingleLineString(row.tool, 1, 120, false),
      rule: validateSingleLineString(row.rule, 1, 200, !isPublicModuleRule(module, row.tool, row.rule)),
      file,
      line: row.line,
      severity: severityParsed.data,
      message: validateTextBlock(row.message, 1, 2000).replace(/\s*\n\s*/g, ' '),
      evidence: validateTextBlock(row.evidence, 1, 2000),
    });
  });

  for (const row of coverage) {
    for (const file of row.files ?? []) {
      if (isProtectedLocation(file) && !findings.some(f => f.file === file && f.tool === row.tool))
        throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    }
  }
  return {coverage, findings};
}

const GIT_ARCHIVE_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
  GIT_TERMINAL_PROMPT: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};

function extractGitArchive(repo: string, commit: string, destination: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const git = spawn('/usr/bin/git', ['--no-replace-objects', '-C', repo, '-c', 'core.hooksPath=/dev/null', 'archive', '--format=tar', commit], {
      env: GIT_ARCHIVE_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tar = spawn('/usr/bin/tar', ['-x', '-C', destination, '-f', '-'], {
      env: {PATH: '/usr/bin:/bin'},
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const stop = () => {
      git.kill('SIGKILL');
      tar.kill('SIGKILL');
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stop();
      reject(error);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise();
    };
    timer = setTimeout(() => fail(new Refusal('VERIFY_TOOLS_FAILED')), ARCHIVE_TIMEOUT_MS);
    git.stdout?.pipe(tar.stdin);
    git.once('error', () => fail(new Refusal('VERIFY_TOOLS_FAILED')));
    tar.once('error', () => fail(new Refusal('VERIFY_TOOLS_FAILED')));
    let gitCode: number | null = null;
    let tarCode: number | null = null;
    const maybe = () => {
      if (settled || gitCode === null || tarCode === null) return;
      if (gitCode === 0 && tarCode === 0) succeed();
      else fail(new Refusal('VERIFY_COMMIT_INVALID', 400));
    };
    git.once('close', code => { gitCode = code ?? 1; maybe(); });
    tar.once('close', code => { tarCode = code ?? 1; maybe(); });
  });
}

async function widenSnapshotForUnprivilegedContainer(dir: string): Promise<void> {
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await widenSnapshotForUnprivilegedContainer(full);
    } else if (info.isFile()) {
      const execBit = (info.mode & 0o100) !== 0 ? 0o755 : 0o644;
      await chmod(full, execBit);
    }
  }
}

/** Git archive snapshot of the examined commit, outside the live repository and readable by container uid 65532. */
export async function prepareModuleSnapshot(repoPath: string, commit: string): Promise<string> {
  if (typeof repoPath !== 'string' || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Refusal('VERIFY_COMMIT_INVALID', 400);
  }
  const repo = resolve(repoPath);
  const parent = await mkdtemp(join(tmpdir(), 'ac-module-snapshot-'));
  const snapshot = join(parent, 'repo');
  await mkdir(snapshot, {mode: 0o700});
  const rel = relative(repo, snapshot);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) {
    await rm(parent, {recursive: true, force: true});
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  try {
    await extractGitArchive(repo, commit, snapshot);
    await widenSnapshotForUnprivilegedContainer(snapshot);
    return snapshot;
  } catch (error) {
    await rm(parent, {recursive: true, force: true});
    throw error;
  }
}

/** Remove both the snapshot and its private parent. Accept only snapshots created here. */
export async function removeModuleSnapshot(snapshot: string): Promise<void> {
  const parent = dirname(snapshot);
  if (basename(snapshot) !== 'repo' || dirname(parent) !== tmpdir() || !basename(parent).startsWith('ac-module-snapshot-')) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  await rm(parent, {recursive: true, force: true});
}

function moduleImageMissing(diagnostic: string, image: string): boolean {
  const message = diagnostic.replace(/\r?\n$/, '').replace(/^docker: /, '');
  return message === 'Error response from daemon: No such image: ' + image || message === 'Error: No such image: ' + image;
}

async function confirmCollectorStarted(run: CollectorProcess, id: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!signal.aborted) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining < 1) break;
    const inspected = await run([MODULE_RUNTIME_BIN, 'container', 'inspect', '--format', '{{.Id}} {{.State.Status}}', id],
      {timeoutMs: remaining, maxStdoutBytes: 4096, signal});
    const state = inspected.stdout.toString('utf8').trim();
    if (inspected.code !== 0) break;
    if (state === `${id} running` || state === `${id} exited`) return;
    if (state !== `${id} created`) break;
    try {
      await delay(Math.min(50, remaining), undefined, {signal});
    } catch {
      break;
    }
  }
  throw new Refusal('VERIFY_TOOLS_FAILED', 503);
}

export async function runModuleCollectorContainer(input: {
  image: string;
  repoPath: string;
  commit: string;
  module?: VerificationModule;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  passiveTlsEvidence?: ProntidaoPassiveEvidence;
  signal?: AbortSignal;
  executeProcess?: CollectorProcess;
  journal: ReturnType<typeof moduleContainerJournal>;
}): Promise<{code: number; output: ModuleCollectorOutput}> {
  if (!input.journal) throw new Refusal('VERIFY_CONTAINER_JOURNAL_REQUIRED', 503);
  const timeoutMs = input.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
  const maxStdoutBytes = input.maxStdoutBytes ?? MAX_COLLECTOR_STDOUT_BYTES;
  const maxTransportBytes = maxStdoutBytes + COLLECTOR_HEADER_BYTES;
  const captureBytes = maxStdoutBytes + 4096;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxStdoutBytes)
    || maxStdoutBytes < 1 || !Number.isSafeInteger(captureBytes)) {
    throw new Refusal('VERIFY_LIMITS_INVALID', 400);
  }
  const snapshot = await prepareModuleSnapshot(input.repoPath, input.commit);
  let evidenceDir: string | undefined;
  let evidenceFile: string | undefined;
  try {
    if (input.passiveTlsEvidence !== undefined) {
      const validated = validatePassiveTlsEvidence(input.passiveTlsEvidence);
      evidenceDir = await mkdtemp(join(tmpdir(), 'ac-prontidao-evidence-'));
      evidenceFile = join(evidenceDir, 'evidence.json');
      await writeFile(evidenceFile, `${JSON.stringify(validated)}\n`, {encoding: 'utf8', mode: 0o644, flag: 'wx'});
      await chmod(evidenceFile, 0o644);
    }
    const token = randomUUID();
    const baseArgs = moduleCollectorArguments({
      image: input.image,
      repository: snapshot,
      ...(evidenceFile !== undefined ? {evidenceFile} : {}),
    });
    const run = input.executeProcess ?? runBoundedCollectorProcess;
    if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
    const daemonTimeout = Math.min(timeoutMs, COLLECTOR_DAEMON_TIMEOUT_MS);
    const daemonOptions = {timeoutMs: daemonTimeout, maxStdoutBytes: 4096};
    const imageCommand = await run([MODULE_RUNTIME_BIN, 'image', 'inspect', '--format',
      '[{{json .Config.Entrypoint}},{{json .Config.Cmd}}]', input.image],
      {timeoutMs: daemonTimeout, maxStdoutBytes: 1024 * 1024, signal: input.signal});
    if (imageCommand.code !== 0) {
      throw new Refusal(moduleImageMissing(imageCommand.stderr, input.image) ? 'VERIFY_MODULE_IMAGE_MISSING' : 'VERIFY_TOOLS_FAILED', 503);
    }
    const wrapper = assertHostPath(join(dirname(snapshot), 'collector-entrypoint'));
    await writeFile(wrapper, collectorOutputWrapper(imageCommand.stdout, token, maxStdoutBytes), {flag: 'wx', mode: 0o555});
    await chmod(wrapper, 0o555);
    // Journal the owner before create, and record the immutable ID before start.
    // Let create return its ID even when cancellation arrives during the call.
    // Drain the attached streams without persisting either one in the daemon.
    const createArgs = [MODULE_RUNTIME_BIN, 'create', '--pull', 'never', '--name', moduleContainerName(token),
      '--label', `${MODULE_CONTAINER_LABEL}=${token}`, '--log-driver', 'none',
      '--mount', `type=bind,src=${wrapper},dst=${COLLECTOR_WRAPPER_PATH},readonly`,
      '--tmpfs', `${COLLECTOR_CAPTURE_DIR}:rw,noexec,nosuid,nodev,uid=65532,gid=65532,mode=0700,size=${captureBytes}`,
      '--env', `AC_COLLECTOR_CAPTURE_DIR=${COLLECTOR_CAPTURE_DIR}`,
      '--entrypoint', '/bin/sh', ...baseArgs.slice(3), COLLECTOR_WRAPPER_PATH];
    if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
    const stream = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, stream.signal]) : stream.signal;
    let id: string | undefined;
    let creationRejected = true;
    let startAuthorized = false;
    try {
      await input.journal.register(token);
      creationRejected = false;
      const created = await run(createArgs, daemonOptions);
      if (created.code !== 0) {
        // A missing image with --pull never is a definitive daemon rejection.
        creationRejected = moduleImageMissing(created.stderr, input.image);
        throw new Refusal(creationRejected ? 'VERIFY_MODULE_IMAGE_MISSING' : 'VERIFY_TOOLS_FAILED', 503);
      }
      const candidate = createdContainerId(created.stdout);
      await assertOwnedModuleContainer(run, token, candidate);
      id = candidate;
      const {deadline, attached} = await input.journal.start(token, candidate, async () => {
        if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
        startAuthorized = true;
        const deadline = performance.now() + timeoutMs;
        // Docker attaches before sending start. Observe the start separately
        // so the authority lock covers the startup, not the whole collection.
        const attached = run([MODULE_RUNTIME_BIN, 'start', '--attach', candidate],
          {timeoutMs, maxStdoutBytes: maxTransportBytes, signal});
        const started = confirmCollectorStarted(run, candidate, daemonTimeout, signal);
        await Promise.race([started, attached.then(() => started)]);
        return {deadline, attached};
      });
      const remainingTime = () => {
        if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining < 1) throw new Refusal('VERIFY_TOOLS_FAILED', 503);
        return remaining;
      };
      const captured = await attached;
      // Inspect the final state of the exact container. The wait command
      // exposes only the status code and hides errors reported by the daemon.
      const terminalFormat = '{{.Id}} {{.State.Status}} {{.State.ExitCode}} ' +
        '{{if or .State.Running .State.Paused .State.Restarting .State.Dead .State.OOMKilled .State.Error}}invalid{{else}}ok{{end}}';
      const terminal = await run([MODULE_RUNTIME_BIN, 'inspect', '--type', 'container', '--format', terminalFormat, candidate],
        {timeoutMs: remainingTime(), maxStdoutBytes: 4096, signal});
      remainingTime();
      if (terminal.code !== 0 || !Number.isInteger(captured.code) || captured.code < 0 || captured.code > 255 ||
          terminal.stdout.toString('utf8').trim() !== candidate + ' exited ' + captured.code + ' ok') {
        throw new Refusal('VERIFY_TOOLS_FAILED', 503);
      }
      const frame = verifyCollectorOutput(captured.stdout, token, captured.code, maxStdoutBytes);
      const output = parseModuleCollectorOutput(frame.stdout, {maxStdoutBytes, module: input.module});
      return {code: frame.code, output};
    } finally {
      stream.abort();
      await input.journal.cleanup(token, id, {creationRejected, startAuthorized});
    }
  } finally {
    try {
      if (evidenceDir) await rm(evidenceDir, {recursive: true, force: true});
    } finally {
      await removeModuleSnapshot(snapshot);
    }
  }
}

type ModuleReviewPromptInput = {
  module: VerificationModule;
  achadoId?: string;
  tool: string;
  rule: string;
  file: string;
  line: number;
  evidence: string;
  codeExcerpt: string;
  [key: string]: unknown;
};

function moduleReviewPromptEvidence(input: ModuleReviewPromptInput) {
  assertVerificationModule(input.module);
  const file = assertModuleRepoRelativePath(input.file);
  if (!Number.isInteger(input.line) || input.line < 1) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const tool = validateSingleLineString(input.tool, 1, 120, false);
  const rule = validateSingleLineString(input.rule, 1, 200, true);
  const evidence = validateTextBlock(input.evidence, 1, 2000);
  const code = sanitizeText(input.codeExcerpt).trim().slice(0, EXCERPT_LIMIT / 2);
  return {module: input.module, tool, rule, file, line: input.line, evidence, code, hypothesis: moduleCollectorHypothesis(rule)};
}

/** The request is assembled from source evidence and omits author conclusions. */
export function buildModuleReviewPrompt(input: ModuleReviewPromptInput): string {
  return moduleReviewTask(moduleReviewPromptEvidence(input));
}

function assertNoLiveAccessKey(value: unknown): void {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (hasKnownSecret(current)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (hasKnownSecret(key)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
      pending.push(item);
    }
  }
}

function guardReportText(text: string): string {
  if (hasKnownSecret(text)) throw new Refusal('VERIFY_SECRET_IN_REPORT', 400);
  return text;
}

function stampOf(createdAt: Date): string {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const pad = (value: number, width = 2) => value.toString().padStart(width, '0');
  return `${pad(createdAt.getUTCFullYear(), 4)}${pad(createdAt.getUTCMonth() + 1)}${pad(createdAt.getUTCDate())}-${pad(createdAt.getUTCHours())}${pad(createdAt.getUTCMinutes())}${pad(createdAt.getUTCSeconds())}`;
}

function reportSuffix(runId: string): string {
  if (Id.safeParse(runId).success) return runId.replaceAll('-', '').toLowerCase();
  return randomBytes(4).toString('hex');
}

export function moduleReportDirectoryName(createdAt: Date, runId: string, module: VerificationModule): string {
  assertVerificationModule(module);
  return `${stampOf(createdAt)}-${reportSuffix(runId)}-${module}`;
}

function failureCounts(achados: readonly Achado[]): ModuleReportSummary['counts'] {
  const counts = {alta: 0, media: 0, baixa: 0, informativa: 0};
  for (const achado of achados) {
    if (achado.status === 'confirmado' || achado.status === 'reaberto') counts[achado.severity] += 1;
  }
  return counts;
}

function pt(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function failureNote(counts: ModuleReportSummary['counts'], toolFailures: number): string {
  if (toolFailures > 0) return `Nota de falha: execução com ${pt(toolFailures, 'falha de ferramenta', 'falhas de ferramentas')} na cobertura.`;
  if (counts.alta > 0) return 'Nota de falha: reprovado por achado confirmado ou reaberto de gravidade alta.';
  if (counts.media > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade média.';
  if (counts.baixa > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade baixa.';
  if (counts.informativa > 0) return 'Nota de falha: ressalva por achado confirmado ou reaberto de gravidade informativa.';
  return 'Nota de falha: sem falha confirmada ou reaberta.';
}

const SEVERITY_LABEL: Record<Achado['severity'], string> = {
  alta: 'alta',
  media: 'média',
  baixa: 'baixa',
  informativa: 'informativa',
};

const STATUS_LABEL: Record<Achado['status'], string> = {
  confirmado: 'confirmado',
  provavel: 'provável',
  descartado: 'descartado',
  fechado: 'fechado',
  reaberto: 'reaberto',
};

function achadoMarkdown(achado: Achado): string {
  const where = achado.where.line === null ? achado.where.file : `${achado.where.file}:${achado.where.line}`;
  const situacao = achado.verifier
    ? `${STATUS_LABEL[achado.status]} (verificador: ${achado.verifier.model}, ${achado.verifier.provider})`
    : STATUS_LABEL[achado.status];
  return [
    `# ${achado.id}: ${achado.title}`,
    `- Gravidade: ${SEVERITY_LABEL[achado.severity]}`,
    `- Situação: ${situacao}`,
    `- Referência: ${achado.reference}`,
    `- Onde: ${where}`,
    `- Cenário: ${achado.scenario}`,
    `- Prova: ${achado.proof}`,
    `- Correção sugerida: ${achado.suggestion}`,
    `- Critério de aceite: ${achado.acceptance}`,
    `- Fontes: ${achado.sources.join(', ')}`,
    '',
  ].join('\n');
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

export function renderModuleCoverageMarkdown(
  toolCoverage: readonly ModuleToolCoverage[],
  fileCoverage: readonly CoverageRow[],
): string {
  return [
    '# Cobertura',
    '',
    '## Cobertura das ferramentas',
    '',
    '| Ferramenta | Versão | Situação | Detalhe |',
    '|---|---|---|---|',
    ...toolCoverage.map(row => `| ${tableCell(row.tool)} | ${tableCell(row.version)} | ${tableCell(row.status)} | ${tableCell(row.detail)} |`),
    '',
    '## Cobertura de arquivos',
    '',
    '| Arquivo | Examinador (provedor/modelo) | Itens da lista |',
    '|---|---|---|',
    ...fileCoverage.map(row => `| ${tableCell(row.file)} | ${tableCell(`${row.examinerProvider}/${row.examinerModel}`)} | ${tableCell(row.checklist.join(', '))} |`),
    '',
  ].join('\n');
}

function renderModuleReadme(input: {
  module: VerificationModule;
  runId: string;
  directoryName: string;
  createdAt: Date;
  commit: string;
  note: string;
  total: number;
  counts: ModuleReportSummary['counts'];
  discarded: number;
  toolCoverage: readonly ModuleToolCoverage[];
}): string {
  const title = MODULE_TITLES[input.module];
  const failing = input.counts.alta + input.counts.media + input.counts.baixa + input.counts.informativa;
  const failedTools = input.toolCoverage.filter(row => row.status === 'failed');
  const skippedTools = input.toolCoverage.filter(row => row.status === 'skipped');
  const unverifiedLines = [
    ...failedTools.map(row => `- ${row.tool} (${row.version}) [failed]: ${row.detail}`),
    ...skippedTools.map(row => `- ${row.tool} (${row.version}) [skipped]: ${row.detail}`),
  ];
  return [
    `# Relatório de verificação — ${title} (${input.module})`,
    '',
    '## Resumo',
    '',
    `Execução \`${input.runId}\`, módulo \`${input.module}\`, diretório \`${input.directoryName}\`, commit \`${input.commit}\`, gerado em ${input.createdAt.toISOString()}.`,
    `Há ${pt(input.total, 'achado', 'achados')} no relatório. A nota de falha considera ${pt(failing, 'achado', 'achados')} com situação confirmado ou reaberto.`,
    '',
    '## Nota geral',
    '',
    input.note,
    '',
    '## Contagem por gravidade',
    '',
    '| Gravidade | Quantidade |',
    '|---|---|',
    `| alta | ${input.counts.alta} |`,
    `| média | ${input.counts.media} |`,
    `| baixa | ${input.counts.baixa} |`,
    `| informativa | ${input.counts.informativa} |`,
    '',
    '## Nota de falha',
    '',
    failureNote(input.counts, failedTools.length),
    '',
    '## Cobertura das ferramentas',
    '',
    '| Ferramenta | Versão | Situação | Detalhe |',
    '|---|---|---|---|',
    ...input.toolCoverage.map(row => `| ${tableCell(row.tool)} | ${tableCell(row.version)} | ${tableCell(row.status)} | ${tableCell(row.detail)} |`),
    '',
    '## Falhas de ferramentas',
    '',
    ...(failedTools.length > 0
      ? failedTools.map(row => `- ${row.tool} (${row.version}): ${row.detail}`)
      : ['Nenhuma falha de ferramenta registrada.']),
    '',
    '## O que não foi possível verificar',
    '',
    ...(unverifiedLines.length > 0 ? unverifiedLines : [input.note]),
    '',
  ].join('\n');
}

function renderModuleMapMarkdown(
  module: VerificationModule,
  files: readonly string[],
  toolCoverage: readonly ModuleToolCoverage[],
): string {
  const tools = [...new Set(toolCoverage.map(item => `${item.tool}@${item.version}`))];
  return [
    `# Mapa — ${MODULE_TITLES[module]} (${module})`,
    '',
    '## Ferramentas executadas',
    ...(tools.length > 0 ? tools.map(item => `- ${item}`) : ['- nenhuma']),
    '',
    '## Arquivos examinados',
    ...(files.length > 0 ? files.map(item => `- ${item}`) : ['- nenhum']),
    '',
  ].join('\n');
}

async function requireDataDirectory(dataDirectory: string): Promise<string> {
  try {
    const info = await lstat(dataDirectory);
    if (!info.isDirectory() && !info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    const real = await realpath(dataDirectory);
    const realInfo = await lstat(real);
    if (!realInfo.isDirectory() || realInfo.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    return real;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) {
      throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    }
    throw error;
  }
}

async function ensureDir(parentReal: string, name: string): Promise<string> {
  assertSafeSegment(name);
  const path = join(parentReal, name);
  assertInside(parentReal, path);
  try {
    await mkdir(path, {mode: 0o700});
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(path);
  if (real !== path) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(parentReal, real);
  await chmod(path, 0o700);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o777) !== 0o700) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  return path;
}

async function createReportDir(parentReal: string, name: string): Promise<string> {
  assertSafeSegment(name);
  const path = join(parentReal, name);
  assertInside(parentReal, path);
  try {
    await mkdir(path, {mode: 0o700});
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw new Refusal('VERIFY_REPORT_EXISTS', 409);
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(path);
  if (real !== path) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(parentReal, real);
  await chmod(path, 0o700);
  return path;
}

async function writePrivate(path: string, root: string, content: string): Promise<void> {
  const lexical = resolve(path);
  assertInside(root, lexical);
  const parent = dirname(lexical);
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || await realpath(parent) !== parent)
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const handle = await open(lexical, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, {encoding: 'utf8'});
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
}

async function syncReportDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeModuleReport(input: {
  dataDirectory: string;
  projectId: string;
  module: VerificationModule;
  runId: string;
  createdAt: Date;
  commit: string;
  image?: string;
  deferPublication?: boolean;
  toolCoverage: readonly ModuleToolCoverage[];
  fileCoverage: readonly CoverageRow[];
  achados: readonly Achado[];
  raw: ModuleCollectorOutput;
  measuredFiles?: ReadonlyMap<string, readonly ModuleToolCoverage[]>;
  exam?: Pick<ModuleExamResult, 'mode' | 'coverage' | 'routes' | 'notes'> & {findings?: ModuleExamResult['findings']};
  note?: string;
  directoryName?: string;
}): Promise<{directory: string; directoryName: string; summary: ModuleReportSummary; examOriginSha256?: string}> {
  assertVerificationModule(input.module);
  assertSafeSegment(input.projectId);
  assertSafeSegment(input.runId);
  if (!/^[a-f0-9]{40}$/.test(input.commit)) throw new Refusal('VERIFY_COMMIT_INVALID', 400);
  const sourceCoverage = input.toolCoverage.map(row => ModuleToolCoverage.parse(row));
  const doc = input.module === 'documentacao' ? documentationCoverage(sourceCoverage) : undefined;
  if (!doc && sourceCoverage.some(row => row.tool.endsWith(':artefato'))) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const toolCoverage = doc?.coverage ?? sourceCoverage;
  if (toolCoverage.length < 1) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const fileCoverage = input.fileCoverage.map(row => CoverageRow.parse(row));
  const ids = new Set<string>();
  const achados = input.achados.map(item => {
    const parsed = Achado.safeParse(item);
    if (!parsed.success || ids.has(parsed.data.id)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    ids.add(parsed.data.id);
    return parsed.data;
  });
  assertNoLiveAccessKey(input.raw);
  const raw = validateModuleCollectorObject(input.raw, input.module);
  if (JSON.stringify(raw.coverage) !== JSON.stringify(sourceCoverage)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  for (const row of fileCoverage) {
    if (input.module === 'prontidao' && isProtectedLocation(row.file)) {
      if (!raw.findings.some(finding => finding.file === row.file)) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    } else assertModuleRepoRelativePath(row.file);
  }
  for (const achado of achados) {
    if (!isProtectedLocation(achado.where.file)) {
      assertModuleRepoRelativePath(achado.where.file);
      continue;
    }
    const finding = raw.findings[Number(achado.id.slice(4)) - 1];
    if (input.module !== 'prontidao' || !finding || finding.file !== achado.where.file
      || finding.line !== achado.where.line || achado.scenario !== finding.message
      || achado.proof !== finding.evidence || achado.sources[0] !== finding.tool || achado.sources[1] !== finding.rule)
      throw new Refusal('VERIFY_REPORT_INVALID', 400);
  }
  const safeRaw = {...raw, coverage: toolCoverage};
  assertNoLiveAccessKey(safeRaw);
  assertNoLiveAccessKey(achados);
  const rawBody = guardReportText(`${JSON.stringify(safeRaw, null, 2)}\n`);
  const reserved = typeof input.directoryName === 'string';
  const directoryName = reserved
    ? input.directoryName!
    : moduleReportDirectoryName(input.createdAt, input.runId, input.module);
  const counts = failureCounts(achados);
  const toolFailures = toolCoverage.filter(row => row.status === 'failed').length;
  const defaultNote = toolFailures > 0
    ? `Módulo ${input.module} concluído com ${pt(toolFailures, 'falha de ferramenta', 'falhas de ferramentas')} registrada na cobertura.`
    : `Verificação do módulo ${input.module} concluída.`;
  const note = sanitizeText(input.note ?? defaultNote).slice(0, 500);
  const summaryParsed = ModuleReportSummary.safeParse({
    id: input.runId,
    module: input.module,
    directoryName,
    commit: input.commit,
    ...(input.image ? {image: assertPinnedModuleImage(input.image)} : {}),
    createdAt: input.createdAt.toISOString(),
    counts,
    toolFailures,
    note,
  });
  if (!summaryParsed.success) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const summary = summaryParsed.data;
  const discarded = achados.filter(item => item.status === 'descartado').length;
  let mapMarkdown = renderModuleMapMarkdown(input.module, fileCoverage.map(row => row.file), toolCoverage);
  let coverageBody = renderModuleCoverageMarkdown(toolCoverage, fileCoverage);
  const cell = (value: string) => sanitizeText(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replace(/[\r\n]+/g, ' ');
  if (input.measuredFiles?.size) {
    const measurements = [...input.measuredFiles].map(([file, rows]) =>
      `| ${cell(file)} | ${[...new Set(rows.map(row => cell(row.tool) + '@' + cell(row.version)))].join(', ')} |`);
    coverageBody += ['', '## Medições do coletor por arquivo', '', '| Arquivo | Ferramentas |', '|---|---|', ...measurements, ''].join('\n');
  }
  if (input.exam) {
    const files = input.exam.coverage.map(row =>
      `| ${cell(row.file)} | ${cell(row.status)} | ${cell(row.reason ?? row.examiner?.model ?? '')} |`);
    const routes = input.exam.routes.map(row =>
      `| ${cell(row.method)} | ${cell(row.path)} | ${cell(row.file)}#${row.line} | ${cell(row.status)} |`);
    mapMarkdown += ['','## Inventário de arquivos','','| Arquivo | Exame | Motivo ou modelo |','|---|---|---|', ...files,
      '', '## Rotas identificadas', '', '| Método | Rota | Origem | Exame |', '|---|---|---|---|', ...routes, ''].join('\n');
    coverageBody += ['', '## Exame independente', '', `Modo: ${cell(input.exam.mode)}`, '',
      '| Arquivo | Estado | Motivo ou modelo |','|---|---|---|', ...files, '', ...input.exam.notes.map(n => `- ${cell(n)}`), ''].join('\n');
  }
  const examOrigin = input.exam ? guardReportText(JSON.stringify(
      achados.flatMap((item, index) => {
        if (item.sources[0] !== 'examinador' || item.sources[1] !== 'exame-de-arquivo') return [];
        const hypothesis = input.exam?.findings?.[index]?.hypothesis;
        return [{id: item.id, file: item.where.file, line: item.where.line, evidence: item.scenario,
          ...(hypothesis ? {hypothesis: sanitizeText(hypothesis)} : {})}];
      }),
    )) : undefined;
  const planned: {segments: string[]; body: string}[] = [
    {
      segments: ['README.md'],
      body: guardReportText(renderModuleReadme({
        module: input.module,
        runId: summary.id,
        directoryName,
        createdAt: input.createdAt,
        commit: input.commit,
        note,
        total: achados.length,
        counts,
        discarded,
        toolCoverage,
      })),
    },
    {segments: ['mapa.md'], body: guardReportText(mapMarkdown)},
    {segments: ['cobertura.md'], body: guardReportText(coverageBody)},
    {segments: ['achados.json'], body: guardReportText(`${JSON.stringify({achados}, null, 2)}\n`)},
    ...achados.map(achado => ({segments: ['achados', `${achado.id}.md`], body: guardReportText(achadoMarkdown(achado))})),
    {segments: ['bruto', 'achados-brutos.json'], body: rawBody},
    ...(examOrigin !== undefined ? [{segments: ['bruto', 'exame.json'], body: examOrigin}] : []),
    ...Object.entries(doc?.artifacts ?? {}).flatMap(([name, artifact]) => artifact.status === 'present'
      ? [{segments: [name], body: guardReportText(artifact.content)}] : []),
    {segments: [input.deferPublication ? '.run-pending.json' : 'run.json'], body: guardReportText(`${JSON.stringify(summary, null, 2)}\n`)},
  ];
  for (const file of planned) {
    for (const segment of file.segments) assertSafeSegment(segment);
    if (file.segments[0] === 'achados' && file.segments.length === 2 && !ACHADO_FILE.test(file.segments[1]!)) {
      throw new Refusal('VERIFY_REPORT_INVALID', 400);
    }
  }
  const dataReal = await requireDataDirectory(input.dataDirectory);
  const root = await ensureDir(dataReal, 'verificacoes');
  const project = await ensureDir(root, input.projectId);
  const directory = reserved ? await ensureDir(project, directoryName) : await createReportDir(project, directoryName);
  const findingsDirectory = await ensureDir(directory, 'achados');
  const rawDirectory = await ensureDir(directory, 'bruto');
  for (const file of planned) {
    const path = file.segments.reduce((parent, segment) => {
      const next = join(parent, segment);
      assertInside(directory, next);
      return next;
    }, directory);
    await writePrivate(path, directory, file.body);
  }
  await Promise.all([syncReportDirectory(findingsDirectory), syncReportDirectory(rawDirectory)]);
  for (const ancestor of [directory, project, root, dataReal]) await syncReportDirectory(ancestor);
  return {directory, directoryName, summary,
    ...(examOrigin !== undefined ? {examOriginSha256: createHash('sha256').update(examOrigin).digest('hex')} : {})};
}

async function resolveProjectVerificationsDir(dataDirectory: string, projectId: string): Promise<string | null> {
  assertSafeSegment(projectId);
  let dataReal: string;
  try {
    dataReal = await realpath(dataDirectory);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw error;
  }
  const root = join(dataReal, 'verificacoes');
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const project = join(root, projectId);
  assertInside(root, project);
  let info;
  try {
    info = await lstat(project);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(project);
  if (real !== project) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
  return real;
}

async function readTextInside(root: string, path: string, missingCode: 'VERIFY_ACHADO_NOT_FOUND' | 'VERIFY_REPORT_INVALID', expectedSha256?: string): Promise<string> {
  const lexical = resolve(path);
  assertInside(root, lexical);
  let info;
  try {
    info = await lstat(lexical);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Refusal(missingCode, missingCode === 'VERIFY_ACHADO_NOT_FOUND' ? 404 : 400);
    if (isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR')) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isDirectory() && await realpath(lexical) === lexical) throw new Refusal(missingCode, missingCode === 'VERIFY_ACHADO_NOT_FOUND' ? 404 : 400);
  if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!expectedSha256) return await handle.readFile('utf8');
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new Refusal('VERIFY_REPORT_INVALID', 400);
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}

function requiredModuleArtifacts(coverage: readonly ModuleToolCoverage[]): string[] {
  const published = new Set(coverage.filter(row => row.status === 'ok').map(row => row.tool));
  const names: string[] = [];
  if (published.has('typedoc:artefato')) names.push('api.json');
  if (published.has('dependency-cruiser:artefato')) names.push('dependencias.mmd');
  return names;
}

async function loadModuleReports(
  projectDir: string,
  module?: VerificationModule,
): Promise<{directory: string; summary: ModuleReportSummary}[]> {
  if (module !== undefined) assertVerificationModule(module);
  const found: {directory: string; summary: ModuleReportSummary}[] = [];
  for (const entry of await readdir(projectDir, {withFileTypes: true})) {
    const name = entry.name;
    if (!MODULE_REPORT_DIR.test(name)) continue;
    if (module !== undefined && !name.endsWith(`-${module}`)) continue;
    const path = join(projectDir, name);
    if (entry.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    if (!entry.isDirectory() || !await reportDirectoryExists(path)) continue;
    try {
      const text = await readTextInside(projectDir, join(path, 'run.json'), 'VERIFY_REPORT_INVALID');
      const parsed = ModuleReportSummary.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.directoryName !== name) continue;
      if (module !== undefined && parsed.data.module !== module) continue;
      const rawText = await readTextInside(path, join(path, 'bruto', 'achados-brutos.json'), 'VERIFY_REPORT_INVALID');
      const raw = validateModuleCollectorObject(JSON.parse(rawText), parsed.data.module);
      const findingsText = await readTextInside(path, join(path, 'achados.json'), 'VERIFY_REPORT_INVALID');
      const findings = z.object({achados: z.array(Achado).max(999)}).parse(JSON.parse(findingsText));
      const required = ['README.md', 'mapa.md', 'cobertura.md', ...requiredModuleArtifacts(raw.coverage),
        ...findings.achados.map(item => join('achados', item.id + '.md'))];
      for (const file of required) {
        const fullPath = join(path, file);
        const info = await lstat(fullPath);
        if (info.isSymbolicLink() || await realpath(fullPath) !== fullPath) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
        if (!info.isFile()) throw new Refusal('VERIFY_REPORT_INVALID', 400);
      }
      found.push({directory: path, summary: parsed.data});
    } catch (error) {
      if (error instanceof Refusal && error.code === 'VERIFY_PATH_FORBIDDEN') throw error;
    }
  }
  found.sort((a, b) => a.summary.directoryName.localeCompare(b.summary.directoryName) || a.summary.id.localeCompare(b.summary.id));
  return found;
}

export async function listModuleReports(
  dataDirectory: string,
  projectId: string,
  module?: VerificationModule,
): Promise<ModuleReportSummary[]> {
  const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
  if (!projectDir) return [];
  return (await loadModuleReports(projectDir, module)).map(item => item.summary);
}

export async function readModuleReport(
  dataDirectory: string,
  projectId: string,
  runId: string,
  module?: VerificationModule,
): Promise<{
  summary: ModuleReportSummary;
  achados: Achado[];
  coverageMarkdown: string;
  mapMarkdown: string;
  readmeMarkdown: string;
  toolCoverage: ModuleToolCoverage[];
}> {
  assertSafeSegment(projectId);
  assertSafeSegment(runId);
  const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
  if (!projectDir) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  const matches = (await loadModuleReports(projectDir, module)).filter(item => item.summary.id === runId);
  if (matches.length === 0) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  if (matches.length > 1) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const report = matches[0]!;
  const achadosRaw = JSON.parse(await readTextInside(report.directory, join(report.directory, 'achados.json'), 'VERIFY_REPORT_INVALID')) as {achados?: unknown};
  if (!achadosRaw || typeof achadosRaw !== 'object' || !Array.isArray(achadosRaw.achados)) {
    throw new Refusal('VERIFY_REPORT_INVALID', 400);
  }
  const achados = achadosRaw.achados.map(item => Achado.parse(item));
  const coverageMarkdown = await readTextInside(report.directory, join(report.directory, 'cobertura.md'), 'VERIFY_REPORT_INVALID');
  const mapMarkdown = await readTextInside(report.directory, join(report.directory, 'mapa.md'), 'VERIFY_REPORT_INVALID');
  const readmeMarkdown = await readTextInside(report.directory, join(report.directory, 'README.md'), 'VERIFY_REPORT_INVALID');
  const rawJson = JSON.parse(await readTextInside(report.directory, join(report.directory, 'bruto', 'achados-brutos.json'), 'VERIFY_REPORT_INVALID')) as unknown;
  const raw = validateModuleCollectorObject(rawJson, report.summary.module);
  return {summary: report.summary, achados, coverageMarkdown, mapMarkdown, readmeMarkdown, toolCoverage: raw.coverage};
}

export async function readModuleAchadoMarkdown(
  dataDirectory: string,
  projectId: string,
  runId: string,
  achadoId: string,
  module?: VerificationModule,
): Promise<string> {
  assertSafeSegment(achadoId);
  if (!ACHADO_ID.safeParse(achadoId).success) throw new Refusal('VERIFY_ACHADO_NOT_FOUND', 404);
  const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
  if (!projectDir) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  const matches = (await loadModuleReports(projectDir, module)).filter(item => item.summary.id === runId);
  if (matches.length !== 1) throw new Refusal('VERIFY_REPORT_NOT_FOUND', 404);
  return readTextInside(matches[0]!.directory, join(matches[0]!.directory, 'achados', `${achadoId}.md`), 'VERIFY_ACHADO_NOT_FOUND');
}

async function assertReportOutsideRepo(repoPath: string, dataDirectory: string): Promise<void> {
  const repo = await realpath(repoPath);
  const data = await realpath(dataDirectory);
  const rel = relative(repo, data);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (rel === '' || !outside) throw new Refusal('VERIFY_REPORT_INSIDE_REPO', 403);
}

function escapesRepo(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === '';
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
  const real = await realpath(current);
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

async function readBoundedExcerpt(repo: string, relativeFile: string, line: number): Promise<string> {
  const located = await locateRepoFile(repo, relativeFile);
  if (!located || isSecretClassBasename(relativeFile) || isProtectedLocation(relativeFile)) return '';
  const handle = await open(located, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.size > 1024 * 1024) return '';
    const lines = (await handle.readFile({encoding: 'utf8'})).split('\n');
    const target = lines[line - 1];
    if (target === undefined || target.length > EXCERPT_LIMIT / 2 || MULTILINE_CONTROL_CHAR.test(target)) return '';
    const selected = sanitizeText(target).trim();
    return selected === target.trim() && /[\p{L}\p{N}]/u.test(selected) ? selected : '';
  } finally {
    await handle.close();
  }
}

async function confirmFindingWithReviewer(
  input: VerificationModuleRunInput,
  intentId: string,
  finding: ModuleRawFinding,
): Promise<{status: 'confirmado' | 'provavel' | 'descartado'; title?: string; proof: string; verifier: Achado['verifier']}> {
  const pending = {status: 'provavel' as const, proof: sanitizeText(finding.evidence), verifier: null};
  const excerpt = await readBoundedExcerpt(input.repoPath, finding.file, finding.line);
  if (!excerpt) return pending;
  const evidence = moduleReviewPromptEvidence({...finding, module: input.module, codeExcerpt: excerpt});
  const capacity = new Capacity(input.ledger);
  let seat;
  try {
    seat = await reserveSpecialistExamSeat({
      capacity,
      ledger: input.ledger,
      principal: input.principal,
      authority: input.authority,
      intentId,
      purpose: 'reviewer',
      releaseGrant: grantId => capacity.transition(input.principal, grantId, input.authority, 'released', {processId: 'module-confirm', state: 'not_started'}),
    });
  } catch (error) {
    if (error instanceof Refusal && ['CAPACITY_NOT_CONFIGURED', 'CAPACITY_POLICY_REQUIRED', 'DESIGN_REVIEWER_UNAVAILABLE',
      'NO_ELIGIBLE_CAPACITY', 'ROLE_NOT_CONFIGURED', 'PROVIDER_USAGE_LIMIT'].includes(error.code)) return pending;
    throw error;
  }
  try {
    const call = VerifyWorkerCall.parse({
      role: 'reviewer',
      provider: seat.provider,
      accountId: seat.accountId,
      profileId: seat.profileId,
      model: seat.model,
      grantId: seat.grantId,
      intentId,
      task: moduleReviewTask(evidence),
      repo: input.repoPath,
      writePaths: [],
    });
    const output = await input.worker!.run(call);
    const confirm = parseModuleReviewOutput(output);
    if (!confirm || confirm.status === 'provavel' || !hasModuleReviewProof(evidence, confirm)) return pending;
    return {
      status: confirm.status,
      title: confirm.status === 'confirmado' ? moduleReviewObservationTitle(confirm.observation) : undefined,
      proof: localizedProof(evidence.code, confirm.reason),
      verifier: {model: call.model, provider: call.provider},
    };
  } finally {
    await capacity.transition(input.principal, seat.grantId, input.authority, 'released', {processId: 'module-confirm', state: 'not_started'}).catch(() => undefined);
  }
}

function localizedProof(code: string, reason: string): string {
  return sanitizeText(`${code}\n${reason}`).slice(0, 2000).trim();
}

async function beginModuleRunTx(input: {
  ledger: Ledger;
  principal: string;
  authority: Authority;
  projectId: string;
  module: VerificationModule;
  commit: string;
  runId: string;
  repoPath: string;
  preparedDir: string;
}): Promise<string> {
  const intentId = randomUUID();
  await input.ledger.tx(async c => {
    const context = await input.ledger.authorize(c, input.principal, input.authority.contextId);
    await input.ledger.fence(c, input.authority);
    if (context.project_id !== input.projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    const repoRow = (await c.query<{repo: string}>(
      'SELECT repo FROM ac_project_repositories WHERE project_id=$1 FOR SHARE', [input.projectId],
    )).rows[0];
    if (!repoRow || await realpath(repoRow.repo) !== await realpath(input.repoPath)) {
      throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    }
    const examBinding = await c.query<{module: string}>(
      'SELECT module FROM ac_exam_contexts WHERE project_id=$1 AND context_id=$2',
      [input.projectId, input.authority.contextId],
    );
    if (!examBinding.rowCount || examBinding.rows[0]?.module !== input.module) {
      throw new Refusal('EXAM_CONTEXT_MISMATCH', 403);
    }
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.projectId, input.module]);
    const alreadyRunning = await c.query(
      "SELECT 1 FROM ac_verify_runs WHERE project_id=$1 AND module=$2 AND status='running' LIMIT 1",
      [input.projectId, input.module],
    );
    if (alreadyRunning.rowCount) throw new Refusal('VERIFY_ALREADY_RUNNING', 409);
    const command = {
      schemaVersion: 1 as const,
      intentId,
      deliveryAttemptId: randomUUID(),
      contextId: input.authority.contextId,
      policyRevision: Number(context.policy_revision),
      action: 'plan.start' as const,
      payload: {
        workflow: 'security-verify-readonly-v1' as const,
        messageRef: `${input.module}:${input.projectId}:${input.commit}`.slice(0, 200),
        projectId: input.projectId,
        commit: input.commit,
      },
    };
    await c.query(
      `INSERT INTO ac_intents (id, context_id, principal_id, digest, command, operation_id, run_id, manager_epoch, plan_revision)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [
        intentId,
        input.authority.contextId,
        input.principal,
        digest(command),
        JSON.stringify(command),
        randomUUID(),
        randomUUID(),
        input.authority.epoch,
        Number(context.plan_revision),
      ],
    );
    await c.query(
      `INSERT INTO ac_verify_runs (id, project_id, context_id, intent_id, principal_id, commit_id, status, report_dir, module, report_prepared_dir)
       VALUES ($1,$2,$3,$4,$5,$6,'running','pending',$7,$8)`,
      [input.runId, input.projectId, input.authority.contextId, intentId, input.principal, input.commit, input.module, input.preparedDir],
    );
  });
  return intentId;
}

/**
 * Full execution path for verification modules 2 to 9 (`qa`, `arquitetura`, `dependencias`,
 * `banco`, `prontidao`, `desempenho`, `documentacao`, `conformidade`).
 */
export async function runVerificationModule(input: VerificationModuleRunInput): Promise<VerificationModuleRunResult> {
  assertVerificationModule(input.module);
  if (!Id.safeParse(input.projectId).success) throw new Refusal('NOT_FOUND', 404);
  if (typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)) {
    throw new Refusal('VERIFY_COMMIT_INVALID', 400);
  }
  await assertPersonalActivation(input.ledger);
  await assertReportOutsideRepo(input.repoPath, input.dataDirectory);
  const execute = input.executeCollectorProcess ?? runBoundedCollectorProcess;
  await recoverModuleContainers(input.ledger, input.principal, input.authority, input.projectId, execute, input.module);
  await reconcileReports(input.ledger, input.principal, input.authority, input.dataDirectory, input.projectId);
  const parsedRunId = Id.safeParse(input.runId ?? randomUUID());
  if (!parsedRunId.success) throw new Refusal('INVALID_CONTRACT', 400);
  const runId = parsedRunId.data.toLowerCase();
  const createdAt = input.createdAt ?? new Date();
  const preparedDir = join(await requireDataDirectory(input.dataDirectory), 'verificacoes', input.projectId,
    moduleReportDirectoryName(createdAt, runId, input.module));
  const timeoutMs = input.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
  const maxStdoutBytes = input.maxStdoutBytes ?? MAX_COLLECTOR_STDOUT_BYTES;
  const needImage = input.collectorOutput === undefined && input.runCollector === undefined;
  const image = input.image !== undefined
    ? assertPinnedModuleImage(input.image)
    : needImage
      ? await readPinnedModuleImage(input.module, input.rootDir)
      : undefined;

  const intentId = await beginModuleRunTx({
    ledger: input.ledger,
    principal: input.principal,
    authority: input.authority,
    projectId: input.projectId,
    module: input.module,
    commit: input.commit,
    runId,
    repoPath: input.repoPath,
    preparedDir,
  });

  let snapshot: string | undefined;
  let sourceCoverage: ModuleToolCoverage[] | undefined;
  try {
    if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
    snapshot = await prepareModuleSnapshot(input.repoPath, input.commit);
    const passiveTlsEvidence = input.passiveTlsEvidence !== undefined
      ? (() => {
          if (input.module !== 'prontidao') throw new Refusal('INVALID_CONTRACT', 400);
          return validatePassiveTlsEvidence(input.passiveTlsEvidence);
        })()
      : undefined;
    let collectorCode = 0;
    let collectorData: ModuleCollectorOutput;
    try {
    if (input.collectorOutput !== undefined) {
      collectorData = typeof input.collectorOutput === 'string' || Buffer.isBuffer(input.collectorOutput)
        ? parseModuleCollectorOutput(input.collectorOutput, {maxStdoutBytes, module: input.module})
        : validateModuleCollectorObject(input.collectorOutput, input.module);
    } else if (input.runCollector !== undefined) {
      const raw = await input.runCollector({
        module: input.module,
        image,
        repoPath: input.repoPath,
        commit: input.commit,
        timeoutMs,
        maxStdoutBytes,
        signal: input.signal,
        ...(passiveTlsEvidence !== undefined ? {passiveTlsEvidence} : {}),
      });
      collectorData = typeof raw === 'string' || Buffer.isBuffer(raw)
        ? parseModuleCollectorOutput(raw, {maxStdoutBytes, module: input.module})
        : validateModuleCollectorObject(raw, input.module);
    } else {
      const executed = await runModuleCollectorContainer({
        image: image!,
        module: input.module,
        repoPath: input.repoPath,
        commit: input.commit,
        timeoutMs,
        maxStdoutBytes,
        signal: input.signal,
        executeProcess: execute,
        journal: moduleContainerJournal(input.ledger, input.principal, input.authority, runId, execute),
        ...(passiveTlsEvidence !== undefined ? {passiveTlsEvidence} : {}),
      });
      collectorCode = executed.code;
      collectorData = executed.output;
    }
    if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
    if (input.module === 'documentacao') {
      sourceCoverage = collectorData.coverage;
      collectorData = {...collectorData, coverage: documentationCoverage(sourceCoverage).coverage};
    } else if (collectorData.coverage.some(row => row.tool.endsWith(':artefato'))) {
      throw new Refusal('VERIFY_REPORT_INVALID', 400);
    }
    assertNoLiveAccessKey(collectorData);
    for (const finding of collectorData.findings) {
      await resolveInsideRepo(snapshot, finding.file);
      if (!collectorData.coverage.some(row => row.tool === finding.tool && row.status === 'ok')) {
        throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
      }
    }
    for (const row of collectorData.coverage) {
      for (const file of row.files ?? []) await resolveInsideRepo(snapshot, file);
    }
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Refusal && error.code === 'VERIFY_CONTAINER_CLEANUP_PENDING')) throw error;
      sourceCoverage = undefined;
      const reason = error instanceof Refusal ? error.code : 'VERIFY_TOOLS_FAILED';
      collectorCode = 1;
      const detail = reason === 'VERIFY_MODULE_IMAGE_MISSING'
        ? 'Imagem fixada do módulo ausente no Docker local (VERIFY_MODULE_IMAGE_MISSING).'
        : `Falha de processo ou leitura da saída: ${reason}`;
      collectorData = {coverage: [{tool: 'coletor', version: 'indisponível', status: 'failed', detail}], findings: []};
    }
    if (collectorCode !== 0 && !collectorData.coverage.some(row => row.status === 'failed')) {
      const failure: ModuleToolCoverage = {tool: 'coletor', version: 'indisponível', status: 'failed', detail: `Processo terminou com código ${collectorCode}.`};
      collectorData.coverage.push(failure);
      sourceCoverage?.push(failure);
    }

    const collector = {module: input.module, intentId, snapshot, commit: input.commit, exitCode: collectorCode,
      coverage: sourceCoverage ?? collectorData.coverage, findings: collectorData.findings};
    const exam = await input.examinar?.({intentId, snapshot, module: input.module,
      findings: structuredClone(collectorData.findings), collector: structuredClone(collector), signal: input.signal});
    if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
    if (exam && (exam.findings.length < collectorData.findings.length || exam.findings.length > 999)) {
      throw new Refusal('MODULE_EXAM_FINDINGS_INVALID', 400);
    }
    // Rebuild the source inventory from the host snapshot for graph proofs.
    // A reviewer response never supplies the file map or the collector records.
    const needsGraph = input.module === 'arquitetura' && exam?.mode === 'exame' &&
      exam.findings.some(finding => finding.status !== 'provavel');
    const relatedSources = needsGraph ? new Map((await mapModuleSnapshot(snapshot, input.signal)).files
      .map(file => [file.file, file.code] as const)) : undefined;
    const coverage = new Map(exam?.coverage.map(row => [row.file, row] as const));
    const collectorReview = {collector, intentId, snapshot, relatedSources, coverage};
    const achados: Achado[] = [];
    for (const finding of collectorData.findings) {
      const achadoId = `ACH-${String(achados.length + 1).padStart(3, '0')}`;
      let title = sanitizeText(`${finding.rule}: ${finding.message}`).slice(0, 200) || finding.rule;
      const toolRule = `${finding.tool}:${finding.rule}`;
      const reference = (isPublicModuleRule(input.module, finding.tool, finding.rule) ? toolRule : sanitizeText(toolRule)).slice(0, 200);
      let status: 'confirmado' | 'provavel' | 'descartado' = 'provavel';
      let proof = sanitizeText(finding.evidence).slice(0, 2000);
      let verifier: Achado['verifier'] = null;
      const audited = exam?.findings[achados.length];
      if (audited) {
        const origin = moduleCollectorCandidate(finding);
        if (audited.file !== origin.file || audited.line !== origin.line || audited.source !== origin.source ||
          audited.evidence !== origin.evidence || audited.title !== origin.title || audited.severity !== origin.severity) {
          throw new Refusal('MODULE_EXAM_FINDINGS_INVALID', 400);
        }
        verifier = await independentVerifier(snapshot, input.module, exam!, audited, finding, collectorReview);
        status = verifier ? audited.status : 'provavel';
        if (verifier) {
          proof = localizedProof(audited.proof, audited.reason);
          if (status === 'confirmado') title = moduleReviewObservationTitle(audited.observation) ?? title;
        }
      } else if (input.worker && !(input.module === 'prontidao' && isProtectedLocation(finding.file))) {
        const confirmed = await confirmFindingWithReviewer({...input, repoPath: snapshot}, intentId, finding);
        status = confirmed.status;
        title = confirmed.title ?? title;
        proof = confirmed.proof;
        verifier = confirmed.verifier;
      }
      achados.push(Achado.parse({
        id: achadoId,
        title,
        severity: finding.severity,
        status,
        verifier,
        reference,
        where: {file: finding.file, line: finding.line},
        scenario: sanitizeText(finding.message).slice(0, 2000),
        proof,
        suggestion: isProtectedLocation(finding.file) && input.module === 'prontidao'
          ? 'O responsável deve tratar manualmente o arquivo protegido e executar novamente o módulo.'
          : 'Corrigir o ponto indicado no arquivo, adicionar teste de regressão e executar novamente o módulo.',
        acceptance: REMEDIATION_ACCEPTANCE,
        sources: [finding.tool.slice(0, 200), finding.rule.slice(0, 200)],
        secretPreview: null,
      }));
    }

    for (const judged of exam?.findings.slice(collectorData.findings.length) ?? []) {
      if (judged.source !== 'examinador' || isProtectedLocation(judged.file) ||
        !exam?.coverage.some(row => row.file === judged.file && row.status === 'lido' && row.examiner)) {
        throw new Refusal('MODULE_EXAM_FINDINGS_INVALID', 400);
      }
      await resolveInsideRepo(snapshot, judged.file);
      const verifier = await independentVerifier(snapshot, input.module, exam!, judged);
      achados.push(Achado.parse({
        id: `ACH-${String(achados.length + 1).padStart(3, '0')}`, title: sanitizeText(judged.title), severity: judged.severity,
        status: verifier ? judged.status : 'provavel', verifier,
        reference: 'exame-de-arquivo', where: {file: judged.file, line: judged.line}, scenario: sanitizeText(judged.evidence),
        proof: verifier ? localizedProof(judged.proof, judged.reason) : '', suggestion: 'Revisar o trecho indicado e verificar a correção.',
        acceptance: REMEDIATION_ACCEPTANCE, sources: ['examinador', 'exame-de-arquivo'], secretPreview: null,
      }));
    }
    const measured = new Map<string, ModuleToolCoverage[]>();
    for (const row of collectorData.coverage.filter(row => row.status === 'ok')) {
      const files = new Set([...(row.files ?? []), ...collectorData.findings.filter(f => f.tool === row.tool).map(f => f.file)]);
      const detailFile = collectorMeasuredDetailFile(row);
      if (detailFile) {
        // A text field is not trusted as a filesystem path until resolved in the snapshot.
        try { await resolveInsideRepo(snapshot, detailFile); files.add(detailFile); } catch { /* no positive file evidence */ }
      }
      for (const file of files) measured.set(file, [...(measured.get(file) ?? []), row]);
    }
    const fileCoverage: CoverageRow[] = [...measured.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, rows]) =>
      CoverageRow.parse({
        file,
        examinerProvider: 'ferramenta',
        examinerModel: `${rows[0]!.tool}@${rows[0]!.version}`.slice(0, 100),
        profileId: null,
        checklist: [...new Set(rows.map(row => row.tool.slice(0, 80)))].slice(0, 80),
      }),
    );

    if (exam) {
      const byFile = new Map(fileCoverage.map(row => [row.file, row]));
      for (const row of exam.coverage) {
        if (row.status !== 'lido' || !row.examiner) continue;
        await resolveInsideRepo(snapshot, assertModuleRepoRelativePath(row.file));
        byFile.set(row.file, CoverageRow.parse({file: row.file, examinerProvider: row.examiner.provider,
          examinerModel: row.examiner.model, profileId: row.examiner.profileId, checklist: row.checklist}));
      }
      fileCoverage.length = 0;
      for (const row of byFile.values()) fileCoverage.push(row);
    }
    const hasToolFailure = collectorCode !== 0 || collectorData.coverage.some(row => row.status === 'failed');
    const notes: string[] = [...(input.notes ?? [])];
    if (exam) notes.push(...exam.notes);
    else notes.push('Cobertura por arquivo limitada aos arquivos informados pelos coletores ou com achados; ausência de registro não comprova exame. O snapshot é gerado por git archive.');
    for (const failed of collectorData.coverage.filter(row => row.status === 'failed')) {
      notes.push(`Falha em ${failed.tool} (${failed.version}): ${failed.detail}`);
    }
    if (collectorCode !== 0 && !collectorData.coverage.some(row => row.status === 'failed')) {
      notes.push(`O coletor saiu com código ${collectorCode}.`);
    }
    const finalState: 'done' | 'failed' = hasToolFailure ? 'failed' : 'done';
    const report = await input.ledger.tx(async c => {
      await input.ledger.authorize(c, input.principal, input.authority.contextId);
      await input.ledger.fence(c, input.authority);
      const active = await c.query(
        "SELECT 1 FROM ac_verify_runs WHERE id=$1 AND context_id=$2 AND status='running' AND report_prepared_dir=$3 FOR UPDATE",
        [runId, input.authority.contextId, preparedDir],
      );
      if (!active.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT');
      if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
      const prepared = await writeModuleReport({
        dataDirectory: input.dataDirectory,
        projectId: input.projectId,
        module: input.module,
        runId,
        createdAt,
        commit: input.commit,
        image,
        deferPublication: true,
        exam, measuredFiles: measured,
        toolCoverage: sourceCoverage ?? collectorData.coverage,
        fileCoverage,
        achados,
        raw: {...collectorData, coverage: sourceCoverage ?? collectorData.coverage},
        ...(notes.length > 0 ? {note: notes.join(' ')} : {}),
      });
      if (prepared.directory !== preparedDir) throw new Refusal('VERIFY_REPORT_INTEGRITY', 409);
      if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
      for (const achado of achados) {
        await c.query(
          `INSERT INTO ac_verify_findings (run_id, achado_id, status, severity, file, line, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            runId,
            achado.id,
            achado.status,
            achado.severity,
            achado.where.file,
            achado.where.line,
            JSON.stringify({
              ...achado,
              snippet: achado.proof.slice(0, 240),
            }),
          ],
        );
      }
      for (const row of fileCoverage) {
        await c.query(
          `INSERT INTO ac_verify_coverage (run_id, file, examiner_provider, examiner_model, profile_id, checklist, provenance, collector_measurements)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`,
          [runId, row.file, row.examinerProvider, row.examinerModel, row.profileId, JSON.stringify(row.checklist), row.profileId === null ? 'collector' : 'examiner',
            JSON.stringify((measured.get(row.file) ?? []).map(({tool, version}) => ({tool, version})))],
        );
      }
      for (let index = 0; index < collectorData.coverage.length; index += 1) {
        const item = collectorData.coverage[index]!;
        await c.query(
          `INSERT INTO ac_verify_tool_coverage (run_id, seq, tool, version, status, detail)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [runId, index + 1, item.tool, item.version, item.status, item.detail],
        );
      }
      await input.ledger.fence(c, input.authority);
      const updated = await c.query(
        `UPDATE ac_verify_runs SET status=$2, report_dir=$3, finished_at=clock_timestamp(), collector_image=$5
         WHERE id=$1 AND context_id=$4 AND status='running'`,
        [runId, finalState, prepared.directory, input.authority.contextId, image ?? null],
      );
      if (!updated.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT');
      if (prepared.examOriginSha256) {
        await c.query('UPDATE ac_verify_runs SET exam_origin_sha256=$2 WHERE id=$1', [runId, prepared.examOriginSha256]);
      }
      await finishExamIntentTx(c, input.ledger, {intentId, contextId: input.authority.contextId}, finalState);
      return prepared;
    });
    await reconcileReports(input.ledger, input.principal, input.authority, input.dataDirectory, input.projectId, runId);

    return {
      runId,
      intentId,
      module: input.module,
      directory: report.directory,
      directoryName: report.directoryName,
      achados,
      coverage: fileCoverage,
      toolCoverage: collectorData.coverage,
      hasToolFailure,
      summary: report.summary,
    };
  } catch (error) {
    let rolledBackRun = false;
    try {
      rolledBackRun = await input.ledger.tx(async c => {
        await input.ledger.authorize(c, input.principal, input.authority.contextId);
        await input.ledger.fence(c, input.authority);
        const updated = await c.query("UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp() WHERE id=$1 AND status='running'", [runId]);
        if (updated.rowCount) await finishExamIntentTx(c, input.ledger, {intentId, contextId: input.authority.contextId}, 'failed');
        return Boolean(updated.rowCount);
      });
    } catch { /* preserve original failure */ }
    // Only a confirmed failure transition permits cleanup here. After an
    // ambiguous COMMIT recovery consults the persisted reservation and outcome.
    if (rolledBackRun) await reconcileReports(input.ledger, input.principal, input.authority, input.dataDirectory, input.projectId)
      .catch(() => undefined);
    throw error;
  } finally {
    if (snapshot) await removeModuleSnapshot(snapshot);
  }
}

function uniqueSortedIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new Refusal('VERIFY_NOTHING_TO_FIX', 400);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !ACHADO_ID.safeParse(id).success) throw new Refusal('VERIFY_FINDING_MISSING', 404);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (unique.length > 20) throw new Refusal('VERIFY_TOO_MANY', 400);
  unique.sort((a, b) => a.localeCompare(b));
  return unique;
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].map(String).sort((x, y) => x.localeCompare(y));
  const b = [...right].map(String).sort((x, y) => x.localeCompare(y));
  return a.every((id, index) => id === b[index]);
}

function moduleRegressionPath(module: string, achadoId: string): string {
  const folder = module === 'verify' ? 'seguranca' : module;
  return `tests/${folder}/${achadoId.toLowerCase()}.test.ts`;
}

function moduleRegressionText(module: string, ids: readonly string[]): string {
  return ids.map(id => `O teste ${moduleRegressionPath(module, id)} tem de falhar antes da correção e passar depois.`).join('\n');
}

type EligibleFinding = {
  id: string;
  file: string;
  line: number | null;
  status: string;
  severity: string;
  title: string;
  snippet: string;
};

function renderModuleRemediationTask(input: {
  projectId: string;
  module: string;
  runId: string;
  groups: readonly {file: string; items: EligibleFinding[]}[];
  writePaths: readonly string[];
  regression: string;
}): string {
  const body = input.groups.map(group => [
    `Arquivo: ${group.file}`,
    ...(input.module === 'prontidao' && isProtectedLocation(group.file)
      ? ['Ação manual do responsável: tratar o arquivo protegido; não ler nem editar esse arquivo.'] : []),
    ...group.items.map(item => `- ${item.id} linha ${item.line ?? 'não informada'}: ${item.title}\n  Prova: ${item.snippet}`),
  ].join('\n')).join('\n');
  return [
    `Corrija os achados selecionados do módulo ${input.module}.`,
    `Projeto: ${input.projectId}`,
    `Execução: ${input.runId}`,
    '',
    'O que corrigir:',
    body,
    '',
    'Caminhos de escrita:',
    ...input.writePaths.map(file => `- ${file}`),
    '',
    'Teste de regressão exigido:',
    input.regression,
    '',
    'Critério de aceite:',
    REMEDIATION_ACCEPTANCE,
  ].join('\n');
}

/**
 * Idempotently converts confirmed/reopened findings from a module run into a product task
 * linked to the project, with real repository write paths, regression test path, and acceptance criteria.
 */
export async function requestModuleCorrection(
  ledger: Ledger,
  principal: string,
  authority: Authority,
  input: {
    module?: VerificationModule;
    runId: string;
    achadoIds: readonly string[];
    dataDirectory: string;
    projectId: string;
    repoPath?: string;
  },
): Promise<CorrectionReceipt & {
  contextId: string;
  regressionTest: string;
  acceptance: string;
  projectId: string;
}> {
  if (input.module !== undefined) assertVerificationModule(input.module);
  if (!Id.safeParse(input.runId).success || !Id.safeParse(input.projectId).success) {
    throw new Refusal('VERIFY_RUN_MISSING', 404);
  }
  await assertPersonalActivation(ledger);
  const requested = uniqueSortedIds(input.achadoIds);

  return ledger.tx(async client => {
    await lockWorkflowProjectShared(client, authority.contextId);
    const mainRow = (await client.query<{id: string}>(
      `SELECT x.id::text AS id
       FROM ac_contexts x
       WHERE x.project_id=$1 AND x.project_id=(SELECT project_id FROM ac_contexts WHERE id=$2) AND NOT x.archived
         AND NOT EXISTS (SELECT 1 FROM ac_exam_contexts e WHERE e.context_id=x.id)
       ORDER BY x.created_at, x.id LIMIT 1`,
      [input.projectId, authority.contextId],
    )).rows[0];
    // The main-context foreign key is needed at dispatch. Lock it before the exam context
    // so a caller using main authority cannot hold it while waiting for this run lock.
    if (mainRow && mainRow.id !== authority.contextId) {
      await client.query('SELECT id FROM ac_contexts WHERE id=$1 FOR KEY SHARE', [mainRow.id]);
    }
    const authContext = await ledger.authorize(client, principal, authority.contextId);
    await ledger.fence(client, authority);
    if (authContext.project_id !== input.projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);

    const runRow = (await client.query<{
      id: string;
      context_id: string;
      module: string;
    }>(
      "SELECT id::text AS id, context_id::text AS context_id, module FROM ac_verify_runs WHERE id=$1 AND project_id=$2 AND report_dir <> 'discarded' AND report_dir NOT LIKE 'discarded:%' FOR UPDATE",
      [input.runId, input.projectId],
    )).rows[0];
    if (!runRow) throw new Refusal('VERIFY_RUN_MISSING', 404);
    if (input.module !== undefined && runRow.module !== input.module) {
      throw new Refusal('VERIFY_RUN_MISSING', 404);
    }

    const mainContextId = mainRow?.id ?? runRow.context_id;
    if (authority.contextId !== runRow.context_id && authority.contextId !== mainContextId) {
      throw new Refusal('VERIFY_RUN_MISSING', 404);
    }

    const coveredRows = (await client.query<{file: string}>('SELECT file FROM ac_verify_coverage WHERE run_id=$1', [runRow.id])).rows;
    const covered = new Set(coveredRows.map(row => String(row.file)));
    const findingRows = (await client.query<{
      achado_id: string;
      status: string;
      file: string;
      line: number | null;
      severity: string;
      payload: unknown;
    }>(
      'SELECT achado_id, status, file, line, severity, payload FROM ac_verify_findings WHERE run_id=$1 AND achado_id = ANY($2::text[])',
      [runRow.id, requested],
    )).rows;
    const byId = new Map(findingRows.map(row => [String(row.achado_id), row]));
    const findings: EligibleFinding[] = requested.map(id => {
      const row = byId.get(id);
      if (!row || !['confirmado', 'reaberto', 'fechado'].includes(row.status)) {
        throw new Refusal('VERIFY_FINDING_MISSING', 404);
      }
      const candidate = String(row.file);
      const file = runRow.module === 'prontidao' && isProtectedLocation(candidate)
        ? protectedLocation(candidate) : assertModuleRepoRelativePath(candidate);
      if (!covered.has(file)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      const lineNum = row.line !== null && Number.isInteger(Number(row.line)) && Number(row.line) >= 1 ? Number(row.line) : null;
      const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
      if (isProtectedLocation(file)) {
        const sources = Array.isArray(payload.sources) ? payload.sources : [];
        if (runRow.module !== 'prontidao' || !isProtectedFindingSource(sources[0], sources[1])
          || typeof sources[1] !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(sources[1])
          || payload.scenario !== 'Possível segredo em arquivo protegido.'
          || payload.proof !== 'Localização informada pelo coletor; conteúdo protegido.')
          throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
        return {id, file, line: lineNum, status: String(row.status), severity: String(row.severity),
          title: 'Possível segredo em arquivo protegido', snippet: 'Localização informada pelo coletor; conteúdo protegido.'};
      }
      const title = typeof payload.title === 'string' ? payload.title.slice(0, 200) : id;
      const snippet = typeof payload.snippet === 'string'
        ? payload.snippet
        : typeof payload.proof === 'string'
          ? payload.proof
          : '';
      return {id, file, line: lineNum, status: String(row.status), severity: String(row.severity), title, snippet};
    });

    const repoRow = (await client.query<{repo: string}>('SELECT repo FROM ac_project_repositories WHERE project_id=$1', [input.projectId])).rows[0];
    const repo = repoRow?.repo ?? input.repoPath ?? null;
    if (!repo) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);

    const findRequest = await loadCorrectionRequests(client, runRow.id, requested);
    const exact = findRequest(requested);
    const groups = groupCorrectionFindings(findings, runRow.module === 'dependencias');
    const plans = exact ? [{groups, ids: requested, existing: exact}] : groups.map(group => {
      const ids = group.items.map(item => item.id);
      return {groups: [group], ids, existing: findRequest(ids)};
    });
    // A closed finding can replay its receipt. It cannot participate in new dispatch.
    if (plans.some(plan => !plan.existing) && findings.some(finding => finding.status === 'fechado')) {
      throw new Refusal('VERIFY_FINDING_MISSING', 404);
    }
    const prefix = runRow.module === 'verify' ? 'verify-fix' : `module-${runRow.module}-fix`;
    const contextIds = mainContextId === authority.contextId ? [mainContextId] : [mainContextId, authority.contextId];
    const requestsToSave = [];
    for (const plan of plans) {
      const sourcePaths = [...new Set(plan.groups.map(group => group.file))];
      const writableSources = sourcePaths.filter(path => !isProtectedLocation(path));
      const regressionPaths = plan.ids.map(id => moduleRegressionPath(runRow.module, id));
      const writePaths = [...new Set([...writableSources, ...regressionPaths])];
      const existing = plan.existing;
      if (existing?.writePaths.some(path => !writePaths.includes(path))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      for (const path of sourcePaths) {
        if (existing) await assertNoSymlinkAlongPath(repo, path);
        else if (!(await locateRepoFile(repo, path))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      }
      for (const path of regressionPaths) await assertNoSymlinkAlongPath(repo, path);
      const regressionTest = moduleRegressionText(runRow.module, plan.ids)
        + (writableSources.length < sourcePaths.length
          ? '\nUse dados sintéticos e teste um alvo seguro; não leia nem edite arquivos protegidos.' : '');
      requestsToSave.push({...plan, writePaths, regressionTest});
    }
    const requests = [];
    for (const {groups, ids, existing, writePaths, regressionTest} of requestsToSave) {
      requests.push(existing ?? await saveCorrectionRequest(client, {
        runId: runRow.id, prefix, ids, writePaths, regressionTest, contextIds,
        text: renderModuleRemediationTask({
          projectId: input.projectId, module: runRow.module, runId: runRow.id, groups, writePaths, regression: regressionTest,
        }),
      }));
    }
    return {
      ...correctionReceipt(requests),
      contextId: mainContextId,
      regressionTest: requests.map(request => request.regressionTest).join('\n'),
      acceptance: requests[0]!.acceptance,
      projectId: input.projectId,
    };
  });
}

async function replacePrivateFile(directory: string, name: string, body: string): Promise<void> {
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  if (!target.startsWith(directory + sep) || !temporary.startsWith(directory + sep)) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  try {
    let existing = null;
    try {
      existing = await lstat(target);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    }
    if (existing && (existing.mode & 0o777) === 0o600
      && await readTextInside(directory, target, 'VERIFY_REPORT_INVALID') === body) return;
    await writePrivate(temporary, directory, body);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

type PersistedModuleReport = {
  id: string;
  module: VerificationModule;
  commit_id: string;
  report_dir: string;
  report_prepared_dir: string | null;
  report_legacy_missing: boolean;
};

function reportIntegrity(): Refusal {
  return new Refusal('VERIFY_REPORT_INTEGRITY', 409);
}

function assertPersistedReportPath(projectDir: string, path: string, row: PersistedModuleReport): void {
  const id = row.id.replaceAll('-', '');
  const name = basename(path);
  const suffix = name.slice(16, -(row.module.length + 1));
  if (dirname(path) !== projectDir || resolve(path) !== path || !MODULE_REPORT_DIR.test(name)
    || !name.endsWith(`-${row.module}`) || (suffix !== id && (row.report_prepared_dir !== null || suffix !== id.slice(0, 8)))) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
}

async function reportDirectoryExists(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
      throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    }
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function findReportSummary(directory: string): Promise<{summary: ModuleReportSummary | null; published: boolean}> {
  for (const name of ['run.json', '.run-pending.json']) {
    let text: string;
    try {
      text = await readTextInside(directory, join(directory, name), 'VERIFY_REPORT_INVALID');
    } catch (error) {
      if (error instanceof Refusal && error.code === 'VERIFY_REPORT_INVALID') continue;
      throw error;
    }
    try {
      const summary = ModuleReportSummary.safeParse(JSON.parse(text));
      return {summary: summary.success ? summary.data : null, published: name === 'run.json'};
    } catch {
      return {summary: null, published: name === 'run.json'};
    }
  }
  return {summary: null, published: false};
}

function reportMatches(summary: ModuleReportSummary, directory: string, row: PersistedModuleReport): boolean {
  return summary.id === row.id && summary.module === row.module && summary.commit === row.commit_id
    && summary.directoryName === basename(directory);
}

async function assertUnsharedLegacyReport(client: pg.PoolClient, target: string, runId: string): Promise<void> {
  // A historical short suffix can collide even if the summary is incomplete.
  const conflict = await client.query(
    "SELECT 1 FROM ac_verify_runs WHERE id<>$1 AND (report_dir IN ($2, 'discarded:' || $2) OR report_prepared_dir=$2)",
    [runId, target],
  );
  if (conflict.rowCount) throw reportIntegrity();
}

async function removePersistedModuleReport(client: pg.PoolClient, projectDir: string, row: PersistedModuleReport): Promise<void> {
  const path = row.report_dir.startsWith('discarded:') ? row.report_dir.slice('discarded:'.length) : row.report_dir;
  const target = path === 'pending' || path === 'discarded' ? row.report_prepared_dir : path;
  if (target) {
    assertPersistedReportPath(projectDir, target, row);
    if (!await reportDirectoryExists(target)) return;
    const {summary} = await findReportSummary(target);
    if (summary && !reportMatches(summary, target, row)) throw reportIntegrity();
    if (!row.report_prepared_dir) {
      await assertUnsharedLegacyReport(client, target, row.id);
      if (!summary) {
        const collision = await client.query(
          `SELECT 1 FROM ac_verify_runs own JOIN ac_verify_runs other ON other.project_id=own.project_id
           AND other.module=own.module AND left(other.id::text,8)=left(own.id::text,8)
           WHERE own.id=$1 AND other.id<>own.id AND other.report_prepared_dir IS NULL
           AND other.report_dir='pending' LIMIT 1`, [row.id],
        );
        if (collision.rowCount) throw reportIntegrity();
      }
    }
    await rm(target, {recursive: true, force: true});
    return;
  }

  // Pre-reservation runs may have prepared a directory while report_dir was
  // still pending. Match the full identity in its summary before removing it.
  if (!await reportDirectoryExists(projectDir)) return;
  for (const name of await readdir(projectDir)) {
    if (!MODULE_REPORT_DIR.test(name) || !name.endsWith(`-${row.id.slice(0, 8)}-${row.module}`)) continue;
    const directory = join(projectDir, name);
    if (!await reportDirectoryExists(directory)) continue;
    const {summary} = await findReportSummary(directory);
    if (summary && reportMatches(summary, directory, row)) {
      await assertUnsharedLegacyReport(client, directory, row.id);
      await rm(directory, {recursive: true, force: true});
    }
  }
}

export async function discardModuleReport(
  ledger: Ledger, principal: string, dataDirectory: string, projectId: string, module: VerificationModule, runId: string,
): Promise<void> {
  const load = async (client: pg.PoolClient) => {
    const activation = await client.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal' FOR SHARE");
    if (!activation.rowCount) throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
    const membership = await client.query(
      'SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 FOR SHARE', [projectId, principal],
    );
    if (!membership.rowCount || membership.rows[0].role === 'viewer') throw new Refusal('PROJECT_FORBIDDEN', 403);
    const keys = [runId, projectId, module];
    const {rows: [binding]} = await client.query<{context_id: string}>(
      'SELECT context_id FROM ac_verify_runs WHERE id=$1 AND project_id=$2 AND module=$3', keys,
    );
    if (!binding) throw new Refusal('VERIFY_RUN_MISSING', 404);
    // Match reconciliation's context-before-run lock order.
    await ledger.authorize(client, principal, binding.context_id);
    const {rows: [row]} = await client.query<PersistedModuleReport>(
      `SELECT id, module, commit_id, report_dir, report_prepared_dir, report_legacy_missing FROM ac_verify_runs
       WHERE id=$1 AND project_id=$2 AND module=$3 AND status IN ('done','failed') FOR UPDATE`, keys,
    );
    if (!row) throw new Refusal('VERIFY_RUN_MISSING', 404);
    return row;
  };
  const parent = join(await requireDataDirectory(dataDirectory), 'verificacoes', projectId);
  await ledger.tx(async client => {
    const row = await load(client);
    if (row.report_dir === 'discarded' || row.report_dir.startsWith('discarded:')) return;
    if (row.report_dir !== 'pending') assertPersistedReportPath(parent, row.report_dir, row);
    await client.query(
      'UPDATE ac_verify_runs SET report_dir=$2, report_legacy_missing=false WHERE id=$1',
      [runId, row.report_dir === 'pending' ? 'discarded' : `discarded:${row.report_dir}`],
    );
  });
  await ledger.tx(async client => {
    const row = await load(client);
    await resolveProjectVerificationsDir(dataDirectory, projectId);
    await removePersistedModuleReport(client, parent, row);
  });
}

type PersistedFinding = {achado_id: string; severity: Achado['severity']; status: Achado['status']; file: string; line: number | null; payload: Achado};

async function recoverHistoricalCoverage(
  client: pg.PoolClient, runId: string, raw: ModuleCollectorOutput, findings: PersistedFinding[],
): Promise<void> {
  const unknown = await client.query(
    "SELECT 1 FROM ac_verify_coverage WHERE run_id=$1 AND provenance='unknown' AND examiner_provider='ferramenta' AND profile_id IS NULL LIMIT 1",
    [runId],
  );
  if (!unknown.rowCount) return;

  const archived = (await client.query<ModuleToolCoverage>(
    'SELECT tool, version, status, detail FROM ac_verify_tool_coverage WHERE run_id=$1', [runId],
  )).rows;
  const recordedTools = new Set(archived.filter(row => row.status === 'ok')
    .map(row => JSON.stringify([row.tool, row.version, row.detail])));
  const recordedFindings = new Map(findings.map(finding => [finding.achado_id, finding]));
  const proven = new Set<string>();
  for (const row of raw.coverage) {
    if (row.status !== 'ok' || !recordedTools.has(JSON.stringify([row.tool, row.version, row.detail]))) continue;
    for (const file of row.files ?? []) proven.add(file);
    const measured = collectorMeasuredDetailFile(row);
    if (measured) proven.add(measured);
    for (const [index, finding] of raw.findings.entries()) {
      if (finding.tool !== row.tool) continue;
      const recorded = recordedFindings.get(`ACH-${String(index + 1).padStart(3, '0')}`);
      if (recorded?.file === finding.file && recorded.line === finding.line
        && recorded.payload?.sources?.[0] === finding.tool && recorded.payload.sources?.[1] === finding.rule) proven.add(finding.file);
    }
  }
  if (proven.size) await client.query(
    `UPDATE ac_verify_coverage SET provenance='collector' WHERE run_id=$1 AND file=ANY($2::text[])
     AND provenance='unknown' AND examiner_provider='ferramenta' AND profile_id IS NULL`, [runId, [...proven]],
  );
}

async function publishModuleReport(client: pg.PoolClient, row: PersistedModuleReport): Promise<void> {
  const directory = row.report_dir;
  const {summary, published} = await findReportSummary(directory);
  if (!summary || !reportMatches(summary, directory, row)) throw reportIntegrity();
  const parsed = JSON.parse(await readTextInside(directory, join(directory, 'achados.json'), 'VERIFY_REPORT_INVALID'));
  const archived = z.object({achados: z.array(Achado)}).parse(parsed).achados;
  const raw = validateModuleCollectorObject(
    JSON.parse(await readTextInside(directory, join(directory, 'bruto', 'achados-brutos.json'), 'VERIFY_REPORT_INVALID')), row.module,
  );
  const files = ['mapa.md', 'cobertura.md'];
  if (row.module === 'documentacao') files.push(...requiredModuleArtifacts(raw.coverage));
  for (const file of files) {
    await readTextInside(directory, join(directory, file), 'VERIFY_REPORT_INVALID');
  }
  const findings = (await client.query<PersistedFinding>(
    'SELECT achado_id, status, severity, file, line, payload FROM ac_verify_findings WHERE run_id=$1', [row.id],
  )).rows;
  const byId = new Map(findings.map(item => [item.achado_id, item]));
  if (byId.size !== archived.length || new Set(archived.map(item => item.id)).size !== archived.length) throw reportIntegrity();
  const reconciled = archived.map(item => {
    const finding = byId.get(item.id);
    if (!finding || item.where.file !== finding.file || item.where.line !== finding.line) throw reportIntegrity();
    const persisted = Achado.strip().safeParse({...finding.payload, status: finding.status, severity: finding.severity});
    if (!persisted.success || persisted.data.id !== finding.achado_id || persisted.data.where.file !== finding.file
      || persisted.data.where.line !== finding.line) throw reportIntegrity();
    assertNoLiveAccessKey(persisted.data);
    return persisted.data;
  });
  if (!row.report_prepared_dir) await recoverHistoricalCoverage(client, row.id, raw, findings);
  const findingsDirectory = join(directory, 'achados');
  if (!await reportDirectoryExists(findingsDirectory)) throw reportIntegrity();
  const counts = failureCounts(reconciled);
  await replacePrivateFile(directory, 'achados.json', guardReportText(`${JSON.stringify({achados: reconciled}, null, 2)}\n`));
  for (const finding of reconciled) {
    await replacePrivateFile(findingsDirectory, `${finding.id}.md`, guardReportText(achadoMarkdown(finding)));
  }
  await syncReportDirectory(findingsDirectory);
  await replacePrivateFile(directory, 'README.md', guardReportText(renderModuleReadme({
    module: summary.module, runId: summary.id, directoryName: summary.directoryName,
    createdAt: new Date(summary.createdAt), commit: summary.commit, note: summary.note,
    total: reconciled.length, counts, discarded: reconciled.filter(item => item.status === 'descartado').length,
    toolCoverage: raw.coverage,
  })));
  // Initial publication is a single rename of run.json after the files above
  // are ready. Rechecks rebuild these files only from committed database state.
  if (!published || JSON.stringify(summary.counts) !== JSON.stringify(counts)) {
    await replacePrivateFile(directory, 'run.json', guardReportText(`${JSON.stringify({...summary, counts}, null, 2)}\n`));
  }
  await syncReportDirectory(directory);
}

async function reconcileReports(
  ledger: Ledger, principal: string, authority: Authority, dataDirectory: string, projectId: string, publishedRunId?: string,
  recheck?: {runId: string; intentId?: string; signal?: AbortSignal; validateReplay?: (client: pg.PoolClient) => Promise<void>},
): Promise<void> {
  await ledger.tx(async client => {
    if (recheck) {
      await authorizeModuleRecheck(client, ledger, principal, authority, projectId);
    } else {
      const context = await ledger.authorize(client, principal, authority.contextId);
      await ledger.fence(client, authority);
      if (context.project_id !== projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    }
    recheck?.signal?.throwIfAborted();
    await recheck?.validateReplay?.(client);
    const rows = (await client.query<PersistedModuleReport>(
      `SELECT id, module, commit_id, report_dir, report_prepared_dir, report_legacy_missing FROM ac_verify_runs
       WHERE project_id=$1 AND context_id=$2 AND status IN ('done','failed') AND module <> 'verify'
       AND ($3::uuid IS NULL OR id=$3) ORDER BY id FOR UPDATE`,
      [projectId, authority.contextId, recheck?.runId ?? null],
    )).rows;
    if (publishedRunId && !rows.some(row => row.id === publishedRunId && row.report_dir === row.report_prepared_dir)) {
      throw new Refusal('VERIFY_RUN_MISSING', 404);
    }
    if (!rows.length) {
      if (recheck) throw new Refusal('VERIFY_RUN_MISSING', 404);
      return;
    }
    const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
    const parent = projectDir ?? join(await requireDataDirectory(dataDirectory), 'verificacoes', projectId);
    for (const row of rows) {
      if (row.report_dir === 'pending' || row.report_dir === 'discarded' || row.report_dir.startsWith('discarded:')) {
        if (recheck) throw new Refusal('VERIFY_RUN_MISSING', 404);
        await removePersistedModuleReport(client, parent, row);
        continue;
      }
      assertPersistedReportPath(parent, row.report_dir, row);
      if (row.report_prepared_dir && row.report_dir !== row.report_prepared_dir) throw reportIntegrity();
      if (!projectDir || !await reportDirectoryExists(row.report_dir)) {
        if (row.report_prepared_dir || recheck) throw reportIntegrity();
        if (!row.report_legacy_missing) await client.query('UPDATE ac_verify_runs SET report_legacy_missing=true WHERE id=$1', [row.id]);
        continue;
      }
      try {
        await publishModuleReport(client, row);
      } catch (error) {
        // A historical partial restore has no durable reservation. Preserve
        // the files and let unrelated runs reconcile. Reject unsafe paths.
        const incomplete = error instanceof SyntaxError || error instanceof z.ZodError ||
          (error instanceof Refusal && ['VERIFY_REPORT_INTEGRITY', 'VERIFY_REPORT_INVALID'].includes(error.code));
        if (row.report_prepared_dir || recheck || !incomplete) throw error;
        await client.query('UPDATE ac_verify_runs SET report_legacy_missing=true WHERE id=$1', [row.id]);
        continue;
      }
      if (row.report_legacy_missing) await client.query('UPDATE ac_verify_runs SET report_legacy_missing=false WHERE id=$1', [row.id]);
    }
    recheck?.signal?.throwIfAborted();
    if (recheck?.intentId) {
      await ledger.fence(client, authority);
      await client.query(
        `INSERT INTO ac_audit(context_id,kind,detail)
         SELECT $1,'module.recheck_report_published',$2::jsonb WHERE NOT EXISTS (
           SELECT 1 FROM ac_audit WHERE context_id=$1 AND kind='module.recheck_report_published' AND detail=$2::jsonb
         )`,
        [authority.contextId, {runId: recheck.runId, intentId: recheck.intentId}],
      );
      recheck.signal?.throwIfAborted();
    }
  });
}

async function recoverModuleContainers(
  ledger: Ledger, principal: string, authority: Authority, projectId: string, execute: CollectorProcess, module?: VerificationModule,
): Promise<void> {
  const pending = await ledger.tx(async client => {
    const context = await ledger.authorize(client, principal, authority.contextId);
    await ledger.fence(client, authority);
    if (context.project_id !== projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    if (module && !(await client.query(
      'SELECT 1 FROM ac_exam_contexts WHERE project_id=$1 AND context_id=$2 AND module=$3', [projectId, authority.contextId, module],
    )).rowCount) throw new Refusal('EXAM_CONTEXT_MISMATCH', 403);
    const abandoned = await client.query<{id: string; intent_id: string}>(
      `UPDATE ac_verify_runs r SET status='failed', finished_at=clock_timestamp() FROM ac_intents i
       WHERE r.intent_id=i.id AND r.context_id=$1 AND r.module <> 'verify'
       AND r.status='running' AND i.manager_epoch<>$2 RETURNING r.id, r.intent_id`, [authority.contextId, authority.epoch],
    );
    for (const row of abandoned.rows) {
      await finishExamIntentTx(client, ledger, {intentId: row.intent_id, contextId: authority.contextId}, 'failed');
    }
    return (await client.query<{id: string; collector_container_token: string}>(
      `SELECT id, collector_container_token FROM ac_verify_runs WHERE context_id=$1 AND module <> 'verify'
       AND status IN ('done','failed') AND collector_container_token IS NOT NULL ORDER BY id`, [authority.contextId],
    )).rows;
  });
  for (const row of pending) {
    await moduleContainerJournal(ledger, principal, authority, row.id, execute).cleanup(row.collector_container_token, undefined, {recovering: true});
  }
}

/** Recover reports and collector cleanup under the current project/context authority. */
export async function reconcileModuleReports(
  ledger: Ledger, principal: string, authority: Authority, dataDirectory: string, projectId: string,
): Promise<void> {
  await assertPersonalActivation(ledger);
  await recoverModuleContainers(ledger, principal, authority, projectId, runBoundedCollectorProcess);
  await reconcileReports(ledger, principal, authority, dataDirectory, projectId);
}

type ModuleRecheckExaminer = {provider: string; model: string; accountId: string | null; profileId: string | null};
type ModuleRecheckReviewer = {provider: string; model: string; accountId: string; profileId: string; grantId: string};
export type ModuleRecheckReview = (request: {
  intentId: string;
  commit: string;
  task: string;
  examiner: ModuleRecheckExaminer | null;
  signal?: AbortSignal;
}) => Promise<{output: string; reviewer: ModuleRecheckReviewer} | {reason: string; reviewer?: ModuleRecheckReviewer}>;

const ModuleRecheckResult = z.discriminatedUnion('status', [
  z.object({id: ACHADO_ID, status: z.enum(['fechado', 'reaberto'])}),
  z.object({id: ACHADO_ID, status: z.literal('pendente'), reason: z.string()}),
]);
type ModuleRecheckResult = z.infer<typeof ModuleRecheckResult>;
const RecheckDigest = z.string().regex(/^[a-f0-9]{64}$/);
const RecheckCommit = z.string().regex(/^[a-f0-9]{40}$/);
const ModuleRecheckPublication = z.object({
  runId: Id, intentId: Id, commit: RecheckCommit, results: z.array(ModuleRecheckResult).min(1).max(20),
  proofRunId: Id.optional(), proofVersion: z.number().int().optional(),
  receiptDigests: z.partialRecord(ACHADO_ID, RecheckDigest).optional(),
});
type ModuleRecheckPublication = z.infer<typeof ModuleRecheckPublication>;
const RecheckAuditProof = z.object({
  id: ACHADO_ID, status: z.enum(['fechado', 'reaberto']), commit: RecheckCommit, reviewerBinding: RecheckDigest,
  proofDigest: RecheckDigest, reviewerReason: z.string().min(1),
  reviewer: z.object({provider: z.string().min(1), model: z.string().min(1), accountId: Id, profileId: Id, grantId: Id}),
  source: z.object({file: z.string(), line: z.number().int().positive(), tool: z.string(), rule: z.string(),
    origin: z.literal('collector'), commit: RecheckCommit, evidenceDigest: RecheckDigest}),
  moduleProof: z.object({runId: Id, tool: z.string(), version: z.string().min(1), origin: z.literal('collector'), collectorImage: z.string()}),
  regressionProof: z.looseObject({
    proofVersion: z.literal(RECHECK_PROOF_VERSION), receiptDigest: RecheckDigest, moduleProofRunId: Id,
    criterion: z.string().min(1), recordedRule: z.string().optional(),
    scope: z.looseObject({id: ACHADO_ID, runId: Id, file: z.string(), line: z.number().int().positive(), tool: z.string(),
      rule: z.string(), evidenceDigest: RecheckDigest}),
    observations: z.looseObject({original: z.looseObject({commit: RecheckCommit}), corrected: z.looseObject({commit: RecheckCommit})}),
  }),
});
type ModuleRecheckOutcome = {
  results: ModuleRecheckResult[];
  publication: 'published' | 'pending';
};
type RecheckCoverage = {
  file: string; examiner_provider: string; examiner_model: string; profile_id: string | null;
  account_id: string | null; provenance: string; checklist: string[];
};

function protectedRecheckFile(file: string): boolean {
  return isProtectedLocation(file) || isSecretClassBasename(file) || /(?:^|\/)(?:logs?|\.ssh|\.aws|\.config)(?:\/|$)/i.test(file)
    || /\.log(?:[.\d_-].*)?$|(?:^|[._-])(?:secrets?|credentials?|password|senha)(?:[._-]|$)|^\.pypirc$/i.test(basename(file))
    || sanitizeRecheckText(file) !== file;
}

function sanitizeRecheckText(text: string): string {
  // Drop lines containing old persisted secret previews or newly detected secrets.
  return sanitizeText(text).split('\n').map(line =>
    /…|\[REDACTED\]|\[removido: alta entropia\]/i.test(line) ? '[trecho omitido]' : line,
  ).join('\n');
}

function safeRecheckTestTitle(title: string): boolean {
  // This value comes from a Git blob, so a literal ellipsis may be punctuation.
  // Normalize before screening so it cannot suppress a redaction match.
  const screened = title.replaceAll('…', '...');
  return sanitizeRecheckText(screened) === screened;
}

async function readRecheckLine(repo: string, commit: string, file: string, line: number, signal?: AbortSignal) {
  const blob = await readRecheckBlob(repo, commit, file, signal);
  const target = blob && sanitizeRecheckText(blob.text).split('\n')[line - 1]?.trim();
  return target && target !== '[trecho omitido]' && target.length <= EXCERPT_LIMIT / 2
    && !MULTILINE_CONTROL_CHAR.test(target) ? target : '';
}

function sanitizedRecheckReason(reason: string): string {
  const safe = sanitizeRecheckText(reason).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return hasKnownSecret(safe) ? '[trecho omitido]' : safe;
}

function recheckOriginalImage(image: string | null): string | undefined {
  if (image === null) return;
  try {
    return assertPinnedModuleImage(image);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
  }
}

async function validRecheckJournal(client: pg.PoolClient, contextId: string, run: {
  id: string; module: VerificationModule; commit_id: string; collector_image: string | null;
}, journal: ModuleRecheckPublication) {
  if (journal.runId !== run.id) return false;
  const {proofRunId, proofVersion, receiptDigests} = journal;
  const closes = journal.results.filter(result => result.status === 'fechado');
  if (!proofRunId && !proofVersion && !receiptDigests) return closes.length === 0;
  if (!proofRunId || proofVersion !== RECHECK_PROOF_VERSION || !receiptDigests) return false;
  const ids = Object.keys(receiptDigests);
  if (!ids.length || ids.length > journal.results.length || closes.some(result => !ids.includes(result.id))) return false;
  const {rows} = await client.query<{detail: unknown; status: string}>(
    `SELECT a.detail, f.status FROM ac_audit a JOIN ac_verify_findings f
     ON f.run_id=$2 AND f.achado_id=a.detail->>'id'
     WHERE a.context_id=$1 AND a.kind='module.finding_rechecked' AND a.detail->>'runId'=$2::uuid::text
     AND a.detail->>'intentId'=$3 AND f.achado_id=ANY($4::text[])`,
    [contextId, run.id, journal.intentId, ids],
  );
  const proofs = rows.map(row => ({...row, proof: RecheckAuditProof.safeParse(row.detail).data}));
  return proofs.length === ids.length && ids.every(id => {
    const decisions = journal.results.filter(result => result.id === id && result.status !== 'pendente');
    const matches = proofs.filter(row => row.proof?.id === id);
    const entry = matches[0];
    if (matches.length !== 1 || decisions.length !== 1 || !entry?.proof) return false;
    const {proof, status} = entry;
    const {regressionProof, moduleProof, source} = proof;
    const {receiptDigest, ...receipt} = regressionProof;
    const criterion = supportsFunctionalRecheck(run.module, receipt.scope) ? FUNCTION_COVERAGE_CRITERION
      : moduleMeasurementCriterion(run.module, receipt.scope)?.id;
    return receipt.criterion === criterion && receiptDigest === receiptDigests[id] && digest(receipt) === receiptDigest
      && proof.status === decisions[0]!.status && status === proof.status && proof.commit === journal.commit
      && receipt.moduleProofRunId === proofRunId && moduleProof.runId === proofRunId
      && moduleProof.collectorImage === run.collector_image && moduleProof.tool === source.tool
      && receipt.scope.id === id && receipt.scope.runId === run.id && receipt.scope.file === source.file
      && receipt.scope.line === source.line && receipt.scope.tool === source.tool
      && sanitizeRecheckText(receipt.recordedRule ?? receipt.scope.rule) === source.rule
      && receipt.scope.evidenceDigest === source.evidenceDigest
      && receipt.observations.original.commit === run.commit_id && source.commit === run.commit_id
      && receipt.observations.corrected.commit === journal.commit;
  });
}

async function currentRecheckJournal(client: pg.PoolClient, journal: ModuleRecheckPublication, scope: Omit<MeasurementScope, 'head'>,
  image: string | null, repo: string, signal?: AbortSignal) {
  if (await recheckHead(repo, signal) !== journal.commit) return false;
  if (!journal.proofRunId) return true;
  const latest = await latestModuleMeasurement(client, {...scope, head: journal.commit});
  return latest?.runId === journal.proofRunId && latest.status === 'done' && latest.usable && latest.collectorImage === image;
}

async function authorizeModuleRecheck(
  client: pg.PoolClient, ledger: Ledger, principal: string, authority: Authority, projectId: string,
) {
  const context = await ledger.authorize(client, principal, authority.contextId);
  await ledger.fence(client, authority);
  if (context.project_id !== projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
  const membership = await client.query(
    "SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner' FOR SHARE", [projectId, principal],
  );
  if (!membership.rowCount) throw new Refusal('PROJECT_FORBIDDEN', 403);
  return context;
}

export async function moduleRemeasurementTarget(ledger: Ledger, principal: string, authority: Authority, input: {
  projectId: string; module: VerificationModule; runId: string; repo: string; signal?: AbortSignal;
}) {
  await assertPersonalActivation(ledger);
  return ledger.tx(async client => {
    await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
    input.signal?.throwIfAborted();
    const {rows: [origin]} = await client.query<{commit_id: string; collector_image: string | null; repo: string}>(
      `SELECT r.commit_id, r.collector_image, p.repo FROM ac_verify_runs r
       JOIN ac_project_repositories p ON p.project_id=r.project_id
       WHERE r.id=$1 AND r.project_id=$2 AND r.context_id=$3 AND r.module=$4 AND r.status IN ('done','failed')
       AND r.report_dir NOT IN ('pending','discarded') AND r.report_dir NOT LIKE 'discarded:%' FOR SHARE`,
      [input.runId, input.projectId, authority.contextId, input.module],
    );
    if (!origin) throw new Refusal('VERIFY_RUN_MISSING', 404);
    if (await realpath(origin.repo) !== await realpath(input.repo)) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    const image = assertPinnedModuleImage(origin.collector_image ?? '');
    const commit = await recheckHead(input.repo, input.signal);
    if (commit === origin.commit_id || !await sameRecheckHistory(input.repo, origin.commit_id, commit, input.signal)) {
      throw new Refusal('VERIFY_RECHECK_CHANGE_UNPROVEN', 409);
    }
    return {image, commit};
  });
}

/** Recheck only committed, sanitized evidence. A pending result preserves the persisted finding status. */
export async function recheckModuleFindings(
  ledger: Ledger,
  principal: string,
  authority: Authority,
  input: {
    module?: VerificationModule;
    runId: string;
    achadoIds: readonly string[];
    dataDirectory: string;
    projectId: string;
    review: ModuleRecheckReview;
    signal?: AbortSignal;
  },
): Promise<ModuleRecheckOutcome> {
  const {signal} = input;
  signal?.throwIfAborted();
  if (input.module !== undefined) assertVerificationModule(input.module);
  if (!Id.safeParse(input.runId).success || !Id.safeParse(input.projectId).success) {
    throw new Refusal('VERIFY_RUN_MISSING', 404);
  }
  await assertPersonalActivation(ledger);
  const requested = uniqueSortedIds(input.achadoIds);
  const loaded = await ledger.tx(async client => {
    await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
    signal?.throwIfAborted();
    const run = (await client.query<{id: string; module: VerificationModule; commit_id: string; report_dir: string; exam_origin_sha256: string | null;
      collector_image: string | null; status: string}>(
      `SELECT r.id, r.module, r.commit_id, r.report_dir, r.exam_origin_sha256, r.collector_image, r.status FROM ac_verify_runs r
       JOIN ac_exam_contexts e ON (e.project_id,e.context_id,e.module)=(r.project_id,r.context_id,r.module)
       WHERE r.id=$1 AND r.project_id=$2 AND r.context_id=$3
       AND ($4::text IS NULL OR r.module=$4) AND r.module <> 'verify' AND r.status IN ('done','failed')
       AND r.report_dir NOT IN ('pending','discarded') AND r.report_dir NOT LIKE 'discarded:%' FOR UPDATE OF r`,
      [input.runId, input.projectId, authority.contextId, input.module ?? null],
    )).rows[0];
    if (!run) throw new Refusal('VERIFY_RUN_MISSING', 404);
    const rows = (await client.query<{achado_id: string; file: string; line: number | null; payload: Achado}>(
      'SELECT achado_id, file, line, payload FROM ac_verify_findings WHERE run_id=$1 AND achado_id = ANY($2::text[])',
      [run.id, requested],
    )).rows;
    const byId = new Map(rows.map(row => [row.achado_id, row]));
    const items = requested.map(id => {
      const row = byId.get(id);
      if (!row) throw new Refusal('VERIFY_FINDING_MISSING', 404);
      const file = run.module === 'prontidao' && isProtectedLocation(row.file)
        ? protectedLocation(row.file) : assertModuleRepoRelativePath(row.file);
      const {sources, reference, scenario, proof, verifier, severity} = row.payload;
      return {id, file, line: row.line ?? 1, hasOriginalLine: row.line !== null, tool: sources?.[0] ?? run.module,
        rule: sources?.[1] ?? reference ?? id, scenario, proof, verifier, severity};
    });
    const repo = (await client.query<{repo: string}>('SELECT repo FROM ac_project_repositories WHERE project_id=$1', [input.projectId])).rows[0]?.repo;
    const latest = (await client.query<{detail: unknown; published: boolean}>(
      `SELECT a.detail, EXISTS (
         SELECT 1 FROM ac_audit p WHERE p.context_id=a.context_id AND p.kind='module.recheck_report_published'
         AND p.detail->>'runId'=$2 AND p.detail->>'intentId'=a.detail->>'intentId'
       ) AS published FROM ac_audit a WHERE a.context_id=$1 AND a.kind='module.recheck_report_pending'
       AND a.detail->>'runId'=$2 ORDER BY a.id DESC LIMIT 1`, [authority.contextId, run.id],
    )).rows[0];
    const previous = latest && ModuleRecheckPublication.safeParse(latest.detail).data;
    const validJournal = previous && await validRecheckJournal(client, authority.contextId, run, previous) ? previous : undefined;
    const journal = latest?.published ? undefined : validJournal;
    const legacyExamOrigin = !run.exam_origin_sha256 && items.some(item => item.tool === 'examinador' && item.rule === 'exame-de-arquivo');
    const matchingJournal = validJournal && sameIdSet(requested, validJournal.results.map(result => result.id)) ? validJournal : undefined;
    const scope = {projectId: input.projectId, contextId: authority.contextId, module: run.module};
    const replay = matchingJournal && (!latest!.published || !legacyExamOrigin) && repo
      && await currentRecheckJournal(client, matchingJournal, scope, run.collector_image, repo, signal).catch(error => {
        // A pending publication can still be recovered when its checkout is unavailable.
        if (journal && error instanceof Refusal && error.code === 'VERIFY_COMMIT_INVALID') return false;
        throw error;
      });
    let verifiedOrigin: string | undefined;
    if (run.exam_origin_sha256) {
      try {
        const projectDir = await resolveProjectVerificationsDir(input.dataDirectory, input.projectId);
        if (!projectDir) throw new Refusal('VERIFY_REPORT_INVALID', 400);
        assertInside(projectDir, run.report_dir);
        verifiedOrigin = await readTextInside(projectDir, join(run.report_dir, 'bruto', 'exame.json'),
          'VERIFY_REPORT_INVALID', run.exam_origin_sha256);
      } catch (error) {
        // Preserve a committed verdict until its original archive can be restored.
        if (replay && !latest!.published) return {journal: matchingJournal, replay: true as const, archivePending: true as const};
        throw error;
      }
    }
    if (replay) return {journal: matchingJournal, run, repo, scope, replay: true as const, archivePending: false as const};
    if (!repo && !journal) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    const generation = await client.query<{recheck_generation: string}>(
      'UPDATE ac_verify_runs SET recheck_generation=recheck_generation+1 WHERE id=$1 RETURNING recheck_generation::text',
      [run.id],
    );
    return {run, items, repo, journal, verifiedOrigin, generation: generation.rows[0]!.recheck_generation,
      reconcile: !latest || latest.published || Boolean(journal), replay: false as const};
  });

  const publish = async (journal: ModuleRecheckPublication, validateReplay?: (client: pg.PoolClient) => Promise<void>): Promise<ModuleRecheckOutcome> => {
    try {
      await reconcileReports(ledger, principal, authority, input.dataDirectory, input.projectId, undefined,
        {runId: journal.runId, intentId: journal.intentId, signal, validateReplay});
      return {results: journal.results, publication: 'published'};
    } catch (error) {
      if (validateReplay && error instanceof Refusal && error.code === 'VERIFY_RUN_CONFLICT') throw error;
      return {results: journal.results, publication: 'pending'};
    }
  };
  if (loaded.replay) {
    if (loaded.archivePending) return {results: loaded.journal.results, publication: 'pending'};
    return publish(loaded.journal, async client => {
      if (!await validRecheckJournal(client, authority.contextId, loaded.run, loaded.journal)
        || !await currentRecheckJournal(client, loaded.journal, loaded.scope, loaded.run.collector_image, loaded.repo, signal)) {
        throw new Refusal('VERIFY_RUN_CONFLICT', 409);
      }
    });
  }
  const directory = loaded.run.report_dir;
  const sourceFile = join(directory, 'bruto', 'exame.json');
  const {verifiedOrigin} = loaded;
  if (loaded.journal) {
    const recovered = await publish(loaded.journal);
    if (recovered.publication === 'pending') {
      throw new Refusal('VERIFY_RECHECK_PREVIOUS_PUBLICATION_PENDING', 503);
    }
  } else if (loaded.reconcile) {
    await reconcileReports(ledger, principal, authority, input.dataDirectory, input.projectId, undefined, {runId: loaded.run.id, signal});
  }
  const {repo} = loaded;
  if (!repo) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  const projectDir = await resolveProjectVerificationsDir(input.dataDirectory, input.projectId);
  if (!projectDir) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  assertInside(projectDir, directory);
  const raw = ModuleCollectorOutput.parse(JSON.parse(await readTextInside(directory, join(directory, 'bruto', 'achados-brutos.json'), 'VERIFY_REPORT_INVALID')));
  const coverage = await ledger.pool.query<RecheckCoverage>(
    `SELECT v.file, v.examiner_provider, v.examiner_model, v.profile_id, p.account_id, v.provenance, v.checklist
     FROM ac_verify_coverage v LEFT JOIN ac_profiles p ON p.id=v.profile_id WHERE v.run_id=$1`,
    [loaded.run.id],
  );
  const byFile = new Map(coverage.rows.map(row => [row.file, row]));
  const head = await recheckHead(repo, signal);
  const originalCommit = loaded.run.commit_id;
  const sameHistory = head !== originalCommit && await sameRecheckHistory(repo, originalCommit, head, signal);
  const moduleName = assertVerificationModule(loaded.run.module);
  const measurementScope = {projectId: input.projectId, contextId: authority.contextId, module: moduleName, head};
  const originalImage = recheckOriginalImage(loaded.run.collector_image);
  let measurement: BoundScope['measurement'];
  if (sameHistory && loaded.run.status === 'done' && originalImage && loaded.items.some(item =>
    supportsFunctionalRecheck(moduleName, item) || moduleMeasurementCriterion(moduleName, item))) {
    const latest = await latestModuleMeasurement(ledger.pool, measurementScope);
    if (latest?.status === 'done' && latest.usable && latest.collectorImage === originalImage) {
      measurement = {runId: latest.runId, collectorImage: originalImage};
    }
  }
  const intentId = randomUUID();
  await ledger.tx(async client => {
    const context = await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
    signal?.throwIfAborted();
    const command = {
      schemaVersion: 1 as const, intentId, deliveryAttemptId: randomUUID(),
      contextId: authority.contextId, policyRevision: Number(context.policy_revision), action: 'plan.start' as const,
      payload: {workflow: 'security-verify-readonly-v1' as const, messageRef: `recheck:${loaded.run.id}`, projectId: input.projectId, commit: head},
    };
    await client.query(
      `INSERT INTO ac_intents (id, context_id, principal_id, digest, command, operation_id, run_id, manager_epoch, plan_revision)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [intentId, authority.contextId, principal, digest(command), JSON.stringify(command), randomUUID(), randomUUID(), authority.epoch, Number(context.plan_revision)],
    );
  });

  const results: ModuleRecheckResult[] = [];
  let completed = false;
  try {
    const audit: (ModuleRecheckResult & {
      examiner: ModuleRecheckExaminer | null; reviewer: ModuleRecheckReviewer | null; proofDigest: string | null;
      reviewerReason: string | null;
      reviewerBinding: string | null;
      source: {file: string; line: number; tool: string; rule: string; commit: string; origin: string; evidenceDigest: string} | null;
      moduleProof: FunctionalRegression['moduleProof'] | null; regressionProof: FunctionalRegression['receipt'] | null;
    })[] = [];
    const hasExamFindings = loaded.items.some(item => item.tool === 'examinador' && item.rule === 'exame-de-arquivo');
    const archived = verifiedOrigin !== undefined || (hasExamFindings && await lstat(sourceFile).then(() => true, error => {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }));
    const originText = verifiedOrigin ?? (archived ? await readTextInside(directory, sourceFile, 'VERIFY_REPORT_INVALID') : undefined);
    const origin = z.object({id: ACHADO_ID, file: z.string(), line: z.number().int().positive(),
      evidence: z.string(), hypothesis: z.string().max(300).optional()});
    const reviewedSources = new Map<string, z.infer<typeof origin>>();
    if (originText !== undefined) {
      try {
        for (const entry of z.array(origin).max(999).parse(JSON.parse(originText))) {
          if (reviewedSources.has(entry.id)) throw new Error();
          reviewedSources.set(entry.id, entry);
        }
      } catch { throw new Refusal('VERIFY_REPORT_INVALID', 400); }
    }
    for (const item of loaded.items) {
      signal?.throwIfAborted();
      const row = byFile.get(item.file);
      const examiner: ModuleRecheckExaminer | null = row?.provenance === 'examiner' ? {
        provider: row.examiner_provider, model: row.examiner_model, profileId: row.profile_id, accountId: row.account_id,
      } : item.verifier ? {...item.verifier, profileId: null, accountId: null} : null;
      const logOrProtected = protectedRecheckFile(item.file);
      const fromExaminer = item.tool === 'examinador' && item.rule === 'exame-de-arquivo';
      const observed = fromExaminer ? reviewedSources.get(item.id) : undefined;
      const historicalLine = !logOrProtected && (sameHistory || (fromExaminer && !archived)) && /^[0-9a-f]{40}$/.test(originalCommit)
        ? await readRecheckLine(repo, originalCommit, item.file, item.line, signal) : '';
      const legacyEvidence = historicalLine && item.scenario.trim() && historicalLine.trim() === item.scenario.trim();
      const original = fromExaminer
        ? (archived ? observed : legacyEvidence ? {file: item.file, line: item.line, evidence: item.scenario} : undefined)
        : raw.findings[Number(item.id.slice(4)) - 1];
      if ((archived || !fromExaminer) && (!original || original.file !== item.file || original.line !== item.line ||
          (fromExaminer ? original.evidence !== item.scenario : !('tool' in original) || original.tool !== item.tool || original.rule !== item.rule))) {
        throw new Refusal('VERIFY_REPORT_INVALID', 400);
      }
      const sourceKnown = original && (row?.provenance === 'examiner' || (row?.provenance === 'collector' && !fromExaminer));
      const evidence = !original || logOrProtected ? '' : sanitizeRecheckText(original.evidence);
      const qaRegression = supportsFunctionalRecheck(moduleName, item);
      const functional = qaRegression || moduleMeasurementCriterion(moduleName, item);
      let line = !functional && !logOrProtected && sourceKnown
        ? await readRecheckLine(repo, head, item.file, item.line, signal) : '';
      let result: ModuleRecheckResult | undefined;
      let reviewer: ModuleRecheckReviewer | undefined;
      let proofDigest: string | undefined;
      let reviewerReason: string | undefined;
      let reviewerBinding: string | undefined;
      let regression: FunctionalRegression | undefined;
      const pending = (reason: string): ModuleRecheckResult => ({id: item.id, status: 'pendente', reason});
      if (logOrProtected) {
        result = pending('MODULE_RECHECK_PROTECTED');
      } else if (!sourceKnown) {
        result = pending('MODULE_RECHECK_ORIGINAL_UNKNOWN');
      } else if (!evidence.replaceAll('[trecho omitido]', '').trim()) {
        result = pending('MODULE_RECHECK_EVIDENCE_UNAVAILABLE');
      } else if (functional) {
        if (!item.hasOriginalLine || !original || !('message' in original)
          || item.scenario !== sanitizeText(original.message) || item.severity !== original.severity
          || (!item.verifier && item.proof !== evidence)) {
          result = pending('MODULE_RECHECK_FUNCTIONAL_ORIGIN_UNPROVEN');
        } else if (!sameHistory) {
          result = pending(head === originalCommit ? 'MODULE_RECHECK_SAME_COMMIT' : 'MODULE_RECHECK_CHANGE_UNPROVEN');
        } else {
          const scope: BoundScope = {
            module: moduleName, repo, runId: loaded.run.id, measurement,
            originalCommit, head, item: {id: item.id, file: item.file, line: item.line, tool: item.tool, rule: item.rule},
            evidence, originalMessage: item.scenario, testFile: moduleRegressionPath(moduleName, item.id), signal,
          };
          const measured = qaRegression ? await measureRecheckRegression(ledger, scope)
            : await measureLocalRegression(ledger, scope, original, text =>
              !MULTILINE_CONTROL_CHAR.test(text) && sanitizeRecheckText(text) === text);
          if (measured.reason !== undefined) result = pending(measured.reason);
          else if ([measured.before.code, measured.after.code, measured.assertion, measured.moduleProof.version,
            ...('verdict' in measured ? Object.values(measured.receipt.observations)
              .flatMap(side => side.uncovered.map(finding => finding.name)) : [])]
            .some(value => value !== null && sanitizeRecheckText(value) !== value)
            || (measured.receipt.testTitle !== undefined && !safeRecheckTestTitle(measured.receipt.testTitle))) {
            result = pending('MODULE_RECHECK_EVIDENCE_UNAVAILABLE');
          } else {
            regression = measured;
            line = measured.after.code;
          }
        }
      } else if (!line) {
        result = pending('MODULE_RECHECK_EVIDENCE_UNAVAILABLE');
      }

      if (!result) {
        const rule = regression?.receipt.scope.rule ?? sanitizeRecheckText(item.rule);
        const hypothesis = observed?.hypothesis ? sanitizeRecheckText(observed.hypothesis)
          : fromExaminer ? 'A linha atual ainda sustenta a observação original?' : moduleCollectorHypothesis(rule);
        let skipSnapshot: {originalCommit: string; original: string; current: string} | undefined;
        if (sameHistory && moduleName === 'qa' && !regression && (fromExaminer || rule === 'QA-TESTE-PULADO')) {
          const [original, current] = await Promise.all([originalCommit, head].map(commit =>
            readRecheckBlob(repo, commit, item.file, signal)));
          if (original && current && [original.text, current.text].every(text =>
            Buffer.byteLength(text) <= 16000 && sanitizeRecheckText(text) === text)) {
            skipSnapshot = {originalCommit, original: original.text, current: current.text};
          }
        }
        const reviewEvidence = {
          module: moduleName, file: item.file, line: regression?.after.line ?? item.line, code: line, commit: head,
          tool: sanitizeRecheckText(item.tool), rule, hypothesis, evidence,
          skipSnapshot, originalCommit, originalCode: regression?.before.code ?? (historicalLine || null),
          moduleProof: regression?.moduleProof ?? null, regressionProof: regression?.receipt ?? null,
          regressionAssertion: regression?.assertion ?? null,
        };
        const task = JSON.parse(moduleReviewTask(reviewEvidence));
        if (regression && !('verdict' in regression)) {
          task.instruction = 'Compare a identidade e as duas medições locais de regressionProof. Sem ferramentas, rede ou escrita. '
            + 'Responda JSON com kind confirmacao, binding, status provavel ou descartado, reason e proof. '
            + 'Para descartar a hipótese, copie code em proof e inclua correction com rule, criterion e object (de regressionProof), '
            + 'original e corrected (de regressionProof.observations). Explique como a mesma regressão verifica a correção. '
            + 'Cite entre crases o objeto e os valores actual das duas revisões.';
        } else if (regression) {
          task.instruction = COVERAGE_REVIEW_INSTRUCTION;
        }
        const reviewed = !regression && task.criterion === null && head !== originalCommit
          ? {reason: 'MODULE_RECHECK_FUNCTIONAL_RULE_UNSUPPORTED'}
          : await input.review({intentId, commit: head, task: JSON.stringify(task), examiner, signal});
        signal?.throwIfAborted();
        reviewer = 'reviewer' in reviewed ? reviewed.reviewer : undefined;
        if ('reason' in reviewed) {
          result = pending(/^[A-Z][A-Z0-9_]{0,79}$/.test(reviewed.reason) ? reviewed.reason : 'MODULE_RECHECK_PROOF_UNAVAILABLE');
        } else if (examiner && (reviewed.reviewer.provider === examiner.provider || reviewed.reviewer.profileId === examiner.profileId
          || reviewed.reviewer.accountId === examiner.accountId)) {
          throw new Refusal('MODULE_EXAM_PROVIDER_NOT_DISTINCT');
        } else {
          const parsed = parseModuleReviewJson(reviewed.output);
          const verdict = regression ? readFunctionalRecheckVerdict(parsed) : readModuleReviewVerdict(parsed);
          if (verdict) reviewerReason = sanitizedRecheckReason(verdict.reason);
          if (regression) {
            const status = 'verdict' in regression ? regression.verdict : 'fechado';
            if (!verdict || verdict.status !== (status === 'fechado' ? 'descartado' : 'confirmado')
              || verdict.binding !== task.binding || verdict.proof.trim() !== line) {
              result = pending('MODULE_RECHECK_PROOF_UNAVAILABLE');
            } else if (!recheckCorrectionMatches(parsed, reviewerReason ?? '', regression)) {
              result = pending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
            } else {
              result = {id: item.id, status};
              proofDigest = digest(line);
              reviewerBinding = verdict.binding;
            }
          } else if (!verdict || verdict.status === 'provavel' || !hasModuleReviewProof(reviewEvidence, verdict)) {
            result = pending('MODULE_RECHECK_PROOF_UNAVAILABLE');
          } else if (verdict.status === 'confirmado') {
            result = {id: item.id, status: 'reaberto'};
            proofDigest = digest(line);
          } else if (head === originalCommit) {
            result = pending('MODULE_RECHECK_SAME_COMMIT');
          } else if (!sameHistory || !historicalLine || historicalLine === line) {
            result = pending('MODULE_RECHECK_CHANGE_UNPROVEN');
          } else {
            result = pending('MODULE_RECHECK_FUNCTIONAL_RULE_UNSUPPORTED');
          }
        }
      }
      results.push(result);
      audit.push({...result, examiner, reviewer: reviewer ?? null, proofDigest: proofDigest ?? null,
        reviewerReason: reviewerReason ?? null, reviewerBinding: reviewerBinding ?? null,
        source: sourceKnown && evidence ? {file: item.file, line: item.line, tool: sanitizeRecheckText(item.tool),
          rule: sanitizeRecheckText(item.rule), commit: originalCommit,
          origin: fromExaminer ? (archived ? 'examiner' : 'legacy-git') : 'collector', evidenceDigest: digest(evidence)} : null,
        moduleProof: regression?.moduleProof ?? null, regressionProof: regression?.receipt ?? null,
      });
    }

    const decisionsWithProof = audit.filter(item => item.status !== 'pendente' && item.regressionProof !== null);
    const proofRunId = decisionsWithProof[0]?.moduleProof?.runId;
    const publication: ModuleRecheckPublication = {intentId, runId: loaded.run.id, commit: head, results,
      ...(proofRunId && {proofRunId, proofVersion: RECHECK_PROOF_VERSION,
        receiptDigests: Object.fromEntries(decisionsWithProof.map(item => [item.id, item.regressionProof!.receiptDigest]))})};
    await ledger.tx(async client => {
      await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
      await ledger.assertIntentActive(client, authority.contextId, intentId);
      const {rows: [liveRun]} = await client.query<{recheck_generation: string}>(
        "SELECT recheck_generation::text FROM ac_verify_runs WHERE id=$1 AND report_dir NOT IN ('pending','discarded') AND report_dir NOT LIKE 'discarded:%' FOR UPDATE",
        [loaded.run.id],
      );
      if (!liveRun) throw new Refusal('VERIFY_RUN_MISSING', 404);
      const currentRepo = (await client.query<{repo: string}>('SELECT repo FROM ac_project_repositories WHERE project_id=$1 FOR SHARE',
        [input.projectId])).rows[0]?.repo;
      if (liveRun.recheck_generation !== loaded.generation || currentRepo !== repo
        || await recheckHead(repo, signal) !== head) {
        throw new Refusal('VERIFY_RUN_CONFLICT', 409);
      }
      if (proofRunId) {
        const liveProof = await latestModuleMeasurement(client, measurementScope);
        if (liveProof?.runId !== proofRunId || liveProof.status !== 'done' || !liveProof.usable
          || liveProof.collectorImage !== measurement?.collectorImage) {
          throw new Refusal('VERIFY_RUN_CONFLICT', 409);
        }
      }
      for (const result of audit) {
        signal?.throwIfAborted();
        if (result.status !== 'pendente') {
          const updated = await client.query(
            'UPDATE ac_verify_findings SET status=$3 WHERE run_id=$1 AND achado_id=$2',
            [loaded.run.id, result.id, result.status],
          );
          if (!updated.rowCount) throw new Refusal('VERIFY_FINDING_MISSING', 404);
        }
        await client.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'module.finding_rechecked',$2)",
          [authority.contextId, {...result, intentId, runId: loaded.run.id, commit: head}]);
      }
      signal?.throwIfAborted();
      if (results.some(result => result.status !== 'pendente')) {
        await client.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'module.recheck_report_pending',$2)",
          [authority.contextId, publication]);
      }
      await finishExamIntentTx(client, ledger, {intentId, contextId: authority.contextId}, 'done');
      signal?.throwIfAborted();
    });
    completed = true;
    return results.some(result => result.status !== 'pendente')
      ? publish(publication) : {results, publication: 'published'};
  } finally {
    if (!completed) {
      await ledger.tx(async client => {
        await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
        await finishExamIntentTx(client, ledger, {intentId, contextId: authority.contextId}, 'failed');
      }).catch(() => undefined);
    }
  }
}

function parseModuleReviewJson(output: string): unknown {
  try {
    return JSON.parse(output.trim().replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

function parseModuleReviewOutput(output: string) {
  return readModuleReviewVerdict(parseModuleReviewJson(output));
}
