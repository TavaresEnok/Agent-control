import {assertDiskSpaceForLaunch,installationVolumes,launchVolumesOf} from './personal-disk.ts';
import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {Capacity} from './capacity.ts';
import {Id, Refusal, type Authority} from './contracts.ts';
import {examLoginBusyNote, examLoginStaleNote} from './exam-login.ts';
import {loadInstallation, readPrivateFile, type Installation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {endRound, trackRoundTemp, type RoundScope} from './personal-artifact-hooks.ts';
import {personalAccountRoot} from './personal-health.ts';
import {collectToolFindings} from './verify-collect.ts';
import {claimVerifyDatabaseStamp, readCurrentVerifyDatabase, releaseVerifyDatabaseStamp} from './verify-db.ts';
import {attachInternalTarget, dynamicScanPlan} from './verify-dynamic.ts';
import {VERIFY_RUNTIME_BIN, verifyExamArguments} from './verify-image.ts';
import {isCapacityNativeWorker, type SecurityExamSupervisor} from './verify-native-launch.ts';
import {
  runResolvedPersonalSecurityVerification,
  runSecurityVerification,
  type SecurityVerificationInput,
} from './verify-runtime.ts';
import type {VerifyWorker} from './verify-types.ts';

export const HOMOLOGATION_NOTE = 'Homologação declarada e não varrida: a imagem não tem ZAP, Nuclei nem Schemathesis.';

const EXAM_MEMORY_BYTES = 2_147_483_648;
const EXAM_NANO_CPUS = 1_000_000_000;
const EXAM_PIDS = 256;
/** Six hours. A full exam finished in about three, so this is the ceiling. */
export const EXAM_TIME_LIMIT_MS = 21_600_000;
/** Docker network create, inspect, connect, disconnect and rm. */
export const NETWORK_COMMAND_TIMEOUT_MS = 30_000;
const ARCHIVE_TIMEOUT_MS = 60_000;

export type ToolRun = (spec: {image: string; repository: string; databases: string; output: string; staticPersonalExam?: true; retention?: RoundScope}) => Promise<void>;
type NetworkRunner = (args: readonly string[]) => Promise<{code: number; stdout: string}>;
const STAMP_DIRECTORY = /^\d{8}-\d{6}(?:-\d+)?$/;

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
  modelCallBudget?: number;
  mapEnabled?: boolean;
  accountRoot?: string;
  timeLimitMs?: number;
  networkRunner?: NetworkRunner;
};

/**
 * Static CLI policy capability for module 1. It is issued only by `resolvePersonalVerification` without `--url`,
 * to the native capacity worker built there, and the only wrapper created for it is the deadline guard in `runJob`.
 * The runtime can ask whether a worker holds it, never issue it.
 */
type StaticCliPolicyGrant = Readonly<{nativeWorker: VerifyWorker; projectId: string; contextId: string; commit: string}>;
const staticPolicyWorkers = new WeakMap<VerifyWorker, StaticCliPolicyGrant>();

function issueStaticCliPolicy(input: {url?: string} & StaticCliPolicyGrant): void {
  if (input.url !== undefined) throw new Refusal('VERIFY_STATIC_POLICY_UNAUTHORIZED', 403);
  if (!isCapacityNativeWorker(input.nativeWorker)) throw new Refusal('VERIFY_WORKER_UNAVAILABLE', 503);
  staticPolicyWorkers.set(input.nativeWorker, Object.freeze({
    nativeWorker: input.nativeWorker,
    projectId: input.projectId,
    contextId: input.contextId,
    commit: input.commit,
  }));
}

/** Grant held by this worker for exactly this project, context and commit, or null. */
function heldStaticCliPolicy(input: {
  worker: VerifyWorker;
  projectId: string;
  commit: string;
  authority: {contextId: string};
}): StaticCliPolicyGrant | null {
  const grant = staticPolicyWorkers.get(input.worker);
  if (
    !grant
    || grant.projectId !== input.projectId
    || grant.contextId !== input.authority.contextId
    || grant.commit !== input.commit
    || !isCapacityNativeWorker(grant.nativeWorker)
  ) {
    return null;
  }
  return grant;
}

