import {Refusal} from './contracts.ts';
import type {VerificationModule} from './ledger.ts';
import {isPublicModuleRule} from './module-exam-collector-proof.ts';
import {hasKnownSecret, redactUnknownSecrets} from './verify-redact.ts';
import {VerifySeverity} from './verify-types.ts';
import {CONTROL_CHAR, MAX_COLLECTOR_STDOUT_BYTES, MULTILINE_CONTROL_CHAR, ModuleCollectorOutput, ModuleRawFinding, ModuleToolCoverage, ModuleToolStatus, assertModuleRepoRelativePath, isProtectedFindingSource, isProtectedLocation, protectedLocation} from './verification-modules-contracts.ts';

function shannonEntropy(value: string): number {
  const chars = [...value];
  const total = chars.length;
  if (total === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of chars) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const REMOVED_HIGH_ENTROPY = '[removido: alta entropia]';
const BASE64_SECRET = /[A-Za-z0-9+]{40,}={0,2}/;
const SNAKE_IDENTIFIER = /^(?=.*_)[a-z][a-z0-9_]{31,}$/;
const SHORT_FILE_EXTENSION = /\.[A-Za-z0-9]{1,5}$/;
const ROUTE_DELIMITER = /[\[\]()]/;
const STATIC_ROUTE_SEGMENT = /^[A-Za-z0-9@._-]+$/;
const INTERCEPT_PREFIX = /^(?:\(\.\)|\(\.\.\)(?:\(\.\.\))?|\(\.\.\.\))(.+)$/u;
const ROUTE_IDENTIFIER = /^[\p{L}][\p{L}\p{N}_-]*$/u;
const ROUTE_VERSION_SUFFIX = /(?:[-_]?[Vv]\d{1,2})$/;
const APP_ROUTE_LEAF = /^(?:page|layout|template|loading|error|not-found|global-error|default|route)\.(?:[cm]?[jt]sx?)$/;

function isDescriptiveRouteIdentifier(name: string): boolean {
  if (!ROUTE_IDENTIFIER.test(name) || shannonEntropy(name) >= 4.3) return false;
  const stem = name.replace(ROUTE_VERSION_SUFFIX, '');
  const words = stem
    .split(/[-_]+/)
    .flatMap(part => part.split(/(?=\p{Lu}\p{Ll})/u))
    .filter(Boolean);
  if (words.length < 2 || words.some(word => !/^\p{Lu}?\p{Ll}+$/u.test(word))) return false;
  const longWordChars = words
    .filter(word => /^\p{Lu}?\p{Ll}{3,}$/u.test(word))
    .reduce((sum, word) => sum + word.length, 0);
  return longWordChars * 2 >= name.length;
}

function extractFrameworkRouteName(segment: string): string | null {
  let body = segment;
  let intercepted = false;
  const interceptMatch = INTERCEPT_PREFIX.exec(segment);
  if (interceptMatch) {
    intercepted = true;
    body = interceptMatch[1]!;
  }

  let inner: string | null = null;
  if (body.startsWith('[[...') && body.endsWith(']]')) {
    inner = body.slice(5, -2);
  } else if (body.startsWith('[...') && body.endsWith(']')) {
    inner = body.slice(4, -1);
  } else if (body.startsWith('[') && body.endsWith(']')) {
    inner = body.slice(1, -1);
  } else if (!intercepted && body.startsWith('(') && body.endsWith(')')) {
    inner = body.slice(1, -1);
  } else if (intercepted) {
    inner = body;
  }

  return inner && ROUTE_IDENTIFIER.test(inner) ? inner : null;
}

function isValidAppRoutePath(segments: readonly string[], cleanLeaf: string): boolean {
  if (cleanLeaf.length >= 32 || !APP_ROUTE_LEAF.test(cleanLeaf)) return false;
  const dirSegments = segments.slice(0, -1);
  const appIndex = dirSegments.indexOf('app');
  if (appIndex < 0 || appIndex >= dirSegments.length - 1) return false;
  if (dirSegments.slice(0, appIndex).some(seg => seg.length >= 32 || seg === '.' || seg === '..' || !STATIC_ROUTE_SEGMENT.test(seg))) {
    return false;
  }
  return dirSegments.slice(appIndex + 1).every(segment => {
    if (segment === '.' || segment === '..') return false;
    if (ROUTE_DELIMITER.test(segment) || segment.length >= 32) {
      const routeName = extractFrameworkRouteName(segment);
      return routeName !== null && (segment.length < 32 || isDescriptiveRouteIdentifier(routeName));
    }
    return STATIC_ROUTE_SEGMENT.test(segment);
  });
}

function isSnakeToken(token: string): boolean {
  if (token.includes('/') && ROUTE_DELIMITER.test(token)) return false;
  if (SNAKE_IDENTIFIER.test(token)) return true;
  const pieces = token.split(/[^A-Za-z0-9_]+/).filter(piece => piece.length > 0);
  if (pieces.length === 0 || pieces.some(piece => !/^[a-z][a-z0-9_]*$/.test(piece))) return false;
  return pieces.some(piece => SNAKE_IDENTIFIER.test(piece));
}

function isPathToken(token: string): boolean {
  if (token.startsWith('/') || token.startsWith('./') || token.startsWith('../')) return true;
  const normalized = token.replace(/^(?:arquivo|modulo|pacote)=/, '');
  const segments = normalized.split('/');
  if (segments.length <= 1) return false;
  const cleanLeaf = segments[segments.length - 1]!.replace(/(?::\d+(?:-\d+)?)?[,;:)]*$/, '');
  if (segments.every(segment => segment.length < 32)) {
    return segments.slice(0, -1).some(segment => SHORT_FILE_EXTENSION.test(segment)) || SHORT_FILE_EXTENSION.test(cleanLeaf);
  }
  return isValidAppRoutePath(segments, cleanLeaf);
}

