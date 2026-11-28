import {availableSimpleToolsImage} from './simple-tools-image.ts';
import {execFile, spawn as spawnProcess} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {constants, createReadStream, lstatSync} from 'node:fs';
import {chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {installationName, ownerLabelArgs} from '../scripts/ac-labels.mjs';
import {Refusal} from './contracts.ts';
import {VERIFY_RUNTIME_BIN, verifyDatabaseArguments} from './verify-image.ts';
import {diskUsedPercent} from './personal-disk.ts';
import {promisify} from 'node:util';

export type VerifyDatabaseSnapshot = {
  directory: string;
  fetchedAt: string;
  manifestSha256: string;
};

export type RefreshVerifyDatabasesInput = {
  simple?: boolean;
  dataDirectory: string;
  image?: string;
  spawn?: (args: readonly string[]) => Promise<number>;
  now?: Date;
  /** Disk use of the data directory; tests replace it. Undefined keeps the normal retention (`keep`). */
  usedDiskPercent?: () => Promise<number | undefined>;
  /** Stamps kept after publishing, the new one included (storage.verifyDb.keep). Older ones go in the same run. */
  keep?: number;
  /** False skips the Trivy Java database (storage.verifyDb.javaDb, see verifyJavaDatabaseWanted). */
  javaDb?: boolean;
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
/** Stamps being discarded are renamed to this prefix first; it does not match a stamp name. */
const DISCARD_PREFIX = '.descarte-';
const DISCARD_NAME = /^\.descarte-(\d{8}-\d{6}(?:-\d+)?)-[0-9a-f-]{36}$/;
const PRUNE_LOCK = '.poda.lock';
const PRUNE_LOCK_STALE_MS = 60 * 60 * 1000;
const CLAIM_MAX_BYTES = 8192;
/** storage.verifyDb.keep default: the stamp just published (or the newest) plus current.json and the in-use ones. */
const DEFAULT_KEEP = 1;

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
    // The stamps live in <dataDirectory>/verify-db: the installation is the parent's parent.
    ...ownerLabelArgs({installation: installationName(dirname(resolve(parent))), kind: 'verify-db-discard'}),
    image, '-c', 'chmod -R a+rwX /databases',
  ];
}

async function discardStamp(stamp: string, parent: string, image: string | (() => Promise<string>), spawn?: CommandRunner): Promise<void> {
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
  let args: readonly string[];
  try {
    args = discardStampArguments(stamp, parent, typeof image === 'string' ? image : await image());
  } catch {
    throw new Error('VERIFY_DB_FETCH_FAILED');
  }
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
  const image = input.image ?? (input.simple ? await availableSimpleToolsImage(root) : undefined) ?? await readInstalledImage(root);
  const parent = join(root, 'verify-db');
  const fetchedAt = now.toISOString();
  verifyDatabaseArguments({image, output: join(parent, formatStamp(now))});
  await ensureDatabaseRoot(parent);
  const stamp = await createStamp(parent, now, image);
  // A concurrent prune must not take the stamp this process is still downloading.
  const downloadClaim = randomUUID();
  try {
    await claimVerifyDatabaseStamp(root, stamp, downloadClaim);
    // A pressured prune may have taken the empty folder between its creation and this claim.
    if (await stampPresence(stamp) !== 'yes') throw new Error('VERIFY_DB_FETCH_FAILED');
  } catch {
    await releaseVerifyDatabaseStamp(root, stamp, downloadClaim).catch(() => undefined /* the fetch already fails; a leftover claim of this pid expires with it */);
    await discardStamp(stamp, parent, image).catch(() => undefined /* the fetch already fails; the next prune takes an unclaimed folder */);
    throw new Error('VERIFY_DB_FETCH_FAILED');
  }
  let published: VerifyDatabaseSnapshot;
  try {
    published = await publishStamp(input, root, parent, stamp, image, fetchedAt);
  } finally {
    await releaseVerifyDatabaseStamp(root, stamp, downloadClaim).catch(() => {
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'download-claim'}));
    });
  }
  // The new stamp is published whole; compressing it is only a saving and never fails the refresh.
  try {
    for (const line of await compactVerifyDatabaseStamps(root, true, {image, spawn: input.spawn})) console.error(JSON.stringify({event: 'VERIFY_DB_COMPACT', line}));
  } catch {
    console.error(JSON.stringify({event: 'VERIFY_DB_COMPACT_FAILED'}));
  }
  return published;
}

