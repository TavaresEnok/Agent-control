import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Capacity} from './capacity.ts';
import {Id, Refusal, type Authority} from './contracts.ts';
import {loadInstallation, readPrivateFile, type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {collectToolFindings} from './verify-collect.ts';
import {readCurrentVerifyDatabase} from './verify-db.ts';
import {attachInternalTarget, dynamicScanPlan} from './verify-dynamic.ts';
import {VERIFY_RUNTIME_BIN, verifyExamArguments} from './verify-image.ts';
import {type SecurityExamSupervisor} from './verify-native-launch.ts';
import {runSecurityVerification} from './verify-runtime.ts';
import type {VerifyWorker} from './verify-types.ts';

export const HOMOLOGATION_NOTE = 'Homologação declarada e não varrida: a imagem não tem ZAP, Nuclei nem Schemathesis.';

const EXAM_MEMORY_BYTES = 2_147_483_648;
const EXAM_NANO_CPUS = 1_000_000_000;
const EXAM_PIDS = 256;
/** Six hours. A full exam finished in about three, so this is the ceiling. */
export const EXAM_TIME_LIMIT_MS = 21_600_000;

export type ToolRun = (spec: {image: string; repository: string; databases: string; output: string}) => Promise<void>;

export type PersonalVerificationInput = {
  installationPath?: string;
  projectId: string;
  url?: string;
  dataDirectory: string;
  repoPath: string;
  commit?: string;
  ledger?: Ledger;
  principal?: string;
  authority?: Authority;
  policyRevision?: number;
  worker?: VerifyWorker;
  runTools?: ToolRun;
  observe?: (job: Promise<void>) => void;
  databasesDirectory?: string;
  image?: string;
  modelCalls?: {count: number};
  timeLimitMs?: number;
  networkRunner?: (args: readonly string[]) => Promise<{code: number; stdout: string}>;
};

export type VerificationProgress = {
  id: string;
  status: string;
  phase: string;
  startedAt: string;
  note?: string;
  modelCalls?: number;
  durationMs?: number;
};

type ReadyVerification = {
  projectId: string;
  url?: string;
  dataDirectory: string;
  repoPath: string;
  commit: string;
  ledger: Ledger;
  principal: string;
  authority: Authority;
  policyRevision: number;
  worker: VerifyWorker;
  runTools?: ToolRun;
  databasesDirectory: string;
  image: string;
  modelCalls?: {count: number};
  timeLimitMs: number;
};

type ProgressState = {
  id: string;
  status: 'running' | 'done' | 'failed';
  phase: string;
  startedAt: string;
  note?: string;
  modelCalls?: number;
  durationMs?: number;
};

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function assertSafeSegment(value: string): void {
  if (value.length === 0 || value.length > 240 || value === '.' || value === '..' || value.includes('..') || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
}

function requireReady(input: PersonalVerificationInput): ReadyVerification {
  if (!input.ledger || !input.principal || !input.authority || !input.worker) throw new Refusal('VERIFY_INPUT_INCOMPLETE', 400);
  if (typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)) throw new Refusal('VERIFY_COMMIT_INVALID', 400);
  if (typeof input.policyRevision !== 'number' || !Number.isInteger(input.policyRevision) || input.policyRevision < 1) throw new Refusal('VERIFY_INPUT_INCOMPLETE', 400);
  if (typeof input.image !== 'string' || input.image.length < 1) throw new Refusal('VERIFY_IMAGE_UNPINNED');
  if (typeof input.databasesDirectory !== 'string' || input.databasesDirectory.length < 1) throw new Refusal('VERIFY_DB_REQUIRED', 409);
  if (typeof input.dataDirectory !== 'string' || typeof input.repoPath !== 'string') throw new Refusal('VERIFY_INPUT_INCOMPLETE', 400);
  assertSafeSegment(input.projectId);
  return {
    projectId: input.projectId,
    url: input.url,
    dataDirectory: input.dataDirectory,
    repoPath: input.repoPath,
    commit: input.commit,
    ledger: input.ledger,
    principal: input.principal,
    authority: input.authority,
    policyRevision: input.policyRevision,
    worker: input.worker,
    runTools: input.runTools,
    databasesDirectory: input.databasesDirectory,
    image: input.image,
    modelCalls: input.modelCalls,
    timeLimitMs: chosenTimeLimit(input.timeLimitMs),
  };
}

function chosenTimeLimit(value: number | undefined): number {
  if (value === undefined) return EXAM_TIME_LIMIT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Refusal('VERIFY_LIMITS_INVALID');
  return value;
}

function assertExamDeadline(startedMs: number, limitMs: number): void {
  if (Date.now() >= startedMs + limitMs) throw new Error('VERIFY_EXAM_TIMEOUT');
}

function workerWithDeadline(worker: VerifyWorker, startedMs: number, limitMs: number): VerifyWorker {
  return {
    async run(call) {
      assertExamDeadline(startedMs, limitMs);
      return worker.run(call);
    },
  };
}

async function ensureTree(root: string, segments: readonly string[]): Promise<string> {
  let current = resolve(root);
  for (const segment of segments) {
    assertSafeSegment(segment);
    current = join(current, segment);
    try {
      await mkdir(current, {mode: 0o700});
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    await chmod(current, 0o700);
  }
  return current;
}

async function writePrivateFile(path: string, body: string): Promise<void> {
  await writeFile(path, body, {encoding: 'utf8', mode: 0o600});
  await chmod(path, 0o600);
}

function renderProgress(state: ProgressState): string {
  const body: Record<string, unknown> = {
    id: state.id,
    status: state.status,
    phase: state.phase,
    startedAt: state.startedAt,
  };
  if (state.note) body.note = state.note;
  if (state.modelCalls !== undefined) body.modelCalls = state.modelCalls;
  if (state.durationMs !== undefined) body.durationMs = state.durationMs;
  return `${JSON.stringify(body)}\n`;
}

function runArguments(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error?: Refusal) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolvePromise();
    };
    const child = spawn(args[0] ?? '', [...args.slice(1)], {stdio: 'inherit'});
    child.once('error', () => finish(new Refusal('VERIFY_TOOLS_FAILED')));
    child.once('close', code => finish(code === 0 ? undefined : new Refusal('VERIFY_TOOLS_FAILED')));
  });
}

