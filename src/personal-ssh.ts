import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {Refusal} from './contracts.ts';
import {privateDirectory} from './installation.ts';
import {withPersonalProjectCreation} from './personal-panel-projects.ts';
import {containFailure} from './failure-log.ts';

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

/**
 * Options on every ssh invocation, and on clone, fetch and push through GIT_SSH_COMMAND.
 * ssh-keyscan has no matching flags; its call stays limited to -T, -p and -t.
 * No user or system config, no extra known_hosts file, no proxy, no agent and no host-key rewrite.
 */
export function sshOptionArgs(knownHosts: string, identityFile: string): string[] {
 return ['-F', '/dev/null', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes',
  '-o', `IdentityFile=${identityFile}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
  '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'ForwardAgent=no', '-o', 'VerifyHostKeyDNS=no',
  '-o', 'PermitLocalCommand=no'];
}

export function gitSshCommand(knownHosts: string, identityFile: string): string {
 return ['ssh', '-F', '/dev/null', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${shellSingleQuote(knownHosts)}`, '-o', 'UpdateHostKeys=no', '-o', 'IdentitiesOnly=yes',
  '-o', `IdentityFile=${shellSingleQuote(identityFile)}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
  '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'ForwardAgent=no', '-o', 'VerifyHostKeyDNS=no',
  '-o', 'PermitLocalCommand=no'].join(' ');
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
 const name = host.trim().toLowerCase();
 if (!hostName.test(name) || name.includes('..') || !Number.isInteger(port) || port < 1 || port > 65535) throw new Refusal('HOST_INVALID', 400);
 return port === 22 ? name : `[${name}]:${port}`;
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
 const wanted = token.toLowerCase();
 return field.split(',').some(item => item.toLowerCase() === wanted);
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
 const name = host.trim().toLowerCase();
 knownHostToken(name, port);
 let stdout = '';
 try {
  stdout = (await run('ssh-keyscan', ['-T', '15', '-p', String(port), '-t', 'ed25519,ecdsa,rsa', name],
   {encoding: 'utf8', timeout: 20000, env: {PATH: '/usr/bin:/bin'}})).stdout;
 } catch (error) {
  const recovered = (error as {stdout?: string}).stdout;
  if (typeof recovered !== 'string' || !recovered.trim()) throw new Refusal('HOST_IDENTITY_UNAVAILABLE', 503);
  stdout = recovered;
 }
 const found = identitiesFromKeyscan(stdout, name, port);
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
 const identity = preferredIdentity(await scanHostIdentities(host.trim().toLowerCase(), port));
 return {fingerprint: identity.fingerprint};
}

function cleanLabel(label: string) {
 const clean = label.trim();
 if (clean.length < 1 || clean.length > 200 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Refusal('LABEL_INVALID', 400);
 return clean;
}

/**
 * Writes the host and, only when this host and port have no pin yet, one known_hosts line.
 * Another user of the same host and port must present the same fingerprint.
 * A different key is HOST_KEY_CHANGED and no line is removed.
 */
export async function confirmPersonalHost(dataDirectory: string, input: {host: string; port: number; user: string; label: string; fingerprint: string}, scan: Scan = scanHostIdentities): Promise<PersonalSshHost> {
 const host = input.host.trim().toLowerCase();
 const user = input.user.trim();
 const label = cleanLabel(input.label);
 const token = knownHostToken(host, input.port);
 if (!userName.test(user)) throw new Refusal('HOST_INVALID', 400);
 const identity = matchConfirmedFingerprint(await scan(host, input.port), input.fingerprint);
 if (!keyType.test(identity.type) || !keyMaterial.test(identity.key)) throw new Refusal('HOST_IDENTITY_MISMATCH', 409);
 const line = `${identity.hostField} ${identity.type} ${identity.key}`;
 return exclusive(async () => {
  const hosts = await readHosts(dataDirectory);
  if (hosts.some(item => item.host.toLowerCase() === host && item.port === input.port && item.user === user)) throw new Refusal('HOST_ALREADY_PRESENT', 409);
  const pinned = hosts.find(item => item.host.toLowerCase() === host && item.port === input.port);
  if (pinned && pinned.fingerprint !== identity.fingerprint) throw new Refusal('HOST_KEY_CHANGED', 409);
  const lines = await readKnownHostLines(dataDirectory);
  const existing = lines.find(item => lineMatchesToken(item, token));
  if (existing) {
   const key = existing.split(' ')[2] ?? '';
   let pinnedFingerprint = '';
   try { pinnedFingerprint = fingerprintOfKey(key); } catch { pinnedFingerprint = ''; }
   if (pinnedFingerprint !== identity.fingerprint) throw new Refusal('HOST_KEY_CHANGED', 409);
  }
  if (hosts.length >= 32) throw new Refusal('HOST_LIMIT', 409);
  const record: PersonalSshHost = {id: randomUUID(), label, host, port: input.port, user, fingerprint: identity.fingerprint};
  const added = !existing;
  if (added) {
   lines.push(line);
   await writeKnownHostLines(dataDirectory, lines);
  }
  try { await writeHosts(dataDirectory, [...hosts, record]); }
  catch (error) {
   if (added) await writeKnownHostLines(dataDirectory, lines.filter(item => item !== line)).catch(containFailure('SSH_KNOWN_HOST_ROLLBACK_FAILED', undefined));
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
 return `ssh://${host.user}@${host.host.toLowerCase()}:${host.port}${encoded}`;
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
/** Caller holds the host-list lock, so removal cannot pass between this check and the write. */
async function rememberRemoteLocked(dataDirectory: string, record: PersonalRemoteProject) {
 const hosts = await readHosts(dataDirectory);
 if (!hosts.some(item => item.id === record.hostId)) throw new Refusal('HOST_NOT_FOUND', 404);
 const current = await readRemoteProjects(dataDirectory);
 if (current.some(item => item.projectId === record.projectId || (item.hostId === record.hostId && item.path === record.path))) return;
 if (current.length >= 32) throw new Refusal('HOST_LIMIT', 409);
 await writeRemoteProjects(dataDirectory, [...current, record]);
}

async function sshCommand(dataDirectory: string, host: PersonalSshHost, command: string): Promise<string> {
 const paths = personalSshPaths(dataDirectory);
 return (await run('ssh', [...sshOptionArgs(paths.knownHosts, paths.identityFile), '-p', String(host.port), `${host.user}@${host.host.toLowerCase()}`, command],
  {encoding: 'utf8', timeout: 20000, env: {PATH: '/usr/bin:/bin'}})).stdout;
}

/** Options for the one connection that authenticates with the owner's password. Same isolation, no key, no batch mode. */
export function passwordSshArgs(knownHosts: string): string[] {
 return ['-F', '/dev/null', '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'UpdateHostKeys=no', '-o', 'PubkeyAuthentication=no',
  '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=15',
  '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'ForwardAgent=no', '-o', 'VerifyHostKeyDNS=no', '-o', 'PermitLocalCommand=no'];
}

const installablePublicKey = /^ssh-ed25519 [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]+)?$/;
/** Fixed remote command: create ~/.ssh and authorized_keys, append the key once. */
export function installKeyRemoteCommand(publicKey: string): string {
 const key = publicKey.trim();
 if (!installablePublicKey.test(key)) throw new Refusal('SSH_KEY_INVALID', 503);
 const script = 'set -eu\numask 077\nmkdir -p "$HOME/.ssh"\nchmod 700 "$HOME/.ssh"\ntouch "$HOME/.ssh/authorized_keys"\nchmod 600 "$HOME/.ssh/authorized_keys"\ngrep -qxF -- "$1" "$HOME/.ssh/authorized_keys" || printf \'%s\\n\' "$1" >> "$HOME/.ssh/authorized_keys"\n';
 return `sh -c ${shellSingleQuote(script)} -- ${shellSingleQuote(key)}`;
}

const installWindowMs = 10 * 60_000;
const installAttempts = new Map<string, {failures: number[]; pending: number}>();

async function runPasswordInstall(dataDirectory: string, host: PersonalSshHost, password: string) {
 const {publicKey} = await exclusive(() => ensurePersonalSshKey(dataDirectory));
 const paths = personalSshPaths(dataDirectory);
 const secret = Buffer.from(password + '\n', 'utf8');
 const {spawn} = await import('node:child_process');
 try { return await new Promise<{code: number | null; stderr: string}>(done => {
  const child = spawn('/usr/bin/sshpass', ['-d', '3', '/usr/bin/ssh', ...passwordSshArgs(paths.knownHosts), '-p', String(host.port),
   `${host.user}@${host.host.toLowerCase()}`, '--', installKeyRemoteCommand(publicKey)],
   {stdio: ['ignore', 'ignore', 'pipe', 'pipe'], env: {PATH: '/usr/bin:/bin'}, timeout: 30000});
  let stderr = '';
  child.stderr!.on('data', chunk => { if (stderr.length < 4000) stderr += String(chunk); });
  const channel = child.stdio[3] as import('node:stream').Writable;
  channel.on('error', () => {});
  channel.end(secret, () => secret.fill(0));
  child.on('error', () => done({code: -1, stderr: ''}));
  child.on('close', code => done({code, stderr}));
 }); } finally { secret.fill(0); }
}

/**
 * Uses the owner's password once, only after the host identity was confirmed and pinned.
 * Reserves a try before starting SSH and releases the reservation on every outcome.
 */
export async function installKeyWithPassword(dataDirectory: string, hostId: string, password: string, now = Date.now(), runInstall = runPasswordInstall): Promise<void> {
 if (!z.uuid().safeParse(hostId).success) throw new Refusal('HOST_NOT_FOUND', 404);
 if (!password || password.length > 200) throw new Refusal('SSH_PASSWORD_REJECTED', 401);
 const host = (await readHosts(dataDirectory)).find(item => item.id === hostId);
 if (!host) throw new Refusal('HOST_NOT_FOUND', 404);
 for (const [key, attempts] of installAttempts) {
  attempts.failures = attempts.failures.filter(at => now - at < installWindowMs);
  if (attempts.pending === 0 && attempts.failures.length === 0) installAttempts.delete(key);
 }
 const key = join(dataDirectory, hostId);
 const attempts = installAttempts.get(key) ?? {failures: [], pending: 0};
 if (attempts.failures.length + attempts.pending >= 5) throw new Refusal('SSH_PASSWORD_LIMIT', 409);
 attempts.pending++;
 installAttempts.set(key, attempts);
 try {
  const outcome = await runInstall(dataDirectory, host, password);
  if (outcome.code !== 0) {
   // sshpass exit 5: wrong password. Host key problems come from ssh itself. Never echo the server's text.
   if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(outcome.stderr)) throw new Refusal('HOST_KEY_CHANGED', 409);
   if (outcome.code === 5 || /Permission denied/i.test(outcome.stderr)) {
    attempts.failures.push(now);
    throw new Refusal('SSH_PASSWORD_REJECTED', 401);
   }
   throw new Refusal('SSH_FAILED', 503);
  }
  attempts.failures = attempts.failures.filter(at => at >= now);
  try { await sshCommand(dataDirectory, host, 'true'); }
  catch { throw new Refusal('SSH_KEY_INSTALL_FAILED', 503); }
 } finally {
  attempts.pending--;
  if (attempts.pending === 0 && attempts.failures.length === 0) installAttempts.delete(key);
 }
}

/** An archived project no longer pulls from or pushes to its server; the host can then be removed. */
export async function forgetRemoteProject(dataDirectory: string, projectId: string): Promise<void> {
 await exclusive(async () => {
  const projects = await readRemoteProjects(dataDirectory);
  const kept = projects.filter(project => project.projectId !== projectId);
  if (kept.length !== projects.length) await writeRemoteProjects(dataDirectory, kept);
 });
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
  } catch { await rm(dest, {recursive: true, force: true}).catch(() => undefined /* best-effort cleanup; the original error is what the caller sees */); throw new Refusal('SSH_FAILED', 503); }
  let branch = '';
  try {
   branch = (await run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-C', dest, 'symbolic-ref', '--short', 'HEAD'],
    {encoding: 'utf8', timeout: 15000, env: {PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0'}})).stdout.trim();
  } catch { branch = ''; }
  if (!branchName.test(branch) || branch.split('/').includes('..')) {
   await rm(dest, {recursive: true, force: true}).catch(() => undefined /* best-effort cleanup; the original error is what the caller sees */);
   throw new Refusal('REPOSITORY_BRANCH_REQUIRED', 409);
  }
  let created: {projectId: string};
  try {
   created = await exclusive(async () => {
    const hostNow = (await readHosts(input.dataDirectory)).find(item => item.id === host.id);
    if (!hostNow) throw new Refusal('HOST_NOT_FOUND', 404);
    const linked = await readRemoteProjects(input.dataDirectory);
    if (linked.some(item => item.hostId === hostNow.id && item.path === path)) throw new Refusal('REPOSITORY_ALREADY_IN_INSTALLATION', 409);
    try {
     const added = await input.addPersonalProject(input.installationPath, dest, label);
     await rememberRemoteLocked(input.dataDirectory, {projectId: added.projectId, hostId: hostNow.id, path, branch});
     return added;
    } catch (error) {
     const kept = await projectIdForRepository(input.installationPath, dest);
     if (kept) await rememberRemoteLocked(input.dataDirectory, {projectId: kept, hostId: hostNow.id, path, branch}).catch(containFailure('SSH_REMOTE_LINK_NOT_RECORDED', undefined));
     throw error;
    }
   });
  } catch (error) {
   const kept = await projectIdForRepository(input.installationPath, dest);
   if (!kept) await rm(dest, {recursive: true, force: true}).catch(() => undefined /* best-effort cleanup; the original error is what the caller sees */);
   rethrowAdd(error);
  }
  const restarting = input.underSystemd;
  return {projectId: created.projectId, restarting, restartRequired: !restarting};
 });
}

const pendingRef = /^refs\/heads\/agent-control\/[0-9]{8}-[0-9]{4}-[0-9a-f]{7}$/;
const PendingRecord = z.object({
 id: z.uuid(), projectId: z.uuid(), hostId: z.uuid(), commit: z.string().regex(commitId), ref: z.string().regex(pendingRef),
 pushed: z.boolean(), told: z.enum(['none', 'failed', 'sent']),
}).strict();
type PendingPush = z.infer<typeof PendingRecord>;
type RemoteRegistry = {dataDirectory: string; projects: readonly {id: string; repo: string}[]};
let remoteRegistry: RemoteRegistry | undefined;
const repoLocks = new Map<string, Promise<unknown>>();

export function registerPersonalRemote(registry: RemoteRegistry) {
 remoteRegistry = {dataDirectory: resolve(registry.dataDirectory), projects: registry.projects.map(project => ({id: project.id, repo: project.repo}))};
}

function pendingPath(dataDirectory: string) { return join(resolve(dataDirectory), 'remote-pending.json'); }
async function readPending(dataDirectory: string): Promise<PendingPush[]> {
 try { return z.array(PendingRecord).max(100).parse(JSON.parse(await readFile(pendingPath(dataDirectory), 'utf8'))); }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Refusal('REMOTE_FILE_INVALID', 503); }
}
async function writePending(dataDirectory: string, pending: readonly PendingPush[]) {
 await writePrivate(pendingPath(dataDirectory), JSON.stringify(pending, null, 2) + '\n');
}
function withRepo<T>(repo: string, work: () => Promise<T>): Promise<T> {
 const previous = repoLocks.get(repo) ?? Promise.resolve();
 const run = previous.then(work, work);
 repoLocks.set(repo, run.then(() => undefined, () => undefined));
 return run;
}
async function git(repo: string, args: string[], env: NodeJS.ProcessEnv) {
 return run('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-c', 'protocol.allow=never',
  '-c', 'protocol.ssh.allow=always', '-c', 'submodule.recurse=false', '-C', repo, ...args], {encoding: 'utf8', timeout: 60000, env});
}
async function isAncestor(repo: string, older: string, newer: string, env: NodeJS.ProcessEnv): Promise<boolean> {
 try { await git(repo, ['merge-base', '--is-ancestor', older, newer], env); return true; }
 catch (error) { if ((error as {code?: unknown}).code === 1) return false; throw error; }
}
async function lookupRemote(checkout: string) {
 const registry = remoteRegistry;
 if (!registry) return undefined;
 let real: string;
 try { real = await realpath(checkout); } catch { return undefined; }
 let projectId: string | undefined;
 for (const project of registry.projects) {
  if ((await realpath(project.repo).catch(() => project.repo)) === real) { projectId = project.id; break; }
 }
 if (!projectId) return undefined;
 const record = (await readRemoteProjects(registry.dataDirectory)).find(item => item.projectId === projectId);
 const host = record ? (await readHosts(registry.dataDirectory)).find(item => item.id === record.hostId) : undefined;
 if (!record || !host) return undefined;
 return {projectId, record, host, repo: real, dataDirectory: registry.dataDirectory};
}

