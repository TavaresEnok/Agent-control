import {execFile, spawn} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import type pg from 'pg';
import {z} from 'zod';
import {Capacity} from './capacity.ts';
import {digest, Id, Refusal, type Authority} from './contracts.ts';
import {enqueuePersonalOwner, readPersonalOwnerText} from './conversation-transport.ts';
import {finishExamIntent, finishExamIntentTx} from './exam-intent.ts';
import {reserveSpecialistExamSeat} from './exam-provider.ts';
import {VERIFICATION_MODULES, type Ledger, type VerificationModule} from './ledger.ts';
import {validatePassiveTlsEvidence, type ProntidaoPassiveEvidence} from './prontidao-target.ts';
import {assertPersonalActivation} from './verify-intent.ts';
import {hasKnownSecret, isSecretClassBasename, redactUnknownSecrets} from './verify-redact.ts';
import {listExamFiles} from './verify-slices.ts';
import {
  Achado,
  ConfirmResult,
  CoverageRow,
  REMEDIATION_ACCEPTANCE,
  VerifySeverity,
  VerifyWorkerCall,
  type VerifyWorker,
} from './verify-types.ts';

/** Container runtime binary. Tests compare against this constant and do not quote the name. */
export const MODULE_RUNTIME_BIN = 'docker';
export const MODULE_CONTAINER_USER = '65532:65532';
export const MAX_COLLECTOR_STDOUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_COLLECTOR_TIMEOUT_MS = 1_200_000;
export const MODULE_MEMORY_BYTES = 2_147_483_648;
export const MODULE_NANO_CPUS = 2_000_000_000;
export const MODULE_PIDS_LIMIT = 256;
export const DETERMINISTIC_MODULE_PROFILE_ID = '00000000-0000-4000-8000-000000000104';

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
const REPO_PATH = /^[A-Za-z0-9._@+\/-]+$/;
const LOWER_FORBIDDEN = new Set(['.mcp.json', '.claude', '.husky', '.codex', '.grok']);
const ACHADO_ID = z.string().regex(/^ACH-\d{3}$/);
const ACHADO_FILE = /^ACH-\d{3}\.md$/;
const EXCERPT_LIMIT = 4000;
const ARCHIVE_TIMEOUT_MS = 60_000;
const execGit = promisify(execFile);

export const ModuleToolStatus = z.enum(['ok', 'failed', 'skipped']);
export type ModuleToolStatus = z.infer<typeof ModuleToolStatus>;

