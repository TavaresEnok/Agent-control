import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, copyFile, lstat, mkdir, open, readdir, realpath, rm, rmdir} from 'node:fs/promises';
import {isAbsolute, join, resolve, sep} from 'node:path';
import {Id, Refusal} from './contracts.ts';
import type {DesignScreenCapture} from './design-examine.ts';

const RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PNG_NAME = /^[a-f0-9]{64}\.png$/;
const MAX_FILES = 40;
const MAX_BYTES = 2_000_000;
const CAPTURE_DIR_ENV = 'AC_DESIGN_CAPTURE_DIR';
const CAPTURE_RUN_ENV = 'AC_DESIGN_CAPTURE_RUN';
const WRITE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const OPEN_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

type CaptureFile = {name: string; from: string};

type CaptureEnv =
  | {kind: 'absent'}
  | {kind: 'invalid'}
  | {kind: 'private'; dir: string; run: string};

/**
 * Copies design PNGs into the native job directories the model can open.
 * Both `AC_DESIGN_CAPTURE_DIR` and `AC_DESIGN_CAPTURE_RUN` must name one private run.
 * The repository tree, including `.design-captures`, is never a source. An absent or
 * invalid pair copies nothing. A private PNG is copied only when its filename is the
 * sha256 of its bytes.
 */
export async function stageDesignCapturesForJob(repository: string, destinations: readonly string[]): Promise<number> {
  void repository;
  const selected = readCaptureEnv();
  if (selected.kind !== 'private') return 0;
  return copyPrivateRun(selected.dir, selected.run, destinations);
}

const STAGE_NOTE_NAME = 'stage-notes.txt';

/** One line from `stage-notes.txt` in the private run, or nothing when staging wrote no note. */
export async function readDesignCaptureStageNote(): Promise<string | undefined> {
  const selected = readCaptureEnv();
  if (selected.kind !== 'private') return undefined;
  const path = join(selected.dir, selected.run, STAGE_NOTE_NAME);
  let info;
  try {
    info = await lstat(path);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size < 1 || info.size > 4096) return undefined;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const text = await handle.readFile({encoding: 'utf8'});
    const line = text.trim();
    return line.length > 0 ? line : undefined;
  } finally {
    await handle.close();
  }
}

const REFERENCE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:png|jpe?g)$/i;

export type DesignStagedReference = {path: string; sha256: string; name: string};

