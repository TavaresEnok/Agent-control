import {spawn as spawnProcess} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {chmod, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {Refusal} from './contracts.ts';
import {VERIFY_RUNTIME_BIN, verifyDatabaseArguments} from './verify-image.ts';

export type VerifyDatabaseSnapshot = {
  directory: string;
  fetchedAt: string;
  manifestSha256: string;
};

export type RefreshVerifyDatabasesInput = {
  dataDirectory: string;
  image?: string;
  spawn?: (args: readonly string[]) => Promise<number>;
  now?: Date;
};

type ManifestFile = {path: string; sha256: string; bytes: number};

function runCommand(args: readonly string[], stdio: 'ignore' | 'inherit'): Promise<number> {
  const command = args[0];
  if (!command) return Promise.resolve(1);
  return new Promise((resolvePromise) => {
    const child = spawnProcess(command, args.slice(1), {stdio});
    child.on('error', () => resolvePromise(1));
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

function formatStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function parsePinnedImage(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Refusal('VERIFY_IMAGE_UNPINNED');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Refusal('VERIFY_IMAGE_UNPINNED');
  const image = (parsed as {image?: unknown}).image;
  if (typeof image !== 'string' || image.length === 0) throw new Refusal('VERIFY_IMAGE_UNPINNED');
  return image;
}

async function readInstalledImage(root: string): Promise<string> {
  const path = join(root, 'verify-image.json');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') throw new Refusal('VERIFY_IMAGE_UNPINNED');
    throw error;
  }
  try {
    const info = await file.stat();
    const uid = process.getuid?.();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 4096 || (uid !== undefined && info.uid !== uid)) {
      throw new Refusal('VERIFY_IMAGE_UNPINNED');
    }
    return parsePinnedImage((await file.readFile()).toString('utf8'));
  } finally {
    await file.close();
  }
}

async function ensureDatabaseRoot(parent: string): Promise<void> {
  try {
    await mkdir(parent, {mode: 0o700});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  await chmod(parent, 0o700);
}

async function discardStamp(stamp: string, parent: string, image: string): Promise<void> {
  const resolvedStamp = resolve(stamp);
  const resolvedParent = resolve(parent);
  if (resolvedStamp === resolvedParent || !resolvedStamp.startsWith(resolvedParent + sep)) {
    throw new Error('VERIFY_DB_FETCH_FAILED');
  }
  try {
    await rm(resolvedStamp, {recursive: true, force: true});
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw new Error('VERIFY_DB_FETCH_FAILED');
  }
  // The downloader runs as uid 65532 and may leave a mode-0700 directory the host user cannot read.
  const opened = await runCommand([
    VERIFY_RUNTIME_BIN, 'run', '--rm', '--user', '0', '--network', 'none',
    '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${resolvedStamp},dst=/databases`,
    image, '-c', 'chmod -R a+rwX /databases',
  ], 'ignore');
  if (opened !== 0) throw new Error('VERIFY_DB_FETCH_FAILED');
  try {
    await rm(resolvedStamp, {recursive: true, force: true});
  } catch {
    throw new Error('VERIFY_DB_FETCH_FAILED');
  }
}

async function createStamp(parent: string, now: Date, image: string): Promise<string> {
  const base = formatStamp(now);
  for (let index = 1; index <= 100; index += 1) {
    const stamp = join(parent, index === 1 ? base : `${base}-${index}`);
    verifyDatabaseArguments({image, output: stamp});
    try {
      await mkdir(stamp, {mode: 0o777});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      // The pinned image runs as uid 65532 and must be able to write the mount.
      await chmod(stamp, 0o777);
      for (const name of ['grype', 'trivy', 'osv']) {
        const child = join(stamp, name);
        await mkdir(child, {mode: 0o777});
        await chmod(child, 0o777);
      }
    } catch (error) {
      await rm(stamp, {recursive: true, force: true});
      throw error;
    }
    return stamp;
  }
  throw new Error('VERIFY_DB_FETCH_FAILED');
}

async function listRegularFiles(root: string): Promise<ManifestFile[]> {
  const files: ManifestFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(root, full).split(sep).join('/');
      if (path === 'manifest.json') continue;
      const hashed = await hashFile(full);
      files.push({path, sha256: hashed.sha256, bytes: hashed.bytes});
    }
  }
  await walk(root);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return files;
}

function hashFile(path: string): Promise<{sha256: string; bytes: number}> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk: Buffer | string) => {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += piece.length;
      hash.update(piece);
    });
    stream.once('error', reject);
    stream.once('end', () => resolvePromise({sha256: hash.digest('hex'), bytes}));
  });
}

async function writePrivateJson(directory: string, name: string, value: unknown): Promise<void> {
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

/** Download vulnerability databases into a new stamp and publish current.json atomically. */
export async function refreshVerifyDatabases(input: RefreshVerifyDatabasesInput): Promise<VerifyDatabaseSnapshot> {
  if (typeof input.dataDirectory !== 'string' || !isAbsolute(input.dataDirectory) || input.dataDirectory.includes('\0')) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN');
  }
  const root = resolve(input.dataDirectory);
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('VERIFY_DB_FETCH_FAILED');
  const image = input.image ? input.image : await readInstalledImage(root);
  const parent = join(root, 'verify-db');
  const fetchedAt = now.toISOString();
  verifyDatabaseArguments({image, output: join(parent, formatStamp(now))});
  await ensureDatabaseRoot(parent);
  const stamp = await createStamp(parent, now, image);
  const args = verifyDatabaseArguments({image, output: stamp});
  const run = input.spawn ?? ((command) => runCommand(command, 'inherit'));
  let code = 1;
  try {
    code = await run(args);
  } catch {
    code = 1;
  }
  if (code !== 0) {
    await discardStamp(stamp, parent, image);
    throw new Error('VERIFY_DB_FETCH_FAILED');
  }
  try {
    // chmod(1) returns non-zero for files the downloader owns. The fetch script already
    // granted a+rX on those. Listing below is what proves the stamp is readable.
    await runCommand(['chmod', '-R', 'a+rX', stamp], 'ignore');
    const files = await listRegularFiles(stamp);
    const manifestBytes = Buffer.from(JSON.stringify({fetchedAt, files}, null, 2) + '\n', 'utf8');
    await writeFile(join(stamp, 'manifest.json'), manifestBytes, {mode: 0o644, flag: 'wx'});
    const snapshot = {
      directory: stamp,
      fetchedAt,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    };
    await writePrivateJson(parent, 'current.json', snapshot);
    return snapshot;
  } catch (error) {
    await discardStamp(stamp, parent, image);
    if (error instanceof Error && error.message === 'VERIFY_DB_FETCH_FAILED') throw error;
    throw new Error('VERIFY_DB_FETCH_FAILED');
  }
}

/** The published stamp, or null when nothing has been published yet. */
export async function readCurrentVerifyDatabase(dataDirectory: string): Promise<VerifyDatabaseSnapshot | null> {
  if (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory)) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  try {
    const parsed = JSON.parse(await readFile(join(resolve(dataDirectory), 'verify-db', 'current.json'), 'utf8')) as {
      directory?: unknown;
      fetchedAt?: unknown;
      manifestSha256?: unknown;
    };
    if (typeof parsed.directory !== 'string' || typeof parsed.fetchedAt !== 'string' || typeof parsed.manifestSha256 !== 'string') {
      throw new Error('VERIFY_DB_CURRENT_INVALID');
    }
    return {directory: parsed.directory, fetchedAt: parsed.fetchedAt, manifestSha256: parsed.manifestSha256};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
