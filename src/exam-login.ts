import {spawn} from 'node:child_process';
import {createHash, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readlink, rename, rm, symlink, unlink, type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Id, Refusal} from './contracts.ts';
import type {Installation} from './installation.ts';
import type {Ledger} from './ledger.ts';

/** Renew in place only when `expiresAt` is missing, unreadable, or has less than 5 minutes remaining. */
export const EXAM_LOGIN_MARGIN_MS = 5 * 60 * 1000;
export const EXAM_LOGIN_RENEW_TIMEOUT_MS = 90_000;
export const EXAM_LOGIN_RENEW_KILL_GRACE_MS = 5_000;
export const EXAM_LOGIN_LOCK_TIMEOUT = '120s';

export const EXAM_LOGIN_STALE_TEXT = 'O login da conta venceu. Entre de novo: npm run gateway -- account-add.';
export const EXAM_LOGIN_RECOVERY_TEXT = 'O login renovado no exame foi guardado para recuperação; rode `npm run gateway -- account-recover` ou entre de novo';
export const EXAM_LOGIN_BUSY_TEXT = 'A conta está ocupada renovando o login em outra execução. Tente de novo em instantes.';

const CREDENTIAL_LIMIT = 65536;
const READ_OWN = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const STRICT_IDENTITY_FIELDS = ['organizationUuid', 'accountUuid', 'uuid'] as const;
const SOFT_IDENTITY_FIELDS = ['subscriptionType', 'rateLimitTier'] as const;
const RECOVERY_FILE_PATTERN = /^\.exam-credential-recovery-([A-Za-z0-9_-]{1,80})\.json$/;
const CLAUDE_SNAPSHOT_FILES = ['.claude.json', 'settings.json', '.claude/settings.json'] as const;

const examRecoveryErrors = new WeakSet<object>();

export type ReturnedCredentialClass = 'ok' | 'invalid' | 'other-account';
export type AccountLoginLock = <T>(accountId: string, fn: () => Promise<T>) => Promise<T>;

export type ExamCredentialApplyReason =
  | 'invalid'
  | 'other-account'
  | 'same-refresh'
  | 'missing-mark'
  | 'hash-mismatch'
  | 'expires-not-greater'
  | 'write-failed';

function isLockTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? (error as {code?: unknown}).code : undefined;
  if (code === '55P03') return true;
  const message = 'message' in error ? String((error as {message?: unknown}).message ?? '').toLowerCase() : '';
  return message.includes('lock timeout');
}

/** Advisory lock keyed by accountId on the installation Postgres, shared across gateway and CLI. */
export function postgresAccountLoginLock(ledger: Pick<Ledger, 'tx'>, lockTimeout = EXAM_LOGIN_LOCK_TIMEOUT): AccountLoginLock {
  if (!/^\d+(?:ms|s)$/.test(lockTimeout)) throw new Error('INVALID_LOCK_TIMEOUT');
  return (accountId, fn) =>
    ledger.tx(async client => {
      await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      try {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 90))', [accountId]);
      } catch (error) {
        if (isLockTimeoutError(error)) throw new Refusal('EXAM_LOGIN_BUSY', 409);
        throw error;
      }
      return fn();
    });
}

export function hashExamRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
}

/** Read only the SHA-256 hash of `claudeAiOauth.refreshToken` from the account directory. */
export async function readClaudeRefreshTokenHash(accountDir: string): Promise<string | null> {
  const text = await readCredentialText(join(accountDir, '.credentials.json')).catch(() => undefined);
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const oauth = oauthOf(parsed);
    return nonEmpty(oauth?.refreshToken) ? hashExamRefreshToken(oauth.refreshToken) : null;
  } catch {
    return null;
  }
}

/** `expiresAt` only. Values below 1e12 are seconds and become milliseconds. Anything else is unreadable. */
export function claudeAccessExpiresAt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

/** True when the access token is missing, unreadable, or has less than five minutes remaining. */
export function examLoginNeedsRefresh(expiresAt: number | null, now: number, _examMaxMs?: number): boolean {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return true;
  return expiresAt < now + EXAM_LOGIN_MARGIN_MS;
}

