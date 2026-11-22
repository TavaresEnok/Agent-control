import {Refusal} from './contracts.ts';

/** Binário do runtime de contêiner. Os testes comparam esta constante. */
export const DESIGN_RUNTIME_BIN = 'docker';

/**
 * Tag fixa v1.65.1-noble. O digest é o índice OCI publicado pelo registro
 * em 2026-11-17, o mesmo que `imagetools inspect` devolve para essa tag.
 */
export const DESIGN_IMAGE =
  'mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579';

export const DESIGN_NETWORK = 'design-homologation';
export const DESIGN_USER = '65532:65532';
export const DESIGN_ENTRYPOINT = '/usr/local/bin/design-entrypoint.sh';

const MEMORY_MIN = 64 * 1024 * 1024;
const MEMORY_MAX = 8 * 1024 * 1024 * 1024;
const PIDS_MIN = 16;
const PIDS_MAX = 512;
const NANO_MIN = 100_000_000;
const NANO_MAX = 4_000_000_000;

const HOST = /^(?:127\.0\.0\.1|localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local)$/;
/** Nome pode trazer o host:porta de um registro. A tag continua sem dois-pontos e o digest é obrigatório. */
const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]*:[A-Za-z0-9][A-Za-z0-9._-]{0,127}@sha256:[a-f0-9]{64}$/;

export type DesignTarget = {host: string; port: number; origin: string};

export type DesignRunInput = {
  image: string;
  repository: string;
  output: string;
  targetUrl: string;
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  network?: string;
  /** Caminho absoluto do storageState. Sem o campo, o argv não ganha mount. */
  loginState?: string;
  /** CA da homologação HTTPS, já conferida. O exame só aceita a cadeia que fecha nela. */
  trustCa?: string;
};

export const DESIGN_TRUST_CA_MOUNT = '/trust/ca.pem';

/** Monta a CA no caminho fixo que a imagem lê. Só vale para alvo HTTPS. */
export function designTrustArguments(targetUrl: string, trustCa: string | undefined): string[] {
  if (trustCa === undefined) return [];
  if (parseTarget(targetUrl, 'DESIGN_EXTERNAL_TARGET').protocol !== 'https:') throw new Refusal('DESIGN_TRUST_CA_INVALID', 400);
  assertMountPath(trustCa);
  return [
    '--mount', `type=bind,source=${trustCa},destination=${DESIGN_TRUST_CA_MOUNT},readonly`,
    '--env', `DESIGN_TRUST_CA=${DESIGN_TRUST_CA_MOUNT}`,
  ];
}

function writtenHost(value: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value);
  const authority = match?.[1] ?? '';
  if (authority === '' || authority.includes('@') || authority.startsWith('[')) return '';
  const colon = authority.lastIndexOf(':');
  if (colon > 0 && /^\d{1,5}$/.test(authority.slice(colon + 1))) return authority.slice(0, colon).toLowerCase();
  return authority.toLowerCase();
}

function parseTarget(value: string, code: 'DESIGN_EXTERNAL_TARGET' | 'DESIGN_TARGET_ESCAPE'): DesignTarget & {protocol: 'http:' | 'https:'} {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) throw new Refusal(code);
  if (/[\u0000-\u0020\u007f\\]/.test(value)) throw new Refusal(code);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Refusal(code);
  }
  if (url.username !== '' || url.password !== '') throw new Refusal(code);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Refusal(code);
  const host = url.hostname.toLowerCase();
  if (!HOST.test(host) || writtenHost(value) !== host) throw new Refusal(code);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal(code);
  return {host, port, origin: url.origin, protocol: url.protocol};
}

export function assertDesignTarget(targetUrl: string): DesignTarget {
  const target = parseTarget(targetUrl, 'DESIGN_EXTERNAL_TARGET');
  return {host: target.host, port: target.port, origin: target.origin};
}

export function assertDesignDestination(targetUrl: string, destination: string): void {
  const target = parseTarget(targetUrl, 'DESIGN_EXTERNAL_TARGET');
  const dest = parseTarget(destination, 'DESIGN_TARGET_ESCAPE');
  if (dest.host !== target.host || dest.port !== target.port || dest.protocol !== target.protocol) {
    throw new Refusal('DESIGN_TARGET_ESCAPE');
  }
}

