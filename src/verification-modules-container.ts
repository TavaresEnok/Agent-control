import {hostCollectorArgs,type HostCollector} from './simple-host-tools.ts';
import {extractGitArchive} from './git-archive-snapshot.ts';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Refusal} from './contracts.ts';
import type {VerificationModule} from './ledger.ts';
import {COLLECTOR_CAPTURE_DIR, COLLECTOR_HEADER_BYTES, COLLECTOR_WRAPPER_PATH, collectorOutputWrapper, verifyCollectorOutput} from './module-collector-output.ts';
import {MODULE_CONTAINER_LABEL, MODULE_RUNTIME_BIN, assertOwnedModuleContainer, createdContainerId, moduleContainerJournal, moduleContainerName, runBoundedCollectorProcess, type CollectorProcess} from './module-container-cleanup.ts';
import {validatePassiveTlsEvidence, type ProntidaoPassiveEvidence} from './prontidao-target.ts';
import {trackRoundTemp, type RoundScope} from './personal-artifact-hooks.ts';
import {ARCHIVE_TIMEOUT_MS, COLLECTOR_DAEMON_TIMEOUT_MS, DEFAULT_COLLECTOR_TIMEOUT_MS, DIGEST, MAX_COLLECTOR_STDOUT_BYTES, MODULE_CONTAINER_USER, MODULE_MEMORY_BYTES, MODULE_NANO_CPUS, MODULE_PIDS_LIMIT, MUTABLE_LATEST, ModuleCollectorOutput, assertVerificationModule, isErrno} from './verification-modules-contracts.ts';
import {parseModuleCollectorOutput} from './verification-modules-collector.ts';
import {installationName, ownerLabelArgs, projectLabel} from '../scripts/ac-labels.mjs';

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

export async function readOptionalPinnedModuleImage(module: VerificationModule, rootDir?: string): Promise<string | undefined> {
  const path = moduleDigestPath(module, rootDir);
  let text: string;
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  return parsePinnedModuleImage(text);
}

export async function readPinnedModuleImage(module: VerificationModule, rootDir?: string): Promise<string> {
  const image = await readOptionalPinnedModuleImage(module, rootDir);
  if (!image) throw new Refusal('VERIFY_IMAGE_UNPINNED');
  return image;
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

/** Where a module run records its temporaries for retention: the installation data directory, the project and the run (the round). */
export type ModuleRetention = RoundScope;

/** Git archive snapshot of the examined commit, outside the live repository and readable by container uid 65532.
 * With `retention`, the private parent folder is recorded for the round so a crash that skips the cleanup below
 * does not leave it forever. Recording never fails the snapshot. */
export async function prepareModuleSnapshot(repoPath: string, commit: string, retention?: ModuleRetention): Promise<string> {
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
  if (retention) await trackRoundTemp(retention, parent);
  try {
    await extractGitArchive(repo, commit, snapshot, {timeoutMs: ARCHIVE_TIMEOUT_MS});
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

/** Ownership labels of a module exam container: the installation and the project of the run, when the run is known. */
export function moduleOwnerLabelArgs(retention: ModuleRetention | undefined, module: VerificationModule | undefined): string[] {
  return retention ? ownerLabelArgs({installation: installationName(retention.dataDirectory), project: projectLabel(retention.projectId),
    kind: `exam-${module ?? 'module'}`}) : [];
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
  retention?: ModuleRetention;
  snapshot?:string;
  hostCollector?:HostCollector;
  commonTools?:boolean;
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
  const snapshot = input.snapshot ?? await prepareModuleSnapshot(input.repoPath, input.commit, input.retention);
  let evidenceDir: string | undefined;
  let evidenceFile: string | undefined;
  try {
    evidenceDir = await mkdtemp(join(tmpdir(), input.passiveTlsEvidence === undefined ? 'ac-collector-' : 'ac-prontidao-evidence-'));
    if (input.retention) await trackRoundTemp(input.retention, evidenceDir);
    if (input.passiveTlsEvidence !== undefined) {
      const validated = validatePassiveTlsEvidence(input.passiveTlsEvidence);
      evidenceFile = join(evidenceDir, 'evidence.json');
      await writeFile(evidenceFile, `${JSON.stringify(validated)}\n`, {encoding: 'utf8', mode: 0o644, flag: 'wx'});
      await chmod(evidenceFile, 0o644);
    }
    if(input.hostCollector){
      const run=input.executeProcess??runBoundedCollectorProcess;
      const result=await run(hostCollectorArgs(input.hostCollector,snapshot,{evidence:evidenceFile}),{timeoutMs,maxStdoutBytes,signal:input.signal});
      return {code:result.code,output:parseModuleCollectorOutput(result.stdout,{maxStdoutBytes,module:input.module})};
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
    const wrapper = assertHostPath(join(evidenceDir, 'collector-entrypoint'));
    const command=input.commonTools?Buffer.from(JSON.stringify([['/usr/local/bin/ac-collect',assertVerificationModule(input.module)],[]])):imageCommand.stdout;
    await writeFile(wrapper, collectorOutputWrapper(command, token, maxStdoutBytes), {flag: 'wx', mode: 0o555});
    await chmod(wrapper, 0o555);
    // Journal the owner before create, and record the immutable ID before start.
    // Let create return its ID even when cancellation arrives during the call.
    // Drain the attached streams without persisting either one in the daemon.
    const createArgs = [MODULE_RUNTIME_BIN, 'create', '--pull', 'never', '--name', moduleContainerName(token),
      '--label', `${MODULE_CONTAINER_LABEL}=${token}`, ...moduleOwnerLabelArgs(input.retention, input.module), '--log-driver', 'none',
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
      if (!input.snapshot) await removeModuleSnapshot(snapshot);
    }
  }
}