/** Fetch the recorded branch and move the copy only when that is a fast-forward. A divergence changes nothing. */
async function fastForward(repo: string, host: PersonalSshHost, record: PersonalRemoteProject, dataDirectory: string): Promise<'current' | 'forward' | 'diverged'> {
 if (!branchName.test(record.branch) || record.branch.split('/').includes('..')) throw new Refusal('REPOSITORY_BRANCH_REQUIRED', 409);
 const env = gitEnv(dataDirectory);
 await git(repo, ['fetch', '--no-tags', '--no-recurse-submodules', remoteGitUrl(host, record.path), `refs/heads/${record.branch}`], env);
 if (await isAncestor(repo, 'FETCH_HEAD', 'HEAD', env)) return 'current';
 if (!await isAncestor(repo, 'HEAD', 'FETCH_HEAD', env)) return 'diverged';
 await git(repo, ['merge', '--ff-only', 'FETCH_HEAD'], env);
 return 'forward';
}

export async function syncRemoteBeforeRequest(repo: string): Promise<{proceed: true} | {proceed: false; text: string}> {
 const found = await lookupRemote(repo);
 if (!found) return {proceed: true};
 try {
  const outcome = await withRepo(found.repo, () => fastForward(found.repo, found.host, found.record, found.dataDirectory));
  if (outcome === 'diverged') return {proceed: false, text: `O branch no servidor ${found.host.label} divergiu. Não mexi na cópia.`};
  return {proceed: true};
 } catch { return {proceed: false, text: `Não consegui buscar ${found.host.label}. Não comecei o pedido.`}; }
}