/** The only thing the runtime imports about the capability: the native worker and context a worker is authorized for. */
export function authorizedStaticCliPolicy(input: {
  worker: VerifyWorker;
  projectId: string;
  commit: string;
  authority: {contextId: string};
}): {nativeWorker: VerifyWorker; contextId: string} | null {
  const grant = heldStaticCliPolicy(input);
  return grant ? {nativeWorker: grant.nativeWorker, contextId: grant.contextId} : null;
}

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
  modelCallBudget?: number;
  mapEnabled?: boolean;
  accountRoot?: string;
  timeLimitMs: number;
  staticPolicy?: StaticCliPolicyGrant;
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
    mapEnabled: input.mapEnabled,
    modelCallBudget: typeof input.modelCallBudget === 'number' ? input.modelCallBudget : undefined,
    accountRoot: typeof input.accountRoot === 'string' && input.accountRoot.length > 0 ? input.accountRoot : undefined,
    timeLimitMs: chosenTimeLimit(input.timeLimitMs),
    staticPolicy: input.url === undefined
      ? heldStaticCliPolicy({worker: input.worker, projectId: input.projectId, commit: input.commit, authority: input.authority}) ?? undefined
      : undefined,
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

/** Deadline guard. When the worker holds the static policy, the guard it returns inherits it, and no other wrapper does. */
function workerWithDeadline(worker: VerifyWorker, startedMs: number, limitMs: number): VerifyWorker {
  const guard: VerifyWorker = {
    async run(call) {
      assertExamDeadline(startedMs, limitMs);
      return worker.run(call);
    },
  };
  const grant = staticPolicyWorkers.get(worker);
  if (grant) staticPolicyWorkers.set(guard, grant);
  return guard;
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

export function runBoundedCommand(args: readonly string[], timeoutMs: number): Promise<{code: number; stdout: string}> {
  return new Promise(resolvePromise => {
    let settled = false;
    let stdout = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({code, stdout});
    };
    const child = spawn(args[0] ?? '', [...args.slice(1)], {stdio: ['ignore', 'pipe', 'ignore']});
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124);
    }, timeoutMs);
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.once('error', () => finish(1));
    child.once('close', code => finish(code === 0 ? 0 : (code ?? 1)));
  });
}

function runArguments(args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Refusal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise();
    };
    const child = spawn(args[0] ?? '', [...args.slice(1)], {stdio: 'inherit'});
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Refusal('VERIFY_TOOLS_FAILED'));
    }, timeoutMs);
    child.once('error', () => finish(new Refusal('VERIFY_TOOLS_FAILED')));
    child.once('close', code => finish(code === 0 ? undefined : new Refusal('VERIFY_TOOLS_FAILED')));
  });
}

function defaultNetworkRunner(args: readonly string[]): Promise<{code: number; stdout: string}> {
  return runBoundedCommand(args, NETWORK_COMMAND_TIMEOUT_MS);
}

const GIT_ARCHIVE_ENV = {
  PATH: '/usr/bin:/bin',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
  GIT_TERMINAL_PROMPT: '0',
};