function assertPinnedImage(image: string): void {
  if (typeof image !== 'string' || image.length < 1 || image.length > 300) throw new Refusal('DESIGN_IMAGE_UNPINNED');
  if (image.includes('..') || image.includes('//') || !PINNED_IMAGE.test(image)) throw new Refusal('DESIGN_IMAGE_UNPINNED');
  const digestAt = image.lastIndexOf('@sha256:');
  const colon = image.lastIndexOf(':', digestAt);
  const tag = image.slice(colon + 1, digestAt);
  if (tag.toLowerCase() === 'latest') throw new Refusal('DESIGN_IMAGE_UNPINNED');
}

/** Recusa referência solta. O retorno é a mesma string, já validada. */
export function requirePinnedDesignImage(image: string): string {
  assertPinnedImage(image);
  return image;
}

/** Lê o primeiro `FROM` e devolve a referência com tag e digest. */
export function pinnedDesignImage(dockerfileText: string): string {
  if (typeof dockerfileText !== 'string' || dockerfileText.length < 1 || dockerfileText.length > 200_000) {
    throw new Refusal('DESIGN_IMAGE_UNPINNED');
  }
  for (const raw of dockerfileText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    const image = match?.[1];
    if (!image) throw new Refusal('DESIGN_IMAGE_UNPINNED');
    assertPinnedImage(image);
    return image;
  }
  throw new Refusal('DESIGN_IMAGE_UNPINNED');
}

function assertLimit(value: number, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Refusal('DESIGN_LIMITS_INVALID');
  }
}

function formatCpus(nanoCpus: number): string {
  const whole = Math.trunc(nanoCpus / 1_000_000_000);
  const fraction = nanoCpus % 1_000_000_000;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(9, '0').replace(/0+$/u, '')}`;
}

function assertMountPath(path: string): void {
  if (typeof path !== 'string' || path.length < 2 || path.length > 400) throw new Refusal('DESIGN_PATH_FORBIDDEN');
  if (path.includes('..') || /[\s\u0000\\]/.test(path) || path.includes(':') || path.includes(',')) {
    throw new Refusal('DESIGN_PATH_FORBIDDEN');
  }
  if (!path.startsWith('/') || path.includes('//')) throw new Refusal('DESIGN_PATH_FORBIDDEN');
  if (path.endsWith('.sock') || path.includes('.sock/') || path.includes('docker.sock')) {
    throw new Refusal('DESIGN_SOCKET_FORBIDDEN');
  }
}

export function designRunArguments(input: DesignRunInput): readonly string[] {
  const target = assertDesignTarget(input.targetUrl);
  assertDesignDestination(input.targetUrl, target.origin);
  assertPinnedImage(input.image);
  assertMountPath(input.repository);
  assertMountPath(input.output);
  if (input.repository === input.output) throw new Refusal('DESIGN_PATH_FORBIDDEN');
  const network = input.network ?? DESIGN_NETWORK;
  if (network !== DESIGN_NETWORK) throw new Refusal('DESIGN_NETWORK_FORBIDDEN');
  assertLimit(input.memoryBytes, MEMORY_MIN, MEMORY_MAX);
  assertLimit(input.pidsLimit, PIDS_MIN, PIDS_MAX);
  assertLimit(input.nanoCpus, NANO_MIN, NANO_MAX);
  const loginMount: string[] = [];
  if (input.loginState !== undefined) {
    assertMountPath(input.loginState);
    loginMount.push('--mount', `type=bind,source=${input.loginState},destination=/login/state.json,readonly`);
  }
  const trust = designTrustArguments(input.targetUrl, input.trustCa);
  const memory = String(input.memoryBytes);
  return [
    DESIGN_RUNTIME_BIN,
    'run',
    '--rm',
    // Node é o PID 1 e não recolhe os processos do Chrome que terminam. Sem o init,
    // os zumbis enchem o --pids-limit e o exame trava no meio do Lighthouse.
    '--init',
    '--network',
    DESIGN_NETWORK,
    '--read-only',
    '--user',
    DESIGN_USER,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(input.pidsLimit),
    '--memory',
    memory,
    '--memory-swap',
    memory,
    '--cpus',
    formatCpus(input.nanoCpus),
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=512m',
    '--env',
    'HOME=/tmp',
    '--env',
    'TMPDIR=/tmp',
    '--env',
    `DESIGN_TARGET_URL=${target.origin}`,
    '--mount',
    `type=bind,source=${input.repository},destination=/repository,readonly`,
    '--mount',
    `type=bind,source=${input.output},destination=/output`,
    ...loginMount,
    ...trust,
    '--entrypoint',
    DESIGN_ENTRYPOINT,
    input.image,
  ];
}
