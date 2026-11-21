import {CLAUDE_HOOKS_OFF_SETTINGS} from './claude-hardening.ts';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, link, lstat, mkdtemp, open, rename, rm, unlink, type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';

/** Safety buffer added to the job's max duration when deciding whether to force an in-place refresh. */
export const EXAM_LOGIN_MARGIN_MS = 10 * 60 * 1000;
export const DEFAULT_EXAM_MAX_MS = 15 * 60 * 1000;
export const EXAM_LOGIN_RENEW_TIMEOUT_MS = 90_000;
export const EXAM_LOGIN_RENEW_KILL_GRACE_MS = 5_000;
export const EXAM_LOGIN_LOCK_TIMEOUT = '120s';

export const EXAM_LOGIN_STALE_TEXT = 'O login da conta venceu. Entre de novo: npm run gateway -- account-add.';
export const EXAM_LOGIN_BUSY_TEXT = 'A conta está ocupada renovando o login em outra execução. Tente de novo em instantes.';
export const EXAM_LOGIN_RESTORE_FAILED_TEXT = 'A renovação do login falhou e não foi possível restaurar o arquivo da conta.';

const CREDENTIAL_LIMIT = 65536;
const READ_OWN = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export type AccountLoginLock = <T>(accountId: string, fn: () => Promise<T>) => Promise<T>;

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

/** `expiresAt` only. Values below 1e12 are seconds and become milliseconds. Anything else is unreadable. */
export function claudeAccessExpiresAt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

/** True when the access token is missing, unreadable, or expires within `examMaxMs + 10 min`. */
export function examLoginNeedsRefresh(expiresAt: number | null, now: number, examMaxMs = DEFAULT_EXAM_MAX_MS): boolean {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return true;
  if (typeof examMaxMs !== 'number' || !Number.isFinite(examMaxMs) || examMaxMs < 0) return true;
  return expiresAt <= now + examMaxMs + EXAM_LOGIN_MARGIN_MS;
}

