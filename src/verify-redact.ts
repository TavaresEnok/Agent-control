import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, open, readdir} from 'node:fs/promises';
import {basename, join, relative, sep} from 'node:path';

const ELLIPSIS = '\u2026';
const SHA256_MIN_LENGTH = 16;
// A masked value already contains the ellipsis; do not treat that token as a new secret.
const NOT_A_MASK = String.raw`(?![^\s\u2026]*\u2026)`;
// A quoted value keeps internal spaces. An unquoted value stops at whitespace.
const SECRET_VALUE = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|\S+)`;
// `key` is not a letter suffix (monkey) and not the prefix of keyboard.
// No lookbehind on secret: `_` before it is what hid client_secret.
const ASSIGN_NAME = String.raw`pass|passwd|password|secret|token|(?<![A-Za-z])key(?!board)|auth|credential`;

const UNKNOWN_PATTERNS = [
  /-----BEGIN(?: [A-Za-z0-9][A-Za-z0-9 -]{0,80})?-----[\s\S]*?-----END(?: [A-Za-z0-9][A-Za-z0-9 -]{0,80})?-----/g,
  /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g,
  /(?<![A-Z0-9])ASIA[0-9A-Z]{16}(?![A-Z0-9])/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,400}(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])ghs_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])gho_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,400}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{10,400}(?![A-Za-z0-9-])/g,
  /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@\u2026]{1,200}:[^\s/@\u2026]{1,200}@/g,
  /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_])sk_live_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])rk_live_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
  new RegExp(String.raw`(?<![A-Za-z0-9_])authorization[ \t]*:[ \t]*(?:bearer|basic)[ \t]+${NOT_A_MASK}${SECRET_VALUE}`, 'gi'),
  // 40-char AWS secret access key. Pure hex is a git SHA-1 and must stay.
  /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]{0,39}[G-Zg-z+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/g,
  /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{16,128}(?![A-Za-z0-9_-])/g,
  // `--password x` and `--password=secret`. A space separates only after `--`.
  new RegExp(String.raw`(?<![A-Za-z0-9_])--(?:${ASSIGN_NAME})\w*(?:["']?\s*[:=]\s*|[ \t]+)${NOT_A_MASK}(?!(?:null|true|false)\b)${SECRET_VALUE}`, 'gi'),
  // Optional quote covers JSON keys. A bare JSON literal is not a secret: "secretPreview": null must stay.
  new RegExp(String.raw`(?:${ASSIGN_NAME})\w*["']?\s*[:=]\s*${NOT_A_MASK}(?!(?:null|true|false)\b)${SECRET_VALUE}`, 'gi'),
];

// The 40-char AWS rule above also matches a lowercase repository path of 40 characters, such as
// backend/internal/attendance/store/errors.go. A random key has no uppercase in about 1 of 10^9, so a lowercase run with a
// slash is a path and stays. Kept outside the list: the collector of module 8 copies the list verbatim.
const AWS_SECRET_KEY = UNKNOWN_PATTERNS.find(pattern => pattern.source.endsWith('[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])'))!;
const LOWERCASE_PATH = /^[a-z0-9]*\/[a-z0-9/]*$/;
const isLive = (pattern: RegExp, match: string) => pattern !== AWS_SECRET_KEY || !LOWERCASE_PATH.test(match);

function fresh(pattern: RegExp, global: boolean): RegExp {
  const flags = new Set(pattern.flags);
  if (global) flags.add('g');
  else flags.delete('g');
  return new RegExp(pattern.source, [...flags].join(''));
}

export function secretPreview(secret: string): {preview: string; sha256: string} {
  const preview = `${secret.slice(0, 4)}${ELLIPSIS}`;
  if (secret.length < SHA256_MIN_LENGTH) return {preview, sha256: ''};
  return {
    preview,
    sha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
  };
}

function masked(secret: string): string {
  const preview = secretPreview(secret);
  if (secret.length < SHA256_MIN_LENGTH) return preview.preview;
  return `${preview.preview} (sha256:${preview.sha256})`;
}

export function redactText(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter(secret => secret.length >= 4))];
  unique.sort((left, right) => right.length - left.length || (left < right ? -1 : 1));
  const ranges: {start: number; end: number; secret: string}[] = [];
  for (const secret of unique) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(secret, from);
      if (start < 0) break;
      const end = start + secret.length;
      if (!ranges.some(range => start < range.end && end > range.start)) ranges.push({start, end, secret});
      from = end;
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    out += text.slice(cursor, range.start) + masked(range.secret);
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

export function redactUnknownSecrets(text: string, mask: (secret: string) => string = masked): string {
  let out = text;
  for (const pattern of UNKNOWN_PATTERNS) out = out.replace(fresh(pattern, true), match => (isLive(pattern, match) ? mask(match) : match));
  return out;
}

