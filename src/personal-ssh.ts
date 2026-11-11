import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {privateDirectory} from './installation.ts';
import {withPersonalProjectCreation} from './personal-panel-projects.ts';

const run = promisify(execFile);
const hostName = /^(?=.{1,253}$)(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])$/;
const userName = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
const keyType = /^(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)$/;
const keyMaterial = /^[A-Za-z0-9+/=]+$/;
const fingerprintText = /^SHA256:[A-Za-z0-9+/]{43}$/;
const commitId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const agentControlRef = /^refs\/heads\/agent-control\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const preferredTypes = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'] as const;

export type ScannedIdentity = {fingerprint: string; type: string; key: string; hostField: string};
export type PersonalSshHost = {id: string; label: string; host: string; port: number; user: string; fingerprint: string};

const HostRecord = z.object({
 id: z.uuid(), label: z.string().min(1).max(200), host: z.string().regex(hostName),
 port: z.number().int().min(1).max(65535), user: z.string().regex(userName), fingerprint: z.string().regex(fingerprintText),
}).strict();

type Scan = (host: string, port: number) => Promise<ScannedIdentity[]>;
let files: Promise<unknown> = Promise.resolve();

/** One writer at a time for the host list and known_hosts. A scan never writes either. */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
 const run = files.then(work, work);
 files = run.then(() => undefined, () => undefined);
 return run;
}

/**
 * Remote path the owner typed. The character class is the whole allow-list:
 * `..`, quotes, `$`, backtick and `;` are outside it, and `..` is refused again as a segment.
 */
export function assertRemotePath(path: string): string {
 if (!/^\/[A-Za-z0-9._/ -]{1,400}$/.test(path)) throw new Refusal('REMOTE_PATH_FORBIDDEN', 403);
 const parts = path.split('/');
 if (parts.some((part, index) => index > 0 && (!part || part === '.' || part === '..'))) throw new Refusal('REMOTE_PATH_FORBIDDEN', 403);
 return path;
}