export const ModuleToolCoverage = z.object({
  tool: z.string().min(1).max(120),
  version: z.string().min(1).max(120),
  status: ModuleToolStatus,
  detail: z.string().min(1).max(2000),
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

export const ModuleCollectorOutput = z.object({
  coverage: z.array(ModuleToolCoverage).min(1).max(5000),
  findings: z.array(ModuleRawFinding).max(999),
}).strict();
export type ModuleCollectorOutput = z.infer<typeof ModuleCollectorOutput>;

export const ModuleReportSummary = z.object({
  id: Id,
  module: z.enum(VERIFICATION_MODULES),
  directoryName: z.string().regex(/^\d{8}-\d{6}-[a-f0-9]{8}-(qa|arquitetura|dependencias|banco|prontidao|desempenho|documentacao|conformidade)$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
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
  image: string;
  repoPath: string;
  commit: string;
  timeoutMs: number;
  maxStdoutBytes: number;
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
  passiveTlsEvidence?: ProntidaoPassiveEvidence;
  collectorOutput?: unknown;
  runCollector?: (spec: CollectorRunnerSpec) => Promise<string | Buffer | ModuleCollectorOutput>;
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
    || part === '.'
    || part === '..'
    || part === '.git'
    || part === '.github'
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
    || trimmed.length > 400
    || trimmed.startsWith('/')
    || trimmed.startsWith('~')
    || /^[A-Za-z]:/.test(trimmed)
    || !REPO_PATH.test(trimmed)
  ) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  const parts = trimmed.split('/');
  if (parts.some(forbiddenSegment)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  return parts.join('/');
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
  options?: {maxStdoutBytes?: number},
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
  return validateModuleCollectorObject(parsed);
}

export function validateModuleCollectorObject(parsed: unknown): ModuleCollectorOutput {
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
      itemKeys.length !== 4
      || !itemKeys.includes('tool')
      || !itemKeys.includes('version')
      || !itemKeys.includes('status')
      || !itemKeys.includes('detail')
    ) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const row = item as Record<string, unknown>;
    const statusParsed = ModuleToolStatus.safeParse(row.status);
    if (!statusParsed.success) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    return ModuleToolCoverage.parse({
      tool: validateSingleLineString(row.tool, 1, 120, false),
      version: validateSingleLineString(row.version, 1, 120, false),
      status: statusParsed.data,
      detail: validateTextBlock(row.detail, 1, 2000).replace(/\s*\n\s*/g, ' '),
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
    const file = assertModuleRepoRelativePath(typeof row.file === 'string' ? row.file : '');
    if (typeof row.line !== 'number' || !Number.isInteger(row.line) || row.line < 1 || row.line > 10_000_000) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const severityParsed = VerifySeverity.safeParse(row.severity);
    if (!severityParsed.success) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    return ModuleRawFinding.parse({
      tool: validateSingleLineString(row.tool, 1, 120, false),
      rule: validateSingleLineString(row.rule, 1, 200, true),
      file,
      line: row.line,
      severity: severityParsed.data,
      message: validateTextBlock(row.message, 1, 2000).replace(/\s*\n\s*/g, ' '),
      evidence: validateTextBlock(row.evidence, 1, 2000),
    });
  });

  return {coverage, findings};
}

const GIT_ARCHIVE_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
  GIT_TERMINAL_PROMPT: '0',
};

function extractGitArchive(repo: string, commit: string, destination: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const git = spawn('/usr/bin/git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'archive', '--format=tar', commit], {
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
  const snapshot = await mkdtemp(join(tmpdir(), 'ac-module-snapshot-'));
  const rel = relative(repo, snapshot);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) {
    await rm(snapshot, {recursive: true, force: true});
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  try {
    await extractGitArchive(repo, commit, snapshot);
    await widenSnapshotForUnprivilegedContainer(snapshot);
    return snapshot;
  } catch (error) {
    await rm(snapshot, {recursive: true, force: true});
    throw error;
  }
}

export type BoundedProcessResult = {code: number; stdout: Buffer; stderr: string};

export function runBoundedCollectorProcess(
  args: readonly string[],
  options: {timeoutMs: number; maxStdoutBytes: number},
): Promise<BoundedProcessResult> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let totalBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(args[0] ?? '', [...args.slice(1)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent'},
    });
    const fail = (error: Refusal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8').slice(0, 1000),
      });
    };
    timer = setTimeout(() => fail(new Refusal('VERIFY_TOOLS_FAILED', 503)), options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      totalBytes += buf.byteLength;
      if (totalBytes > options.maxStdoutBytes) {
        fail(new Refusal('VERIFY_STDOUT_LIMIT', 400));
        return;
      }
      stdoutChunks.push(buf);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (stderrBytes < 4096) {
        stderrChunks.push(buf);
        stderrBytes += buf.byteLength;
      }
    });
    child.once('error', () => fail(new Refusal('VERIFY_TOOLS_FAILED', 503)));
    child.once('close', code => finish(code === 0 ? 0 : (code ?? 1)));
  });
}

export async function runModuleCollectorContainer(input: {
  image: string;
  repoPath: string;
  commit: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  passiveTlsEvidence?: ProntidaoPassiveEvidence;
  executeProcess?: (args: readonly string[], options: {timeoutMs: number; maxStdoutBytes: number}) => Promise<BoundedProcessResult>;
}): Promise<{code: number; output: ModuleCollectorOutput}> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
  const maxStdoutBytes = input.maxStdoutBytes ?? MAX_COLLECTOR_STDOUT_BYTES;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Refusal('VERIFY_LIMITS_INVALID', 400);
  }
  const snapshot = await prepareModuleSnapshot(input.repoPath, input.commit);
  let evidenceDir: string | undefined;
  let evidenceFile: string | undefined;
  try {
    if (input.passiveTlsEvidence !== undefined) {
      const validated = validatePassiveTlsEvidence(input.passiveTlsEvidence);
      evidenceDir = await mkdtemp(join(tmpdir(), 'ac-prontidao-evidence-'));
      await chmod(evidenceDir, 0o755);
      evidenceFile = join(evidenceDir, 'evidence.json');
      await writeFile(evidenceFile, `${JSON.stringify(validated)}\n`, {encoding: 'utf8', mode: 0o644, flag: 'wx'});
      await chmod(evidenceFile, 0o644);
    }
    const args = moduleCollectorArguments({
      image: input.image,
      repository: snapshot,
      ...(evidenceFile !== undefined ? {evidenceFile} : {}),
    });
    const run = input.executeProcess ?? runBoundedCollectorProcess;
    const result = await run(args, {timeoutMs, maxStdoutBytes});
    const output = parseModuleCollectorOutput(result.stdout, {maxStdoutBytes});
    return {code: result.code, output};
  } finally {
    if (evidenceDir) await rm(evidenceDir, {recursive: true, force: true});
    await rm(snapshot, {recursive: true, force: true});
  }
}

/**
 * Constructs a review/confirmation prompt for an independent reviewer.
 * Strictly includes only module, tool, rule, file, line, raw tool evidence, and code excerpt.
 * Never includes author or examiner conclusions (`message`, `title`, `scenario`, `suggestion`, `conclusion`).
 */
