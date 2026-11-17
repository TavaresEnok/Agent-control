import {createHash} from 'node:crypto';

const ELLIPSIS = '\u2026';

const UNKNOWN_PATTERNS = [
  /-----BEGIN(?: [A-Za-z0-9][A-Za-z0-9 -]{0,80})?-----[\s\S]*?-----END(?: [A-Za-z0-9][A-Za-z0-9 -]{0,80})?-----/g,
  /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,400}(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,400}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{10,400}(?![A-Za-z0-9-])/g,
];

export function secretPreview(secret: string): {preview: string; sha256: string} {
  return {
    preview: `${secret.slice(0, 4)}${ELLIPSIS}`,
    sha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
  };
}

function masked(secret: string): string {
  const preview = secretPreview(secret);
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
  for (const pattern of UNKNOWN_PATTERNS) out = out.replace(new RegExp(pattern.source, 'g'), match => masked(match));
  return out;
}