/** True after renewal only when `expiresAt` is strictly more than five minutes in the future. */
export function examLoginFreshAfterRenew(expiresAt: number | null, now: number): boolean {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return false;
  return expiresAt > now + EXAM_LOGIN_MARGIN_MS;
}

/** Read only `expiresAt`. A missing file, a symlink, or unreadable JSON means the login needs renewal. */
export async function readClaudeExpiresAt(accountDir: string): Promise<number | null> {
  const text = await readCredentialText(join(accountDir, '.credentials.json')).catch(() => undefined);
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const oauth = oauthOf(parsed);
    return claudeAccessExpiresAt(oauth?.expiresAt);
  } catch {
    return null;
  }
}

/**
 * Provider auth phrases become a code. The raw sentence, and any token inside it, is not returned.
 * Auth phrases win over a generic failure code that may sit in the same text.
 */
export function providerFailureCode(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes('failed to authenticate') || lower.includes('oauth session expired') || lower.includes('could not be refreshed') || text.includes('PROVIDER_AUTH_FAILED')) {
    return 'PROVIDER_AUTH_FAILED';
  }
  return null;
}

export function safeFailureCode(value: unknown, fallback = 'EXECUTION_NATIVE_FAILED'): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : fallback;
}

export function examLoginStaleNote(error: unknown): string | undefined {
  return error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE' ? EXAM_LOGIN_STALE_TEXT : undefined;
}

export function examLoginBusyNote(error: unknown): string | undefined {
  return error instanceof Refusal && error.code === 'EXAM_LOGIN_BUSY' ? EXAM_LOGIN_BUSY_TEXT : undefined;
}

export function markExamRecoverySaved(error: object): void {
  examRecoveryErrors.add(error);
}

export function examLoginRecoveryNote(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && examRecoveryErrors.has(error) ? EXAM_LOGIN_RECOVERY_TEXT : undefined;
}

/**
 * The returned document is the same Claude account when `claudeAiOauth` is present,
 * the scope set matches, strict UUID identity fields match, and `subscriptionType` / `rateLimitTier`
 * match whenever present on both sides. Appearing or disappearing soft fields are accepted.
 */
export function classifyReturnedCredential(originalText: string, returnedText: string): ReturnedCredentialClass {
  let original: unknown;
  let returned: unknown;
  try {
    original = JSON.parse(originalText);
    returned = JSON.parse(returnedText);
  } catch {
    return 'invalid';
  }
  const left = oauthOf(original);
  const right = oauthOf(returned);
  if (!left || !right) return 'invalid';
  if (!nonEmpty(right.accessToken) || !nonEmpty(right.refreshToken)) return 'invalid';
  const leftScopes = scopeKey(left.scopes);
  const rightScopes = scopeKey(right.scopes);
  if (leftScopes === null || rightScopes === null) return 'invalid';
  if (leftScopes !== rightScopes) return 'other-account';
  for (const field of STRICT_IDENTITY_FIELDS) {
    const leftPresent = left[field] !== undefined;
    const rightPresent = right[field] !== undefined;
    if (leftPresent !== rightPresent) return 'other-account';
    if (leftPresent && !Object.is(left[field], right[field])) return 'other-account';
  }
  for (const field of SOFT_IDENTITY_FIELDS) {
    const leftPresent = left[field] !== undefined && left[field] !== null;
    const rightPresent = right[field] !== undefined && right[field] !== null;
    if (leftPresent && rightPresent && !Object.is(left[field], right[field])) return 'other-account';
  }
  return 'ok';
}

/**
 * Compare the mounted login with the exam copy. An unchanged file, a symlink, or an unreadable file
 * sends nothing. Only a rotated document that still belongs to the same account is returned.
 */