export function buildModuleReviewPrompt(input: {
  module: VerificationModule;
  achadoId?: string;
  tool: string;
  rule: string;
  file: string;
  line: number;
  evidence: string;
  codeExcerpt: string;
  [key: string]: unknown;
}): string {
  assertVerificationModule(input.module);
  const file = assertModuleRepoRelativePath(input.file);
  if (!Number.isInteger(input.line) || input.line < 1) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const tool = validateSingleLineString(input.tool, 1, 120, false);
  const rule = validateSingleLineString(input.rule, 1, 200, true);
  const evidence = validateTextBlock(input.evidence, 1, 2000);
  const excerpt = sanitizeText(String(input.codeExcerpt ?? '')).slice(0, EXCERPT_LIMIT);
  const lines = [
    'Pedido de confirmação.',
    'Tente derrubar o ponto a partir do código e da evidência bruta.',
    `Módulo: ${input.module}`,
    ...(input.achadoId ? [`Achado: ${input.achadoId}`] : []),
    `Ferramenta: ${tool}`,
    `Regra: ${rule}`,
    `Arquivo: ${file}`,
    `Linha: ${input.line}`,
    `Evidência bruta: ${evidence}`,
    'Conteúdo do arquivo:',
    excerpt || 'codigo-nao-visto',
    'Responda só com JSON {"kind":"confirmacao","status":"confirmado"|"provavel"|"descartado","reason":"...","proof":"..."}.',
  ];
  return lines.join('\n');
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
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return runId.slice(0, 8).toLowerCase();
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
  await writeFile(lexical, content, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  await chmod(lexical, 0o600);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
}

export async function writeModuleReport(input: {
  dataDirectory: string;
  projectId: string;
  module: VerificationModule;
  runId: string;
  createdAt: Date;
  commit: string;
  toolCoverage: readonly ModuleToolCoverage[];
  fileCoverage: readonly CoverageRow[];
  achados: readonly Achado[];
  raw: ModuleCollectorOutput;
  note?: string;
  directoryName?: string;
}): Promise<{directory: string; directoryName: string; summary: ModuleReportSummary}> {
  assertVerificationModule(input.module);
  assertSafeSegment(input.projectId);
  assertSafeSegment(input.runId);
  if (!/^[a-f0-9]{40}$/.test(input.commit)) throw new Refusal('VERIFY_COMMIT_INVALID', 400);
  const toolCoverage = input.toolCoverage.map(row => ModuleToolCoverage.parse(row));
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
  const rawBody = guardReportText(`${JSON.stringify(input.raw, null, 2)}\n`);
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
    createdAt: input.createdAt.toISOString(),
    counts,
    toolFailures,
    note,
  });
  if (!summaryParsed.success) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  const summary = summaryParsed.data;
  const discarded = achados.filter(item => item.status === 'descartado').length;
  const mapMarkdown = renderModuleMapMarkdown(input.module, fileCoverage.map(row => row.file), toolCoverage);
  const coverageBody = renderModuleCoverageMarkdown(toolCoverage, fileCoverage);
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
    {segments: ['run.json'], body: guardReportText(`${JSON.stringify(summary, null, 2)}\n`)},
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
  await ensureDir(directory, 'achados');
  await ensureDir(directory, 'bruto');
  for (const file of planned) {
    const path = file.segments.reduce((parent, segment) => {
      const next = join(parent, segment);
      assertInside(directory, next);
      return next;
    }, directory);
    await writePrivate(path, directory, file.body);
  }
  return {directory, directoryName, summary};
}

const MODULE_REPORT_DIR = /^\d{8}-\d{6}-[a-f0-9]{8}-(qa|arquitetura|dependencias|banco|prontidao|desempenho|documentacao|conformidade)$/;

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

async function readTextInside(root: string, path: string, missingCode: 'VERIFY_ACHADO_NOT_FOUND' | 'VERIFY_REPORT_INVALID'): Promise<string> {
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
  if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical);
  if (real !== lexical) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  assertInside(root, real);
  return readFile(real, 'utf8');
}

