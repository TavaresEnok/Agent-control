// The documentation image builds from this directory alone. Keep the
// publication patterns in sync with src/verify-redact.ts (checked by the tests).
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

const REPORT_PATTERNS = UNKNOWN_PATTERNS.map(pattern => new RegExp(pattern.source, pattern.flags.replace('g', '')));
// A tool may print an absolute path or a longer path. The host's 40-character
// pattern also accepts slashes, so an added parent can mask a relative match.
const PATH_CANDIDATE = /[/\\](?=([A-Za-z0-9+/]{40})(?![A-Za-z0-9+]))/g;

function hasKnownSecret(text) {
  return REPORT_PATTERNS.some(pattern => pattern.test(text));
}

export function hasProtectedReportText(text) {
  if (hasKnownSecret(text)) return true;
  // Match a protected filename or directory even when a surrounding path
  // changes the pattern's boundary, or a renderer displays only that segment.
  const segments = text.split(/[/\\]/);
  if (segments.length === 1) return false;
  if (segments.some(hasKnownSecret)) return true;
  for (const [, candidate] of text.matchAll(PATH_CANDIDATE)) {
    if (hasKnownSecret(candidate)) return true;
  }
  return false;
}

// The host scans both the raw catalog and decoded JSON. Check before encoding
// so its transport cannot carry a catalog that would fail publication.
export function catalogHasProtectedContent(value) {
  if (typeof value === 'string') return hasProtectedReportText(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => hasProtectedReportText(key) || catalogHasProtectedContent(child));
}