async function publishStamp(
  input: RefreshVerifyDatabasesInput,
  root: string,
  parent: string,
  stamp: string,
  image: string,
  fetchedAt: string,
): Promise<VerifyDatabaseSnapshot> {
  const args = verifyDatabaseArguments({image, output: stamp, javaDb: input.javaDb !== false, labels: ownerLabelArgs({installation: installationName(root), kind: 'verify-db'})});
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
    if (input.javaDb === false && files.some((file) => file.path === JAVA_DB_FILE)) {
      // The pinned image predates AC_VERIFY_JAVA_DB: the stamp is complete, only the saving did not happen.
      console.error(JSON.stringify({event: 'VERIFY_DB_JAVA_SKIP_IGNORED'}));
    }
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
    await pruneVerifyDatabaseStamps(root, image, undefined, {keepRecent: verifyDatabaseKeepRecent(await (input.usedDiskPercent ?? (() => measuredDiskPercent(root)))(), input.keep)});
  } catch {
    console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED'}));
  }
  if (!snapshot) throw new Error('VERIFY_DB_FETCH_FAILED');
  return snapshot;
}

/** The Trivy Java database inside a stamp; verify-entrypoint.sh looks for the same file. */
const JAVA_DB_FILE = 'trivy/java-db/trivy-java.db';

/** True when the stamp carries the Trivy Java database. */
export async function verifyDatabaseStampHasJava(stamp: string): Promise<boolean> {
  if ((await readStampPack(stamp).catch(() => undefined /* unreadable pack: the file itself decides */))?.files.some(entry => entry.path === JAVA_DB_FILE)) return true;
  return (await lstat(join(stamp, JAVA_DB_FILE)).catch(() => null/* absent file: the stamp has no Java database */))?.isFile() === true;
}

/** What makes a project "Java" for the Trivy Java database: Maven or Gradle builds, or a tracked archive. */
const JAVA_PATHSPECS = [':(glob)**/pom.xml', ':(glob)**/build.gradle*', ':(glob)**/*.jar'];

/** True when git lists a Java file in the repository. Throws when git cannot answer. */
export async function repositoryHasJava(repository: string): Promise<boolean> {
  const {stdout} = await promisify(execFile)('/usr/bin/git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repository, 'ls-files', '-z', '--', ...JAVA_PATHSPECS,
  ], {encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', HOME: '/nonexistent'}});
  return stdout.length > 0;
}

/**
 * storage.verifyDb.javaDb: `always` and `never` decide alone; `auto` fetches the Java database only when some project of
 * the installation has Java. A repository git cannot read counts as Java, so an error never takes coverage away.
 */
export async function verifyJavaDatabaseWanted(
  mode: 'auto' | 'always' | 'never',
  repositories: readonly string[],
  hasJava: (repository: string) => Promise<boolean> = repositoryHasJava,
): Promise<boolean> {
  if (mode !== 'auto') return mode === 'always';
  for (const repository of new Set(repositories)) {
    if (await hasJava(repository).catch(() => true /* unknown: keep the Java database */)) return true;
  }
  return false;
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

async function claimFileGone(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
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

/**
 * Live claims only. A dead pid does not keep its stamp, and with `mutate` its claim file is removed.
 * A claim file that cannot be read is logged and skipped; with `strict` it throws, because the stamp it protects is
 * unknown. Strict is used under disk pressure, when no recent stamp is kept as a margin.
 */
async function liveClaimStamps(parent: string, mutate = true, strict = false): Promise<string[]> {
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
      if (strict) throw new Error('VERIFY_DB_CLAIM_UNREADABLE');
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'in-use'}));
      continue;
    }
    if (!claim) {
      // A claim released between the listing and the read protects nothing any more.
      if (await claimFileGone(path)) continue;
      if (strict) throw new Error('VERIFY_DB_CLAIM_UNREADABLE');
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'in-use'}));
      continue;
    }
    if (!claimHolderAlive(claim.pid)) {
      if (!mutate) continue;
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

/** From this disk use on, only the current stamp and the stamps held by a live run are kept. Each stamp has several GB. */
export const VERIFY_DB_PRESSURE_PERCENT = 90;

/**
 * Recent stamps kept besides the current one and the claimed ones (a run's claim, or the claim of a download in progress):
 * two normally, none under disk pressure.
 */
export function verifyDatabaseKeepRecent(usedPercent: number | undefined, keep = DEFAULT_KEEP): number {
  if (usedPercent !== undefined && Number.isFinite(usedPercent) && usedPercent >= VERIFY_DB_PRESSURE_PERCENT) return 0;
  return Number.isInteger(keep) && keep >= 1 && keep <= 4 ? keep : DEFAULT_KEEP;
}

/** Disk use of the data directory, or undefined when it cannot be measured (then the normal retention applies). */
async function measuredDiskPercent(root: string): Promise<number | undefined> {
  try {
    return await diskUsedPercent(root);
  } catch {
    return undefined;
  }
}

/** Stamps that a prune with `keepRecent` would discard. Null when current.json or the claims cannot be read: nothing is discarded. */
export async function verifyDatabaseStampsToDiscard(dataDirectory: string, keepRecent = DEFAULT_KEEP, mutate = true): Promise<string[] | null> {
  const root = assertDataDirectory(dataDirectory);
  const parent = join(root, 'verify-db');
  const names = await listStampNames(parent);
  if (names.length === 0) return [];
  let currentName: string | null = null;
  try {
    const current = await readCurrentVerifyDatabase(root);
    currentName = current ? directStampName(parent, current.directory) : null;
  } catch {
    console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'current'}));
    return null;
  }
  let inUse: string[];
  try {
    inUse = await liveClaimStamps(parent, mutate, keepRecent === 0);
  } catch {
    console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', reason: 'in-use'}));
    return null;
  }
  const keep = new Set(keepRecent > 0 ? names.slice(-keepRecent) : []);
  if (currentName) keep.add(currentName);
  for (const used of inUse) {
    const name = directStampName(parent, used);
    if (!name) continue;
    const presence = await stampPresence(join(parent, name));
    if (presence === 'no') continue;
    keep.add(name);
  }
  return names.filter(name => !keep.has(name));
}