// A JSON key names a secret when one of its words does: `Secret`, `apiKey`, `client_secret`, `AppSecret`.
// `Author`, `keywords` and `evaluated_keys` are not secrets, and the old unanchored text pattern masked them.
const SECRET_WORDS = new Set(['pass', 'passwd', 'password', 'passwords', 'passphrase', 'secret', 'secrets', 'token', 'tokens', 'key', 'auth', 'credential', 'credentials']);
const MASK_SHAPE = /^.{0,4}\u2026(?: \(sha256:[0-9a-f]{64}\))?$/u;
// Shorter values are masked under their own key but not hunted for in other fields: a 4-character word would eat prose.
const PROPAGATE_MIN_LENGTH = 8;

function isSecretKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some(word => SECRET_WORDS.has(word));
}

function secretText(value: unknown): string | null {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  if (text === null || text.length === 0 || /^(?:null|true|false)$/.test(text) || MASK_SHAPE.test(text)) return null;
  return text;
}

/** Values the tool filed under a secret-looking key. The same value shows up in `Match`, in code blocks and in messages. */
function collectJsonSecrets(value: unknown, key: string | null, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonSecrets(item, key, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) collectJsonSecrets(item, name, found);
  } else if (key !== null && isSecretKey(key)) {
    const text = secretText(value);
    if (text !== null && text.length >= PROPAGATE_MIN_LENGTH) found.add(text);
  }
}

function redactJsonValue(value: unknown, key: string | null, secrets: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map(item => redactJsonValue(item, key, secrets));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      // defineProperty: a plain assignment to "__proto__" would swap the prototype and drop the field.
      Object.defineProperty(out, redactUnknownSecrets(name), {value: redactJsonValue(item, name, secrets), enumerable: true, writable: true, configurable: true});
    }
    return out;
  }
  if (key !== null && isSecretKey(key)) {
    const text = secretText(value);
    if (text !== null) return masked(text);
  }
  return typeof value === 'string' ? redactUnknownSecrets(redactText(value, secrets)) : value;
}

/**
 * Redacts a JSON document value by value, so the result is still valid JSON. Running the text patterns over the raw
 * document eats quotes and commas around a match (`"Secret": "x",` becomes `"Secr… (sha256:…),`) and breaks the file.
 * A value under a secret-looking key is masked whole, and that same value is masked wherever else it appears (`Match`).
 * Every other string goes through redactUnknownSecrets. Written compact, so the file does not outgrow the read limit.
 * Returns null when the text is not JSON, so the caller can fall back to the text patterns.
 */
export function redactJsonDocument(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const found = new Set<string>();
  collectJsonSecrets(parsed, null, found);
  const compact = JSON.stringify(parsed);
  const redacted = JSON.stringify(redactJsonValue(parsed, null, [...found]));
  return redacted === compact ? text : `${redacted}\n`;
}

/** True when text still contains a live known secret. A mask from secretPreview does not count. */
export function hasKnownSecret(text: string): boolean {
  return UNKNOWN_PATTERNS.some(pattern => pattern === AWS_SECRET_KEY
    ? [...text.matchAll(fresh(pattern, true))].some(match => isLive(pattern, match[0]))
    : fresh(pattern, false).test(text));
}

/** Basename only, compared in lowercase. `identity.ts` is not secret-class; `id_rsa` is. */
export function isSecretClassBasename(file: string): boolean {
  const base = basename(file).toLowerCase();
  if (base === '.env' || base.startsWith('.env') || base.endsWith('.pem') || base.endsWith('.key') || base.startsWith('id_')) return true;
  if (base === '.npmrc' || base === '.netrc' || base === '.pgpass') return true;
  if (base.endsWith('.p12') || base.endsWith('.pfx') || base.endsWith('.jks')) return true;
  if (base.endsWith('.tfstate') || base.endsWith('.tfvars')) return true;
  if (base.startsWith('credentials')) return true;
  if (base.startsWith('service-account') && base.endsWith('.json')) return true;
  return base.includes('kubeconfig');
}

export function secretFileStub(relativePath: string, line?: number | null): string {
  const name = relativePath.split(sep).join('/');
  if (typeof line === 'number' && Number.isInteger(line) && line > 0) return `nome: ${name}\nlinha: ${line}\n`;
  return `nome: ${name}\n`;
}

/** Replace secret-class regular files with a name stub. Symlinks are left untouched. */
export async function replaceSecretClassFiles(root: string): Promise<void> {
  await stubTree(root, root);
}

async function stubTree(root: string, dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await stubTree(root, path);
      continue;
    }
    if (!info.isFile() || !isSecretClassBasename(name)) continue;
    const rel = relative(root, path).split(sep).join('/');
    await chmod(path, 0o600);
    const handle = await open(path, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
      await handle.writeFile(secretFileStub(rel), 'utf8');
    } finally {
      await handle.close();
    }
  }
}