function extractGitArchive(repo: string, commit: string, destination: string, staticPersonalExam: boolean): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const git = spawn('/usr/bin/git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...(staticPersonalExam ? ['-c', 'tar.umask=0022'] : []), 'archive', '--format=tar', commit], {
      env: GIT_ARCHIVE_ENV,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tar = spawn('/usr/bin/tar', ['-x', ...(staticPersonalExam ? ['--same-permissions'] : []), '-C', destination, '-f', '-'], {
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

/** Git archive of the examined commit. The directory is mode 0700 and is not the live tree.
 * With `retention` the private parent folder is recorded for the round, so a crash that skips the cleanup does not leave it
 * forever. Only the personal exam (`staticPersonalExam`) is recorded: there the mounted checkout is a child of the folder, so
 * the owner marker never enters the examined tree. Recording never fails the snapshot. */
export async function prepareExamSnapshot(repoPath: string, commit: string, staticPersonalExam = false, retention?: RoundScope): Promise<string> {
  if (typeof repoPath !== 'string' || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Refusal('VERIFY_COMMIT_INVALID', 400);
  }
  const repo = resolve(repoPath);
  const snapshot = await mkdtemp(join(tmpdir(), 'ac-verify-snapshot-'));
  await chmod(snapshot, 0o700);
  const rel = relative(repo, snapshot);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) {
    await rm(snapshot, {recursive: true, force: true});
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
  if (retention && staticPersonalExam) await trackRoundTemp(retention, snapshot);
  try {
    // Docker mounts the inner checkout by path. The host keeps its enclosing directory private.
    const checkout = staticPersonalExam ? join(snapshot, 'repository') : snapshot;
    if (staticPersonalExam) await mkdir(checkout, {mode: 0o700});
    await extractGitArchive(repo, commit, checkout, staticPersonalExam);
    if (staticPersonalExam) await chmod(checkout, 0o755);
    await chmod(snapshot, 0o700);
    return snapshot;
  } catch (error) {
    await rm(snapshot, {recursive: true, force: true});
    throw error;
  }
}

/** The exam user is not the directory owner, so the mount is widened only while the process runs. */
export async function defaultRunTools(
  spec: {image: string; repository: string; databases: string; output: string; commit: string; staticPersonalExam?: true; retention?: RoundScope},
  timeLimitMs: number = EXAM_TIME_LIMIT_MS,
  execute?: (args: readonly string[]) => Promise<void>,
): Promise<void> {
  const snapshot = await prepareExamSnapshot(spec.repository, spec.commit, spec.staticPersonalExam, spec.retention);
  try {
    const args = verifyExamArguments({
      image: spec.image,
      repository: spec.staticPersonalExam ? join(snapshot, 'repository') : snapshot,
      databases: spec.databases,
      output: spec.output,
      memoryBytes: EXAM_MEMORY_BYTES,
      nanoCpus: EXAM_NANO_CPUS,
      pidsLimit: EXAM_PIDS,
    });
    await chmod(spec.output, 0o777);
    try {
      await (execute ?? (command => runArguments(command, timeLimitMs)))(args);
    } finally {
      await chmod(spec.output, 0o700);
    }
  } finally {
    await rm(snapshot, {recursive: true, force: true});
  }
}

function claimableDatabaseStamp(dataDirectory: string, databasesDirectory: string): string | undefined {
  if (!isAbsolute(dataDirectory) || !isAbsolute(databasesDirectory) || dataDirectory.includes('\0') || databasesDirectory.includes('\0')) return undefined;
  const parent = join(resolve(dataDirectory), 'verify-db');
  const stamp = resolve(databasesDirectory);
  if (stamp === parent || !stamp.startsWith(parent + sep)) return undefined;
  const name = stamp.slice(parent.length + 1);
  if (!STAMP_DIRECTORY.test(name)) return undefined;
  return stamp;
}

async function claimExamDatabase(dataDirectory: string, databasesDirectory: string, runId: string): Promise<string | undefined> {
  const stamp = claimableDatabaseStamp(dataDirectory, databasesDirectory);
  if (!stamp) return undefined;
  await claimVerifyDatabaseStamp(dataDirectory, stamp, runId);
  return stamp;
}

async function releaseExamDatabase(dataDirectory: string, stamp: string | undefined, runId: string): Promise<void> {
  if (!stamp) return;
  await releaseVerifyDatabaseStamp(dataDirectory, stamp, runId);
}

async function homologationContainers(installationPath: string | undefined): Promise<readonly string[]> {
  if (!installationPath) return [];
  const config = await loadInstallation(installationPath);
  return config.verifyHomologationContainers ?? [];
}

async function assertVerificationAvailable(ready: ReadyVerification): Promise<void> {
  const pool = ready.ledger.pool as {query?: (sql: string, params: readonly unknown[]) => Promise<{rows?: unknown; rowCount?: unknown}>} | undefined;
  if (typeof pool?.query === 'function') {
    const found = await pool.query(
      "SELECT 1 AS present FROM ac_verify_runs WHERE project_id = $1 AND status = 'running' LIMIT 1",
      [ready.projectId],
    );
    const rows = found?.rows;
    const rowCount = found?.rowCount;
    if ((Array.isArray(rows) && rows.length > 0) || (typeof rowCount === 'number' && rowCount > 0)) {
      throw new Refusal('VERIFY_ALREADY_RUNNING', 409);
    }
  }
  const progress = await readVerificationProgress(ready.dataDirectory, ready.projectId);
  if (progress.some(row => row.status === 'running')) throw new Refusal('VERIFY_ALREADY_RUNNING', 409);
}

async function releaseRunningLock(path: string, id: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return;
    const body = await readFile(path, 'utf8');
    if (body !== id) return;
    await rm(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
}

async function removeHomologationNetwork(network: string, container: string, run: NetworkRunner): Promise<void> {
  try {
    await run([VERIFY_RUNTIME_BIN, 'network', 'disconnect', network, container]);
  } catch { /* disconnect is best-effort */ }
  try {
    await run([VERIFY_RUNTIME_BIN, 'network', 'rm', network]);
  } catch { /* removal must not hide the exam result */ }
}

async function attachHomologation(network: string, container: string, run: NetworkRunner): Promise<void> {
  let attached = false;
  try {
    await attachInternalTarget({network, container, run});
    attached = true;
  } finally {
    if (!attached) await removeHomologationNetwork(network, container, run);
  }
}

async function removeExamOutput(dataDirectory: string, projectId: string, output: string): Promise<void> {
  const project = resolve(dataDirectory, 'verificacoes', projectId);
  const target = resolve(output);
  const rel = relative(project, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  const real = await realpath(target);
  if (real !== target) return;
  const relReal = relative(project, real);
  if (relReal === '' || relReal === '..' || relReal.startsWith(`..${sep}`) || isAbsolute(relReal)) return;
  await rm(real, {recursive: true});
}

async function runJob(input: {
  ready: ReadyVerification;
  id: string;
  output: string;
  progressPath: string;
  state: ProgressState;
  modelCalls: {count: number};
  startedMs: number;
  lockPath: string;
  databaseStamp?: string;
  network?: string;
  container?: string;
  networkRunner: NetworkRunner;
}): Promise<void> {
  const {ready, id, output, progressPath, state, modelCalls, startedMs} = input;
  const onPhase = async (phase: 'mapa' | 'exame' | 'confirmacao' | 'relatorio') => {
    state.phase = phase;
    await writePrivateFile(progressPath, renderProgress(state));
  };
  try {
    try {
      const runTools: ToolRun = ready.runTools ?? (spec => defaultRunTools({...spec, commit: ready.commit}, ready.timeLimitMs));
      assertExamDeadline(startedMs, ready.timeLimitMs);
      await runTools({image: ready.image, repository: ready.repoPath, databases: ready.databasesDirectory, output,
        ...(ready.staticPolicy ? {staticPersonalExam: true} : {}),
        retention: {dataDirectory: ready.dataDirectory, projectId: ready.projectId, roundId: id},
      });
      const collected = await collectToolFindings(output);
      assertExamDeadline(startedMs, ready.timeLimitMs);
      const verification: SecurityVerificationInput & {modelCallBudget?: number} = {
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
        mapEnabled: ready.mapEnabled,
        notes: state.note ? [state.note] : undefined,
      };
      if (ready.modelCallBudget !== undefined) verification.modelCallBudget = ready.modelCallBudget;
      if (ready.accountRoot) verification.accountRoot = ready.accountRoot;
      if (ready.staticPolicy) {
        await runResolvedPersonalSecurityVerification(verification);
      } else {
        await runSecurityVerification(verification);
      }
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
        const stale = examLoginStaleNote(error) ?? examLoginBusyNote(error);
        if (stale) state.note = stale;
        await writePrivateFile(progressPath, renderProgress(state));
        await removeExamOutput(ready.dataDirectory, ready.projectId, output);
      } catch { /* the original failure stays visible */ }
      throw error;
    }
  } finally {
    // The job reached its end (done or failed) and the snapshot was removed by the tool run: leftovers may now age out.
    await endRound({dataDirectory: ready.dataDirectory, projectId: ready.projectId, roundId: id});
    try { await releaseExamDatabase(ready.dataDirectory, input.databaseStamp, id); }
    catch { /* the exam result stays visible */ }
    try { await releaseRunningLock(input.lockPath, id); }
    catch { /* the exam result stays visible */ }
    if (input.network && input.container) {
      try { await removeHomologationNetwork(input.network, input.container, input.networkRunner); }
      catch { /* the exam result stays visible */ }
    }
  }
}

export async function beginPersonalVerification(input: PersonalVerificationInput): Promise<{id: string; status: 'running'; phase: string}> {
  const startedMs = Date.now();
  const plan = input.url !== undefined ? dynamicScanPlan(input.url) : undefined;
  const ready = requireReady(input);
  await assertDiskSpaceForLaunch(launchVolumesOf(ready.ledger, ready.dataDirectory));
  await assertVerificationAvailable(ready);
  const id = randomUUID();
  const networkRunner = input.networkRunner ?? defaultNetworkRunner;
  const needsNetwork = plan !== undefined && plan.allowedHost !== '127.0.0.1' && plan.allowedHost !== 'localhost';
  let network: string | undefined;
  let container: string | undefined;
  if (needsNetwork && plan) {
    const allowed = await homologationContainers(input.installationPath);
    if (!allowed.includes(plan.allowedHost)) throw new Refusal('VERIFY_TARGET_FORBIDDEN', 403);
    const hex = id.replaceAll('-', '').slice(0, 8);
    if (!/^[a-f0-9]{8}$/.test(hex)) throw new Refusal('VERIFY_NETWORK_FORBIDDEN');
    network = `verify-homologation-${hex}`;
    container = plan.allowedHost;
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
  const lockPath = join(progressDir, '.running');
  try {
    await writeFile(lockPath, id, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  } catch (error) {
    if (isErrno(error, 'EEXIST')) throw new Refusal('VERIFY_ALREADY_RUNNING', 409);
    throw error;
  }
  let started = false;
  let databaseStamp: string | undefined;
  try {
    if (network && container) await attachHomologation(network, container, networkRunner);
    databaseStamp = await claimExamDatabase(ready.dataDirectory, ready.databasesDirectory, id);
    const output = await ensureTree(ready.dataDirectory, ['verificacoes', ready.projectId, 'ferramentas', id]);
    const progressPath = join(progressDir, `${id}.json`);
    await writePrivateFile(progressPath, renderProgress(state));
    const job = runJob({ready, id, output, progressPath, state, modelCalls, startedMs, lockPath, databaseStamp, network, container, networkRunner});
    started = true;
    input.observe?.(job);
    void job.catch(() => undefined);
    return {id, status: 'running', phase: 'ferramentas'};
  } catch (error) {
    if (!started) {
      try { await releaseExamDatabase(ready.dataDirectory, databaseStamp, id); } catch { /* keep the original error */ }
      try { await releaseRunningLock(lockPath, id); } catch { /* keep the original error */ }
      if (network && container) {
        try { await removeHomologationNetwork(network, container, networkRunner); } catch { /* keep the original error */ }
      }
    }
    throw error;
  }
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
    try {
      return await ledger.acquire(principal, contextId, instanceId, 'personal-verify', 3600);
    } catch (error) {
      if (!(error instanceof Refusal) || error.code !== 'INVALID_LEASE') throw error;
      return await ledger.acquire(principal, contextId, instanceId, 'personal-verify', 60);
    }
  } catch (error) {
    if (error instanceof Refusal && error.code === 'MANAGER_ACTIVE') {
      throw new Refusal('VERIFY_ALREADY_RUNNING', 409);
    }
    throw error;
  }
}

function projectOf(config: Installation, projectId: string) {
  return [config.project, ...config.projects].find(item => item.id === projectId);
}

export async function resolvePersonalVerification(
  argv: readonly string[],
  deps?: {composeRuntime?: typeof import('./personal-runtime.ts').composePersonalRuntime},
): Promise<{input: PersonalVerificationInput; close: () => Promise<void>}> {
  const parsed = parseVerifyArgs(argv);
  if (parsed.url !== undefined) dynamicScanPlan(parsed.url);
  const config = await loadInstallation(resolve(parsed.installationPath));
  if (config.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const project = projectOf(config, parsed.projectId);
  if (!project) throw new Refusal('NOT_FOUND', 404);
  const ledger = new Ledger(config.databaseUrl, config.installationAuthority?.token, undefined, installationVolumes(config));
  let authority: Authority | undefined;
  try {
    const commit = await readHead(project.repo);
    const principal = project.owner;
    const exam = await ledger.ensureExamContext(principal, project.id, 'verify');
    const policyRevision = exam.policyRevision;
    if (!Number.isInteger(policyRevision) || policyRevision < 1) throw new Refusal('VERIFY_CONTEXT_REQUIRED', 409);
    authority = await acquirePersonalVerify(ledger, principal, exam.contextId);
    if (exam.mainCapacityPolicyRevision !== null && exam.capacityPolicyRevision !== exam.mainCapacityPolicyRevision) {
      await new Capacity(ledger).assignPolicy(principal, exam.contextId, exam.mainCapacityPolicyRevision);
    }
    const composeRuntime = deps?.composeRuntime ?? (await import('./personal-runtime.ts')).composePersonalRuntime;
    const runtime = await composeRuntime(config, ledger);
    if (!runtime) throw new Refusal('VERIFY_WORKER_UNAVAILABLE', 503);
    const {createCapacityNativeWorker} = await import('./verify-native-launch.ts');
    const worker = createCapacityNativeWorker({
      supervisors: runtime.executions as unknown as readonly SecurityExamSupervisor[],
      ledger,
      principal,
      authority,
      base: commit,
      releaseGrant: (grantId, how) => releaseCapacityGrant(ledger, principal, authority!, grantId, how),
      pollBackoff: project.economy?.managerDiscipline !== false,
    });
    const image = await readPinnedImage(config.dataDirectory);
    const databases = await readCurrentVerifyDatabase(config.dataDirectory);
    if (!databases) throw new Refusal('VERIFY_DB_REQUIRED', 409);
    if (parsed.url === undefined) {
      issueStaticCliPolicy({nativeWorker: worker, projectId: project.id, contextId: exam.contextId, commit});
    }
    return {
      input: {
        installationPath: resolve(parsed.installationPath),
        projectId: project.id,
        mapEnabled: project.economy?.map,
        url: parsed.url,
        dataDirectory: config.dataDirectory,
        accountRoot: personalAccountRoot(config),
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
      close: async () => {
        await ledger.releaseLease(authority!).catch(() => undefined);
        await ledger.close();
      },
    };
  } catch (error) {
    if (authority) await ledger.releaseLease(authority).catch(() => undefined);
    await ledger.close();
    throw error;
  }
}
