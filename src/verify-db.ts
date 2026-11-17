import {spawn as spawnProcess} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile} from 'node:fs/promises';
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
type CommandRunner = (args: readonly string[]) => Promise<number>;

/** The root chmod only has to finish; the download itself is the long one. */
const DISCARD_TIMEOUT_MS = 60_000;
/** Two hours. Vulnerability archives are large and the fetch must not hang forever. */
const FETCH_TIMEOUT_MS = 7_200_000;
const STAMP_DIRECTORY = /^\d{8}-\d{6}(?:-\d+)?$/;
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RUN_CLAIM_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const IN_USE_DIR = 'in-use';
const CLAIM_MAX_BYTES = 8192;

type StampClaim = {stamp: string; pid: number; claimedAt: string};

function runCommand(args: readonly string[], stdio: 'ignore' | 'inherit', timeoutMs: number): Promise<number> {
  const command = args[0];
  if (!command) return Promise.resolve(1);
  return new Promise((resolvePromise) => {
    const child = spawnProcess(command, args.slice(1), {stdio});
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(code);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(1);
    }, timeoutMs);
    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code ?? 1));
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

function assertStampInside(stamp: string, parent: string): string {
  const resolvedStamp = resolve(stamp);
  const resolvedParent = resolve(parent);
  if (resolvedStamp === resolvedParent || !resolvedStamp.startsWith(resolvedParent + sep)) {
    throw new Error('VERIFY_DB_FETCH_FAILED');
  }
  return resolvedStamp;
}

