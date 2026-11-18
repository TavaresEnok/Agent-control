import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Capacity} from './capacity.ts';
import {digest, Id, Refusal, type Authority} from './contracts.ts';
import {acceptClaudeExamSeat} from './exam-provider.ts';
import {assertDesignTarget} from './design-image.ts';
import {publicLoginRecord, type DesignLogin, type PublicLoginRecord} from './design-discover.ts';
import type {DesignSourceFile} from './design-collect.ts';
import {createDesignNativeWorker, type DesignExamSupervisor} from './design-native-launch.ts';
import {loadInstallation} from './installation.ts';
import {Ledger} from './ledger.ts';
import {composePersonalRuntime} from './personal-runtime.ts';
import type {DesignWorker} from './design-types.ts';

const MAX_DESIGN_FILES = 400;
const MAX_DESIGN_FILE_BYTES = 200_000;
const MAX_DESIGN_TOTAL_BYTES = 2_000_000;
const MAX_LOGIN_BYTES = 4096;
const SOURCE = /\.(?:html?|css|tsx|jsx|vue|ts|js)$/i;
/** Basenames skipped at any depth. Matching is case-sensitive. */
const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', '.design-captures', '.ai', '.state', 'coverage', '.next', 'build', 'out',
  '.claude', '.mcp.json', '.codex', '.grok',
]);

type DesignSeat = {
  provider: string;
  model: string;
  accountId: string;
  profileId: string;
  grantId: string;
};

export type ParsedDesignArgs = {
  installationPath: string;
  projectId: string;
  url: string;
  loginFile?: string;
};

export type ResolvedPersonalDesign = {
  ledger: Ledger;
  authority: Authority;
  projectId: string;
  repo: string;
  dataDirectory: string;
  commit: string;
  intentId: string;
  worker: DesignWorker;
  reserve(role: 'specialist' | 'reviewer', avoidProvider?: string): Promise<DesignSeat>;
  release(seat: DesignSeat): Promise<void>;
  close(): Promise<void>;
};

export type OpenedDesignLogin = {
  publicLogin: PublicLoginRecord;
  login: DesignLogin;
  wipe(): void;
};

export function parseDesignArgs(argv: readonly string[]): ParsedDesignArgs {
  const positional: string[] = [];
  let url: string | undefined;
  let loginFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--url') {
      const value = argv[index + 1];
      if (url !== undefined || value === undefined || value.startsWith('--')) throw new Refusal('DESIGN_USAGE', 400);
      url = value;
      index += 1;
      continue;
    }
    if (arg === '--login-file') {
      const value = argv[index + 1];
      if (loginFile !== undefined || value === undefined || value.startsWith('--')) throw new Refusal('DESIGN_USAGE', 400);
      loginFile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) throw new Refusal('DESIGN_USAGE', 400);
    positional.push(arg);
  }
  const installationPath = positional[0];
  const projectId = positional[1];
  if (!installationPath || !projectId || positional.length !== 2 || url === undefined) throw new Refusal('DESIGN_USAGE', 400);
  if (!Id.safeParse(projectId).success) throw new Refusal('NOT_FOUND', 404);
  assertDesignTarget(url);
  return {installationPath, projectId, url, ...(loginFile === undefined ? {} : {loginFile})};
}

/** Mode is checked before the bytes are read. A widened file never reaches the report. */
export async function readDesignLoginFile(path: string): Promise<OpenedDesignLogin> {
  const listed = await lstat(path);
  if (!listed.isFile() || listed.isSymbolicLink() || (listed.mode & 0o077) !== 0) throw new Refusal('DESIGN_LOGIN_MODE', 403);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Refusal('DESIGN_LOGIN_MODE', 403);
    if (info.size > MAX_LOGIN_BYTES) throw new Refusal('DESIGN_LOGIN_INVALID', 400);
    bytes = await file.readFile();
    if (bytes.length > MAX_LOGIN_BYTES) throw new Refusal('DESIGN_LOGIN_INVALID', 400);
  } finally {
    await file.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    bytes.fill(0);
    throw new Refusal('DESIGN_LOGIN_INVALID', 400);
  }
  bytes.fill(0);
  const login = loginFromJson(parsed);
  const publicLogin = publicLoginRecord(login);
  if (publicLogin === undefined) throw new Refusal('DESIGN_LOGIN_INVALID', 400);
  return {
    publicLogin,
    login,
    wipe() {
      login.password = '';
    },
  };
}

