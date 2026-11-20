import {lstat,readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {isAbsolute,resolve} from 'node:path';
import {Refusal} from './contracts.ts';

/** Where the local Docker daemon keeps images, containers and volumes. Read only, never taken from a request.
 * The daemon itself is the source of truth (`GET /info`, field DockerRootDir); when it cannot be asked, the
 * daemon's own configuration file (`data-root`) and finally the default location answer. No local socket means no local storage. */
export const DOCKER_SOCKET = '/var/run/docker.sock';
export const DOCKER_DAEMON_CONFIG = '/etc/docker/daemon.json';
export const DOCKER_DEFAULT_ROOT = '/var/lib/docker';

export interface DockerStorageSources {
  socketPath: string;
  configFile: string;
  defaultRoot: string;
  /** Answer of `GET /info` as parsed JSON. Absent or throwing means the daemon could not be asked. */
  info?: (socketPath: string) => Promise<unknown>;
}

function cleanRoot(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) return undefined;
  return resolve(value);
}

/** One bounded read-only GET on a fixed route over the local unix socket. */
export function readDockerInfo(socketPath: string, timeoutMs = 2000): Promise<unknown> {
  return new Promise((ok, fail) => {
    const req = request({socketPath, method: 'GET', path: '/info', timeout: timeoutMs}, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1048576) { req.destroy(); fail(new Refusal('DOCKER_RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
      res.on('end', () => {
        if (res.statusCode !== 200) { fail(new Refusal('DOCKER_UNCERTAIN')); return; }
        try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(new Refusal('DOCKER_RESPONSE_INVALID')); }
      });
      res.on('error', () => fail(new Refusal('DOCKER_UNCERTAIN')));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => fail(new Refusal('DOCKER_UNCERTAIN')));
    req.end();
  });
}

/** Directory of the local daemon's storage, or undefined when this machine has no local daemon. */
export async function probeLocalDockerStorage(sources: Partial<DockerStorageSources> = {}): Promise<string | undefined> {
  const {socketPath, configFile, defaultRoot, info} = {socketPath: DOCKER_SOCKET, configFile: DOCKER_DAEMON_CONFIG, defaultRoot: DOCKER_DEFAULT_ROOT, info: readDockerInfo, ...sources};
  try { if (!(await lstat(socketPath)).isSocket()) return undefined; } catch { return undefined; }
  try {
    const root = cleanRoot((await info(socketPath) as {DockerRootDir?: unknown} | null)?.DockerRootDir);
    if (root) return root;
  } catch { /* the daemon may be down or closed to this user; the files below still say where it writes */ }
  try {
    const root = cleanRoot((JSON.parse(await readFile(configFile, 'utf8')) as {'data-root'?: unknown})['data-root']);
    if (root) return root;
  } catch { /* no readable configuration */ }
  return cleanRoot(defaultRoot);
}

export interface DockerStorageResolver {resolve(): Promise<string | undefined>}

/** The location changes only when the daemon is reconfigured, so one answer serves many admissions. A failed probe keeps
 * the last good answer; a negative answer is retried sooner. Concurrent callers share one probe. */
export function dockerStorageResolver(probe: () => Promise<string | undefined>, options: {now?: () => number; foundTtlMs?: number; missingTtlMs?: number} = {}): DockerStorageResolver {
  const now = options.now ?? Date.now, foundTtl = options.foundTtlMs ?? 600_000, missingTtl = options.missingTtlMs ?? 30_000;
  let current: {value: string | undefined; until: number} | undefined;
  let lastGood: string | undefined;
  let pending: Promise<string | undefined> | undefined;
  return {
    async resolve() {
      if (current && now() < current.until) return current.value;
      pending ??= (async () => {
        try {
          const value = await probe();
          lastGood = value;
          current = {value, until: now() + (value ? foundTtl : missingTtl)};
          return value;
        } catch {
          current = {value: lastGood, until: now() + missingTtl};
          return lastGood;
        } finally { pending = undefined; }
      })();
      return pending;
    },
  };
}

let shared = dockerStorageResolver(() => probeLocalDockerStorage());
export function localDockerStorage(): Promise<string | undefined> { return shared.resolve(); }
/** Test seam: replaces the process-wide resolver; call with no argument to restore the real one. */
export function useDockerStorageProbeForTests(probe?: () => Promise<string | undefined>): void {
  shared = dockerStorageResolver(probe ?? (() => probeLocalDockerStorage()));
}
