import {Refusal} from './contracts.ts';

/** Container runtime binary. Tests compare against this constant and do not quote the name. */
export const VERIFY_RUNTIME_BIN = 'docker';

const VERIFY_USER = '65532:65532';
const DIGEST = /(?:^|@)sha256:[a-f0-9]{64}$/;
const MUTABLE_LATEST = /(^|[/:])latest($|@)/i;

function assertNoForeignNetwork(value: string): void {
  if (/(?:--network|--net)(?:=|\s+)(?!none\b)\S+/i.test(value)) throw new Refusal('VERIFY_NETWORK_FORBIDDEN');
}

function isSocket(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.includes('.sock') || lower.includes('docker.sock');
}

function assertPinnedImage(image: string): void {
  if (typeof image !== 'string') throw new Refusal('VERIFY_IMAGE_UNPINNED');
  assertNoForeignNetwork(image);
  if (isSocket(image)) throw new Refusal('VERIFY_SOCKET_FORBIDDEN');
  if (image.split('/').includes('..')) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  if (image.length === 0 || image.length > 512 || /[\s\u0000-\u001f]/.test(image) || MUTABLE_LATEST.test(image) || !DIGEST.test(image)) {
    throw new Refusal('VERIFY_IMAGE_UNPINNED');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(image)) throw new Refusal('VERIFY_IMAGE_UNPINNED');
}

function assertHostPath(path: string): string {
  if (typeof path !== 'string') throw new Refusal('VERIFY_PATH_FORBIDDEN');
  assertNoForeignNetwork(path);
  if (isSocket(path)) throw new Refusal('VERIFY_SOCKET_FORBIDDEN');
  if (path.length === 0 || path.length > 4096 || path.includes('\0') || path.includes('\\') || /\s/.test(path) || !path.startsWith('/') || !/^\/[A-Za-z0-9._/-]+$/.test(path)) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN');
  }
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (normalized.split('/').includes('..') || normalized.split('/').includes('.')) throw new Refusal('VERIFY_PATH_FORBIDDEN');
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

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

/** Separate step, with network, that only downloads vulnerability databases. */
export function verifyDatabaseArguments({image, output, labels = []}: {image: string; output: string;
  /** Ownership `--label` arguments (installation, kind). */
  labels?: readonly string[]}): readonly string[] {
  assertPinnedImage(image);
  const databases = assertHostPath(output);
  return [
    VERIFY_RUNTIME_BIN, 'run', '--rm',
    '--network', 'bridge',
    '--read-only',
    '--user', VERIFY_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=1g',
    '--env', 'HOME=/tmp',
    '--env', 'TMPDIR=/tmp',
    '--workdir', '/databases',
    '--mount', `type=bind,src=${databases},dst=/databases`,
    ...labels,
    '--entrypoint', '/usr/local/bin/verify-db-fetch.sh',
    image,
  ];
}

/** Offline exam. Refuses .., a socket, or any network other than none. */
export function verifyExamArguments({image, repository, databases, output, memoryBytes, nanoCpus, pidsLimit,commonTools,labels=[]}: {
  image: string;
  /** Ownership `--label` arguments (installation, project, kind). */
  labels?: readonly string[];
  repository: string;
  databases: string;
  output: string;
  commonTools?:boolean;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
}): readonly string[] {
  assertPinnedImage(image);
  const source = assertHostPath(repository);
  const cache = assertHostPath(databases);
  const report = assertHostPath(output);
  if (overlaps(report, source) || overlaps(report, cache)) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  assertLimit(memoryBytes, 68_719_476_736);
  assertLimit(nanoCpus, 1_024_000_000_000);
  assertLimit(pidsLimit, 512);
  const memory = String(memoryBytes);
  return [
    VERIFY_RUNTIME_BIN, 'run', '--rm',
    '--network', 'none',
    '--read-only',
    '--user', VERIFY_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(pidsLimit),
    '--memory', memory,
    '--memory-swap', memory,
    '--cpus', cpusFromNano(nanoCpus),
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m',
    '--env', 'HOME=/tmp',
    '--env', 'TMPDIR=/tmp',
    '--workdir', '/output',
    '--mount', `type=bind,src=${source},dst=/repository,readonly`,
    '--mount', `type=bind,src=${cache},dst=/databases,readonly`,
    '--mount', `type=bind,src=${report},dst=/output`,
    ...labels,
    '--entrypoint', commonTools?'/usr/local/bin/ac-collect':'/usr/local/bin/verify-entrypoint.sh',
    image, ...(commonTools?['verify']:[]),
  ];
}