/**
 * Delete stamp directories except the `keepRecent` newest names (storage.verifyDb.keep, one by default), the one current.json points at, and
 * any stamp claimed by a live pid. Names sort chronologically. A claim expires when process.kill(pid, 0) fails with
 * ESRCH; prune may remove that file. A failure to delete one stamp is logged and does not stop the others.
 * Null when current.json or a claim cannot be read: nothing was discarded. Each stamp is first renamed aside, so a
 * run that claims it from then on finds it missing (see verifyDatabaseStampPresent); the claims are read again after
 * the rename and a stamp claimed meanwhile is put back.
 */
export async function pruneVerifyDatabaseStamps(
  dataDirectory: string,
  image: string | (() => Promise<string>),
  spawn?: CommandRunner,
  options: {keepRecent?: number; afterAside?: (name: string) => Promise<void>} = {},
): Promise<string[] | null> {
  const root = assertDataDirectory(dataDirectory);
  const parent = join(root, 'verify-db');
  const lock = await takePruneLock(parent);
  if (lock === 'busy') throw new Refusal('VERIFY_DB_PRUNE_BUSY');
  try {
    return await pruneHoldingLock(root, parent, image, spawn, options.keepRecent ?? DEFAULT_KEEP, options.afterAside);
  } finally {
    if (lock) await releasePruneLock(lock);
  }
}

/**
 * One prune at a time. The lock is published whole with link(2), so nobody reads it half written; it holds the pid and
 * a token. A lock that cannot be read counts as held unless it is older than PRUNE_LOCK_STALE_MS. A dead holder's lock
 * is removed only if it still has the content just read. Returns the lock path and token, 'busy', or null when there is
 * no real verify-db directory yet.
 */
async function takePruneLock(parent: string): Promise<{path: string; token: string} | 'busy' | null> {
  try {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const path = join(parent, PRUNE_LOCK);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const body = JSON.stringify({pid: process.pid, token, startedAt: new Date().toISOString()}) + '\n';
    const temporary = join(parent, `${PRUNE_LOCK}.${token}`);
    await writeFile(temporary, body, {mode: 0o600, flag: 'wx'});
    try {
      await link(temporary, path);
      return {path, token};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await unlink(temporary).catch(() => undefined /* the temporary name is unique to this attempt and never read as the lock */);
    }
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return 'busy';
    }
    let holder: number | undefined;
    try {
      const parsed = JSON.parse(raw) as {pid?: unknown};
      holder = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : undefined;
    } catch {
      holder = undefined;
    }
    if (holder === undefined) {
      const age = await lstat(path).then(info => Date.now() - info.mtimeMs, () => 0);
      if (age < PRUNE_LOCK_STALE_MS) return 'busy';
    } else if (claimHolderAlive(holder)) {
      return 'busy';
    }
    const again = await readFile(path, 'utf8').catch(() => undefined /* unreadable now: compared below and treated as held */);
    if (again !== raw) return 'busy';
    await unlinkClaimFile(path);
  }
  return 'busy';
}

async function releasePruneLock(lock: {path: string; token: string}): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(lock.path, 'utf8')) as {token?: unknown};
    if (parsed.token === lock.token) await unlinkClaimFile(lock.path);
  } catch {
    // Already gone or replaced: it is not this prune's lock to remove.
  }
}

/** Folders a dead prune left under the discard prefix: put back when a live run claims the stamp, deleted otherwise. */
async function settleDiscardOrphans(parent: string, image: string | (() => Promise<string>), spawn?: CommandRunner): Promise<void> {
  let entries;
  try {
    entries = await readdir(parent, {withFileTypes: true});
  } catch {
    return;
  }
  const orphans = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(DISCARD_PREFIX));
  if (orphans.length === 0) return;
  let claimed: Set<string>;
  try {
    claimed = new Set((await liveClaimStamps(parent, false, true)).map(stamp => directStampName(parent, stamp)).filter((name): name is string => !!name));
  } catch {
    return;
  }
  for (const entry of orphans) {
    const match = DISCARD_NAME.exec(entry.name);
    const name = match?.[1];
    const aside = join(parent, entry.name);
    if (name && claimed.has(name)) {
      if (await stampPresence(join(parent, name)) === 'no') {
        await rename(aside, join(parent, name)).catch(() => {
          console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', stamp: name, reason: 'restore'}));
        });
      }
      continue;
    }
    await discardStamp(aside, parent, image, spawn).catch(() => {
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', stamp: entry.name, reason: 'orphan'}));
    });
  }
}