export async function readExamCredentialReturn(originalPath: string, copyPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const original = await readCredentialText(originalPath);
    const copy = await readCredentialText(copyPath);
    if (original === undefined || copy === undefined || original === copy) return undefined;
    if (Buffer.byteLength(copy) > CREDENTIAL_LIMIT) return undefined;
    if (classifyReturnedCredential(original, copy) !== 'ok') return undefined;
    const origParsed: unknown = JSON.parse(original);
    const copyParsed: unknown = JSON.parse(copy);
    if (!isRecord(origParsed) || !isRecord(copyParsed)) return undefined;
    const origOauth = oauthOf(origParsed);
    const copyOauth = oauthOf(copyParsed);
    if (!origOauth || !copyOauth) return undefined;
    if (!nonEmpty(origOauth.refreshToken) || !nonEmpty(copyOauth.refreshToken)) return undefined;
    if (copyOauth.refreshToken === origOauth.refreshToken) return undefined;
    const origExpires = claudeAccessExpiresAt(origOauth.expiresAt);
    const copyExpires = claudeAccessExpiresAt(copyOauth.expiresAt);
    if (copyExpires === null || !Number.isFinite(copyExpires)) return undefined;
    if (origExpires !== null && copyExpires <= origExpires) return undefined;
    return copyParsed;
  } catch {
    return undefined;
  }
}