/** SSH joins the remote command into one shell string, so the path is already single-quoted. */
export function shellSingleQuote(value: string): string {
 return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Options on every SSH and Git call after the owner has confirmed the server. No extra identity is offered. */
export function sshOptionArgs(knownHosts: string, identityFile: string): string[] {
 return ['-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'IdentitiesOnly=yes',
  '-o', `IdentityFile=${identityFile}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
}

export function gitSshCommand(knownHosts: string, identityFile: string): string {
 return ['ssh', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${shellSingleQuote(knownHosts)}`,
  '-o', 'IdentitiesOnly=yes', '-o', `IdentityFile=${shellSingleQuote(identityFile)}`,
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'].join(' ');
}

/** OpenSSH SHA256 fingerprint of the raw key blob, without base64 padding. */
export function fingerprintOfKey(key: string): string {
 if (!keyMaterial.test(key)) throw new Refusal('HOST_IDENTITY_UNAVAILABLE', 503);
 const hash = createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
 const fingerprint = `SHA256:${hash}`;
 if (!fingerprintText.test(fingerprint)) throw new Refusal('HOST_IDENTITY_UNAVAILABLE', 503);
 return fingerprint;
}

export function knownHostToken(host: string, port: number): string {
 if (!hostName.test(host) || host.includes('..') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal('HOST_INVALID', 400);
 return port === 22 ? host : `[${host}]:${port}`;
}

export function identitiesFromKeyscan(output: string, host: string, port: number): ScannedIdentity[] {
 const token = knownHostToken(host, port);
 const found: ScannedIdentity[] = [];
 for (const raw of output.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const match = /^(\S+) (ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) ([A-Za-z0-9+/=]+)$/.exec(line);
  if (!match || !match[1].split(',').includes(token)) continue;
  found.push({hostField: match[1], type: match[2], key: match[3], fingerprint: fingerprintOfKey(match[3])});
 }
 return found;
}

/** The confirmed fingerprint has to be one of the keys scanned at this moment. A different key is refused. */
export function matchConfirmedFingerprint(scanned: readonly ScannedIdentity[], fingerprint: string): ScannedIdentity {
 const clean = fingerprint.trim();
 if (!fingerprintText.test(clean)) throw new Refusal('HOST_IDENTITY_MISMATCH', 409);
 const matches = scanned.filter(item => item.fingerprint === clean);
 if (!matches.length) throw new Refusal('HOST_IDENTITY_MISMATCH', 409);
 return matches.find(item => item.type === 'ssh-ed25519') ?? matches[0]!;
}

export function preferredIdentity(scanned: readonly ScannedIdentity[]): ScannedIdentity {
 for (const type of preferredTypes) {
  const found = scanned.find(item => item.type === type);
  if (found) return found;
 }
 throw new Refusal('HOST_IDENTITY_UNAVAILABLE', 503);
}

/**
 * Push refspec. Only `refs/heads/agent-control/<name>` is returned; anything else throws
 * before a Git command is built.
 */
export function pushRefspec(commit: string, ref: string): string {
 if (!commitId.test(commit) || !agentControlRef.test(ref) || ref.includes('..')) throw new Refusal('REMOTE_PUSH_REF_FORBIDDEN', 403);
 return `${commit}:${ref}`;
}

export function agentControlPushRef(commit: string, when: Date): string {
 if (!commitId.test(commit)) throw new Refusal('REMOTE_PUSH_REF_FORBIDDEN', 403);
 const pad = (value: number) => String(value).padStart(2, '0');
 const stamp = `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}`;
 return `refs/heads/agent-control/${stamp}-${commit.slice(0, 7)}`;
}

/**
 * A bind reaches the key when its source is the ssh directory, a file inside it, or a parent of it.
 * Worker, tools and QA binds are taken from hostRoot, accountRoot and work copies under those roots.
 */
export function bindSourceReaches(secretDirectory: string, source: string): boolean {
 const secret = resolve(secretDirectory);
 const mount = resolve(source);
 return mount === secret || mount.startsWith(secret + sep) || secret.startsWith(mount + sep);
}

export function assertSshOutsideMountRoots(sshDirectory: string, roots: readonly string[]): void {
 for (const root of roots) if (bindSourceReaches(sshDirectory, root)) throw new Refusal('SSH_KEY_MOUNT_OVERLAP', 403);
}

/** A clone lives at `<dataDirectory>/remote/<one segment>`, never in the ssh directory and never above it. */
export function isPersonalRemoteCheckout(dataDirectory: string, repo: string): boolean {
 const root = resolve(dataDirectory);
 const remote = join(root, 'remote');
 const ssh = join(root, 'ssh');
 const real = resolve(repo);
 if (bindSourceReaches(ssh, real)) return false;
 if (real === remote || !real.startsWith(remote + sep)) return false;
 return /^[A-Za-z0-9._-]{1,60}$/.test(real.slice(remote.length + 1));
}

function sshDir(dataDirectory: string) { return join(resolve(dataDirectory), 'ssh'); }
function keyPath(dataDirectory: string) { return join(sshDir(dataDirectory), 'id_ed25519'); }
function knownHostsPath(dataDirectory: string) { return join(sshDir(dataDirectory), 'known_hosts'); }
function hostsPath(dataDirectory: string) { return join(resolve(dataDirectory), 'remote-hosts.json'); }

async function writePrivate(path: string, content: string) {
 const temporary = `${path}.${randomUUID()}.tmp`;
 await writeFile(temporary, content, {mode: 0o600, flag: 'wx'});
 await chmod(temporary, 0o600);
 await renameFile(temporary, path);
 await chmod(path, 0o600);
}
async function renameFile(from: string, to: string) {
 const {rename} = await import('node:fs/promises');
 await rename(from, to);
}

async function ensureSshDirectory(dataDirectory: string) {
 const directory = sshDir(dataDirectory);
 await mkdir(directory, {recursive: true, mode: 0o700});
 await chmod(directory, 0o700);
 await privateDirectory(directory);
 return directory;
}

/** Generates the installation key once. A later call leaves the same key in place. */
export async function ensurePersonalSshKey(dataDirectory: string): Promise<{publicKey: string}> {
 await ensureSshDirectory(dataDirectory);
 const file = keyPath(dataDirectory);
 try {
  await readFile(file);
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', file, '-C', 'agent-control', '-q'],
   {timeout: 15000, env: {PATH: '/usr/bin:/bin'}});
 }
 await chmod(file, 0o600);
 const pub = `${file}.pub`;
 await chmod(pub, 0o600);
 const publicKey = (await readFile(pub, 'utf8')).trim();
 if (!publicKey.startsWith('ssh-ed25519 ') || publicKey.includes('\n')) throw new Refusal('SSH_KEY_INVALID', 503);
 return {publicKey};
}

async function readHosts(dataDirectory: string): Promise<PersonalSshHost[]> {
 try {
  const parsed = z.array(HostRecord).max(32).parse(JSON.parse(await readFile(hostsPath(dataDirectory), 'utf8')));
  return parsed;
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
  if (error instanceof Refusal) throw error;
  throw new Refusal('REMOTE_FILE_INVALID', 503);
 }
}
async function writeHosts(dataDirectory: string, hosts: readonly PersonalSshHost[]) {
 await writePrivate(hostsPath(dataDirectory), JSON.stringify(hosts, null, 2) + '\n');
}

function lineMatchesToken(line: string, token: string) {
 const field = line.split(' ')[0] ?? '';
 return field.split(',').includes(token);
}
async function readKnownHostLines(dataDirectory: string): Promise<string[]> {
 try { return (await readFile(knownHostsPath(dataDirectory), 'utf8')).split('\n').filter(line => line.length > 0); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function writeKnownHostLines(dataDirectory: string, lines: readonly string[]) {
 await ensureSshDirectory(dataDirectory);
 await writePrivate(knownHostsPath(dataDirectory), lines.length ? `${lines.join('\n')}\n` : '');
}

export async function scanHostIdentities(host: string, port: number): Promise<ScannedIdentity[]> {
 knownHostToken(host, port);
 let stdout = '';
 try {
  stdout = (await run('ssh-keyscan', ['-T', '15', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', host],
   {encoding: 'utf8', timeout: 20000, env: {PATH: '/usr/bin:/bin'}})).stdout;
 } catch (error) {
  const recovered = (error as {stdout?: string}).stdout;
  if (typeof recovered !== 'string' || !recovered.trim()) throw new Refusal('HOST_IDENTITY_UNAVAILABLE', 503);
  stdout = recovered;
 }
 const found = identitiesFromKeyscan(stdout, host, port);
 if (!found.length) throw new Refusal('HOST_IDENTITY_UNAVAILABLE', 503);
 return found;
}

export async function personalSshStatus(dataDirectory: string) {
 const {publicKey} = await ensurePersonalSshKey(dataDirectory);
 const hosts = await readHosts(dataDirectory);
 return {publicKey, hosts};
}

export async function scanPersonalHost(host: string, port: number, user: string) {
 if (!userName.test(user)) throw new Refusal('HOST_INVALID', 400);
 const identity = preferredIdentity(await scanHostIdentities(host, port));
 return {fingerprint: identity.fingerprint};
}

function cleanLabel(label: string) {
 const clean = label.trim();
 if (clean.length < 1 || clean.length > 200 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Refusal('LABEL_INVALID', 400);
 return clean;
}

/**
 * Writes the host and exactly one known_hosts line. The line is the key scanned again now,
 * and only when its fingerprint is the one the owner confirmed. A changed key updates nothing.
 */
export async function confirmPersonalHost(dataDirectory: string, input: {host: string; port: number; user: string; label: string; fingerprint: string}, scan: Scan = scanHostIdentities): Promise<PersonalSshHost> {
 const host = input.host.trim();
 const user = input.user.trim();
 const label = cleanLabel(input.label);
 const token = knownHostToken(host, input.port);
 if (!userName.test(user)) throw new Refusal('HOST_INVALID', 400);
 const identity = matchConfirmedFingerprint(await scan(host, input.port), input.fingerprint);
 if (!keyType.test(identity.type) || !keyMaterial.test(identity.key)) throw new Refusal('HOST_IDENTITY_MISMATCH', 409);
 const line = `${identity.hostField} ${identity.type} ${identity.key}`;
 return exclusive(async () => {
  const hosts = await readHosts(dataDirectory);
  if (hosts.some(item => item.host === host && item.port === input.port && item.user === user)) throw new Refusal('HOST_ALREADY_PRESENT', 409);
  if (hosts.length >= 32) throw new Refusal('HOST_LIMIT', 409);
  const record: PersonalSshHost = {id: randomUUID(), label, host, port: input.port, user, fingerprint: identity.fingerprint};
  const lines = (await readKnownHostLines(dataDirectory)).filter(item => !lineMatchesToken(item, token));
  lines.push(line);
  await writeKnownHostLines(dataDirectory, lines);
  try { await writeHosts(dataDirectory, [...hosts, record]); }
  catch (error) {
   await writeKnownHostLines(dataDirectory, lines.filter(item => item !== line)).catch(() => undefined);
   throw error;
  }
  return record;
 });
}

export async function removePersonalHost(dataDirectory: string, id: string): Promise<void> {
 if (!z.uuid().safeParse(id).success) throw new Refusal('HOST_NOT_FOUND', 404);
 await exclusive(async () => {
  const hosts = await readHosts(dataDirectory);
  const host = hosts.find(item => item.id === id);
  if (!host) throw new Refusal('HOST_NOT_FOUND', 404);
  if ((await readRemoteProjects(dataDirectory)).some(item => item.hostId === id)) throw new Refusal('HOST_IN_USE', 409);
  const remaining = hosts.filter(item => item.id !== id);
  const token = knownHostToken(host.host, host.port);
  await writeHosts(dataDirectory, remaining);
  if (remaining.some(item => knownHostToken(item.host, item.port) === token)) return;
  await writeKnownHostLines(dataDirectory, (await readKnownHostLines(dataDirectory)).filter(item => !lineMatchesToken(item, token)));
 });
}

/** Absolute paths of the files this module pins. Tests and the gateway use the same pair. */
export function personalSshPaths(dataDirectory: string) {
 const root = resolve(dataDirectory);
 return {directory: join(root, 'ssh'), identityFile: join(root, 'ssh', 'id_ed25519'), knownHosts: join(root, 'ssh', 'known_hosts')};
}

const branchName = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const RemoteProjectRecord = z.object({
 projectId: z.uuid(), hostId: z.uuid(),
 path: z.string().refine(value => { try { assertRemotePath(value); return true; } catch { return false; } }),
 branch: z.string().regex(branchName).refine(value => !value.split('/').includes('..')),
}).strict();
export type PersonalRemoteProject = z.infer<typeof RemoteProjectRecord>;

/**
 * Fixed remote listing. The path is the only variable and it is already single-quoted,
 * because SSH joins its arguments into one shell command. At most 500 names, and none that start with ".".
 */
const remoteFolderScript = `set -eu
dir=$1
test -d "$dir"
find "$dir" -mindepth 1 -maxdepth 1 -type d -name '[!.]*' -print | head -n 500 | while IFS= read -r entry
do
 name=\${entry##*/}
 if test -d "$entry/.git" || test -f "$entry/.git"; then printf '%s\\t1\\n' "$name"; else printf '%s\\t0\\n' "$name"; fi
done
`;

export function remoteFolderCommand(path: string): string {
 return `sh -c ${shellSingleQuote(remoteFolderScript)} -- ${shellSingleQuote(assertRemotePath(path))}`;
}

function projectsPath(dataDirectory: string) { return join(resolve(dataDirectory), 'remote-projects.json'); }

async function readRemoteProjects(dataDirectory: string): Promise<PersonalRemoteProject[]> {
 try { return z.array(RemoteProjectRecord).max(32).parse(JSON.parse(await readFile(projectsPath(dataDirectory), 'utf8'))); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
  throw new Refusal('REMOTE_FILE_INVALID', 503);
 }
}
async function writeRemoteProjects(dataDirectory: string, projects: readonly PersonalRemoteProject[]) {
 await writePrivate(projectsPath(dataDirectory), JSON.stringify(projects, null, 2) + '\n');
}

function gitEnv(dataDirectory: string): NodeJS.ProcessEnv {
 const paths = personalSshPaths(dataDirectory);
 return {PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: gitSshCommand(paths.knownHosts, paths.identityFile)};
}
function remoteGitUrl(host: PersonalSshHost, path: string): string {
 const encoded = assertRemotePath(path).split('/').map(part => encodeURIComponent(part)).join('/');
 return `ssh://${host.user}@${host.host}:${host.port}${encoded}`;
}
function checkoutDirectoryName(label: string): string {
 const name = label.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
 if (!/^[A-Za-z0-9._-]{1,60}$/.test(name)) throw new Refusal('LABEL_INVALID', 400);
 return name;
}
function rethrowAdd(error: unknown): never {
 if (error instanceof Refusal) throw error;
 if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message))
  throw new Refusal(error.message, error.message === 'DATA_DIRECTORY_PATH_FORBIDDEN' || error.message === 'PERSONAL_ACTIVATION_REQUIRED' ? 403 : 409);
 throw error;
}
async function projectIdForRepository(installationPath: string, repository: string): Promise<string | undefined> {
 try {
  const raw = JSON.parse(await readFile(installationPath, 'utf8')) as {project?: {id?: unknown; repo?: unknown}; projects?: {id?: unknown; repo?: unknown}[]};
  const real = await realpath(repository);
  for (const project of [raw.project, ...(raw.projects ?? [])]) {
   if (!project || typeof project.repo !== 'string' || typeof project.id !== 'string') continue;
   const repoReal = await realpath(project.repo).catch(() => project.repo);
   if (repoReal === real) return project.id;
  }
 } catch { return undefined; }
 return undefined;
}
async function rememberRemote(dataDirectory: string, record: PersonalRemoteProject) {
 await exclusive(async () => {
  const hosts = await readHosts(dataDirectory);
  if (!hosts.some(item => item.id === record.hostId)) throw new Refusal('HOST_NOT_FOUND', 404);
  const current = await readRemoteProjects(dataDirectory);
  if (current.some(item => item.projectId === record.projectId || (item.hostId === record.hostId && item.path === record.path))) return;
  if (current.length >= 32) throw new Refusal('HOST_LIMIT', 409);
  await writeRemoteProjects(dataDirectory, [...current, record]);
 });
}

async function sshCommand(dataDirectory: string, host: PersonalSshHost, command: string): Promise<string> {
 const paths = personalSshPaths(dataDirectory);
 return (await run('ssh', [...sshOptionArgs(paths.knownHosts, paths.identityFile), '-p', String(host.port), `${host.user}@${host.host}`, command],
  {encoding: 'utf8', timeout: 20000, env: {PATH: '/usr/bin:/bin'}})).stdout;
}

export async function listRemoteFolders(dataDirectory: string, hostId: string, path: string) {
 const clean = assertRemotePath(path);
 if (!z.uuid().safeParse(hostId).success) throw new Refusal('HOST_NOT_FOUND', 404);
 const host = (await readHosts(dataDirectory)).find(item => item.id === hostId);
 if (!host) throw new Refusal('HOST_NOT_FOUND', 404);
 let stdout = '';
 try { stdout = await sshCommand(dataDirectory, host, remoteFolderCommand(clean)); }
 catch { throw new Refusal('SSH_FAILED', 503); }
 const folders: {name: string; path: string; git: boolean}[] = [];
 for (const line of stdout.split('\n')) {
  if (!line) continue;
  const match = /^([^\t/]+)\t([01])$/.exec(line);
  if (!match || match[1] === '.' || match[1] === '..' || match[1].startsWith('.')) continue;
  const child = `${clean.replace(/\/+$/, '')}/${match[1]}`;
  try { assertRemotePath(child); } catch { continue; }
  if (folders.length >= 500) break;
  folders.push({name: match[1], path: child, git: match[2] === '1'});
 }
 folders.sort((left, right) => left.name.localeCompare(right.name, 'en'));
 return {host: host.id, path: clean, folders};
}

/**
 * Clones over SSH into `<dataDirectory>/remote/<label>`, records where it came from,
 * then attaches the copy with the same module a local folder uses.
 */
export async function createRemotePersonalProject(input: {
 dataDirectory: string; installationPath: string; hostId: string; path: string; label: string; underSystemd: boolean;
 addPersonalProject: (installationPath: string, repository: string, label: string) => Promise<{projectId: string}>;
}): Promise<{projectId: string; restarting: boolean; restartRequired: boolean}> {
 const path = assertRemotePath(input.path);
 const label = cleanLabel(input.label);
 if (!z.uuid().safeParse(input.hostId).success) throw new Refusal('HOST_NOT_FOUND', 404);
 return withPersonalProjectCreation(async () => {
  const host = (await readHosts(input.dataDirectory)).find(item => item.id === input.hostId);
  if (!host) throw new Refusal('HOST_NOT_FOUND', 404);
  if ((await readRemoteProjects(input.dataDirectory)).some(item => item.hostId === host.id && item.path === path)) throw new Refusal('REPOSITORY_ALREADY_IN_INSTALLATION', 409);
  const name = checkoutDirectoryName(label);
  const root = join(resolve(input.dataDirectory), 'remote');
  await mkdir(root, {recursive: true, mode: 0o700});
  await chmod(root, 0o700);
  const dest = join(root, name);
  if (!isPersonalRemoteCheckout(input.dataDirectory, dest)) throw new Refusal('LABEL_INVALID', 400);
  try { await lstat(dest); throw new Refusal('CHECKOUT_EXISTS', 409); }
  catch (error) { if (error instanceof Refusal) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
   await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', 'clone', '--', remoteGitUrl(host, path), dest],
    {encoding: 'utf8', timeout: 120000, env: gitEnv(input.dataDirectory)});
  } catch { await rm(dest, {recursive: true, force: true}).catch(() => undefined); throw new Refusal('SSH_FAILED', 503); }
  let branch = '';
  try {
   branch = (await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', dest, 'symbolic-ref', '--short', 'HEAD'],
    {encoding: 'utf8', timeout: 15000, env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'}})).stdout.trim();
  } catch { branch = ''; }
  if (!branchName.test(branch) || branch.split('/').includes('..')) {
   await rm(dest, {recursive: true, force: true}).catch(() => undefined);
   throw new Refusal('REPOSITORY_BRANCH_REQUIRED', 409);
  }
  let created: {projectId: string};
  try { created = await input.addPersonalProject(input.installationPath, dest, label); }
  catch (error) {
   const kept = await projectIdForRepository(input.installationPath, dest);
   if (kept) await rememberRemote(input.dataDirectory, {projectId: kept, hostId: host.id, path, branch}).catch(() => undefined);
   else await rm(dest, {recursive: true, force: true}).catch(() => undefined);
   rethrowAdd(error);
  }
  await rememberRemote(input.dataDirectory, {projectId: created.projectId, hostId: host.id, path, branch});
  const restarting = input.underSystemd;
  return {projectId: created.projectId, restarting, restartRequired: !restarting};
 });
}