function loginFromJson(value: unknown): DesignLogin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal('DESIGN_LOGIN_INVALID', 400);
  const row = value as Record<string, unknown>;
  const fields = ['username', 'password', 'usernameSelector', 'passwordSelector', 'submitSelector'] as const;
  const picked: Record<(typeof fields)[number], string> = {
    username: '',
    password: '',
    usernameSelector: '',
    passwordSelector: '',
    submitSelector: '',
  };
  for (const field of fields) {
    const item = row[field];
    if (typeof item !== 'string' || item.length < 1 || item.length > 500) throw new Refusal('DESIGN_LOGIN_INVALID', 400);
    picked[field] = item;
  }
  return picked;
}

/**
 * Bounded text read of the project checkout. Skips dependency, VCS, env, key names
 * and agent config (`.claude`, `.mcp.json`, `.codex`, `.grok`) at any depth.
 * Those names are case-sensitive and a symlink with one of them is not followed.
 * Any other symlink is followed only when its real path stays inside the repository.
 */
export async function readDesignRepository(repo: string): Promise<DesignSourceFile[]> {
  let root: string;
  try {
    root = await realpath(repo);
  } catch {
    throw new Refusal('DESIGN_REPO_UNREADABLE', 400);
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Refusal('DESIGN_REPO_UNREADABLE', 400);
  const files: DesignSourceFile[] = [];
  const seen = new Set<string>([root]);
  await walk(root, root, seen, files, {total: 0});
  return files;
}

async function walk(
  root: string,
  directory: string,
  seen: Set<string>,
  files: DesignSourceFile[],
  budget: {total: number},
): Promise<void> {
  if (files.length >= MAX_DESIGN_FILES || budget.total >= MAX_DESIGN_TOTAL_BYTES) return;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (files.length >= MAX_DESIGN_FILES || budget.total >= MAX_DESIGN_TOTAL_BYTES) return;
    if (SKIP_DIR.has(name) || name === '.env' || name.startsWith('.env.')) continue;
    const path = join(directory, name);
    let listed;
    try {
      listed = await lstat(path);
    } catch {
      continue;
    }
    if (listed.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(path);
      } catch {
        continue;
      }
      if (!inside(root, target) || seen.has(target)) continue;
      seen.add(target);
      let targetStat;
      try {
        targetStat = await lstat(target);
      } catch {
        continue;
      }
      if (targetStat.isDirectory()) await walk(root, target, seen, files, budget);
      else if (targetStat.isFile()) await takeFile(root, target, targetStat.size, files, budget);
      continue;
    }
    if (listed.isDirectory()) {
      const real = await realpath(path).catch(() => '');
      if (!real || !inside(root, real) || seen.has(real)) continue;
      seen.add(real);
      await walk(root, path, seen, files, budget);
      continue;
    }
    if (!listed.isFile()) continue;
    await takeFile(root, path, listed.size, files, budget);
  }
}

async function takeFile(
  root: string,
  path: string,
  size: number,
  files: DesignSourceFile[],
  budget: {total: number},
): Promise<void> {
  if (files.length >= MAX_DESIGN_FILES || budget.total >= MAX_DESIGN_TOTAL_BYTES) return;
  const rel = relative(root, path).split(sep).join('/');
  if (!rel || rel.startsWith('../') || rel === '..' || skipped(rel) || !SOURCE.test(rel)) return;
  if (size > MAX_DESIGN_FILE_BYTES || size + budget.total > MAX_DESIGN_TOTAL_BYTES) return;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!file) return;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_DESIGN_FILE_BYTES) return;
    const bytes = await file.readFile();
    if (bytes.length > MAX_DESIGN_FILE_BYTES || bytes.includes(0)) return;
    budget.total += bytes.length;
    files.push({path: rel, text: bytes.toString('utf8')});
  } finally {
    await file.close();
  }
}

function skipped(rel: string): boolean {
  return rel.split('/').some(part => SKIP_DIR.has(part) || part === '.env' || part.startsWith('.env.') || SECRET_FILE.test(part));
}

const SECRET_FILE = /^(?:id_rsa|id_ed25519|id_ecdsa)(?:\.|$)|.+\.(?:pem|key)$/i;

function inside(root: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readHead(repoPath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('/usr/bin/git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/nonexistent',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    }, (error, stdout) => {
      const commit = (stdout ?? '').trim();
      if (error || !/^[a-f0-9]{40}$/.test(commit)) reject(new Refusal('DESIGN_COMMIT_INVALID', 400));
      else resolvePromise(commit);
    });
  });
}

async function acquirePersonalDesign(ledger: Ledger, principal: string, contextId: string): Promise<Authority> {
  const instanceId = randomUUID();
  try {
    return await ledger.acquire(principal, contextId, instanceId, 'personal-design', 3600);
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== 'INVALID_LEASE') throw error;
    return ledger.acquire(principal, contextId, instanceId, 'personal-design', 60);
  }
}

