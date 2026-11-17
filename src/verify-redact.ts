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

export function redactUnknownSecrets(text: string): string {
  let out = text;
  for (const pattern of UNKNOWN_PATTERNS) out = out.replace(fresh(pattern, true), match => masked(match));
  return out;
}

/** True when text still contains a live known secret. A mask from secretPreview does not count. */
export function hasKnownSecret(text: string): boolean {
  return UNKNOWN_PATTERNS.some(pattern => fresh(pattern, false).test(text));
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