async function pruneHoldingLock(
  root: string,
  parent: string,
  image: string | (() => Promise<string>),
  spawn: CommandRunner | undefined,
  keepRecent: number,
  afterAside?: (name: string) => Promise<void>,
): Promise<string[] | null> {
  await settleDiscardOrphans(parent, image, spawn);
  const discard = await verifyDatabaseStampsToDiscard(root, keepRecent);
  if (!discard) return null;
  const options = {keepRecent};
  const removed: string[] = [];
  for (const name of discard) {
    const original = join(parent, name);
    const aside = join(parent, `${DISCARD_PREFIX}${name}-${randomUUID()}`);
    try {
      await rename(original, aside);
    } catch {
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', stamp: name}));
      continue;
    }
    // Tests use this hook to claim the stamp, or break the claims, between the rename and the second read.
    if (afterAside) await afterAside(name).catch(() => undefined /* a test hook; the second read below decides */);
    let claimed: boolean;
    try {
      claimed = (await liveClaimStamps(parent, false, options.keepRecent === 0)).some(stamp => directStampName(parent, stamp) === name);
    } catch {
      claimed = true;
    }
    if (claimed) {
      try {
        await rename(aside, original);
      } catch {
        console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', stamp: name, reason: 'restore'}));
      }
      continue;
    }
    try {
      await discardStamp(aside, parent, image, spawn);
      removed.push(name);
    } catch {
      console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', stamp: name}));
      // A stamp that resists keeps its name: the next prune finds it, and nothing is left under the discard prefix.
      await rename(aside, original).catch(() => {
        console.error(JSON.stringify({event: 'VERIFY_DB_PRUNE_FAILED', stamp: name, reason: 'restore'}));
      });
    }
  }
  return removed;
}