/** True after renewal only when `expiresAt` is strictly greater than `now + examMaxMs + 10 min`. */
export function examLoginFreshAfterRenew(expiresAt: number | null, now: number, examMaxMs = DEFAULT_EXAM_MAX_MS): boolean {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return false;
  if (typeof examMaxMs !== 'number' || !Number.isFinite(examMaxMs) || examMaxMs < 0) return false;
  return expiresAt > now + examMaxMs + EXAM_LOGIN_MARGIN_MS;
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

export function examLoginRestoreFailedNote(error: unknown): string | undefined {
  return error instanceof Refusal && error.code === 'EXAM_LOGIN_RESTORE_FAILED' ? EXAM_LOGIN_RESTORE_FAILED_TEXT : undefined;
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
 * Replace a regular file in place (or recreate it when `allowCreate` is set and it is absent).
 * The temporary file is mode 0600 in the same directory, then linked/renamed atomically.
 * The previous owner (or directory owner on create) is kept. A symlink is not followed and is not replaced.
 */
export async function writePrivateAtomic(file: string, body: string, options?: {allowCreate?: boolean}): Promise<void> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (!options?.allowCreate || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let targetUid: number;
  let targetGid: number;
  if (info) {
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('EXAM_LOGIN_WRITE_REFUSED');
    targetUid = info.uid;
    targetGid = info.gid;
  } else {
    const dirInfo = await lstat(dirname(file));
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error('EXAM_LOGIN_WRITE_REFUSED');
    targetUid = dirInfo.uid;
    targetGid = dirInfo.gid;
  }
  const temp = join(dirname(file), `.ac-private-${randomBytes(8).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, WRITE_NEW, 0o600);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    try {
      await handle.chown(targetUid, targetGid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' || process.getuid?.() !== targetUid) throw error;
    }
    await handle.close();
    handle = undefined;
    if (!info) {
      try {
        await link(temp, file);
        await unlink(temp);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') throw new Error('EXAM_LOGIN_WRITE_REFUSED');
        if (code !== 'EPERM' && code !== 'EXDEV' && code !== 'EOPNOTSUPP') throw error;
        const current = await lstat(file).catch(err => ((err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : Promise.reject(err)));
        if (current) throw new Error('EXAM_LOGIN_WRITE_REFUSED');
      }
    }
    await rename(temp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Under the account lock:
 * 1. Recalculate `Date.now()`. If remaining `expiresAt` > `examMaxMs + 10 min` and `accessToken` is present, return it without renewing.
 * 2. Immediately before writing `claudeAiOauth.expiresAt = 0`, re-read the file; if it changed since the initial read, re-evaluate without writing `expiresAt = 0`.
 * 3. Otherwise atomically set `claudeAiOauth.expiresAt = 0` (preserving all other fields) and run `renew` in place.
 * 4. Keep the new file only when `accessToken` and `refreshToken` are both non-empty, `expiresAt > now + examMaxMs + 10 min`, and `accessToken` changed.
 *    - Otherwise restore the exact original document read under the lock before forcing `expiresAt = 0` (unless an external writer modified the file after `renew` returned), atomically with mode 0600, and refuse with `EXAM_LOGIN_STALE` (or `EXAM_LOGIN_RESTORE_FAILED` if restoration fails).
 * 5. Normalize and read the new `accessToken` still under the lock before returning.
 */
export async function prepareClaudeExamAccessToken(input: {
  accountDir: string;
  accountId?: string;
  now?: number | (() => number);
  examMaxMs?: number;
  renew: (accountDir: string) => Promise<void>;
  /** A stale credential is refused before any account write or renewal. */
  freshOnly?: boolean;
  lock?: AccountLoginLock;
  hooks?: {beforeForceExpire?: () => Promise<void>; beforeRestore?: () => Promise<void>};
}): Promise<{status: 'fresh' | 'renewed'; accessToken: string; secrets: string[]}> {
  const clock = typeof input.now === 'function' ? input.now : typeof input.now === 'number' ? () => input.now as number : () => Date.now();
  const examMaxMs = input.examMaxMs ?? DEFAULT_EXAM_MAX_MS;

  const parseCredential = (text: string | undefined): {parsed: Record<string, unknown>; oauth: Record<string, unknown> & {refreshToken: string}} => {
    if (text === undefined) throw new Refusal('EXAM_LOGIN_STALE', 409);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Refusal('EXAM_LOGIN_STALE', 409);
    }
    if (!isRecord(parsed)) throw new Refusal('EXAM_LOGIN_STALE', 409);
    const oauth = oauthOf(parsed);
    if (!oauth || !nonEmpty(oauth.refreshToken)) throw new Refusal('EXAM_LOGIN_STALE', 409);
    return {parsed, oauth: oauth as Record<string, unknown> & {refreshToken: string}};
  };

  const run = async (): Promise<{status: 'fresh' | 'renewed'; accessToken: string; secrets: string[]}> => {
    const file = join(input.accountDir, '.credentials.json');
    let candidateText: string | undefined;
    let originalText = '';
    let parsed: Record<string, unknown>;
    let oauth: Record<string, unknown> & {refreshToken: string};

    for (let attempt = 0; ; attempt += 1) {
      const lockedNow = clock();
      const currentText = candidateText ?? (await readCredentialText(file));
      const evaluated = parseCredential(currentText);
      const currentExpires = claudeAccessExpiresAt(evaluated.oauth.expiresAt);
      if (!examLoginNeedsRefresh(currentExpires, lockedNow, examMaxMs) && nonEmpty(evaluated.oauth.accessToken)) {
        return {
          status: 'fresh',
          accessToken: evaluated.oauth.accessToken,
          secrets: [...new Set([evaluated.oauth.accessToken, ...extractCredentialSecrets(evaluated.parsed)])],
        };
      }

      if (input.freshOnly) throw new Refusal('EXAM_LOGIN_STALE', 409);
      await input.hooks?.beforeForceExpire?.();
      const beforeWriteText = await readCredentialText(file);
      if (beforeWriteText === undefined) throw new Refusal('EXAM_LOGIN_STALE', 409);
      if (beforeWriteText !== currentText) {
        if (attempt >= 4) throw new Refusal('EXAM_LOGIN_BUSY', 409);
        candidateText = beforeWriteText;
        continue;
      }

      originalText = beforeWriteText;
      parsed = evaluated.parsed;
      oauth = evaluated.oauth;
      break;
    }

    const originalAccessToken = oauth.accessToken;
    const forcedDoc: Record<string, unknown> = {
      ...parsed,
      claudeAiOauth: {
        ...oauth,
        expiresAt: 0,
      },
    };
    try {
      await writePrivateAtomic(file, JSON.stringify(forcedDoc));
    } catch {
      throw new Refusal('EXAM_LOGIN_STALE', 409);
    }

    try {
      await input.renew(input.accountDir);
    } catch {
      /* The file is the record. Check whether the CLI refreshed it. */
    }

    const afterNow = clock();
    const afterText = await readCredentialText(file);
    let afterOauth: Record<string, unknown> | null = null;
    if (afterText !== undefined) {
      try {
        const parsedAfter: unknown = JSON.parse(afterText);
        if (isRecord(parsedAfter)) afterOauth = oauthOf(parsedAfter);
      } catch {
        afterOauth = null;
      }
    }

    const afterExpires = afterOauth ? claudeAccessExpiresAt(afterOauth.expiresAt) : null;
    const expiresGood = examLoginFreshAfterRenew(afterExpires, afterNow, examMaxMs);
    const hasAccess = Boolean(afterOauth && nonEmpty(afterOauth.accessToken));
    const hasRefresh = Boolean(afterOauth && nonEmpty(afterOauth.refreshToken));
    const accessChanged = hasAccess && afterOauth!.accessToken !== originalAccessToken;

    if (!hasAccess || !hasRefresh || !expiresGood || !accessChanged) {
      await input.hooks?.beforeRestore?.();
      let restoreText: string | undefined;
      try {
        restoreText = await readCredentialText(file);
      } catch {
        throw new Refusal('EXAM_LOGIN_RESTORE_FAILED', 409);
      }
      if (restoreText === afterText) {
        try {
          await writePrivateAtomic(file, originalText, {allowCreate: afterText === undefined});
        } catch {
          throw new Refusal('EXAM_LOGIN_RESTORE_FAILED', 409);
        }
      }
      throw new Refusal('EXAM_LOGIN_STALE', 409);
    }

    try {
      await normalizeAccountCredential(input.accountDir);
    } catch {
      throw new Refusal('EXAM_LOGIN_STALE', 409);
    }

    const finalText = await readCredentialText(file);
    if (finalText === undefined) throw new Refusal('EXAM_LOGIN_STALE', 409);
    let finalParsed: unknown;
    try {
      finalParsed = JSON.parse(finalText);
    } catch {
      throw new Refusal('EXAM_LOGIN_STALE', 409);
    }
    const finalOauth = oauthOf(finalParsed);
    if (!finalOauth || !nonEmpty(finalOauth.accessToken)) throw new Refusal('EXAM_LOGIN_STALE', 409);
    return {
      status: 'renewed',
      accessToken: finalOauth.accessToken,
      secrets: [...new Set([finalOauth.accessToken, ...extractCredentialSecrets(finalParsed)])],
    };
  };

  if (input.lock && input.accountId) return input.lock(input.accountId, run);
  return run();
}

export async function ensureExamLoginFresh(input: {
  accountDir: string;
  accountId?: string;
  now?: number | (() => number);
  examMaxMs?: number;
  renew: (accountDir: string) => Promise<void>;
  lock?: AccountLoginLock;
}): Promise<'fresh' | 'renewed'> {
  const prepared = await prepareClaudeExamAccessToken(input);
  return prepared.status;
}

/**
 * The same non-exam Claude path that rewrites `.credentials.json` in the account directory.
 * Runs in an isolated empty 0700 temp directory with user-only settings and empty MCP config
 * so the repo's CLAUDE.md, hooks, and .mcp.json are never loaded.
 * Spawns in its own process group (`detached: true`). On timeout: sends SIGTERM to the group,
 * waits 5s, sends SIGKILL to the group, and always waits for `exit` before removing the temp dir
 * or releasing the caller's lock.
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
          // Runs on the host with the account directory: a hook a job planted there must not run here.
          '--settings',
          CLAUDE_HOOKS_OFF_SETTINGS,
          '--max-turns',
          '1',
        ],
        {
          cwd: scratch,
          detached: true,
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
      const killGroup = (signal: 'SIGTERM' | 'SIGKILL') => {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, signal);
            return;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ESRCH') return;
          }
        }
        try {
          child.kill(signal);
        } catch {
          /* Process may have exited already. */
        }
      };
      const clearAllTimers = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => {
          if (!exited) killGroup('SIGKILL');
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
        killGroup('SIGKILL');
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