function isMaskToken(token: string): boolean {
  return /^\(sha256:[a-f0-9]{64}\)$/.test(token);
}

function isSecretToken(token: string): boolean {
  if (!token || isMaskToken(token)) return false;
  if (BASE64_SECRET.test(token)) return true;
  if (isPathToken(token) || isSnakeToken(token)) return false;
  if (!token.includes('/')) {
    return token.length >= 32 && shannonEntropy(token) >= 3.5;
  }
  return token.split('/').some(segment => {
    if (!segment || SNAKE_IDENTIFIER.test(segment)) return false;
    return segment.length >= 32 && shannonEntropy(segment) >= 3.5;
  });
}

export function sanitizeText(value: string): string {
  return redactUnknownSecrets(value).replace(/\S+/g, token => (isSecretToken(token) ? REMOVED_HIGH_ENTROPY : token));
}

export function validateSingleLineString(value: unknown, min: number, max: number, sanitize = false): string {
  if (typeof value !== 'string') throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  if (CONTROL_CHAR.test(value)) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const cleaned = sanitize ? sanitizeText(trimmed).slice(0, max) : trimmed;
  if (cleaned.length < min) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  return cleaned;
}

export function validateTextBlock(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string') throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  if (MULTILINE_CONTROL_CHAR.test(value)) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (normalized.length < min || normalized.length > max) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  const cleaned = sanitizeText(normalized).slice(0, max);
  if (cleaned.length < min) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  return cleaned;
}

/**
 * Validates and normalizes the collector's UTF-8 JSON stdout before persistence.
 * Enforces stdout byte limits, strict object keys, path safety, line >= 1,
 * allowed statuses/severities, and string bounds.
 */