/** After claiming, a run confirms the stamp is still published there: a prune may have just taken it. */
export async function verifyDatabaseStampPresent(stamp: string): Promise<boolean> {
  try {
    const info = await lstat(join(stamp, 'manifest.json'));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Retention stage of `personal:maintenance`: discards the stamps that a refresh would discard now, with the disk-pressure rule. */
export async function runVerifyDatabaseRetention(
  dataDirectory: string,
  apply: boolean,
  deps: {usedPercent?: number; image?: string; spawn?: CommandRunner; keep?: number} = {},
): Promise<string[]> {
  const root = assertDataDirectory(dataDirectory);
  const used = deps.usedPercent ?? await measuredDiskPercent(root);
  const keepRecent = verifyDatabaseKeepRecent(used, deps.keep);
  const rule = keepRecent === 0 ? `disco em ${VERIFY_DB_PRESSURE_PERCENT}% ou mais: fica só a base atual e as em uso`
    : keepRecent === 1 ? 'fica a base atual e as em uso' : `fica a base atual, as em uso e as ${keepRecent} mais recentes`;
  const discard = await verifyDatabaseStampsToDiscard(root, keepRecent, apply);
  if (discard === null) throw new Refusal('VERIFY_DB_PRUNE_FAILED');
  // The pinned image is needed only to chmod a stamp the host user cannot delete or compress.
  const image = deps.image ?? (() => resolveStampImage(root));
  if (!apply) return [`Bases de vulnerabilidades (${rule}): ${discard.length} elegível(is)${discard.length ? ': ' + discard.join(', ') : ''}.`,
    ...await compactVerifyDatabaseStamps(root, false)];
  let line = `Bases de vulnerabilidades (${rule}): nada a remover.`;
  if (discard.length) {
    const removed = await pruneVerifyDatabaseStamps(root, image, deps.spawn, {keepRecent});
    if (removed === null) throw new Refusal('VERIFY_DB_PRUNE_FAILED');
    line = `Bases de vulnerabilidades (${rule}): removida(s) ${removed.length} de ${discard.length}${removed.length ? ': ' + removed.join(', ') : ''}.`;
  }
  // The stamps that remain (the current one first of all) are kept compressed at rest.
  return [line, ...await compactVerifyDatabaseStamps(root, true, {image, spawn: deps.spawn})];
}

// ---- Compressed stamps at rest -----------------------------------------------------------------------------------
// The large database files of a published stamp (grype, trivy, osv archives) are kept compressed with zstd under
// `<stamp>/.compactado/`, described by `pacote.json` (bound to the manifest by its digest). Each exam expands them into a
// private temporary of its own round, mounted read-only, and removes it when the run ends. A file whose expanded bytes do not
// match the manifest digest is refused (VERIFY_DB_CORRUPT), never used. The stamp is always whole: until `pacote.json` exists
// the originals are all there; the originals go only after it exists and while no live run holds the stamp.

const PACK_DIR = '.compactado';
const PACK_FILE = 'pacote.json';
/** Files from this size on are compressed; the rest stay as they are and are copied into the expanded copy. */
export const PACK_MIN_BYTES = 8 * 1024 * 1024;
const PACK_MAX_BYTES = 4 * 1024 * 1024;
type PackEntry = {path: string; sha256: string; bytes: number; archive: string; archiveSha256: string; archiveBytes: number};
type StampPack = {schemaVersion: 1; codec: 'zstd'; manifestSha256: string; files: PackEntry[]};
const SAFE_RELATIVE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const HEX64 = /^[a-f0-9]{64}$/;

async function readManifest(stamp: string): Promise<{bytes: Buffer; files: ManifestFile[]}> {
  const bytes = await readFile(join(stamp, 'manifest.json'));
  const parsed = JSON.parse(bytes.toString('utf8')) as {files?: unknown};
  if (!Array.isArray(parsed.files)) throw new Refusal('VERIFY_DB_CORRUPT', 503);
  const files = parsed.files.map((file: Partial<ManifestFile>) => {
    if (typeof file?.path !== 'string' || !SAFE_RELATIVE.test(file.path) || file.path.startsWith(PACK_DIR + '/') || typeof file.sha256 !== 'string' || !HEX64.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0) throw new Refusal('VERIFY_DB_CORRUPT', 503);
    return {path: file.path, sha256: file.sha256, bytes: file.bytes as number};
  });
  return {bytes, files};
}

/** The pack of a stamp, or undefined when the stamp is not compressed. A pack that does not match its manifest is refused. */
export async function readStampPack(stamp: string): Promise<StampPack | undefined> {
  let text: Buffer;
  try {
    const handle = await open(join(stamp, PACK_DIR, PACK_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > PACK_MAX_BYTES) throw new Refusal('VERIFY_DB_CORRUPT', 503);
      text = await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof Refusal) throw error;
    throw new Refusal('VERIFY_DB_CORRUPT', 503);
  }
  let pack: StampPack;
  try { pack = JSON.parse(text.toString('utf8')) as StampPack; } catch { throw new Refusal('VERIFY_DB_CORRUPT', 503); }
  const manifest = await readManifest(stamp);
  const byPath = new Map(manifest.files.map(file => [file.path, file]));
  if (pack?.schemaVersion !== 1 || pack.codec !== 'zstd' || !Array.isArray(pack.files)
    || pack.manifestSha256 !== createHash('sha256').update(manifest.bytes).digest('hex')) throw new Refusal('VERIFY_DB_CORRUPT', 503);
  for (const entry of pack.files) {
    const listed = byPath.get(entry?.path);
    if (!listed || listed.sha256 !== entry.sha256 || listed.bytes !== entry.bytes || entry.archive !== `${PACK_DIR}/${entry.path}.zst`
      || typeof entry.archiveSha256 !== 'string' || !HEX64.test(entry.archiveSha256) || !Number.isSafeInteger(entry.archiveBytes)) throw new Refusal('VERIFY_DB_CORRUPT', 503);
  }
  return pack;
}

/** Streams `source` through `transform` (a plain copy when omitted) into `target` (created exclusively), returning the digest
 * and size of what was read and written. */
async function streamThrough(source: string, target: string, transform: NodeJS.ReadWriteStream | undefined, mode: number) {
  const {pipeline} = await import('node:stream/promises');
  const {createWriteStream} = await import('node:fs');
  const {PassThrough} = await import('node:stream');
  const through = transform ?? new PassThrough();
  const read = createHash('sha256'), written = createHash('sha256');
  let readBytes = 0, writtenBytes = 0;
  const input = createReadStream(source);
  input.on('data', (chunk: Buffer | string) => { const piece = Buffer.from(chunk); readBytes += piece.length; read.update(piece); });
  through.on('data', (chunk: Buffer) => { writtenBytes += chunk.length; written.update(chunk); });
  await pipeline(input, through, createWriteStream(target, {flags: 'wx', mode}));
  return {readSha256: read.digest('hex'), readBytes, writtenSha256: written.digest('hex'), writtenBytes};
}

/** Disk use (percent) of the volume of `path` once `bytes` more are written there. Tests replace it. */
type DiskAfter = (path: string, bytes: number) => Promise<number>;

async function usedPercentAfter(path: string, bytes: number): Promise<number> {
  const {statfs} = await import('node:fs/promises');
  const info = await statfs(path);
  const blocks = Math.ceil(bytes / info.bsize);
  if (blocks > info.bavail) return 100;
  const used = info.blocks - info.bfree + blocks, capacity = info.blocks - info.bfree + info.bavail;
  return 100 * used / capacity;
}

/** Prefix of the expanded copies, and the reservation each one keeps while it is being written. */
const EXPANDED_PREFIX = 'ac-verify-db-';
const RESERVATION = '.reserva.json';

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, {withFileTypes: true}).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await treeBytes(child);
    else if (entry.isFile() && entry.name !== RESERVATION) total += await lstat(child).then(info => info.size, () => 0);
  }
  return total;
}