function defaultNetworkRunner(args: readonly string[]): Promise<{code: number; stdout: string}> {
  return new Promise(resolvePromise => {
    let settled = false;
    let stdout = '';
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolvePromise({code, stdout});
    };
    const child = spawn(args[0] ?? VERIFY_RUNTIME_BIN, [...args.slice(1)], {stdio: ['ignore', 'pipe', 'ignore']});
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.once('error', () => finish(1));
    child.once('close', code => finish(code ?? 1));
  });
}

/** The exam user is not the directory owner, so the mount is widened only while the process runs. */
async function defaultRunTools(spec: {image: string; repository: string; databases: string; output: string}): Promise<void> {
  const args = verifyExamArguments({
    image: spec.image,
    repository: spec.repository,
    databases: spec.databases,
    output: spec.output,
    memoryBytes: EXAM_MEMORY_BYTES,
    nanoCpus: EXAM_NANO_CPUS,
    pidsLimit: EXAM_PIDS,
  });
  await chmod(spec.output, 0o777);
  try {
    await runArguments(args);
  } finally {
    await chmod(spec.output, 0o700);
  }
}

async function runJob(input: {
  ready: ReadyVerification;
  id: string;
  output: string;
  progressPath: string;
  state: ProgressState;
  modelCalls: {count: number};
  startedMs: number;
}): Promise<void> {
  const {ready, id, output, progressPath, state, modelCalls, startedMs} = input;
  const onPhase = async (phase: 'mapa' | 'exame' | 'confirmacao' | 'relatorio') => {
    state.phase = phase;
    await writePrivateFile(progressPath, renderProgress(state));
  };
  try {
    const runTools = ready.runTools ?? defaultRunTools;
    assertExamDeadline(startedMs, ready.timeLimitMs);
    await runTools({image: ready.image, repository: ready.repoPath, databases: ready.databasesDirectory, output});
    const collected = await collectToolFindings(output);
    assertExamDeadline(startedMs, ready.timeLimitMs);
    await runSecurityVerification({
      ledger: ready.ledger,
      principal: ready.principal,
      authority: ready.authority,
      projectId: ready.projectId,
      repoPath: ready.repoPath,
      dataDirectory: ready.dataDirectory,
      commit: ready.commit,
      policyRevision: ready.policyRevision,
      worker: workerWithDeadline(ready.worker, startedMs, ready.timeLimitMs),
      rawFindings: collected.findings,
      runId: id,
      onPhase,
      modelCalls,
      notes: state.note ? [state.note] : undefined,
    });
    state.status = 'done';
    state.phase = 'done';
    state.modelCalls = modelCalls.count;
    state.durationMs = Date.now() - startedMs;
    await writePrivateFile(progressPath, renderProgress(state));
  } catch (error) {
    try {
      state.status = 'failed';
      state.phase = 'failed';
      state.modelCalls = modelCalls.count;
      state.durationMs = Date.now() - startedMs;
      await writePrivateFile(progressPath, renderProgress(state));
    } catch { /* the original failure stays visible */ }
    throw error;
  }
}