export function parseModuleCollectorOutput(
  rawStdout: string | Buffer,
  options?: {maxStdoutBytes?: number; module?: VerificationModule},
): ModuleCollectorOutput {
  const maxStdoutBytes = options?.maxStdoutBytes ?? MAX_COLLECTOR_STDOUT_BYTES;
  if (!Number.isInteger(maxStdoutBytes) || maxStdoutBytes < 1) throw new Refusal('VERIFY_LIMITS_INVALID', 400);
  let text: string;
  if (Buffer.isBuffer(rawStdout)) {
    if (rawStdout.byteLength > maxStdoutBytes) throw new Refusal('VERIFY_STDOUT_LIMIT', 400);
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(rawStdout);
    } catch {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
  } else if (typeof rawStdout === 'string') {
    if (Buffer.byteLength(rawStdout, 'utf8') > maxStdoutBytes) throw new Refusal('VERIFY_STDOUT_LIMIT', 400);
    text = rawStdout;
  } else {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  if (text.includes('\0') || text.trim().length === 0) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  return validateModuleCollectorObject(parsed, options?.module);
}

export function validateModuleCollectorObject(parsed: unknown, module?: VerificationModule): ModuleCollectorOutput {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes('coverage') || !keys.includes('findings')) {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  const root = parsed as {coverage: unknown; findings: unknown};
  if (!Array.isArray(root.coverage) || root.coverage.length < 1 || root.coverage.length > 5000) {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  if (!Array.isArray(root.findings) || root.findings.length > 999) {
    throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
  }
  const coverage: ModuleToolCoverage[] = root.coverage.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const itemKeys = Object.keys(item);
    if (
      (itemKeys.length !== 4 && itemKeys.length !== 5)
      || itemKeys.some(key => !['tool', 'version', 'status', 'detail', 'files'].includes(key))
      || !itemKeys.includes('tool')
      || !itemKeys.includes('version')
      || !itemKeys.includes('status')
      || !itemKeys.includes('detail')
    ) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const row = item as Record<string, unknown>;
    if (row.files !== undefined && (!Array.isArray(row.files) || row.files.length > 100000)) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const statusParsed = ModuleToolStatus.safeParse(row.status);
    if (!statusParsed.success) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    return ModuleToolCoverage.parse({
      tool: validateSingleLineString(row.tool, 1, 120, false),
      version: validateSingleLineString(row.version, 1, 120, false),
      status: statusParsed.data,
      detail: validateTextBlock(row.detail, 1, 2000).replace(/\s*\n\s*/g, ' '),
      ...(Array.isArray(row.files) ? {files: row.files.map(file => module === 'prontidao' && typeof file === 'string' && isProtectedLocation(file) ? protectedLocation(file) : assertModuleRepoRelativePath(file))} : {}),
    });
  });

  const findings: ModuleRawFinding[] = root.findings.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const itemKeys = Object.keys(item);
    if (
      itemKeys.length !== 7
      || !itemKeys.includes('tool')
      || !itemKeys.includes('rule')
      || !itemKeys.includes('file')
      || !itemKeys.includes('line')
      || !itemKeys.includes('severity')
      || !itemKeys.includes('message')
      || !itemKeys.includes('evidence')
    ) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const row = item as Record<string, unknown>;
    const candidate = typeof row.file === 'string' ? row.file : '';
    const protectedFile = module === 'prontidao' && isProtectedLocation(candidate);
    const file = protectedFile ? protectedLocation(candidate) : assertModuleRepoRelativePath(candidate);
    if (typeof row.line !== 'number' || !Number.isInteger(row.line) || row.line < 1 || row.line > 10_000_000) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
    const severityParsed = VerifySeverity.safeParse(row.severity);
    if (!severityParsed.success) throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    if (protectedFile) {
      if (!isProtectedFindingSource(row.tool, row.rule) || typeof row.message !== 'string'
        || hasKnownSecret(row.message) || typeof row.evidence !== 'string'
        || !(((row.message === 'Possível segredo em arquivo protegido.' || (row.tool === 'prontidao-audit'
          && row.rule === 'PRONTIDAO-CHAVE-PRIVADA-NO-REPOSITORIO' && row.message === 'Possível chave privada em arquivo protegido.'))
          && row.evidence === 'Localização informada pelo coletor; conteúdo protegido.')
          || (row.tool === 'gitleaks' ? row.evidence === `${row.rule}: match em ${file}:${row.line} [REDACTED]`
          : row.tool === 'trivy' && row.evidence === `${row.rule} em ${file}:${row.line} [REDACTED]`))) {
        throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
      }
      return ModuleRawFinding.parse({tool: row.tool, rule: row.rule, file, line: row.line, severity: severityParsed.data,
        message: 'Possível segredo em arquivo protegido.', evidence: 'Localização informada pelo coletor; conteúdo protegido.'});
    }
    return ModuleRawFinding.parse({
      tool: validateSingleLineString(row.tool, 1, 120, false),
      rule: validateSingleLineString(row.rule, 1, 200, !isPublicModuleRule(module, row.tool, row.rule)),
      file,
      line: row.line,
      severity: severityParsed.data,
      message: validateTextBlock(row.message, 1, 2000).replace(/\s*\n\s*/g, ' '),
      evidence: validateTextBlock(row.evidence, 1, 2000),
    });
  });

  for (const row of coverage) {
    for (const file of row.files ?? []) {
      if (isProtectedLocation(file) && !findings.some(f => f.file === file && f.tool === row.tool))
        throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    }
  }
  return {coverage, findings};
}