/** Bytes that the expansions still being written under `tmp` (by a live process) will add: each reserved its whole size up front.
 * Two exams that check the disk at the same time therefore see each other, and so does a compaction on the same volume. */
async function reservedExpansionBytes(tmp: string, except?: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(tmp).catch(() => [] as string[])) {
    if (!name.startsWith(EXPANDED_PREFIX)) continue;
    const directory = join(tmp, name);
    if (directory === except) continue;
    let reservation: {bytes?: unknown; pid?: unknown};
    try { reservation = JSON.parse(await readFile(join(directory, RESERVATION), 'utf8')) as typeof reservation; } catch { continue; /* finished, or not ours */ }
    const {bytes, pid} = reservation;
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid)) continue;
    total += Math.max(0, bytes - await treeBytes(directory));
  }
  return total;
}

async function sameVolume(a: string, b: string): Promise<boolean> {
  try { return (await lstat(a)).dev === (await lstat(b)).dev; } catch { return true; /* unknown: count the reservations */ }
}

/** Compresses the large files of one stamp under `.compactado/` and writes `pacote.json` last. The originals stay. Idempotent.
 * `replace` starts over from a pack that does not check (its originals were proved present by the caller and are re-read here
 * against the manifest). Before each file the disk is checked: if the archive, at most as large as its original, plus the
 * expansions being written could take the volume to {@link DISK_BLOCK_PERCENT}, the pass stops (PERSONAL_DISK_FULL). */
