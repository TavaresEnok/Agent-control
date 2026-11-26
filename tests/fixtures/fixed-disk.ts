import {useDiskMeasureForTests} from '../../src/personal-disk.ts';

/** A figure well under the 90% verify-db pressure and the 95% launch guard. */
export const FIXED_DISK_USED_PERCENT = 50;

/** The host disk is not what these tests prove. Every disk reading of the product returns a fixed figure, so a server disk
 * near 95% (or temporaries of the suite itself) never refuses a flow with PERSONAL_DISK_FULL. Call it at module scope: it
 * holds for the whole test file (one process per file in the CI). The guard itself is proven with its own injected readings
 * in disk-admission and personal-disk tests; production never injects, so the real 95% guard still applies there. */
export function useFixedDisk(percent = FIXED_DISK_USED_PERCENT): () => void {
  return useDiskMeasureForTests(async () => percent);
}