export async function beginPersonalVerification(input: PersonalVerificationInput): Promise<{id: string; status: 'running'; phase: string}> {
  const startedMs = Date.now();
  const plan = input.url !== undefined ? dynamicScanPlan(input.url) : undefined;
  const ready = requireReady(input);
  const id = randomUUID();
  if (plan && plan.allowedHost !== '127.0.0.1' && plan.allowedHost !== 'localhost') {
    const hex = id.replaceAll('-', '').slice(0, 8);
    if (!/^[a-f0-9]{8}$/.test(hex)) throw new Refusal('VERIFY_NETWORK_FORBIDDEN');
    await attachInternalTarget({
      network: `verify-homologation-${hex}`,
      container: plan.allowedHost,
      run: input.networkRunner ?? defaultNetworkRunner,
    });
  }
  const state: ProgressState = {
    id,
    status: 'running',
    phase: 'ferramentas',
    startedAt: new Date(startedMs).toISOString(),
    note: ready.url ? HOMOLOGATION_NOTE : undefined,
  };
  const modelCalls = ready.modelCalls ?? {count: 0};
  const progressDir = await ensureTree(ready.dataDirectory, ['verificacoes', ready.projectId, 'andamento']);
  const output = await ensureTree(ready.dataDirectory, ['verificacoes', ready.projectId, 'ferramentas', id]);
  const progressPath = join(progressDir, `${id}.json`);
  await writePrivateFile(progressPath, renderProgress(state));
  const job = runJob({ready, id, output, progressPath, state, modelCalls, startedMs});
  input.observe?.(job);
  void job.catch(() => undefined);
  return {id, status: 'running', phase: 'ferramentas'};
}

export async function readVerificationProgress(dataDirectory: string, projectId: string): Promise<VerificationProgress[]> {
  assertSafeSegment(projectId);
  const directory = join(resolve(dataDirectory), 'verificacoes', projectId, 'andamento');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return [];
    throw error;
  }
  const rows: VerificationProgress[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(directory, name), 'utf8'));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const row = parsed as Record<string, unknown>;
    if (typeof row.id !== 'string' || typeof row.status !== 'string' || typeof row.phase !== 'string' || typeof row.startedAt !== 'string') continue;
    const item: VerificationProgress = {id: row.id, status: row.status, phase: row.phase, startedAt: row.startedAt};
    if (typeof row.note === 'string') item.note = row.note;
    if (typeof row.modelCalls === 'number' && Number.isFinite(row.modelCalls)) item.modelCalls = row.modelCalls;
    if (typeof row.durationMs === 'number' && Number.isFinite(row.durationMs)) item.durationMs = row.durationMs;
    rows.push(item);
  }
  rows.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
  return rows;
}

function parseVerifyArgs(argv: readonly string[]): {installationPath: string; projectId: string; url?: string} {
  const positional: string[] = [];
  let url: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--url') {
      const value = argv[index + 1];
      if (url !== undefined || value === undefined || value.startsWith('--')) throw new Refusal('VERIFY_USAGE');
      url = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Refusal('VERIFY_USAGE');
    positional.push(arg);
  }
  const installationPath = positional[0];
  const projectId = positional[1];
  if (!installationPath || !projectId || positional.length !== 2) throw new Refusal('VERIFY_USAGE');
  if (!Id.safeParse(projectId).success) throw new Refusal('NOT_FOUND', 404);
  return {installationPath, projectId, url};
}

function readHead(repoPath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('/usr/bin/git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    }, (error, stdout) => {
      const commit = (stdout ?? '').trim();
      if (error || !/^[a-f0-9]{40}$/.test(commit)) reject(new Refusal('VERIFY_COMMIT_INVALID', 400));
      else resolvePromise(commit);
    });
  });
}

