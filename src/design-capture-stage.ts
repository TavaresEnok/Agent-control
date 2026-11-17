import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, open, readdir, realpath} from 'node:fs/promises';
import {join, sep} from 'node:path';

const RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG_NAME = /^[a-f0-9]{64}\.png$/;
const MAX_FILES = 40;
const MAX_BYTES = 2_000_000;

/**
 * Copies design PNGs into the native job directories the model can open.
 * The git snapshot does not contain `.design-captures`. Grok reads `/planning`;
 * Claude and Codex read `/work` when that bind exists. Missing source is a no-op.
 */
export async function stageDesignCapturesForJob(repository: string, destinations: readonly string[]): Promise<number> {
  const root = await realpath(repository);
  const source = join(root, '.design-captures');
  let runs;
  try {
    runs = await readdir(source, {withFileTypes: true});
  } catch (error) {
    if (isEnoent(error)) return 0;
    return 0;
  }
  const sourceReal = await realpath(source);
  if (sourceReal !== source || !sourceReal.startsWith(root + sep)) return 0;
  const files: {name: string; from: string}[] = [];
  for (const run of runs) {
    if (files.length >= MAX_FILES) break;
    if (!run.isDirectory() || run.isSymbolicLink() || !RUN_DIR.test(run.name)) continue;
    const dir = join(source, run.name);
    const dirReal = await realpath(dir).catch(() => '');
    if (dirReal !== dir || !dirReal.startsWith(source + sep)) continue;
    let inner;
    try {
      inner = await readdir(dir, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const file of inner) {
      if (files.length >= MAX_FILES) break;
      if (!file.isFile() || file.isSymbolicLink() || !PNG_NAME.test(file.name)) continue;
      const from = join(dir, file.name);
      const stat = await lstat(from);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BYTES) continue;
      files.push({name: file.name, from});
    }
  }
  let copied = 0;
  for (const destination of destinations) {
    if (destination.length < 2) continue;
    const destReal = await realpath(destination).catch(() => '');
    if (destReal === '' || destReal.startsWith(source)) continue;
    const folder = join(destination, 'capturas');
    await mkdir(folder, {recursive: true, mode: 0o700});
    for (const file of files) {
      const target = join(folder, file.name);
      try {
        await copyFile(file.from, target, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!isExist(error)) throw error;
      }
      const handle = await open(target, constants.O_RDONLY);
      try {
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      copied += 1;
    }
  }
  return copied;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isExist(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}
