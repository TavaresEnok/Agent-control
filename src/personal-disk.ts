import {statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {Refusal} from './contracts.ts';
import {localDockerStorage} from './docker-storage.ts';

export const DISK_BLOCK_PERCENT = 95;

/** Match df's accounting for blocks reserved for the filesystem administrator. */
export function usedDiskPercent(info: {blocks: number; bfree: number; bavail: number}): number {
  const used = info.blocks - info.bfree;
  const capacity = used + info.bavail;
  if (used < 0 || info.bavail < 0 || capacity <= 0) throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  return 100 * used / capacity;
}

type NativeRoots = {planning: {hostRoot: string; accountRoot: string}; execution: {hostRoot: string; accountRoot: string}};
/** Not a path: stands for the local Docker daemon's storage, whose directory only the daemon knows. Resolved (and cached) when measured. */
export const DOCKER_STORAGE_VOLUME = 'docker-storage:local';

type VolumeSource = {dataDirectory: string; activation?: string | undefined; accountHomesDirectory?: string | undefined; nativeBootstrap?: object | undefined;
  project?: {repo: string} | undefined; projects?: readonly {repo: string}[] | undefined; projectRoots?: readonly {path: string}[] | undefined};

/** Every volume an installation writes to: data, native host and account roots, account homes and temp, then the
 * project repositories and roots and, on a personal installation, the local Docker storage. One list serves the watch,
 * the capacity gate and the supervisors. Remote servers are not listed: their disks are not this machine's. */
export function installationVolumes(config: VolumeSource): string[] {
  const boot = config.nativeBootstrap && 'planning' in config.nativeBootstrap && 'execution' in config.nativeBootstrap ? config.nativeBootstrap as NativeRoots : undefined;
  const paths = [config.dataDirectory, ...(config.accountHomesDirectory ? [config.accountHomesDirectory] : []),
    ...(boot ? [boot.planning.hostRoot, boot.planning.accountRoot, boot.execution.hostRoot, boot.execution.accountRoot] : []), tmpdir(),
    ...(config.projectRoots ?? []).map(root => root.path), ...[config.project, ...(config.projects ?? [])].flatMap(project => project ? [project.repo] : [])].map(path => resolve(path));
  return [...new Set([...paths, ...(config.activation === 'personal' ? [DOCKER_STORAGE_VOLUME] : [])])];
}

async function volumeUsedPercent(path: string): Promise<number> {
  // Newly created jobs and installations can have an as-yet absent leaf.
  let directory = resolve(path);
  for (;;) {
    try {
      return usedDiskPercent(await statfs(directory));
    } catch (error) {
      const parent = dirname(directory);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === directory) {
        if (error instanceof Refusal) throw error;
        throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
      }
      directory = parent;
    }
  }
}

/** Docker storage that this machine cannot see (no local daemon, or its directory lives elsewhere) is skipped, not an error. */
async function dockerStorageUsedPercent(): Promise<number | undefined> {
  const root = await localDockerStorage();
  if (!root) return undefined;
  try {
    return usedDiskPercent(await statfs(root));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  }
}

/** Highest use among the volumes. A path that cannot be measured makes the whole figure unavailable. */
export async function diskUsedPercent(paths: string | readonly string[]): Promise<number> {
  const list = typeof paths === 'string' ? [paths] : paths;
  const measured = (await Promise.all(list.map(path => path === DOCKER_STORAGE_VOLUME ? dockerStorageUsedPercent() : volumeUsedPercent(path)))).filter((used): used is number => used !== undefined);
  if (measured.length === 0) throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  return Math.max(...measured);
}

/** Volumes a gate must measure: those the Ledger was opened with, or the data directory alone when it carries none. */
export function launchVolumesOf(source: {launchVolumes?: readonly string[]} | undefined, dataDirectory: string): readonly string[] {
  return source?.launchVolumes && source.launchVolumes.length > 0 ? source.launchVolumes : [dataDirectory];
}

/** Gate for a new worker or exam only. Replays and reconciliation of existing jobs must not call it. */
export async function assertDiskSpaceForLaunch(paths: string | readonly string[], measure: (paths: string | readonly string[]) => Promise<number> = diskUsedPercent): Promise<void> {
  const used = await measure(paths);
  if (!Number.isFinite(used)) throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  if (used >= DISK_BLOCK_PERCENT) throw new Refusal('PERSONAL_DISK_FULL', 503);
}