async function markPush(dataDirectory: string, id: string, pushed: boolean) {
 await exclusive(async () => {
  const all = await readPending(dataDirectory);
  await writePending(dataDirectory, all.map(item => item.id === id ? {...item, pushed, told: pushed ? 'none' : item.told === 'failed' ? 'failed' : 'none'} : item));
 });
}

/** Retries every push that did not land. The same refspec is safe to repeat and no other ref is accepted. */
export async function retryPendingRemotePushes(): Promise<void> {
 const registry = remoteRegistry;
 if (!registry) return;
 const dataDirectory = registry.dataDirectory;
 for (const item of await readPending(dataDirectory)) {
  if (item.pushed) continue;
  const project = registry.projects.find(entry => entry.id === item.projectId);
  const record = (await readRemoteProjects(dataDirectory)).find(entry => entry.projectId === item.projectId);
  const host = (await readHosts(dataDirectory)).find(entry => entry.id === item.hostId);
  if (!project || !record || !host) continue;
  let repo: string;
  try { repo = await realpath(project.repo); } catch { continue; }
  let refspec: string;
  try { refspec = pushRefspec(item.commit, item.ref); } catch { continue; }
  try {
   await withRepo(repo, () => git(repo, ['push', '--', remoteGitUrl(host, record.path), refspec], gitEnv(dataDirectory)));
   await markPush(dataDirectory, item.id, true);
  } catch { await markPush(dataDirectory, item.id, false); }
 }
}