export async function writeDesignExamCaptures(
  dataDirectory: string,
  runId: string,
  held: readonly {route: string; viewport: number; theme: 'claro' | 'escuro'; state: string; bytes: Buffer}[],
  extras: readonly {name: string; bytes: Buffer}[] = [],
): Promise<{
  byRoute: Map<string, DesignScreenCapture[]>;
  references: DesignStagedReference[];
  publish: () => void;
  conceal: () => void;
  cleanup: () => Promise<void>;
}> {
  const idle = {
    byRoute: new Map<string, DesignScreenCapture[]>(),
    references: [] as DesignStagedReference[],
    publish() {},
    conceal() {},
    cleanup: async () => {},
  };
  if (!Id.safeParse(runId).success || !RUN_DIR.test(runId)) {
    if (held.length === 0 && extras.length === 0) return idle;
    throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  }
  if (held.length === 0 && extras.length === 0) {
    await sweepQuietly(dataDirectory, runId);
    return idle;
  }
  const root = await privateDataRoot(dataDirectory);
  const parent = join(root, 'design-captures');
  await ensurePrivateDir(parent, root);
  await removeLeftoverRuns(parent, runId);
  const dir = join(parent, runId);
  await ensurePrivateDir(dir, parent);
  const byRoute = new Map<string, DesignScreenCapture[]>();
  const written = new Map<string, string>();
  const cleanup = async () => {
    await removePrivateRun(dir, parent);
    await rmdir(parent).catch(() => undefined /* the parent may still hold other runs */);
  };
  try {
    for (const item of held) {
      const sha256 = createHash('sha256').update(item.bytes).digest('hex');
      let path = written.get(sha256);
      if (path === undefined) {
        path = await writePrivatePng(dir, sha256, item.bytes);
        written.set(sha256, path);
      }
      const capture: DesignScreenCapture = {
        path,
        viewport: item.viewport,
        theme: item.theme,
        state: item.state,
        sha256,
      };
      const list = byRoute.get(item.route) ?? [];
      list.push(capture);
      byRoute.set(item.route, list);
    }
    const references = await writeReferenceImages(dir, extras, written);
    const env = bindCaptureEnv(parent, runId);
    return {byRoute, references, publish: env.publish, conceal: env.conceal, cleanup};
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** A referência segue o PNG da captura: o nome no disco é o sha256, com sufixo .png, para o supervisor copiar. */
async function writeReferenceImages(
  dir: string,
  extras: readonly {name: string; bytes: Buffer}[],
  written: Map<string, string>,
): Promise<DesignStagedReference[]> {
  const references: DesignStagedReference[] = [];
  for (const file of extras.slice(0, 10)) {
    if (!REFERENCE_NAME.test(file.name) || file.bytes.length < 8 || file.bytes.length > MAX_BYTES) continue;
    const png = file.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpg = file.bytes[0] === 0xff && file.bytes[1] === 0xd8;
    if (!png && !jpg) continue;
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    let path = written.get(sha256);
    if (path === undefined) {
      path = await writePrivatePng(dir, sha256, file.bytes);
      written.set(sha256, path);
    }
    references.push({path, sha256, name: file.name});
  }
  return references;
}

function readCaptureEnv(): CaptureEnv {
  const dir = process.env[CAPTURE_DIR_ENV];
  const run = process.env[CAPTURE_RUN_ENV];
  if ((dir === undefined || dir === '') && (run === undefined || run === '')) return {kind: 'absent'};
  if (dir === undefined || dir === '' || run === undefined || run === '' || !isAbsolute(dir) || dir.includes('\0') || !RUN_DIR.test(run)) {
    return {kind: 'invalid'};
  }
  return {kind: 'private', dir, run};
}

function bindCaptureEnv(parent: string, runId: string): {publish: () => void; conceal: () => void} {
  let published = false;
  let previousDir: string | undefined;
  let previousRun: string | undefined;
  return {
    publish() {
      if (published) return;
      previousDir = process.env[CAPTURE_DIR_ENV];
      previousRun = process.env[CAPTURE_RUN_ENV];
      process.env[CAPTURE_DIR_ENV] = parent;
      process.env[CAPTURE_RUN_ENV] = runId;
      published = true;
    },
    conceal() {
      if (!published) return;
      if (previousDir === undefined) delete process.env[CAPTURE_DIR_ENV];
      else process.env[CAPTURE_DIR_ENV] = previousDir;
      if (previousRun === undefined) delete process.env[CAPTURE_RUN_ENV];
      else process.env[CAPTURE_RUN_ENV] = previousRun;
      published = false;
    },
  };
}

async function copyPrivateRun(dir: string, run: string, destinations: readonly string[]): Promise<number> {
  let parentStat;
  try {
    parentStat = await lstat(dir);
  } catch {
    return 0;
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return 0;
  const parentReal = await realpath(dir).catch(() => '');
  if (parentReal !== dir) return 0;
  const runDir = join(dir, run);
  let runStat;
  try {
    runStat = await lstat(runDir);
  } catch {
    return 0;
  }
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) return 0;
  const runReal = await realpath(runDir).catch(() => '');
  if (runReal !== runDir || !runReal.startsWith(dir + sep)) return 0;
  const files: CaptureFile[] = [];
  const oversized: string[] = [];
  await collectPngs(runDir, files, oversized);
  await writeStageNote(runDir, oversized);
  return copyCollected(dir, files, destinations);
}

async function collectPngs(dir: string, files: CaptureFile[], oversized: string[]): Promise<void> {
  let inner;
  try {
    inner = await readdir(dir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const file of inner) {
    if (!file.isFile() || file.isSymbolicLink() || !PNG_NAME.test(file.name)) continue;
    const from = join(dir, file.name);
    const stat = await lstat(from);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (stat.size > MAX_BYTES) {
      oversized.push(file.name);
      continue;
    }
    if (stat.size < 1 || files.length >= MAX_FILES) continue;
    const bytes = await readRegularFile(from, stat.size);
    if (bytes === undefined) continue;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (file.name !== `${sha256}.png`) continue;
    files.push({name: file.name, from});
  }
}

async function writeStageNote(runDir: string, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  const path = join(runDir, STAGE_NOTE_NAME);
  const line = `PNG acima de 2 MB descartado no staging: ${names.join(', ')}.\n`;
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (isErrno(error, 'ELOOP')) return;
    throw error;
  }
  try {
    await handle.writeFile(line);
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

/** Reads a regular file without following a symlink that replaced it. */
async function readRegularFile(path: string, expectedSize: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expectedSize || info.size < 1 || info.size > MAX_BYTES) return undefined;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function copyCollected(source: string, files: readonly CaptureFile[], destinations: readonly string[]): Promise<number> {
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

async function privateDataRoot(dataDirectory: string): Promise<string> {
  if (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  }
  const lexical = resolve(dataDirectory);
  let info;
  try {
    info = await lstat(lexical);
  } catch (error) {
    if (isMissing(error)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const real = await realpath(lexical).catch(error => {
    if (isMissing(error)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  });
  if (real !== lexical) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  return real;
}

async function sweepQuietly(dataDirectory: string, runId: string): Promise<void> {
  if (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory) || dataDirectory.includes('\0')) return;
  const lexical = resolve(dataDirectory);
  let info;
  try {
    info = await lstat(lexical);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  const real = await realpath(lexical).catch(() => '');
  if (real !== lexical) return;
  await sweepIfPresent(join(real, 'design-captures'), real, runId);
}

async function sweepIfPresent(parent: string, root: string, runId: string): Promise<void> {
  let info;
  try {
    info = await lstat(parent);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  const real = await realpath(parent).catch(() => '');
  if (real !== parent || !real.startsWith(root + sep)) return;
  await removeLeftoverRuns(parent, runId);
}

async function ensurePrivateDir(path: string, ancestor: string): Promise<void> {
  try {
    await mkdir(path, {mode: 0o700});
  } catch (error) {
    if (!isExist(error)) throw error;
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  await chmod(path, 0o700);
  const after = await lstat(path);
  if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o777) !== 0o700) {
    throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  }
  const real = await realpath(path).catch(error => {
    if (isMissing(error)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  });
  if (real !== path || !real.startsWith(ancestor + sep)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
}

async function removeLeftoverRuns(parent: string, runId: string): Promise<void> {
  const entries = await readdir(parent, {withFileTypes: true});
  for (const entry of entries) {
    if (entry.name === runId || !RUN_DIR.test(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    await removePrivateRun(join(parent, entry.name), parent);
  }
}

async function removePrivateRun(dir: string, parent: string): Promise<void> {
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return;
  const real = await realpath(dir).catch(() => '');
  if (real !== dir || !real.startsWith(parent + sep)) return;
  let handle;
  try {
    handle = await open(dir, OPEN_DIR);
  } catch (error) {
    if (isMissing(error) || isEnoent(error)) return;
    throw error;
  }
  await handle.close();
  await rm(dir, {recursive: true, force: true});
}

async function writePrivatePng(dir: string, sha256: string, bytes: Buffer): Promise<string> {
  const name = `${sha256}.png`;
  if (!PNG_NAME.test(name)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  const path = join(dir, name);
  let handle;
  try {
    handle = await open(path, WRITE_NEW, 0o600);
  } catch (error) {
    if (isExist(error) || isMissing(error)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
    throw error;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o600) {
    throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  }
  const real = await realpath(path);
  if (real !== path || !real.startsWith(dir + sep)) throw new Refusal('DESIGN_PATH_FORBIDDEN', 403);
  return path;
}

function isEnoent(error: unknown): boolean {
  return isErrno(error, 'ENOENT');
}

function isExist(error: unknown): boolean {
  return isErrno(error, 'EEXIST');
}

function isMissing(error: unknown): boolean {
  return isErrno(error, 'ENOENT') || isErrno(error, 'ELOOP') || isErrno(error, 'ENOTDIR');
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