async function readPinnedImage(dataDirectory: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readPrivateFile(join(dataDirectory, 'verify-image.json'))).toString('utf8'));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? (error as {code?: unknown}).code : undefined;
    if (code === 'ENOENT' || error instanceof SyntaxError) throw new Refusal('VERIFY_IMAGE_UNPINNED');
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as {image?: unknown}).image !== 'string' || (parsed as {image: string}).image.length < 1) {
    throw new Refusal('VERIFY_IMAGE_UNPINNED');
  }
  return (parsed as {image: string}).image;
}

async function releaseCapacityGrant(ledger: Ledger, principal: string, authority: Authority, grantId: string, how: 'not_started' | 'exited'): Promise<void> {
  const capacity = new Capacity(ledger);
  const first = how === 'not_started' ? 'not_started' : 'exited';
  const second = first === 'not_started' ? 'exited' : 'not_started';
  try {
    await capacity.transition(principal, grantId, authority, 'released', {processId: grantId, state: first});
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== 'PROCESS_MUST_EXIT') throw error;
    await capacity.transition(principal, grantId, authority, 'released', {processId: grantId, state: second});
  }
}

async function acquirePersonalVerify(ledger: Ledger, principal: string, contextId: string): Promise<Authority> {
  const instanceId = randomUUID();
  try {
    return await ledger.acquire(principal, contextId, instanceId, 'personal-verify', 3600);
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== 'INVALID_LEASE') throw error;
    return ledger.acquire(principal, contextId, instanceId, 'personal-verify', 60);
  }
}

function projectOf(config: Installation, projectId: string) {
  return [config.project, ...config.projects].find(item => item.id === projectId);
}

export async function resolvePersonalVerification(argv: readonly string[]): Promise<{input: PersonalVerificationInput; close: () => Promise<void>}> {
  const parsed = parseVerifyArgs(argv);
  if (parsed.url !== undefined) dynamicScanPlan(parsed.url);
  const config = await loadInstallation(resolve(parsed.installationPath));
  if (config.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const project = projectOf(config, parsed.projectId);
  if (!project) throw new Refusal('NOT_FOUND', 404);
  const ledger = new Ledger(config.databaseUrl);
  try {
    const found = await ledger.pool.query<{id: string; policy_revision: number | string}>(
      'SELECT id::text AS id, policy_revision FROM ac_contexts WHERE project_id=$1 ORDER BY created_at LIMIT 1',
      [project.id],
    );
    const row = found.rows[0];
    if (!row?.id) throw new Refusal('VERIFY_CONTEXT_REQUIRED', 409);
    const policyRevision = Number(row.policy_revision);
    if (!Number.isInteger(policyRevision) || policyRevision < 1) throw new Refusal('VERIFY_CONTEXT_REQUIRED', 409);
    const commit = await readHead(project.repo);
    const principal = project.owner;
    const authority = await acquirePersonalVerify(ledger, principal, row.id);
    const {composePersonalRuntime} = await import('./personal-runtime.ts');
    const runtime = await composePersonalRuntime(config, ledger);
    if (!runtime) throw new Refusal('VERIFY_WORKER_UNAVAILABLE', 503);
    const {createCapacityNativeWorker} = await import('./verify-native-launch.ts');
    const worker = createCapacityNativeWorker({
      supervisors: runtime.executions as unknown as readonly SecurityExamSupervisor[],
      ledger,
      principal,
      authority,
      base: commit,
      releaseGrant: (grantId, how) => releaseCapacityGrant(ledger, principal, authority, grantId, how),
    });
    const image = await readPinnedImage(config.dataDirectory);
    const databases = await readCurrentVerifyDatabase(config.dataDirectory);
    if (!databases) throw new Refusal('VERIFY_DB_REQUIRED', 409);
    return {
      input: {
        installationPath: resolve(parsed.installationPath),
        projectId: project.id,
        url: parsed.url,
        dataDirectory: config.dataDirectory,
        repoPath: project.repo,
        commit,
        ledger,
        principal,
        authority,
        policyRevision,
        worker,
        databasesDirectory: databases.directory,
        image,
        modelCalls: {count: 0},
      },
      close: () => ledger.close(),
    };
  } catch (error) {
    await ledger.close();
    throw error;
  }
}