/** The ledger refuses a lease longer than 60s, so a model call renews the short lease instead. */
export async function releaseDesignGrant(
  ledger: Ledger,
  principal: string,
  authority: Authority,
  grantId: string,
  how: 'not_started' | 'exited',
): Promise<void> {
  const capacity = new Capacity(ledger);
  const first = how === 'not_started' ? 'not_started' : 'exited';
  const second = first === 'not_started' ? 'exited' : 'not_started';
  try {
    await capacity.transition(principal, grantId, authority, 'released', {processId: grantId, state: first});
  } catch (error) {
    if (!(error instanceof Refusal) || error.code !== 'PROCESS_MUST_EXIT') throw error;
    await capacity.transition(principal, grantId, authority, 'released', {processId: grantId, state: second});
  }
}

/**
 * Row only, no outbox and no frozen plan, so Cezar does not dispatch it.
 * The state stays `accepted` until the exam ends: the capacity queue skips
 * done, failed and canceled intents and would otherwise return CAPACITY_QUEUED.
 */
async function insertDesignIntent(
  ledger: Ledger,
  principal: string,
  authority: Authority,
  projectId: string,
  commit: string,
): Promise<string> {
  const intentId = randomUUID();
  await ledger.tx(async c => {
    await ledger.authorize(c, principal, authority.contextId);
    await ledger.fence(c, authority);
    const context = (await c.query<{project_id: string; plan_revision: number | string; policy_revision: number | string}>(
      'SELECT project_id::text AS project_id, plan_revision, policy_revision FROM ac_contexts WHERE id=$1',
      [authority.contextId],
    )).rows[0];
    if (!context || context.project_id !== projectId) throw new Refusal('DESIGN_CONTEXT_REQUIRED', 409);
    const command = {
      schemaVersion: 1 as const,
      intentId,
      deliveryAttemptId: randomUUID(),
      contextId: authority.contextId,
      policyRevision: Number(context.policy_revision),
      action: 'plan.start' as const,
      payload: {
        workflow: 'design-readonly-v1' as const,
        messageRef: `design:${projectId}:${commit}`.slice(0, 200),
        projectId,
        commit,
      },
    };
    await c.query(
      `INSERT INTO ac_intents (id, context_id, principal_id, digest, command, operation_id, run_id, manager_epoch, plan_revision)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [intentId, authority.contextId, principal, digest(command), JSON.stringify(command), randomUUID(), randomUUID(), authority.epoch, Number(context.plan_revision)],
    );
  });
  return intentId;
}

async function readSeat(ledger: Ledger, grantId: string, accountId: string, profileId: string): Promise<DesignSeat> {
  const row = (await ledger.pool.query<{provider: string; model: string}>(
    'SELECT a.provider, p.model FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id JOIN ac_accounts a ON a.id=g.account_id WHERE g.id=$1',
    [grantId],
  )).rows[0];
  if (!row?.provider || !row.model) throw new Refusal('GRANT_FORBIDDEN', 403);
  return {provider: String(row.provider), model: String(row.model), accountId, profileId, grantId};
}

export async function resolvePersonalDesign(argv: readonly string[], known?: {installationPath: string; projectId: string}): Promise<ResolvedPersonalDesign> {
  const parsed = known ?? parseDesignArgs(argv);
  const config = await loadInstallation(resolve(parsed.installationPath));
  if (config.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const project = [config.project, ...config.projects].find(item => item.id === parsed.projectId);
  if (!project) throw new Refusal('NOT_FOUND', 404);
  const ledger = new Ledger(config.databaseUrl);
  try {
    const found = await ledger.pool.query<{id: string}>(
      'SELECT id::text AS id FROM ac_contexts WHERE project_id=$1 ORDER BY created_at LIMIT 1',
      [project.id],
    );
    const row = found.rows[0];
    if (!row?.id) throw new Refusal('DESIGN_CONTEXT_REQUIRED', 409);
    const commit = await readHead(project.repo);
    const principal = project.owner;
    const authority = await acquirePersonalDesign(ledger, principal, row.id);
    const runtime = await composePersonalRuntime(config, ledger);
    if (!runtime) throw new Refusal('DESIGN_WORKER_UNAVAILABLE', 503);
    const intentId = await insertDesignIntent(ledger, principal, authority, project.id, commit);
    const releaseGrant = (grantId: string, how: 'not_started' | 'exited') => releaseDesignGrant(ledger, principal, authority, grantId, how);
    const worker = createDesignNativeWorker({
      supervisors: runtime.executions as unknown as readonly DesignExamSupervisor[],
      ledger,
      principal,
      authority,
      base: commit,
      releaseGrant,
    });
    const reserve = async (role: 'specialist' | 'reviewer', avoidProvider?: string): Promise<DesignSeat> => {
      void avoidProvider;
      const capacity = new Capacity(ledger);
      const grant = await capacity.reserve(principal, {
        attemptId: randomUUID(),
        intentId,
        contextId: authority.contextId,
        role,
      }, authority);
      const seat = await readSeat(ledger, grant.id, grant.account_id, grant.profile_id);
      if (seat.provider !== 'claude') {
        await releaseDesignGrant(ledger, principal, authority, seat.grantId, 'not_started');
      }
      return acceptClaudeExamSeat(seat);
    };
    return {
      ledger,
      authority,
      projectId: project.id,
      repo: project.repo,
      dataDirectory: config.dataDirectory,
      commit,
      intentId,
      worker,
      reserve,
      release: seat => releaseDesignGrant(ledger, principal, authority, seat.grantId, 'not_started'),
      close: () => ledger.close(),
    };
  } catch (error) {
    await ledger.close();
    throw error;
  }
}

export type DesignInvocation =
  | {kind: 'exam'; argv: string[]; references: string[]; threshold: number}
  | {kind: 'approve'; installationPath: string; projectId: string; runId: string}
  | {kind: 'create'; installationPath: string; projectId: string; briefing: string; references: string[]; screens: number; rounds: number};

function takeValues(argv: readonly string[], flag: string): {rest: string[]; values: string[]} {
  const rest: string[] = [];
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) {
      rest.push(argv[index] ?? '');
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Refusal('DESIGN_USAGE', 400);
    values.push(value);
    index += 1;
  }
  return {rest, values};
}

/** A forma antiga continua em parseDesignArgs. Aqui entram criar, baseline e referências. */
export function parseDesignInvocation(argv: readonly string[]): DesignInvocation {
  if (argv[0] === 'criar') {
    const briefing = takeValues(argv.slice(1), '--briefing');
    const references = takeValues(briefing.rest, '--referencia');
    const screens = takeValues(references.rest, '--telas');
    const rounds = takeValues(screens.rest, '--rodadas');
    if (briefing.values.length !== 1 || screens.values.length > 1 || rounds.values.length > 1) throw new Refusal('DESIGN_USAGE', 400);
    const [installationPath, projectId] = rounds.rest;
    if (!installationPath || !projectId || rounds.rest.length !== 2) throw new Refusal('DESIGN_USAGE', 400);
    if (!Id.safeParse(projectId).success) throw new Refusal('NOT_FOUND', 404);
    const count = screens.values[0] === undefined ? 2 : Number(screens.values[0]);
    const roundCount = rounds.values[0] === undefined ? 3 : Number(rounds.values[0]);
    if (!Number.isInteger(count) || count < 1 || count > 8 || !Number.isInteger(roundCount) || roundCount < 1 || roundCount > 5) {
      throw new Refusal('DESIGN_CREATE_INVALID', 400);
    }
    if (references.values.length > 10) throw new Refusal('DESIGN_REFERENCE_LIMIT', 400);
    return {kind: 'create', installationPath, projectId, briefing: briefing.values[0], references: references.values, screens: count, rounds: roundCount};
  }
  const approved = takeValues(argv, '--aprovar-baseline');
  if (approved.values.length > 0) {
    if (approved.values.length !== 1) throw new Refusal('DESIGN_USAGE', 400);
    const [installationPath, projectId] = approved.rest;
    if (!installationPath || !projectId || approved.rest.length !== 2) throw new Refusal('DESIGN_USAGE', 400);
    if (!Id.safeParse(projectId).success || !Id.safeParse(approved.values[0]).success) throw new Refusal('NOT_FOUND', 404);
    return {kind: 'approve', installationPath, projectId, runId: approved.values[0]};
  }
  const references = takeValues(argv, '--referencia');
  const threshold = takeValues(references.rest, '--limiar');
  if (threshold.values.length > 1 || references.values.length > 10) throw new Refusal('DESIGN_USAGE', 400);
  const limit = threshold.values[0] === undefined ? 0.1 : Number(threshold.values[0]);
  if (!Number.isFinite(limit) || limit < 0 || limit > 1) throw new Refusal('DESIGN_USAGE', 400);
  parseDesignArgs(threshold.rest);
  return {kind: 'exam', argv: threshold.rest, references: references.values, threshold: limit};
}

