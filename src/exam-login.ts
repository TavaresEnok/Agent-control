import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, rename, unlink, type FileHandle} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {Refusal} from './contracts.ts';

/** The exam may run for its own timeout. Renew when less than that plus ten minutes remains. */
export const EXAM_LOGIN_MARGIN_MS = 10 * 60 * 1000;

export const EXAM_LOGIN_STALE_TEXT = 'O login da conta venceu. Entre de novo: npm run gateway -- account-add.';

const CREDENTIAL_LIMIT = 65536;
const READ_OWN = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const IDENTITY_FIELDS = ['organizationUuid', 'accountUuid', 'uuid'] as const;

export type ReturnedCredentialClass = 'ok' | 'invalid' | 'other-account';

/** `expiresAt` only. Values below 1e12 are seconds and become milliseconds. Anything else is unreadable. */
export function claudeAccessExpiresAt(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

/** True when the access token is missing or would expire during the exam plus the ten-minute margin. */
export function examLoginNeedsRefresh(expiresAt: number | null, now: number, examMaxMs: number): boolean {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return true;
  return expiresAt < now + examMaxMs + EXAM_LOGIN_MARGIN_MS;
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

/**
 * The returned document is the same Claude account when `claudeAiOauth` is present,
 * the scope set matches, and the identity fields that exist on either side match.
 * A different account or a different scope set is `other-account`. A broken document is `invalid`.
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
  for (const field of IDENTITY_FIELDS) {
    const leftPresent = left[field] !== undefined;
    const rightPresent = right[field] !== undefined;
    if (leftPresent !== rightPresent) return 'other-account';
    if (leftPresent && !Object.is(left[field], right[field])) return 'other-account';
  }
  return 'ok';
}

/**
 * Compare the mounted login with the exam copy. An unchanged file, a symlink, or an unreadable file
 * sends nothing. Only a changed document that still belongs to the same account is returned.
 */
export async function readExamCredentialReturn(originalPath: string, copyPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const original = await readCredentialText(originalPath);
    const copy = await readCredentialText(copyPath);
    if (original === undefined || copy === undefined || original === copy) return undefined;
    if (Buffer.byteLength(copy) > CREDENTIAL_LIMIT) return undefined;
    if (classifyReturnedCredential(original, copy) !== 'ok') return undefined;
    const parsed: unknown = JSON.parse(copy);
    if (!isRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Write the validated document back. Invalid JSON, another account, or a symlink is rejected and the file stays. */
export async function applyReturnedExamCredential(accountDir: string, returnedText: string): Promise<'written' | 'rejected'> {
  if (Buffer.byteLength(returnedText) > CREDENTIAL_LIMIT) return 'rejected';
  const file = join(accountDir, '.credentials.json');
  const original = await readCredentialText(file).catch(() => undefined);
  if (original === undefined) return 'rejected';
  if (classifyReturnedCredential(original, returnedText) !== 'ok') return 'rejected';
  let parsed: unknown;
  try {
    parsed = JSON.parse(returnedText);
  } catch {
    return 'rejected';
  }
  if (!isRecord(parsed)) return 'rejected';
  await writePrivateAtomic(file, JSON.stringify(parsed));
  return 'written';
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
 */
export async function ensureExamLoginFresh(input: {
  accountDir: string;
  now: number;
  examMaxMs: number;
  renew: (accountDir: string) => Promise<void>;
}): Promise<'fresh' | 'renewed'> {
  const before = await readClaudeExpiresAt(input.accountDir);
  if (!examLoginNeedsRefresh(before, input.now, input.examMaxMs)) return 'fresh';
  try {
    await input.renew(input.accountDir);
  } catch {
    /* The file is the record. A non-zero exit can still have written a fresh token. */
  }
  const after = await readClaudeExpiresAt(input.accountDir);
  if (examLoginNeedsRefresh(after, input.now, input.examMaxMs)) throw new Refusal('EXAM_LOGIN_STALE', 409);
  try {
    await normalizeAccountCredential(input.accountDir);
  } catch {
    throw new Refusal('EXAM_LOGIN_STALE', 409);
  }
  return 'renewed';
}

/**
 * The same non-exam Claude path that rewrites `.credentials.json` in the account directory.
 * Stdio is ignored so a token in the CLI output is never logged. Tests inject their own renewer.
 */
export async function renewClaudeLoginInPlace(accountDir: string): Promise<void> {
  const configured = process.env.AC_NATIVE_CLAUDE_BIN;
  const bin = typeof configured === 'string' && configured.startsWith('/') && !configured.includes('\0') ? configured : 'claude';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ['-p', 'ok', '--output-format', 'text'], {
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: accountDir,
        CLAUDE_CONFIG_DIR: accountDir,
        TMPDIR: '/tmp',
      },
      stdio: 'ignore',
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('EXAM_LOGIN_RENEW_FAILED'));
    }, 90_000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('EXAM_LOGIN_RENEW_FAILED'));
    };
    child.on('error', fail);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('EXAM_LOGIN_RENEW_FAILED'));
    });
  });
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