function parseValidReturnedCredential(returnedText: string): {parsed: Record<string, unknown>; oauth: Record<string, unknown>} | null {
  if (Buffer.byteLength(returnedText) > CREDENTIAL_LIMIT) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(returnedText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const oauth = oauthOf(parsed);
  if (!oauth) return null;
  if (!nonEmpty(oauth.accessToken) || !nonEmpty(oauth.refreshToken)) return null;
  if (scopeKey(oauth.scopes) === null) return null;
  return {parsed, oauth};
}

function recoveryFilePath(accountDir: string, jobId?: string): string {
  const id = jobId ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('EXAM_LOGIN_WRITE_REFUSED');
  return join(accountDir, `.exam-credential-recovery-${id}.json`);
}

/** Write a new or replaced private file atomically in `dir` without following symlinks. */
async function writePrivateFileInDir(target: string, body: string): Promise<void> {
  const dir = dirname(target);
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error('EXAM_LOGIN_WRITE_REFUSED');
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('EXAM_LOGIN_WRITE_REFUSED');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = join(dir, `.ac-recovery-${randomBytes(8).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, WRITE_NEW, 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    try {
      await handle.chown(dirInfo.uid, dirInfo.gid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' || process.getuid?.() !== dirInfo.uid) throw error;
    }
    await handle.close();
    handle = undefined;
    await rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Write the host-only 0600 mark file (only the 64-char SHA-256 hash). */
export async function writeExamRefreshMark(file: string, mark: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(mark)) throw new Error('EXAM_LOGIN_MARK_INVALID');
  const handle = await open(file, WRITE_NEW, 0o600);
  try {
    await handle.writeFile(mark, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Read the host-only 0600 mark file. Missing, symlinked, or malformed files return null. */
export async function readExamRefreshMark(file: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(file, READ_OWN);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 128) {
      return null;
    }
    const text = (await handle.readFile('utf8')).trim();
    return /^[a-f0-9]{64}$/.test(text) ? text : null;
  } finally {
    await handle.close();
  }
}

function extractCredentialSecrets(parsed: unknown): string[] {
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : value && typeof value === 'object'
          ? Object.values(value).flatMap(strings)
          : [];
  return strings(parsed).filter(value => value.length > 8);
}

async function copyExamSnapshotSupportFile(sourceRoot: string, destRoot: string, rel: string): Promise<void> {
  const parts = rel.split('/');
  let fromDir = sourceRoot;
  let toDir = destRoot;
  for (let i = 0; i < parts.length; i += 1) {
    const from = join(fromDir, parts[i]!);
    const to = join(toDir, parts[i]!);
    let info;
    try {
      info = await lstat(from);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      let existing;
      try {
        existing = await lstat(to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!existing) await symlink(await readlink(from), to);
      return;
    }
    if (i === parts.length - 1) {
      if (!info.isFile()) return;
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, info.mode & 0o777);
      return;
    }
    if (!info.isDirectory()) return;
    try {
      await mkdir(to, {mode: 0o700});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const created = await lstat(to);
      if (!created.isDirectory()) return;
    }
    fromDir = from;
    toDir = to;
  }
}

/**
 * Under the account lock, read `.credentials.json`, compute its refresh-token SHA-256 mark,
 * extract secrets for redaction/snapshot tagging, and materialize an immutable read-only
 * snapshot directory containing that exact `.credentials.json` (plus Claude settings files).
 */
export async function snapshotClaudeExamAccountUnderLock(input: {
  accountDir: string;
  snapshotDir: string;
  accountId?: string;
  lock?: AccountLoginLock;
}): Promise<{mark: string; secrets: string[]; snapshotDir: string}> {
  const run = async () => {
    const credText = await readCredentialText(join(input.accountDir, '.credentials.json')).catch(() => undefined);
    if (credText === undefined) throw new Refusal('EXAM_LOGIN_STALE', 409);
    let parsed: unknown;
    try {
      parsed = JSON.parse(credText);
    } catch {
      throw new Refusal('EXAM_LOGIN_STALE', 409);
    }
    const oauth = oauthOf(parsed);
    if (!oauth || !nonEmpty(oauth.refreshToken)) throw new Refusal('EXAM_LOGIN_STALE', 409);
    const mark = hashExamRefreshToken(oauth.refreshToken);
    const secrets = extractCredentialSecrets(parsed);
    await mkdir(input.snapshotDir, {mode: 0o700});
    const handle = await open(join(input.snapshotDir, '.credentials.json'), WRITE_NEW, 0o600);
    try {
      await handle.writeFile(credText, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (const rel of CLAUDE_SNAPSHOT_FILES) {
      await copyExamSnapshotSupportFile(input.accountDir, input.snapshotDir, rel);
    }
    return {mark, secrets, snapshotDir: input.snapshotDir};
  };
  if (input.lock && input.accountId) return input.lock(input.accountId, run);
  return run();
}

/**
 * Write back only `accessToken`, `refreshToken`, and `expiresAt` under the account lock when:
 * - current `refreshToken` SHA-256 still matches the starting mark;
 * - returned `expiresAt` is greater than current;
 * - returned `refreshToken` differs from current;
 * - `scopes` and identity fields match (soft fields `subscriptionType`/`rateLimitTier` only diverge when present on both sides).
 * Whenever a valid rotated credential is rejected for missing mark, hash mismatch, non-greater `expiresAt`,
 * or write failure, the returned document is saved to `<accountDir>/.exam-credential-recovery-<jobId>.json` (0600, atomic, no symlinks).
 * Only an invalid returned document (bad JSON or missing `accessToken`/`refreshToken`) is discarded.
 */
export async function applyReturnedExamCredential(
  accountDir: string,
  returnedText: string,
  options: {
    expectedRefreshTokenHash?: string | null;
    accountId?: string;
    lock?: AccountLoginLock;
    jobId?: string;
    onRecovery?: (info: {reason: ExamCredentialApplyReason; path: string}) => void;
  },
): Promise<'written' | 'rejected'> {
  const validReturned = parseValidReturnedCredential(returnedText);
  if (!validReturned) return 'rejected';
  const {parsed: returnedParsed, oauth: returnedOauth} = validReturned;
  const serializedReturned = JSON.stringify(returnedParsed);

  const saveRecovery = async (reason: ExamCredentialApplyReason): Promise<void> => {
    const path = recoveryFilePath(accountDir, options.jobId);
    await writePrivateFileInDir(path, serializedReturned);
    options.onRecovery?.({reason, path});
  };

  const expectedHash = options.expectedRefreshTokenHash;
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    await saveRecovery('missing-mark');
    return 'rejected';
  }

  const run = async (): Promise<'written' | 'rejected'> => {
    const file = join(accountDir, '.credentials.json');
    const original = await readCredentialText(file).catch(() => undefined);
    if (original === undefined) {
      await saveRecovery('write-failed');
      return 'rejected';
    }
    const kind = classifyReturnedCredential(original, serializedReturned);
    if (kind === 'invalid') return 'rejected';
    if (kind === 'other-account') return 'rejected';
    let currentParsed: unknown;
    try {
      currentParsed = JSON.parse(original);
    } catch {
      await saveRecovery('write-failed');
      return 'rejected';
    }
    if (!isRecord(currentParsed)) {
      await saveRecovery('write-failed');
      return 'rejected';
    }
    const currentOauth = oauthOf(currentParsed);
    if (!currentOauth || !nonEmpty(currentOauth.refreshToken)) {
      await saveRecovery('write-failed');
      return 'rejected';
    }
    if (!hashesEqual(hashExamRefreshToken(currentOauth.refreshToken), expectedHash)) {
      await saveRecovery('hash-mismatch');
      return 'rejected';
    }
    if (returnedOauth.refreshToken === currentOauth.refreshToken) return 'rejected';
    const currentExpires = claudeAccessExpiresAt(currentOauth.expiresAt);
    const returnedExpires = claudeAccessExpiresAt(returnedOauth.expiresAt);
    if (returnedExpires === null || !Number.isFinite(returnedExpires) || (currentExpires !== null && returnedExpires <= currentExpires)) {
      await saveRecovery('expires-not-greater');
      return 'rejected';
    }
    const nextDoc: Record<string, unknown> = {
      ...currentParsed,
      claudeAiOauth: {
        ...currentOauth,
        accessToken: returnedOauth.accessToken,
        refreshToken: returnedOauth.refreshToken,
        expiresAt: returnedOauth.expiresAt,
      },
    };
    try {
      await writePrivateAtomic(file, JSON.stringify(nextDoc));
    } catch {
      await saveRecovery('write-failed');
      return 'rejected';
    }
    return 'written';
  };
  if (options.lock && options.accountId) {
    try {
      return await options.lock(options.accountId, run);
    } catch (error) {
      await saveRecovery('write-failed');
      throw error;
    }
  }
  return run();
}

/**
 * Apply the recovery file with the highest `expiresAt` still greater than `.credentials.json`,
 * updating only `accessToken`, `refreshToken`, and `expiresAt`, then delete recovery files.
 */
export async function recoverExamCredential(
  accountDir: string,
  options?: {accountId?: string; lock?: AccountLoginLock},
): Promise<{status: 'recovered' | 'none'; accountId?: string; filesRemoved: number}> {
  const run = async (): Promise<{status: 'recovered' | 'none'; accountId?: string; filesRemoved: number}> => {
    const file = join(accountDir, '.credentials.json');
    const currentText = await readCredentialText(file).catch(() => undefined);
    if (currentText === undefined) throw new Refusal('EXAM_LOGIN_STALE', 409);
    let currentParsed: unknown;
    try {
      currentParsed = JSON.parse(currentText);
    } catch {
      throw new Refusal('EXAM_LOGIN_STALE', 409);
    }
    const currentOauth = oauthOf(currentParsed);
    if (!isRecord(currentParsed) || !currentOauth) throw new Refusal('EXAM_LOGIN_STALE', 409);
    const currentExpires = claudeAccessExpiresAt(currentOauth.expiresAt);

    const entries = await readdir(accountDir, {withFileTypes: true});
    const recoveryPaths: string[] = [];
    let best: {expiresAt: number; oauth: Record<string, unknown>} | undefined;

    for (const entry of entries) {
      if (!RECOVERY_FILE_PATTERN.test(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      const candidatePath = join(accountDir, entry.name);
      const candText = await readCredentialText(candidatePath).catch(() => undefined);
      if (candText === undefined) continue;
      const valid = parseValidReturnedCredential(candText);
      if (!valid) {
        recoveryPaths.push(candidatePath);
        continue;
      }
      if (classifyReturnedCredential(currentText, candText) !== 'ok') continue;
      recoveryPaths.push(candidatePath);
      const candExpires = claudeAccessExpiresAt(valid.oauth.expiresAt);
      if (candExpires === null || !Number.isFinite(candExpires)) continue;
      if (currentExpires !== null && candExpires <= currentExpires) continue;
      if (!best || candExpires > best.expiresAt) {
        best = {expiresAt: candExpires, oauth: valid.oauth};
      }
    }

    if (best) {
      const nextDoc: Record<string, unknown> = {
        ...currentParsed,
        claudeAiOauth: {
          ...currentOauth,
          accessToken: best.oauth.accessToken,
          refreshToken: best.oauth.refreshToken,
          expiresAt: best.oauth.expiresAt,
        },
      };
      await writePrivateAtomic(file, JSON.stringify(nextDoc));
    }

    let filesRemoved = 0;
    for (const candidatePath of recoveryPaths) {
      await unlink(candidatePath).then(() => {
        filesRemoved += 1;
      }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }

    return {
      status: best ? 'recovered' : 'none',
      ...(options?.accountId ? {accountId: options.accountId} : {}),
      filesRemoved,
    };
  };

  if (options?.lock && options.accountId) return options.lock(options.accountId, run);
  return run();
}

/** CLI entry point for `npm run gateway -- account-recover <instalação> <accountId>`. */
export async function recoverAccountCredentialCommand(
  config: Installation,
  ledger: Pick<Ledger, 'tx'>,
  accountId: string,
): Promise<{status: 'recovered' | 'none'; accountId: string; filesRemoved: number}> {
  if (config.activation !== 'personal') throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
  const parsedAccountId = Id.parse(accountId);
  const bootstrapAccountRoot =
    config.nativeBootstrap && (config.nativeBootstrap.state === 'active' || config.nativeBootstrap.state === 'configured')
      ? config.nativeBootstrap.execution.accountRoot
      : undefined;
  const accountRoot = bootstrapAccountRoot ?? config.accountHomesDirectory ?? join(config.dataDirectory, 'accounts');
  const accountDir = join(accountRoot, parsedAccountId);
  let info;
  try {
    info = await lstat(accountDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Refusal('ACCOUNT_HOME_NOT_INITIALIZED', 404);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Refusal('ACCOUNT_HOME_IDENTITY_MISMATCH', 409);
  const result = await recoverExamCredential(accountDir, {
    accountId: parsedAccountId,
    lock: postgresAccountLoginLock(ledger),
  });
  return {status: result.status, accountId: parsedAccountId, filesRemoved: result.filesRemoved};
}

/** Rewrite `.credentials.json` as compact JSON, mode 0600, keeping the owner. A symlink is refused. */
export async function normalizeAccountCredential(accountDir: string): Promise<void> {
  const file = join(accountDir, '.credentials.json');
  const text = await readCredentialText(file);
  if (text === undefined) throw new Refusal('EXAM_LOGIN_STALE', 409);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refusal('EXAM_LOGIN_STALE', 409);
  }
  if (!isRecord(parsed)) throw new Refusal('EXAM_LOGIN_STALE', 409);
  await writePrivateAtomic(file, JSON.stringify(parsed));
}

/**
 * Replace a regular file in place. The temporary file is mode 0600 in the same directory,
 * then renamed. The previous owner is kept. A symlink is not followed and is not replaced.
 */
export async function writePrivateAtomic(file: string, body: string): Promise<void> {
  const info = await lstat(file);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('EXAM_LOGIN_WRITE_REFUSED');
  const temp = join(dirname(file), `.ac-private-${randomBytes(8).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, WRITE_NEW, 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    try {
      await handle.chown(info.uid, info.gid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' || process.getuid?.() !== info.uid) throw error;
    }
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Renew on the real account when the access token would die during the exam.
 * `renew` is the normal writable Claude path. A failure that leaves the file stale refuses the exam
 * before any disposable copy exists. A file that became fresh is normalized even if the process exited non-zero.
 * `Date.now()` is recalculated inside the lock so waiting on another process never uses a stale clock.
 */
export async function ensureExamLoginFresh(input: {
  accountDir: string;
  accountId?: string;
  now?: number | (() => number);
  examMaxMs?: number;
  renew: (accountDir: string) => Promise<void>;
  lock?: AccountLoginLock;
}): Promise<'fresh' | 'renewed'> {
  const clock = typeof input.now === 'function' ? input.now : () => Date.now();
  const initialNow = typeof input.now === 'number' ? input.now : clock();
  const before = await readClaudeExpiresAt(input.accountDir);
  if (!examLoginNeedsRefresh(before, initialNow)) return 'fresh';
  const run = async (): Promise<'fresh' | 'renewed'> => {
    const lockedNow = clock();
    const current = await readClaudeExpiresAt(input.accountDir);
    if (!examLoginNeedsRefresh(current, lockedNow)) return 'fresh';
    try {
      await input.renew(input.accountDir);
    } catch {
      /* The file is the record. A non-zero exit can still have written a fresh token. */
    }
    const afterNow = clock();
    const after = await readClaudeExpiresAt(input.accountDir);
    if (!examLoginFreshAfterRenew(after, afterNow)) throw new Refusal('EXAM_LOGIN_STALE', 409);
    try {
      await normalizeAccountCredential(input.accountDir);
    } catch {
      throw new Refusal('EXAM_LOGIN_STALE', 409);
    }
    return 'renewed';
  };
  if (input.lock && input.accountId) return input.lock(input.accountId, run);
  return run();
}

/**
 * The same non-exam Claude path that rewrites `.credentials.json` in the account directory.
 * Runs in an isolated empty 0700 temp directory with user-only settings and empty MCP config
 * so the repo's CLAUDE.md, hooks, and .mcp.json are never loaded.
 * On timeout: sends SIGTERM, waits 5s, sends SIGKILL, and always waits for `exit` before
 * removing the temporary directory or releasing the caller's lock.
 */
export async function renewClaudeLoginInPlace(
  accountDir: string,
  options?: {timeoutMs?: number; killGraceMs?: number},
): Promise<void> {
  const configured = process.env.AC_NATIVE_CLAUDE_BIN;
  const bin = typeof configured === 'string' && configured.startsWith('/') && !configured.includes('\0') ? configured : 'claude';
  const timeoutMs = options?.timeoutMs ?? EXAM_LOGIN_RENEW_TIMEOUT_MS;
  const killGraceMs = options?.killGraceMs ?? EXAM_LOGIN_RENEW_KILL_GRACE_MS;
  const scratch = await mkdtemp(join(tmpdir(), 'ac-claude-renew-'));
  try {
    await chmod(scratch, 0o700);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        bin,
        [
          '-p',
          'ok',
          '--output-format',
          'text',
          '--setting-sources',
          'user',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          '--max-turns',
          '1',
        ],
        {
          cwd: scratch,
          env: {
            PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
            HOME: accountDir,
            CLAUDE_CONFIG_DIR: accountDir,
            TMPDIR: scratch,
          },
          stdio: 'ignore',
        },
      );
      let settled = false;
      let timedOut = false;
      let exited = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const clearAllTimers = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* Process may have exited right before SIGTERM. */
        }
        killTimer = setTimeout(() => {
          if (!exited) {
            try {
              child.kill('SIGKILL');
            } catch {
              /* Process may have exited right before SIGKILL. */
            }
          }
        }, killGraceMs);
      }, timeoutMs);
      child.once('error', () => {
        exited = true;
        if (settled) return;
        settled = true;
        clearAllTimers();
        reject(new Error('EXAM_LOGIN_RENEW_FAILED'));
      });
      child.once('exit', code => {
        exited = true;
        if (settled) return;
        settled = true;
        clearAllTimers();
        if (!timedOut && code === 0) resolve();
        else reject(new Error('EXAM_LOGIN_RENEW_FAILED'));
      });
    });
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function oauthOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.claudeAiOauth) ? value.claudeAiOauth : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hashesEqual(leftHex: string, rightHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(leftHex) || !/^[a-f0-9]{64}$/.test(rightHex)) return false;
  return timingSafeEqual(Buffer.from(leftHex, 'hex'), Buffer.from(rightHex, 'hex'));
}

/** Sorted scope set. `null` means the field is not a list of strings. Missing scopes are an empty set. */
function scopeKey(value: unknown): string | null {
  if (value === undefined) return '';
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null;
  return [...value].sort().join('\0');
}

/** Regular file only. A symlink or a missing file is `undefined` and is not followed. */
async function readCredentialText(file: string): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, READ_OWN);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > CREDENTIAL_LIMIT) return undefined;
    const bytes = await handle.readFile();
    if (bytes.length > CREDENTIAL_LIMIT) return undefined;
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}