async function packStamp(stamp: string, options: {replace?: boolean; tmpRoot?: string; freeAfter?: DiskAfter} = {}): Promise<StampPack> {
  const existing = options.replace ? undefined : await readStampPack(stamp);
  if (existing) return existing;
  const zlib = await import('node:zlib');
  const {tmpdir} = await import('node:os');
  const {DISK_BLOCK_PERCENT} = await import('./personal-disk.ts');
  const manifest = await readManifest(stamp);
  const root = join(stamp, PACK_DIR);
  const tmp = options.tmpRoot ?? tmpdir();
  const freeAfter = options.freeAfter ?? usedPercentAfter;
  // A pass that died midway left partial archives (or the pack does not check): start over.
  await rm(root, {recursive: true, force: true});
  await mkdir(root, {mode: 0o755});
  const files: PackEntry[] = [];
  try {
    for (const file of manifest.files.filter(item => item.bytes >= PACK_MIN_BYTES)) {
      const reserved = await sameVolume(tmp, stamp) ? await reservedExpansionBytes(tmp) : 0;
      if (await freeAfter(stamp, file.bytes + reserved) >= DISK_BLOCK_PERCENT) throw new Refusal('PERSONAL_DISK_FULL', 503);
      const archive = `${PACK_DIR}/${file.path}.zst`;
      await mkdir(dirname(join(stamp, archive)), {recursive: true, mode: 0o755});
      const done = await streamThrough(join(stamp, file.path), join(stamp, archive), zlib.createZstdCompress(), 0o644);
      // An original that no longer matches its manifest is not packed: the stamp is left as it is.
      if (done.readSha256 !== file.sha256 || done.readBytes !== file.bytes) throw new Refusal('VERIFY_DB_CORRUPT', 503);
      files.push({...file, archive, archiveSha256: done.writtenSha256, archiveBytes: done.writtenBytes});
    }
    const pack: StampPack = {schemaVersion: 1, codec: 'zstd', manifestSha256: createHash('sha256').update(manifest.bytes).digest('hex'), files};
    const temporary = join(root, `.${PACK_FILE}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(pack, null, 1) + '\n', {mode: 0o644, flag: 'wx'});
    await rename(temporary, join(root, PACK_FILE));
    return pack;
  } catch (error) {
    await rm(root, {recursive: true, force: true}).catch(() => undefined /* the error below is what the pass reports */);
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new Refusal('PERSONAL_DISK_FULL', 503);
    throw error;
  }
}

/** Whether every archive of a pack still has the size it was written with (a cheap check at rest; the digests are checked on
 * every expansion). */
async function archivesIntact(stamp: string, pack: StampPack): Promise<boolean> {
  for (const entry of pack.files) {
    const size = await lstat(join(stamp, entry.archive)).then(info => info.isFile() ? info.size : -1, () => -1);
    if (size !== entry.archiveBytes) return false;
  }
  return true;
}

/** Whether every file of the manifest is on disk as an original, with its manifest size. */
async function originalsPresent(stamp: string): Promise<boolean> {
  const manifest = await readManifest(stamp).catch(() => undefined);
  if (!manifest) return false;
  for (const file of manifest.files) {
    const size = await lstat(join(stamp, file.path)).then(info => info.isFile() ? info.size : -1, () => -1);
    if (size !== file.bytes) return false;
  }
  return true;
}

/** Removes the originals that the pack holds. The downloader (uid 65532) owns their folders: when the host user cannot unlink,
 * `openForHost` gives the stamp to it once (the same root chmod a discard uses). Returns the originals still on disk. */
async function dropPackedOriginals(stamp: string, pack: StampPack, openForHost: () => Promise<boolean>): Promise<number> {
  let opened = false, left = 0;
  for (const entry of pack.files) {
    const path = join(stamp, entry.path);
    for (;;) {
      try { await unlink(path); break; } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') break;
        if ((code === 'EACCES' || code === 'EPERM') && !opened) { opened = true; if (await openForHost().catch(() => false)) continue; }
        left += 1;
        break;
      }
    }
  }
  return left;
}

/** Retention and refresh pass: compresses every stamp not yet compressed and, for those that no live run holds, removes the
 * originals. Runs under the prune lock. `apply:false` only says what would happen. A pack that does not check is rebuilt
 * from the originals when they are all still there; without them the pass says that module 1 exams on that stamp are refused
 * until a new stamp is downloaded. */
export async function compactVerifyDatabaseStamps(dataDirectory: string, apply: boolean,
  deps: {image?: string | (() => Promise<string>); spawn?: CommandRunner; tmpRoot?: string; freeAfter?: DiskAfter} = {}): Promise<string[]> {
  const root = assertDataDirectory(dataDirectory);
  const parent = join(root, 'verify-db');
  const names = await listStampNames(parent);
  const lines: string[] = [];
  const pending: string[] = [];
  const rebuild = new Set<string>();
  for (const name of names) {
    const stamp = join(parent, name);
    if (!await verifyDatabaseStampPresent(stamp)) continue;
    let pack = await readStampPack(stamp).catch(() => null);
    if (pack && !await archivesIntact(stamp, pack)) pack = null;
    if (pack === null) {
      if (await originalsPresent(stamp)) {
        lines.push(`Base ${name}: pacote compactado inválido; os originais estão no disco e ${apply ? 'o pacote é refeito' : 'o pacote seria refeito'}.`);
        rebuild.add(name);
        pending.push(name);
      } else {
        lines.push(`Base ${name}: pacote compactado inválido e sem os originais; os exames do módulo 1 com esta base são recusados (VERIFY_DB_CORRUPT) até uma base nova. Baixe outra com npm run personal:maintenance -- <instalação>.`);
      }
      continue;
    }
    if (pack && pack.files.every(entry => !existsSyncSafe(join(stamp, entry.path)))) continue;
    // Nothing large enough to be worth it (or a manifest that cannot be read): the stamp stays as it is.
    if (!pack && !(await readManifest(stamp).catch(() => ({files: []}))).files.some(file => file.bytes >= PACK_MIN_BYTES)) continue;
    pending.push(name);
  }
  if (!pending.length) return lines;
  if (!apply) return [...lines, `Bases de vulnerabilidades: ${pending.length} seria(m) compactada(s): ${pending.join(', ')}.`];
  const lock = await takePruneLock(parent);
  if (lock === 'busy') return [...lines, 'Bases de vulnerabilidades: compactação adiada (outra poda em andamento).'];
  try {
    const image = deps.image ?? (() => resolveStampImage(root));
    for (const name of pending) {
      const stamp = join(parent, name);
      let pack: StampPack;
      try { pack = await packStamp(stamp, {replace: rebuild.has(name), tmpRoot: deps.tmpRoot, freeAfter: deps.freeAfter}); } catch (error) {
        const code = error instanceof Refusal ? error.code : 'erro';
        lines.push(code === 'PERSONAL_DISK_FULL'
          ? `Base ${name}: compactação adiada; o pacote levaria o disco a 95% ou mais (PERSONAL_DISK_FULL). A base segue sem compactar.`
          : `Base ${name}: compactação falhou (${code}); a base segue sem compactar.`);
        continue;
      }
      // The pack exists from here on. A run that claims the stamp now expands the pack; one that claimed it before keeps the originals.
      let claimed: boolean;
      try { claimed = (await liveClaimStamps(parent, false, true)).some(stamp => directStampName(parent, stamp) === name); } catch { claimed = true; }
      const packed = pack.files.reduce((sum, entry) => sum + entry.archiveBytes, 0), original = pack.files.reduce((sum, entry) => sum + entry.bytes, 0);
      if (claimed) { lines.push(`Base ${name}: compactada; originais preservados enquanto um exame a usa (a próxima retenção os remove).`); continue; }
      const left = await dropPackedOriginals(stamp, pack, async () => {
        const args = discardStampArguments(stamp, parent, typeof image === 'string' ? image : await image());
        return (deps.spawn ? await deps.spawn(args) : await runCommand(args, 'ignore', DISCARD_TIMEOUT_MS)) === 0;
      });
      lines.push(left
        ? `Base ${name}: compactada, mas ${left} original(is) não puderam ser removidos (sem permissão); a próxima retenção tenta de novo.`
        : `Base ${name}: compactada (${(original / 1e9).toFixed(2)} GB em ${(packed / 1e9).toFixed(2)} GB).`);
    }
  } finally {
    if (lock) await releasePruneLock(lock);
  }
  return lines;
}

function existsSyncSafe(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** The image that may chmod a stamp: the pinned common image when present, else the installed verify image. */
async function resolveStampImage(root: string): Promise<string> {
  return (await availableSimpleToolsImage(root).catch(() => undefined /* no common pin: the installed image */)) ?? readInstalledImage(root);
}

export type ExpandedDatabases = {directory: string; release: () => Promise<void>};
type ExpandDeps = {tmpRoot?: string; track?: (path: string) => Promise<unknown>; freeAfter?: DiskAfter};

/** A pack that does not check is not the end of the exam when the originals are all still on the stamp (it was held by a run
 * during the compaction, or the pack broke later): each one is read against the manifest digest and the stamp is mounted as it
 * is. Otherwise the original refusal stands. */
async function verifiedOriginals(stamp: string, refusal: unknown): Promise<ExpandedDatabases> {
  const manifest = await readManifest(stamp).catch(() => undefined);
  if (!manifest || !await originalsPresent(stamp)) throw refusal;
  for (const file of manifest.files) {
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of createReadStream(join(stamp, file.path))) { const piece = chunk as Buffer; bytes += piece.length; hash.update(piece); }
    } catch { throw refusal; }
    if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw refusal;
  }
  console.error(JSON.stringify({event: 'VERIFY_DB_PACK_CORRUPT', fallback: 'originals'}));
  return {directory: stamp, release: async () => undefined};
}

/** The directory an exam mounts as `/databases`. An uncompressed stamp is mounted as it is. A compressed one is expanded into a
 * private temporary (`ac-verify-db-*`, registered by `track` as a round temporary) that `release` removes; every expanded or
 * copied file is checked against the manifest digest and size. The expansion reserves its whole size while it is written, and
 * refuses with PERSONAL_DISK_FULL when it plus the other expansions in progress would take the disk to 95% or more. A pack that
 * does not check falls back to the originals when they are all there and match the manifest (see {@link verifiedOriginals}). */
export async function expandVerifyDatabaseStamp(stamp: string, deps: ExpandDeps = {}): Promise<ExpandedDatabases> {
  let pack: StampPack | undefined;
  try { pack = await readStampPack(stamp); } catch (error) { return verifiedOriginals(stamp, error); }
  if (!pack?.files.length) return {directory: stamp, release: async () => undefined};
  const zlib = await import('node:zlib');
  const {mkdtemp, realpath} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {DISK_BLOCK_PERCENT} = await import('./personal-disk.ts');
  const manifest = await readManifest(stamp);
  const tmp = await realpath(deps.tmpRoot ?? tmpdir());
  const needed = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  const directory = await mkdtemp(join(tmp, EXPANDED_PREFIX));
  const release = () => rm(directory, {recursive: true, force: true});
  try {
    await chmod(directory, 0o755);
    await deps.track?.(directory);
    // The reservation goes first, then the check: two exams that start together each count the other one.
    await writeFile(join(directory, RESERVATION), JSON.stringify({bytes: needed, pid: process.pid}) + '\n', {mode: 0o600, flag: 'wx'});
    const others = await reservedExpansionBytes(tmp, directory);
    if (await (deps.freeAfter ?? usedPercentAfter)(tmp, needed + others) >= DISK_BLOCK_PERCENT) throw new Refusal('PERSONAL_DISK_FULL', 503);
    const packed = new Map(pack.files.map(entry => [entry.path, entry]));
    for (const file of manifest.files) {
      const target = join(directory, file.path);
      await mkdir(dirname(target), {recursive: true, mode: 0o755});
      const entry = packed.get(file.path);
      const done = entry
        ? await streamThrough(join(stamp, entry.archive), target, zlib.createZstdDecompress(), 0o644)
        : await streamThrough(join(stamp, file.path), target, undefined, 0o644);
      if ((entry && done.readSha256 !== entry.archiveSha256) || done.writtenSha256 !== file.sha256 || done.writtenBytes !== file.bytes) throw new Refusal('VERIFY_DB_CORRUPT', 503);
      await chmod(target, 0o644);
    }
    const {copyFile} = await import('node:fs/promises');
    await copyFile(join(stamp, 'manifest.json'), join(directory, 'manifest.json'), constants.COPYFILE_EXCL);
    await chmod(join(directory, 'manifest.json'), 0o644);
    await unlink(join(directory, RESERVATION));
    return {directory, release};
  } catch (error) {
    await release().catch(() => undefined /* the refusal below is what the exam reports */);
    const refusal = error instanceof Refusal ? error
      : (error as NodeJS.ErrnoException).code === 'ENOSPC' ? new Refusal('PERSONAL_DISK_FULL', 503)
      // A damaged archive fails inside zstd: it is a corrupt base, never a silent gap.
      : new Refusal('VERIFY_DB_CORRUPT', 503);
    if (refusal.code === 'VERIFY_DB_CORRUPT') return verifiedOriginals(stamp, refusal);
    throw refusal;
  }
}