async function loadModuleReports(
  projectDir: string,
  module?: VerificationModule,
): Promise<{directory: string; summary: ModuleReportSummary}[]> {
  if (module !== undefined) assertVerificationModule(module);
  const found: {directory: string; summary: ModuleReportSummary}[] = [];
  for (const name of await readdir(projectDir)) {
    if (!MODULE_REPORT_DIR.test(name)) continue;
    if (module !== undefined && !name.endsWith(`-${module}`)) continue;
    const path = join(projectDir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    if (!info.isDirectory()) continue;
    const real = await realpath(path);
    if (real !== path) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    assertInside(projectDir, real);
    try {
      const text = await readTextInside(projectDir, join(real, 'run.json'), 'VERIFY_REPORT_INVALID');
      const parsed = ModuleReportSummary.safeParse(JSON.parse(text));
      if (!parsed.success || parsed.data.directoryName !== name) continue;
      if (module !== undefined && parsed.data.module !== module) continue;
      found.push({directory: real, summary: parsed.data});
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
  const raw = validateModuleCollectorObject(rawJson);
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

export async function removeModuleReport(
  dataDirectory: string,
  projectId: string,
  runId: string,
  module?: VerificationModule,
): Promise<void> {
  assertSafeSegment(projectId);
  assertSafeSegment(runId);
  const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
  if (!projectDir) return;
  const matches = (await loadModuleReports(projectDir, module)).filter(item => item.summary.id === runId);
  for (const match of matches) {
    assertInside(projectDir, match.directory);
    await rm(match.directory, {recursive: true, force: true});
  }
}

function assertReportOutsideRepo(repoPath: string, dataDirectory: string): void {
  const repo = resolve(repoPath);
  const data = resolve(dataDirectory);
  const rel = relative(repo, data);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (rel === '' || !outside) throw new Refusal('VERIFY_REPORT_INSIDE_REPO', 403);
}

function escapesRepo(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === '';
}

async function assertNoSymlinkAlongPath(repo: string, relativeFile: string): Promise<void> {
  let rootStat;
  try {
    rootStat = await lstat(repo);
  } catch {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  const root = await realpath(repo);
  const parts = relativeFile.split('/');
  let current = root;
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    current = join(current, part);
    if (escapesRepo(relative(root, current))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    }
    if (info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
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

async function readBoundedExcerpt(repo: string, relativeFile: string): Promise<{text: string; seen: boolean}> {
  const located = await locateRepoFile(repo, relativeFile);
  if (!located) return {text: 'codigo-nao-visto', seen: false};
  if (isSecretClassBasename(relativeFile)) return {text: `nome: ${relativeFile}`, seen: true};
  const handle = await open(located, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = (await handle.readFile({encoding: 'utf8'})).slice(0, 64_000);
    return {text: sanitizeText(raw).slice(0, EXCERPT_LIMIT), seen: true};
  } finally {
    await handle.close();
  }
}

function parseReviewerConfirm(raw: string): ConfirmResult {
  const trimmed = raw.trim().replace(/^\uFEFF/, '');
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Refusal('VERIFY_CONFIRMATION_INVALID', 503);
    try {
      value = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      throw new Refusal('VERIFY_CONFIRMATION_INVALID', 503);
    }
  }
  const parsed = ConfirmResult.safeParse(value);
  if (!parsed.success) throw new Refusal('VERIFY_CONFIRMATION_INVALID', 503);
  return parsed.data;
}

async function confirmFindingWithReviewer(
  input: VerificationModuleRunInput,
  intentId: string,
  finding: ModuleRawFinding,
  achadoId: string,
): Promise<{status: 'confirmado' | 'provavel' | 'descartado'; proof: string; verifier: {model: string; provider: string}}> {
  const excerpt = await readBoundedExcerpt(input.repoPath, finding.file);
  const task = buildModuleReviewPrompt({
    module: input.module,
    achadoId,
    tool: finding.tool,
    rule: finding.rule,
    file: finding.file,
    line: finding.line,
    evidence: finding.evidence,
    codeExcerpt: excerpt.text,
  });
  const capacity = new Capacity(input.ledger);
  let seat: {provider: string; model: string; accountId: string; profileId: string; grantId: string} | undefined;
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
  } catch {
    seat = undefined;
  }
  try {
    const call = VerifyWorkerCall.parse({
      role: 'reviewer',
      provider: seat?.provider ?? 'claude',
      accountId: seat?.accountId ?? '00000000-0000-4000-8000-000000000001',
      profileId: seat?.profileId ?? '00000000-0000-4000-8000-000000000002',
      model: seat?.model ?? 'claude-sonnet-5-5',
      grantId: seat?.grantId ?? '00000000-0000-4000-8000-000000000003',
      intentId,
      task,
      repo: input.repoPath,
      writePaths: [],
    });
    const output = await input.worker!.run(call);
    const confirm = parseReviewerConfirm(output);
    const combinedProof = [finding.evidence, confirm.proof, confirm.reason]
      .map(part => sanitizeText(part).trim())
      .filter((part, idx, arr) => part.length > 0 && arr.indexOf(part) === idx)
      .join('\n')
      .slice(0, 2000);
    return {
      status: confirm.status,
      proof: combinedProof || finding.evidence,
      verifier: {model: call.model, provider: call.provider},
    };
  } finally {
    if (seat) {
      await capacity.transition(input.principal, seat.grantId, input.authority, 'released', {processId: 'module-confirm', state: 'not_started'}).catch(() => undefined);
    }
  }
}

async function beginModuleRunTx(input: {
  ledger: Ledger;
  principal: string;
  authority: Authority;
  projectId: string;
  module: VerificationModule;
  commit: string;
  runId: string;
}): Promise<string> {
  const intentId = randomUUID();
  await input.ledger.tx(async c => {
    const context = await input.ledger.authorize(c, input.principal, input.authority.contextId);
    await input.ledger.fence(c, input.authority);
    if (context.project_id !== input.projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    const examBinding = await c.query<{module: string}>(
      'SELECT module FROM ac_exam_contexts WHERE project_id=$1 AND context_id=$2',
      [input.projectId, input.authority.contextId],
    );
    if (!examBinding.rowCount || examBinding.rows[0]?.module !== input.module) {
      throw new Refusal('EXAM_CONTEXT_MISMATCH', 403);
    }
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
      `INSERT INTO ac_verify_runs (id, project_id, context_id, intent_id, principal_id, commit_id, status, report_dir, module)
       VALUES ($1,$2,$3,$4,$5,$6,'running','pending',$7)`,
      [input.runId, input.projectId, input.authority.contextId, intentId, input.principal, input.commit, input.module],
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
  assertReportOutsideRepo(input.repoPath, input.dataDirectory);
  const runId = input.runId ?? randomUUID();
  if (!Id.safeParse(runId).success) throw new Refusal('INVALID_CONTRACT', 400);
  const createdAt = input.createdAt ?? new Date();
  const timeoutMs = input.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
  const maxStdoutBytes = input.maxStdoutBytes ?? MAX_COLLECTOR_STDOUT_BYTES;
  const needImage = input.collectorOutput === undefined && input.runCollector === undefined;
  const image = input.image !== undefined
    ? assertPinnedModuleImage(input.image)
    : needImage
      ? await readPinnedModuleImage(input.module, input.rootDir)
      : `sha256:${'0'.repeat(64)}`;

  const intentId = await beginModuleRunTx({
    ledger: input.ledger,
    principal: input.principal,
    authority: input.authority,
    projectId: input.projectId,
    module: input.module,
    commit: input.commit,
    runId,
  });

  try {
    const passiveTlsEvidence = input.passiveTlsEvidence !== undefined
      ? (() => {
          if (input.module !== 'prontidao') throw new Refusal('INVALID_CONTRACT', 400);
          return validatePassiveTlsEvidence(input.passiveTlsEvidence);
        })()
      : undefined;
    let collectorCode = 0;
    let collectorData: ModuleCollectorOutput;
    if (input.collectorOutput !== undefined) {
      collectorData = typeof input.collectorOutput === 'string' || Buffer.isBuffer(input.collectorOutput)
        ? parseModuleCollectorOutput(input.collectorOutput, {maxStdoutBytes})
        : validateModuleCollectorObject(input.collectorOutput);
    } else if (input.runCollector !== undefined) {
      const raw = await input.runCollector({
        module: input.module,
        image,
        repoPath: input.repoPath,
        commit: input.commit,
        timeoutMs,
        maxStdoutBytes,
        ...(passiveTlsEvidence !== undefined ? {passiveTlsEvidence} : {}),
      });
      collectorData = typeof raw === 'string' || Buffer.isBuffer(raw)
        ? parseModuleCollectorOutput(raw, {maxStdoutBytes})
        : validateModuleCollectorObject(raw);
    } else {
      const executed = await runModuleCollectorContainer({
        image,
        repoPath: input.repoPath,
        commit: input.commit,
        timeoutMs,
        maxStdoutBytes,
        ...(passiveTlsEvidence !== undefined ? {passiveTlsEvidence} : {}),
      });
      collectorCode = executed.code;
      collectorData = executed.output;
    }

    for (const finding of collectorData.findings) {
      await assertNoSymlinkAlongPath(input.repoPath, finding.file);
    }

    const toolVersions = new Map<string, string>();
    for (const row of collectorData.coverage) {
      if (!toolVersions.has(row.tool)) toolVersions.set(row.tool, row.version);
    }

    const achados: Achado[] = [];
    for (const finding of collectorData.findings) {
      const achadoId = `ACH-${String(achados.length + 1).padStart(3, '0')}`;
      const title = sanitizeText(`${finding.rule}: ${finding.message}`).slice(0, 200) || finding.rule;
      const reference = sanitizeText(`${finding.tool}:${finding.rule}`).slice(0, 200);
      let status: 'confirmado' | 'provavel' | 'descartado' = 'confirmado';
      let proof = sanitizeText(finding.evidence).slice(0, 2000);
      let verifier = {
        model: (toolVersions.get(finding.tool) ?? '1.0.0').slice(0, 100),
        provider: finding.tool.slice(0, 80),
      };
      if (input.worker) {
        const confirmed = await confirmFindingWithReviewer(input, intentId, finding, achadoId);
        status = confirmed.status;
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
        suggestion: 'Corrigir o ponto indicado no arquivo, adicionar teste de regressão e executar novamente o módulo.',
        acceptance: REMEDIATION_ACCEPTANCE,
        sources: [finding.tool.slice(0, 200), finding.rule.slice(0, 200)],
        secretPreview: null,
      }));
    }

    const repoFiles = await listExamFiles(input.repoPath).catch(() => [] as string[]);
    const allCoveredFiles = [...new Set([...repoFiles, ...collectorData.findings.map(item => item.file)])].sort();
    const checklistNames = [...new Set(collectorData.coverage.map(row => row.tool.slice(0, 80)))].slice(0, 80);
    const effectiveChecklist = checklistNames.length > 0 ? checklistNames : [input.module];
    const primaryToolVersion = collectorData.coverage[0]
      ? `${collectorData.coverage[0].tool}@${collectorData.coverage[0].version}`.slice(0, 100)
      : input.module;
    const fileCoverage: CoverageRow[] = (allCoveredFiles.length > 0 ? allCoveredFiles : ['README.md']).map(file =>
      CoverageRow.parse({
        file,
        examinerProvider: input.module,
        examinerModel: primaryToolVersion,
        profileId: DETERMINISTIC_MODULE_PROFILE_ID,
        checklist: effectiveChecklist,
      }),
    );

    const hasToolFailure = collectorCode !== 0 || collectorData.coverage.some(row => row.status === 'failed');
    const notes: string[] = [...(input.notes ?? [])];
    for (const failed of collectorData.coverage.filter(row => row.status === 'failed')) {
      notes.push(`Falha em ${failed.tool} (${failed.version}): ${failed.detail}`);
    }
    if (collectorCode !== 0 && !collectorData.coverage.some(row => row.status === 'failed')) {
      notes.push(`O coletor saiu com código ${collectorCode}.`);
    }
    const report = await writeModuleReport({
      dataDirectory: input.dataDirectory,
      projectId: input.projectId,
      module: input.module,
      runId,
      createdAt,
      commit: input.commit,
      toolCoverage: collectorData.coverage,
      fileCoverage,
      achados,
      raw: collectorData,
      ...(notes.length > 0 ? {note: notes.join(' ')} : {}),
    });

    const finalState: 'done' | 'failed' = hasToolFailure ? 'failed' : 'done';
    await input.ledger.tx(async c => {
      await input.ledger.authorize(c, input.principal, input.authority.contextId);
      await input.ledger.fence(c, input.authority);
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
          `INSERT INTO ac_verify_coverage (run_id, file, examiner_provider, examiner_model, profile_id, checklist)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [runId, row.file, row.examinerProvider, row.examinerModel, row.profileId, JSON.stringify(row.checklist)],
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
      const updated = await c.query(
        `UPDATE ac_verify_runs SET status=$2, report_dir=$3, finished_at=clock_timestamp()
         WHERE id=$1 AND context_id=$4 AND status='running'`,
        [runId, finalState, report.directory, input.authority.contextId],
      );
      if (!updated.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT');
      await finishExamIntentTx(c, input.ledger, {intentId, contextId: input.authority.contextId}, finalState);
    });

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
    try {
      await input.ledger.pool.query(
        "UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp() WHERE id=$1 AND status='running'",
        [runId],
      );
    } catch { /* preserve original failure */ }
    try {
      await finishExamIntent(input.ledger, {intentId, contextId: input.authority.contextId}, 'failed');
    } catch { /* preserve original failure */ }
    throw error;
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

function groupFindingsByFile(findings: readonly EligibleFinding[]): {file: string; items: EligibleFinding[]}[] {
  const sorted = [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
  const groups: {file: string; items: EligibleFinding[]}[] = [];
  for (const item of sorted) {
    const last = groups.at(-1);
    if (last?.file === item.file) last.items.push(item);
    else groups.push({file: item.file, items: [item]});
  }
  return groups;
}

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
    ...group.items.map(item => `- ${item.id} linha ${item.line ?? 'não informada'}`),
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
): Promise<{
  messageLocalId: string;
  writePaths: string[];
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
    const authContext = await ledger.authorize(client, principal, authority.contextId);
    if (authContext.project_id !== input.projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);

    const runRow = (await client.query<{
      id: string;
      project_id: string;
      context_id: string;
      module: string;
      intent_id: string;
      commit_id: string;
    }>(
      'SELECT id::text AS id, project_id::text AS project_id, context_id::text AS context_id, module, intent_id::text AS intent_id, commit_id FROM ac_verify_runs WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [input.runId, input.projectId],
    )).rows[0];
    if (!runRow) throw new Refusal('VERIFY_RUN_MISSING', 404);
    if (input.module !== undefined && runRow.module !== input.module) {
      throw new Refusal('VERIFY_RUN_MISSING', 404);
    }

    const mainRow = (await client.query<{id: string}>(
      `SELECT x.id::text AS id
       FROM ac_contexts x
       WHERE x.project_id=$1 AND NOT x.archived
         AND NOT EXISTS (SELECT 1 FROM ac_exam_contexts e WHERE e.context_id=x.id)
       ORDER BY x.created_at, x.id LIMIT 1`,
      [input.projectId],
    )).rows[0];
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
      if (!row || (row.status !== 'confirmado' && row.status !== 'reaberto')) {
        throw new Refusal('VERIFY_FINDING_MISSING', 404);
      }
      const file = assertModuleRepoRelativePath(String(row.file));
      if (!covered.has(file)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      const lineNum = row.line !== null && Number.isInteger(Number(row.line)) && Number(row.line) >= 1 ? Number(row.line) : null;
      const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
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
    for (const finding of findings) {
      if (!(await locateRepoFile(repo, finding.file))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    }

    const groups = groupFindingsByFile(findings);
    const writePaths = groups.map(group => group.file);
    const ids = findings.map(item => item.id);
    const regression = moduleRegressionText(runRow.module, ids);

    const existingRows = (await client.query<{
      message_local_id: string;
      write_paths: string[];
      finding_ids: string[];
      regression_test: string;
      acceptance: string;
    }>(
      'SELECT message_local_id, write_paths, finding_ids, regression_test, acceptance FROM ac_verify_remediations WHERE run_id=$1 FOR UPDATE',
      [runRow.id],
    )).rows;
    const match = existingRows.find(row => sameIdSet(row.finding_ids ?? [], ids));
    if (match) {
      return {
        messageLocalId: String(match.message_local_id),
        writePaths: [...match.write_paths].map(String),
        contextId: mainContextId,
        regressionTest: String(match.regression_test),
        acceptance: String(match.acceptance),
        projectId: input.projectId,
      };
    }

    const text = renderModuleRemediationTask({
      projectId: input.projectId,
      module: runRow.module,
      runId: runRow.id,
      groups,
      writePaths,
      regression,
    });
    const prefix = runRow.module === 'verify' ? 'verify-fix' : `module-${runRow.module}-fix`;
    const messageLocalId = `${prefix}-${runRow.id}-${digest(ids).slice(0, 12)}`;
    await client.query(
      `INSERT INTO ac_verify_remediations(id,run_id,finding_ids,message_local_id,write_paths,regression_test,acceptance)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), runRow.id, ids, messageLocalId, writePaths, regression, REMEDIATION_ACCEPTANCE],
    );
    await enqueuePersonalOwner(client, mainContextId, messageLocalId, text);
    if ((await readPersonalOwnerText(client, mainContextId, messageLocalId)) !== text) {
      throw new Refusal('CHAT_MESSAGE_CONFLICT');
    }
    if (authority.contextId !== mainContextId) {
      await enqueuePersonalOwner(client, authority.contextId, messageLocalId, text);
      if ((await readPersonalOwnerText(client, authority.contextId, messageLocalId)) !== text) {
        throw new Refusal('CHAT_MESSAGE_CONFLICT');
      }
    }
    return {
      messageLocalId,
      writePaths,
      contextId: mainContextId,
      regressionTest: regression,
      acceptance: REMEDIATION_ACCEPTANCE,
      projectId: input.projectId,
    };
  });
}

function replaceSituacao(markdown: string, status: 'fechado' | 'reaberto'): string {
  const pattern = /^([ \t]*-[ \t]*Situação:[ \t]*)(\S+)/m;
  if (!pattern.test(markdown)) return markdown;
  return markdown.replace(pattern, `$1${status}`);
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
    await writeFile(temporary, body, {mode: 0o600, flag: 'wx'});
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

async function updateModuleReportFiles(
  dataDirectory: string,
  projectId: string,
  runId: string,
  updates: readonly {id: string; status: 'fechado' | 'reaberto'}[],
): Promise<void> {
  const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
  if (!projectDir) return;
  const loaded = (await loadModuleReports(projectDir)).filter(item => item.summary.id === runId);
  const byId = new Map(updates.map(item => [item.id, item.status]));
  for (const report of loaded) {
    const achadosPath = join(report.directory, 'achados.json');
    const text = await readTextInside(report.directory, achadosPath, 'VERIFY_REPORT_INVALID');
    const parsed = JSON.parse(text) as {achados?: Array<Record<string, unknown>>};
    if (Array.isArray(parsed.achados)) {
      parsed.achados = parsed.achados.map(item => {
        const id = typeof item.id === 'string' ? item.id : '';
        const nextStatus = byId.get(id);
        return nextStatus ? {...item, status: nextStatus} : item;
      });
      await replacePrivateFile(report.directory, 'achados.json', `${JSON.stringify(parsed, null, 2)}\n`);
    }
    const achadosDir = join(report.directory, 'achados');
    for (const update of updates) {
      const mdPath = join(achadosDir, `${update.id}.md`);
      try {
        const mdText = await readTextInside(report.directory, mdPath, 'VERIFY_ACHADO_NOT_FOUND');
        await replacePrivateFile(dirname(mdPath), basename(mdPath), replaceSituacao(mdText, update.status));
      } catch (error) {
        if (error instanceof Refusal && error.code === 'VERIFY_ACHADO_NOT_FOUND') continue;
        throw error;
      }
    }
  }
}

/**
 * Rechecks findings for a module run using an independent reviewer worker.
 * The review task carries only the code excerpt, file, line, rule, and raw evidence — never the author's conclusion.
 */
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
    worker: VerifyWorker;
  },
): Promise<{results: {id: string; status: 'fechado' | 'reaberto'}[]}> {
  if (input.module !== undefined) assertVerificationModule(input.module);
  if (!Id.safeParse(input.runId).success || !Id.safeParse(input.projectId).success) {
    throw new Refusal('VERIFY_RUN_MISSING', 404);
  }
  await assertPersonalActivation(ledger);
  const requested = uniqueSortedIds(input.achadoIds);
  const loaded = await ledger.tx(async client => {
    const authContext = await ledger.authorize(client, principal, authority.contextId);
    if (authContext.project_id !== input.projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    const runRow = (await client.query<{
      id: string;
      context_id: string;
      module: string;
      intent_id: string;
      commit_id: string;
    }>(
      'SELECT id::text AS id, context_id::text AS context_id, module, intent_id::text AS intent_id, commit_id FROM ac_verify_runs WHERE id=$1 AND project_id=$2',
      [input.runId, input.projectId],
    )).rows[0];
    if (!runRow) throw new Refusal('VERIFY_RUN_MISSING', 404);
    if (input.module !== undefined && runRow.module !== input.module) throw new Refusal('VERIFY_RUN_MISSING', 404);
    if (authority.contextId !== runRow.context_id) throw new Refusal('VERIFY_RUN_MISSING', 404);
    const coveredRows = (await client.query<{file: string}>('SELECT file FROM ac_verify_coverage WHERE run_id=$1', [runRow.id])).rows;
    const covered = new Set(coveredRows.map(row => String(row.file)));
    const rows = (await client.query<{
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
    const byId = new Map(rows.map(row => [String(row.achado_id), row]));
    const items = requested.map(id => {
      const row = byId.get(id);
      if (!row) throw new Refusal('VERIFY_FINDING_MISSING', 404);
      const file = assertModuleRepoRelativePath(String(row.file));
      if (!covered.has(file)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      const line = row.line !== null && Number.isInteger(Number(row.line)) && Number(row.line) >= 1 ? Number(row.line) : 1;
      const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
      const sources = Array.isArray(payload.sources) ? payload.sources.map(String) : [];
      const tool = (sources[0] ?? runRow.module).slice(0, 120);
      const rule = (sources[1] ?? (typeof payload.reference === 'string' ? payload.reference : id)).slice(0, 200);
      const evidence = (typeof payload.proof === 'string' && payload.proof.trim().length > 0 ? payload.proof : id).slice(0, 2000);
      return {id, file, line, tool, rule, evidence};
    });
    const repoRow = (await client.query<{repo: string}>('SELECT repo FROM ac_project_repositories WHERE project_id=$1', [input.projectId])).rows[0];
    return {run: runRow, items, repo: repoRow?.repo ?? null};
  });

  const decided: {id: string; status: 'fechado' | 'reaberto'}[] = [];
  const moduleName = assertVerificationModule(loaded.run.module);
  for (const item of loaded.items) {
    const excerpt = loaded.repo ? await readBoundedExcerpt(loaded.repo, item.file) : {text: 'codigo-nao-visto', seen: false};
    const task = buildModuleReviewPrompt({
      module: moduleName,
      achadoId: item.id,
      tool: item.tool,
      rule: item.rule,
      file: item.file,
      line: item.line,
      evidence: item.evidence,
      codeExcerpt: excerpt.text,
    });
    const call = VerifyWorkerCall.parse({
      role: 'reviewer',
      provider: 'recheck',
      accountId: '00000000-0000-4000-8000-000000000001',
      profileId: '00000000-0000-4000-8000-000000000002',
      model: 'recheck',
      grantId: '00000000-0000-4000-8000-000000000003',
      intentId: loaded.run.intent_id,
      task,
      repo: 'sem-repositorio',
      writePaths: [],
    });
    const verdict = parseReviewerConfirm(await input.worker.run(call));
    const status: 'fechado' | 'reaberto' = verdict.status === 'descartado' && excerpt.seen ? 'fechado' : 'reaberto';
    decided.push({id: item.id, status});
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
  await updateModuleReportFiles(input.dataDirectory, input.projectId, loaded.run.id, decided);
  return {results: decided};
}
