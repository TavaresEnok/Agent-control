import {statfs} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {Refusal} from './contracts.ts';

export const DISK_BLOCK_PERCENT = 95;

/** Match df's accounting for blocks reserved for the filesystem administrator. */
export function usedDiskPercent(info: {blocks: number; bfree: number; bavail: number}): number {
  const used = info.blocks - info.bfree;
  const capacity = used + info.bavail;
  if (used < 0 || info.bavail < 0 || capacity <= 0) throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  return 100 * used / capacity;
}

export async function diskUsedPercent(path: string): Promise<number> {
  // Newly created jobs and installations can have an as-yet absent leaf.
  let directory = resolve(path);
  for (;;) {
    try {
      return usedDiskPercent(await statfs(directory));
    } catch (error) {
      const parent = dirname(directory);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === directory) throw error;
      directory = parent;
    }
  }
}

export async function assertDiskSpaceForLaunch(path: string, measure = diskUsedPercent): Promise<void> {
  const used = await measure(path);
  if (!Number.isFinite(used)) throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  if (used >= DISK_BLOCK_PERCENT) throw new Refusal('PERSONAL_DISK_FULL', 503);
}