/** Records the agent-control ref before the network call, so a failure leaves a pending push and keeps the integration. */
export async function pushIntegratedRemote(checkout: string, commit: string): Promise<void> {
 const found = await lookupRemote(checkout);
 if (!found || !commitId.test(commit)) return;
 await exclusive(async () => {
  const pending = await readPending(found.dataDirectory);
  if (pending.some(item => item.projectId === found.projectId && item.commit === commit)) return;
  if (pending.length >= 100) throw new Refusal('REMOTE_PENDING_FULL', 409);
  const ref = agentControlPushRef(commit, new Date());
  pushRefspec(commit, ref);
  await writePending(found.dataDirectory, [...pending, {id: randomUUID(), projectId: found.projectId, hostId: found.host.id, commit, ref, pushed: false, told: 'none'}]);
 });
 await retryPendingRemotePushes();
}

export async function remotePushNotices(projectId: string): Promise<{id: string; told: 'failed' | 'sent'; text: string}[]> {
 const registry = remoteRegistry;
 if (!registry || !z.uuid().safeParse(projectId).success) return [];
 const hosts = await readHosts(registry.dataDirectory);
 const notices: {id: string; told: 'failed' | 'sent'; text: string}[] = [];
 for (const item of await readPending(registry.dataDirectory)) {
  if (item.projectId !== projectId) continue;
  const told = item.pushed ? 'sent' as const : 'failed' as const;
  if (item.told === told) continue;
  const label = hosts.find(host => host.id === item.hostId)?.label ?? 'servidor';
  const text = item.pushed
   ? `Resultado enviado para ${label}: branch ${item.ref.slice('refs/heads/'.length)}`
   : `Não consegui enviar para ${label}; vou tentar de novo.`;
  notices.push({id: item.id, told, text});
 }
 return notices;
}

export async function markRemotePushNotice(id: string, told: 'failed' | 'sent') {
 const registry = remoteRegistry;
 if (!registry || !z.uuid().safeParse(id).success) return;
 const dataDirectory = registry.dataDirectory;
 await exclusive(async () => {
  const all = await readPending(dataDirectory);
  await writePending(dataDirectory, all.map(item => item.id === id && (item.pushed ? 'sent' : 'failed') === told ? {...item, told} : item));
 });
}