/** Docker argv for the chmod that runs only when the host cannot unlink a stamp. No I/O. */
export function discardStampArguments(stamp: string, parent: string, image: string): readonly string[] {
  const resolvedStamp = assertStampInside(stamp, parent);
  return [
    VERIFY_RUNTIME_BIN, 'run', '--rm',
    '--user', '0',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE',
    '--cap-add', 'FOWNER',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${resolvedStamp},dst=/databases`,
    image, '-c', 'chmod -R a+rwX /databases',
  ];
}

async function discardStamp(stamp: string, parent: string, image: string, spawn?: CommandRunner): Promise<void> {
  const resolvedStamp = assertStampInside(stamp, parent);
  try {
    await rm(resolvedStamp, {recursive: true, force: true});
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw new Error('VERIFY_DB_FETCH_FAILED');
  }
  // The downloader runs as uid 65532 and may leave a mode-0700 directory the host user cannot read.
  // Root keeps only the caps needed to chmod that tree; the rootfs stays read-only.
  const args = discardStampArguments(stamp, parent, image);
  let opened = 1;
  try {
    opened = spawn ? await spawn(args) : await runCommand(args, 'ignore', DISCARD_TIMEOUT_MS);
  } catch {
    opened = 1;
  }
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
  const run = input.spawn ?? ((command) => runCommand(command, 'inherit', FETCH_TIMEOUT_MS));
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
  let snapshot: VerifyDatabaseSnapshot | undefined;
  try {
    // chmod(1) returns non-zero for files the downloader owns. The fetch script already
    // granted a+rX on those. Listing below is what proves the stamp is readable.
    await runCommand(['chmod', '-R', 'a+rX', stamp], 'ignore', DISCARD_TIMEOUT_MS);
    const files = await listRegularFiles(stamp);
    const manifestBytes = Buffer.from(JSON.stringify({fetchedAt, files}, null, 2) + '\n', 'utf8');
    await writeFile(join(stamp, 'manifest.json'), manifestBytes, {mode: 0o644, flag: 'wx'});
    snapshot = {
      directory: stamp,
      fetchedAt,
      manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    };
    await writePrivateJson(parent, 'current.json', snapshot);
  } catch (error) {
    await discardStamp(stamp, parent, image);
    if (error instanceof Error && error.message === 'VERIFY_DB_FETCH_FAILED') throw error;
    throw new Error('VERIFY_DB_FETCH_FAILED');
  }
  // current.json is already published. A stubborn old stamp must not undo it or fail the refresh.
  try {
    await pruneVerifyDatabaseStamps(root, image);
  } catch {
    console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED'}));
  }
  if (!snapshot) throw new Error('VERIFY_DB_FETCH_FAILED');
  return snapshot;
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

function assertDataDirectory(dataDirectory: string): string {
  if (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN');
  }
  return resolve(dataDirectory);
}

/** Direct child of parent whose name is a stamp, or null when the path is something else. */
function directStampName(parent: string, candidate: string): string | null {
  if (typeof candidate !== 'string' || !isAbsolute(candidate) || candidate.includes('\0')) return null;
  const resolvedParent = resolve(parent);
  const resolved = resolve(candidate);
  if (resolved === resolvedParent || !resolved.startsWith(resolvedParent + sep)) return null;
  const name = resolved.slice(resolvedParent.length + 1);
  if (!STAMP_DIRECTORY.test(name)) return null;
  return name;
}

function assertClaimedStamp(parent: string, stamp: string): string {
  const name = directStampName(parent, stamp);
  if (!name) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  return join(resolve(parent), name);
}

function assertRunId(runId: string): string {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  return runId;
}

function parseStampClaim(raw: string): StampClaim | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const body = parsed as {stamp?: unknown; pid?: unknown; claimedAt?: unknown};
  if (typeof body.stamp !== 'string' || body.stamp.length === 0 || body.stamp.includes('\0')) return null;
  if (typeof body.pid !== 'number' || !Number.isInteger(body.pid) || body.pid <= 0) return null;
  if (typeof body.claimedAt !== 'string' || Number.isNaN(Date.parse(body.claimedAt))) return null;
  return {stamp: body.stamp, pid: body.pid, claimedAt: body.claimedAt};
}

/** ESRCH means the holder is gone. Any other error means the pid may still be live. */
function claimHolderAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function ensureInUseDirectory(parent: string): Promise<string> {
  const directory = join(parent, IN_USE_DIR);
  try {
    await mkdir(directory, {mode: 0o700});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  await chmod(directory, 0o700);
  return directory;
}

async function readClaimFile(path: string): Promise<StampClaim | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    const info = await file.stat();
    const uid = process.getuid?.();
    if (!info.isFile() || info.size > CLAIM_MAX_BYTES || (uid !== undefined && info.uid !== uid)) return null;
    return parseStampClaim((await file.readFile()).toString('utf8'));
  } finally {
    await file.close();
  }
}

async function unlinkClaimFile(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return;
  await unlink(path);
}

/** Live claims only. A dead pid does not keep its stamp, and that claim file may be removed. */
async function liveClaimStamps(parent: string): Promise<string[]> {
  const directory = join(parent, IN_USE_DIR);
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return [];
  const entries = await readdir(directory, {withFileTypes: true});
  const stamps: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    if (!RUN_CLAIM_FILE.test(entry.name)) continue;
    const path = join(directory, entry.name);
    let claim: StampClaim | null;
    try {
      claim = await readClaimFile(path);
    } catch {
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'in-use'}));
      continue;
    }
    if (!claim) {
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'in-use'}));
      continue;
    }
    if (!claimHolderAlive(claim.pid)) {
      try {
        await unlinkClaimFile(path);
      } catch {
        console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'in-use'}));
      }
      continue;
    }
    stamps.push(claim.stamp);
  }
  return stamps;
}

async function listStampNames(parent: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(parent, {withFileTypes: true});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && STAMP_DIRECTORY.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function stampPresence(path: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() ? 'yes' : 'no';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'no';
    return 'unknown';
  }
}

/** Remember a stamp for one exam run. The 0600 file is that run's alone, written by temp and rename. */
export async function claimVerifyDatabaseStamp(dataDirectory: string, stamp: string, runId: string): Promise<void> {
  const root = assertDataDirectory(dataDirectory);
  const parent = join(root, 'verify-db');
  const resolved = assertClaimedStamp(parent, stamp);
  const id = assertRunId(runId);
  await ensureDatabaseRoot(parent);
  const directory = await ensureInUseDirectory(parent);
  const claim: StampClaim = {stamp: resolved, pid: process.pid, claimedAt: new Date().toISOString()};
  const existing = await readClaimFile(join(directory, `${id}.json`));
  if (existing && existing.stamp === claim.stamp && existing.pid === claim.pid) return;
  await writePrivateJson(directory, `${id}.json`, claim);
}

/** Delete that run's claim file. A missing file is a no-op. */
export async function releaseVerifyDatabaseStamp(dataDirectory: string, stamp: string, runId: string): Promise<void> {
  const root = assertDataDirectory(dataDirectory);
  const parent = join(root, 'verify-db');
  assertClaimedStamp(parent, stamp);
  const id = assertRunId(runId);
  const path = join(parent, IN_USE_DIR, `${id}.json`);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Refusal('VERIFY_PATH_FORBIDDEN');
  await unlink(path);
}

/**
 * Delete stamp directories except the two newest names, the one current.json
 * points at, and any stamp claimed by a live pid. Names sort chronologically.
 * A claim expires when process.kill(pid, 0) fails with ESRCH; prune may remove that file.
 * A failure to delete one stamp is logged and does not stop the others.
 */
export async function pruneVerifyDatabaseStamps(dataDirectory: string, image: string, spawn?: CommandRunner): Promise<void> {
  const root = assertDataDirectory(dataDirectory);
  const parent = join(root, 'verify-db');
  const names = await listStampNames(parent);
  if (names.length === 0) return;
  let currentName: string | null = null;
  try {
    const current = await readCurrentVerifyDatabase(root);
    currentName = current ? directStampName(parent, current.directory) : null;
  } catch {
    console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'current'}));
    return;
  }
  let inUse: string[];
  try {
    inUse = await liveClaimStamps(parent);
  } catch {
    console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'in-use'}));
    return;
  }
  const keep = new Set(names.slice(-2));
  if (currentName) keep.add(currentName);
  for (const used of inUse) {
    const name = directStampName(parent, used);
    if (!name) continue;
    const presence = await stampPresence(join(parent, name));
    if (presence === 'no') continue;
    keep.add(name);
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    try {
      await discardStamp(join(parent, name), parent, image, spawn);
    } catch {
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', stamp: name}));
    }
  }
}
