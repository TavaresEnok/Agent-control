import {spawnSync} from 'node:child_process';
import {closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync, writeSync} from 'node:fs';
import {basename, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {AUDIT_VERSION, auditRepositoryReadiness, redactEvidence} from './audit-readiness.mjs';
import {passiveHeaderFacts} from './header-facts.mjs';

const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);
const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MAX_PASSIVE_TARGETS = 16;
const MAX_UNMEASURED_ORIGINS = 33;
const GITLEAKS_MAX_FILES = 4000;
const GITLEAKS_MAX_ENTRIES = 16_000;
const GITLEAKS_MAX_FILE_BYTES = 8 * 1024 * 1024;
const GITLEAKS_MAX_BYTES = 64 * 1024 * 1024;
const GITLEAKS_MAX_DEPTH = 10;
const GITLEAKS_PREPARE_MS = 5000;
const GITLEAKS_PREPARE_ARG = '--prepare-gitleaks-source';
const GITLEAKS_LIMIT_DETAILS = new Map([
  ['files', '4000 arquivos'],
  ['entries', '16000 entradas'],
  ['file-size', '8 MiB por arquivo'],
  ['total-size', '64 MiB no total'],
  ['depth', 'profundidade 10'],
]);
const EXPIRING_CERT_DAYS = 14;

function mapSeverity(raw) {
  const val = String(raw ?? '').trim().toLowerCase();
  if (val === 'critical' || val === 'high' || val === 'fatal' || val === 'error' || val === 'alta') return 'alta';
  if (val === 'medium' || val === 'moderate' || val === 'warn' || val === 'warning' || val === 'media') return 'media';
  if (val === 'low' || val === 'baixa') return 'baixa';
  return 'informativa';
}

function normalizeRelativeFile(rawFile, repoRoot, fallbackFile) {
  let file = String(rawFile ?? '').replaceAll('\\', '/').trim();
  const normRoot = resolve(repoRoot).replaceAll('\\', '/').replace(/\/+$/, '');
  if (file === normRoot || file === `${normRoot}/`) return fallbackFile;
  if (file.startsWith(`${normRoot}/`)) file = file.slice(normRoot.length + 1);
  if (file.startsWith('/repo/')) file = file.slice('/repo/'.length);
  if (file.startsWith('/repository/')) file = file.slice('/repository/'.length);
  file = file.replace(/^\.\//, '').replace(/^\/+/, '');
  const parts = file.split('/').filter(p => p.length > 0 && p !== '.');
  if (parts.length === 0 || parts.includes('..')) return fallbackFile;
  return parts.join('/').slice(0, 400);
}

function normalizeLine(rawLine) {
  const num = typeof rawLine === 'number' ? rawLine : Number.parseInt(String(rawLine ?? ''), 10);
  if (!Number.isFinite(num) || num < 1) return 1;
  return Math.min(10_000_000, Math.trunc(num));
}

function normalizeFinding(item, repoRoot, fallbackFile) {
  const severity = VALID_SEVERITIES.has(item.severity) ? item.severity : mapSeverity(item.severity);
  return {
    tool: String(item.tool || 'prontidao').slice(0, 60),
    rule: String(item.rule || 'sem-regra').slice(0, 200),
    file: normalizeRelativeFile(item.file, repoRoot, fallbackFile),
    line: normalizeLine(item.line),
    severity,
    message: redactEvidence(item.message || 'Achado de prontidão para produção.').slice(0, 500),
    evidence: redactEvidence(item.evidence ?? ''),
  };
}

function normalizeCoverageRow(row) {
  const status = VALID_STATUSES.has(row.status) ? row.status : 'failed';
  return {
    tool: String(row.tool || 'desconhecida').slice(0, 120),
    version: String(row.version || 'desconhecida').slice(0, 80),
    status,
    detail: String(row.detail || '').slice(0, 500),
    ...(row.files === undefined ? {} : {files: row.files}),
  };
}

export function validateTargetUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(trimmed) || trimmed.includes('.sock')) {
    throw new Error('TARGET_URL_INVALID');
  }
  const url = new URL(trimmed);
  if (url.username || url.password) throw new Error('TARGET_URL_CREDENTIALS_FORBIDDEN');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('TARGET_URL_PROTOCOL_INVALID');
  return url;
}

function readTrustedEvidenceFile(evidencePath, repoRoot) {
  const absEvidence = resolve(evidencePath);
  const absRepo = resolve(repoRoot);
  const rel = relative(absRepo, absEvidence);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'))) {
    throw new Error('EVIDENCE_PATH_INSIDE_REPO');
  }
  const info = lstatSync(absEvidence);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_EVIDENCE_BYTES) {
    throw new Error('EVIDENCE_FILE_INVALID');
  }
  const fd = openSync(absEvidence, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < info.size) {
      const n = readSync(fd, buf, offset, info.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return JSON.parse(buf.subarray(0, offset).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

function mapTlsFailureRule(errorCode, errorMessage) {
  const code = String(errorCode || '').toUpperCase();
  const msg = String(errorMessage || '').toLowerCase();
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') {
    return 'PRONTIDAO-CERT-EXPIRADO';
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'HOSTNAME_MISMATCH') {
    return 'PRONTIDAO-CERT-DOMINIO';
  }
  if (
    code.includes('PROTOCOL')
    || code.includes('WRONG_VERSION')
    || code.includes('INVALID_VERSION')
    || msg.includes('protocol version')
    || msg.includes('unsupported protocol')
  ) {
    return 'PRONTIDAO-TLS-FRACO';
  }
  return 'PRONTIDAO-TLS-FALHA';
}

function safeErrorCode(value, fallback) {
  return typeof value === 'string' && /^(?:E[A-Z0-9_]{1,60}|[A-Z_]+_CERT[A-Z_]*|CERT_[A-Z_]+|HOSTNAME_MISMATCH)$/.test(value)
    ? value
    : fallback;
}

export function evaluatePassiveTlsEvidence(evidence, repoRoot, tlsAnchorFile) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('PASSIVE_EVIDENCE_INVALID');
  }
  if (evidence.schemaVersion !== 1 || evidence.collectedBy !== 'agent-control-prontidao-adapter') {
    throw new Error('PASSIVE_EVIDENCE_UNTRUSTED');
  }
  if (!Array.isArray(evidence.targets) || evidence.targets.length === 0 || evidence.targets.length > MAX_PASSIVE_TARGETS) {
    throw new Error('PASSIVE_EVIDENCE_TARGETS_INVALID');
  }
  const unmeasured = evidence.unmeasuredOrigins === undefined ? [] : evidence.unmeasuredOrigins;
  if (!Array.isArray(unmeasured) || unmeasured.length > MAX_UNMEASURED_ORIGINS) {
    throw new Error('PASSIVE_EVIDENCE_ORIGINS_INVALID');
  }

  const coverage = [];
  const findings = [];

  for (const target of evidence.targets) {
    if (!target || typeof target !== 'object') throw new Error('PASSIVE_EVIDENCE_TARGET_INVALID');
    const url = validateTargetUrl(target.origin);
    if (!url || url.protocol !== 'https:') throw new Error('PASSIVE_EVIDENCE_ORIGIN_INVALID');
    const origin = url.origin;

    if (target.status === 'failed') {
      coverage.push(normalizeCoverageRow({
        tool: 'prontidao-tls-passivo',
        version: AUDIT_VERSION,
        status: 'failed',
        detail: `Falha na medição passiva de ${origin} (${safeErrorCode(target.errorCode, 'PROBE_ERROR')}).`,
      }));
      continue;
    }

    if (target.status === 'tls_error') {
      const code = safeErrorCode(target.tlsErrorCode, 'TLS_ERROR');
      const rule = mapTlsFailureRule(code, target.tlsErrorMessage);
      findings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule,
        file: tlsAnchorFile,
        line: 1,
        severity: 'alta',
        message: `Falha de validação TLS ao consultar ${origin} (${code}).`,
        evidence: `${origin} [${code}]: validação TLS falhou.`,
      }, repoRoot, tlsAnchorFile));
      coverage.push(normalizeCoverageRow({
        tool: 'prontidao-tls-passivo',
        version: AUDIT_VERSION,
        status: 'ok',
        detail: `Medição passiva em ${origin}: validação TLS falhou (${code}); cabeçalhos HTTP não coletados em canal não confiável; 1 achado(s).`,
      }));
      continue;
    }

    if (target.status !== 'ok') {
      throw new Error('PASSIVE_EVIDENCE_STATUS_INVALID');
    }

    const targetFindings = [];
    const protocol = /^(?:SSLv[23]|TLSv1(?:\.[0-3])?)$/i.test(target.tlsProtocol ?? '') ? target.tlsProtocol : '';
    if (/^(?:SSLv2|SSLv3|TLSv1(?:\.0)?|TLSv1\.1)$/i.test(protocol)) {
      targetFindings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule: 'PRONTIDAO-TLS-FRACO',
        file: tlsAnchorFile,
        line: 1,
        severity: 'alta',
        message: `Serviço publicado em ${origin} negociou protocolo TLS legado (${protocol}).`,
        evidence: `${origin} protocol=${protocol}`,
      }, repoRoot, tlsAnchorFile));
    }

    const daysRemaining = target.certificate?.daysRemaining;
    if (typeof daysRemaining === 'number' && Number.isFinite(daysRemaining)) {
      if (daysRemaining < 0) {
        targetFindings.push(normalizeFinding({
          tool: 'prontidao-tls-passivo',
          rule: 'PRONTIDAO-CERT-EXPIRADO',
          file: tlsAnchorFile,
          line: 1,
          severity: 'alta',
          message: `Certificado TLS de ${origin} expirado há ${Math.abs(daysRemaining)} dia(s).`,
          evidence: `${origin}: ${Math.abs(daysRemaining)} dia(s) de diferença até a expiração.`,
        }, repoRoot, tlsAnchorFile));
      } else if (daysRemaining <= EXPIRING_CERT_DAYS) {
        targetFindings.push(normalizeFinding({
          tool: 'prontidao-tls-passivo',
          rule: 'PRONTIDAO-CERT-EXPIRANDO',
          file: tlsAnchorFile,
          line: 1,
          severity: 'media',
          message: `Certificado TLS de ${origin} vence em ${daysRemaining} dia(s).`,
          evidence: `${origin}: ${Math.abs(daysRemaining)} dia(s) de diferença até a expiração.`,
        }, repoRoot, tlsAnchorFile));
      }
    }

    if (target.redirectDowngradeHttp) {
      targetFindings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule: 'PRONTIDAO-REDIR-HTTP',
        file: tlsAnchorFile,
        line: 1,
        severity: 'alta',
        message: `Origem HTTPS ${origin} respondeu com redirecionamento para HTTP sem TLS.`,
        evidence: `${origin} HTTP ${target.httpStatus ?? 302}: redirecionamento para HTTP.`,
      }, repoRoot, tlsAnchorFile));
    }

    const facts = target.headerFacts ?? passiveHeaderFacts(target.headers ?? {});
    if (facts.hsts === 'absent') {
      targetFindings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule: 'PRONTIDAO-HSTS-AUSENTE',
        file: tlsAnchorFile,
        line: 1,
        severity: 'media',
        message: `Resposta HTTPS de ${origin} não enviou cabeçalho Strict-Transport-Security (HSTS).`,
        evidence: `${origin} HTTP ${target.httpStatus ?? 200}: Strict-Transport-Security ausente`,
      }, repoRoot, tlsAnchorFile));
    } else {
      if (facts.hsts !== 'adequate') {
        targetFindings.push(normalizeFinding({
          tool: 'prontidao-tls-passivo',
          rule: 'PRONTIDAO-HSTS-FRACO',
          file: tlsAnchorFile,
          line: 1,
          severity: 'media',
          message: `Cabeçalho Strict-Transport-Security de ${origin} possui max-age inválido ou insuficiente.`,
          evidence: `${origin}: max-age ${facts.hsts === 'invalid' ? 'inválido ou ausente' : 'abaixo do mínimo'}.`,
        }, repoRoot, tlsAnchorFile));
      }
    }

    if (!facts.noSniff) {
      targetFindings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule: 'PRONTIDAO-NOSNIFF-AUSENTE',
        file: tlsAnchorFile,
        line: 1,
        severity: 'baixa',
        message: `Resposta HTTPS de ${origin} sem X-Content-Type-Options: nosniff.`,
        evidence: `${origin}: X-Content-Type-Options ausente ou inválido.`,
      }, repoRoot, tlsAnchorFile));
    }

    if (!facts.antiFrame) {
      targetFindings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule: 'PRONTIDAO-FRAME-AUSENTE',
        file: tlsAnchorFile,
        line: 1,
        severity: 'baixa',
        message: `Resposta HTTPS de ${origin} sem proteção contra clickjacking (X-Frame-Options ou CSP frame-ancestors).`,
        evidence: `${origin}: X-Frame-Options e frame-ancestors ausentes ou inválidos.`,
      }, repoRoot, tlsAnchorFile));
    }

    findings.push(...targetFindings);
    const redirectNote = target.redirectCrossOrigin
      ? '; redirecionamento para outra origem não seguido'
      : '';
    const certNote = typeof daysRemaining === 'number' ? `, cert=${daysRemaining}d` : '';
    coverage.push(normalizeCoverageRow({
      tool: 'prontidao-tls-passivo',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Medição passiva em ${origin}: HTTP ${target.httpStatus ?? '-'}, ${protocol || 'TLS'}${certNote}, bytes=${target.bytesRead ?? 0}${redirectNote}; ${targetFindings.length} achado(s).`,
    }));
  }

  for (const raw of unmeasured) {
    const origin = validateTargetUrl(raw);
    if (origin?.protocol !== 'https:') throw new Error('PASSIVE_EVIDENCE_ORIGIN_INVALID');
    coverage.push(normalizeCoverageRow({
      tool: 'prontidao-tls-passivo',
      version: AUDIT_VERSION,
      status: 'skipped',
      detail: `Origem HTTPS ${origin.origin} não medida pelo limite de ${MAX_PASSIVE_TARGETS} origens por execução.`,
    }));
  }
  return {coverage, findings};
}

function probeVersion(runBin, bin, args, regex) {
  const res = runBin(bin, args, {timeout: 15_000});
  if (res.error || res.status !== 0) return null;
  const text = stripVTControlCharacters(`${res.stdout ?? ''}\n${res.stderr ?? ''}`);
  const match = regex.exec(text);
  const version = match?.[1]?.trim();
  if (!version || /[\u0000-\u001f\u007f-\u009f]/.test(version)) return null;
  return version.slice(0, 80);
}

function defaultRunBin(bin, args, options = {}) {
  return spawnSync(bin, args, {
    cwd: options.cwd ?? '/tmp',
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function findDockerfiles(repoRoot) {
  const files = [];
  let omitted = null;
  const asRelative = path => relative(repoRoot, path).split(sep).join('/') || '.';
  const walk = (dir, depth) => {
    if (depth > 8) {
      omitted ??= `${asRelative(dir)}: limite de profundidade na busca de Dockerfiles.`;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      omitted ??= `${asRelative(dir)}: diretório ilegível na busca de Dockerfiles.`;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        if (files.length >= 100) {
          omitted ??= `${asRelative(abs)}: início de entradas omitidas pelo limite de 100 Dockerfiles.`;
          break;
        }
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        const name = entry.name;
        if ((name === 'Dockerfile' || name.startsWith('Dockerfile.') || name.endsWith('.Dockerfile')) && !name.endsWith('.dockerignore')) {
          if (files.length >= 100) {
            omitted ??= `${asRelative(abs)}: início de entradas omitidas pelo limite de 100 Dockerfiles.`;
            break;
          }
          files.push({abs, rel: asRelative(abs)});
        }
      }
    }
  };
  walk(repoRoot, 0);
  return {files, omitted};
}

const REPORT_INVALID = 'ESTRUTURA_DE_RELATORIO_INVALIDA';
const SECRET_MESSAGE = 'Possível segredo em arquivo protegido.';
const SECRET_EVIDENCE = 'Localização informada pelo coletor; conteúdo protegido.';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reportRows(value, validate) {
  if (!Array.isArray(value) || !value.every(row => isRecord(row) && validate(row))) {
    throw new Error(REPORT_INVALID);
  }
  return value;
}

function isRuleId(value) {
  return typeof value === 'string' && /^[\w.-]{1,200}$/.test(value);
}

function isLocation(file, line) {
  return typeof file === 'string' && file.length > 0 && Number.isSafeInteger(line) && line > 0;
}

export function parseGitleaksJson(text, repoRoot, fallbackFile) {
  const parsed = JSON.parse(text);
  // Upstream marshals a nil slice as null on a clean scan.
  const rows = parsed === null ? [] : reportRows(parsed, row => isRuleId(row.RuleID) && isLocation(row.File, row.StartLine));
  return rows.map(row => normalizeFinding({
    tool: 'gitleaks',
    rule: row.RuleID,
    file: row.File,
    line: row.StartLine,
    severity: 'alta',
    message: SECRET_MESSAGE,
    evidence: SECRET_EVIDENCE,
  }, repoRoot, fallbackFile));
}

export function parseHadolintJson(text, repoRoot, fallbackFile) {
  const rows = reportRows(JSON.parse(text), row =>
    isRuleId(row.code) && isLocation(row.file, row.line) && typeof row.level === 'string' && typeof row.message === 'string');
  return rows.map(row => normalizeFinding({
    tool: 'hadolint',
    rule: row.code,
    file: row.file,
    line: row.line,
    severity: mapSeverity(row.level),
    message: 'Hadolint apontou problema na instrução do Dockerfile.',
    evidence: `Regra Hadolint ${row.code} na instrução indicada.`,
  }, repoRoot, fallbackFile));
}

export function parseTrivyConfigJson(text, repoRoot, fallbackFile) {
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(REPORT_INVALID);
  // Trivy v2 omits Results when the scan has no results.
  const emptyReport = parsed.SchemaVersion === 2
    && typeof parsed.ArtifactName === 'string' && typeof parsed.ArtifactType === 'string';
  const results = parsed.Results === undefined && emptyReport
    ? []
    : reportRows(parsed.Results, row => typeof row.Target === 'string' && row.Target.length > 0);
  const findings = [];
  const targets = new Set();
  for (const result of results) {
    const target = normalizeRelativeFile(result.Target, repoRoot, fallbackFile);
    targets.add(target);
    const misconfigs = result.Misconfigurations === undefined ? [] : reportRows(result.Misconfigurations,
      row => isRuleId(row.AVDID || row.ID) && typeof row.Status === 'string' && typeof row.Severity === 'string');
    for (const row of misconfigs) {
      if (row.Status.toUpperCase() === 'PASS') continue;
      findings.push(normalizeFinding({
        tool: 'trivy',
        rule: row.AVDID || row.ID,
        file: target,
        line: row.CauseMetadata?.StartLine ?? 1,
        severity: mapSeverity(row.Severity),
        message: 'Trivy apontou problema de configuração na instrução indicada.',
        evidence: `Regra Trivy ${row.AVDID || row.ID} na instrução indicada.`,
      }, repoRoot, fallbackFile));
    }
    const secrets = result.Secrets === undefined ? [] : reportRows(result.Secrets,
      row => isRuleId(row.RuleID) && Number.isSafeInteger(row.StartLine) && row.StartLine > 0);
    for (const row of secrets) {
      findings.push(normalizeFinding({
        tool: 'trivy',
        rule: row.RuleID,
        file: target,
        line: row.StartLine,
        severity: mapSeverity(row.Severity ?? 'HIGH'),
        message: SECRET_MESSAGE,
        evidence: SECRET_EVIDENCE,
      }, repoRoot, fallbackFile));
    }
  }
  return {findings, targets: [...targets]};
}

export function parseTestsslJson(text, repoRoot, anchorFile) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const sevRaw = String(row.severity ?? '').trim().toUpperCase();
    if (!sevRaw || sevRaw === 'OK' || sevRaw === 'INFO') continue;
    out.push(normalizeFinding({
      tool: 'testssl.sh',
      rule: `TESTSSL-${String(row.id || 'UNKNOWN').toUpperCase()}`,
      file: anchorFile,
      line: 1,
      severity: mapSeverity(sevRaw),
      message: `${row.id ?? 'tls'}: ${row.finding ?? 'Achado TLS/cabeçalhos de segurança.'}`,
      evidence: `${row.ip ?? ''}:${row.port ?? ''} [${sevRaw}] ${row.finding ?? ''}`,
    }, repoRoot, anchorFile));
  }
  return out;
}

function prepareGitleaksSource(repoRoot, workDir) {
  // Gitleaks reads .gitleaksignore at its scan root. Keep every checkout one level below.
  const source = join(workDir, 'source');
  const checkout = join(source, 'checkout');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const tempRoot = resolve(workDir);
  let files = 0;
  let entries = 0;
  let bytes = 0;
  const copyFile = (from, to) => {
    if (++files > GITLEAKS_MAX_FILES) throw new Error('files');
    const input = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const original = fstatSync(input);
      if (!original.isFile()) throw new Error('GITLEAKS_SOURCE_CHANGED');
      if (original.size > GITLEAKS_MAX_FILE_BYTES) throw new Error('file-size');
      if (bytes + original.size > GITLEAKS_MAX_BYTES) throw new Error('total-size');
      const output = openSync(to, 'wx', 0o600);
      try {
        let offset = 0;
        while (offset < original.size) {
          const count = readSync(input, buffer, 0, Math.min(buffer.length, original.size - offset), offset);
          if (!count) throw new Error('GITLEAKS_SOURCE_CHANGED');
          offset += count;
          bytes += count;
          let written = 0;
          while (written < count) {
            const size = writeSync(output, buffer, written, count - written);
            if (!size) throw new Error('GITLEAKS_WRITE_FAILED');
            written += size;
          }
        }
        const final = fstatSync(input);
        if (final.size !== original.size || final.mtimeMs !== original.mtimeMs) throw new Error('GITLEAKS_SOURCE_CHANGED');
      } finally {
        closeSync(output);
      }
    } finally {
      closeSync(input);
    }
  };
  const walk = (from, to, depth) => {
    if (depth > GITLEAKS_MAX_DEPTH) throw new Error('depth');
    if (!lstatSync(from).isDirectory()) throw new Error('GITLEAKS_SOURCE_CHANGED');
    mkdirSync(to, {mode: 0o700});
    const dir = opendirSync(from, {bufferSize: 32});
    try {
      while (true) {
        const entry = dir.readSync();
        if (!entry) break;
        if (++entries > GITLEAKS_MAX_ENTRIES) throw new Error('entries');
        const src = join(from, entry.name);
        if (entry.name === '.git' || src === tempRoot) continue;
        const dst = join(to, entry.name);
        if (entry.isDirectory()) walk(src, dst, depth + 1);
        else if (entry.isFile()) copyFile(src, dst);
      }
    } finally {
      dir.closeSync();
    }
  };
  mkdirSync(source, {mode: 0o700});
  walk(repoRoot, checkout, 0);
}

function runGitleaks(runBin, bin, repoRoot, workDir, anchorFile) {
  const config = join(workDir, 'gitleaks.toml');
  const report = join(workDir, 'gitleaks.json');
  writeFileSync(config, '[extend]\nuseDefault = true\n', {mode: 0o600});
  // The parent enforces the deadline even while the child is in a synchronous filesystem call.
  const staged = spawnSync(process.execPath, [fileURLToPath(import.meta.url), GITLEAKS_PREPARE_ARG, repoRoot, workDir], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    env: {}, timeout: GITLEAKS_PREPARE_MS, killSignal: 'SIGKILL', maxBuffer: 1024,
  });
  if (staged.error || staged.status !== 0) {
    const limit = staged.error?.code === 'ETIMEDOUT' ? '5 s' : GITLEAKS_LIMIT_DETAILS.get(staged.stdout);
    return {detail: limit ? `Preparação do gitleaks excedeu o limite de ${limit}.`
      : 'Falha ao preparar a cópia limitada do snapshot para gitleaks.'};
  }
  const source = join(workDir, 'source');
  const res = runBin(bin, [
    'dir', '--config', config, '--gitleaks-ignore-path', workDir, '--ignore-gitleaks-allow',
    '--report-format', 'json', '--report-path', report, '--exit-code', '0',
    '--no-banner', '--redact=100', '--log-level', 'error', source,
  ], {cwd: workDir, timeout: 60_000});
  if (res.error || res.status !== 0) return {detail: `Falha ao executar gitleaks (${toolExit(res)}).`};
  if (!existsSync(report)) return {detail: 'Relatório JSON do gitleaks ausente.'};
  try {
    return {findings: parseGitleaksJson(readFileSync(report, 'utf8'), join(source, 'checkout'), anchorFile)};
  } catch {
    return {detail: 'Saída JSON inválida do gitleaks.'};
  }
}

function toolExit(result) {
  return Number.isInteger(result.status) ? `exit=${result.status}` : safeErrorCode(result.error?.code, 'execução interrompida');
}

export function runCollector(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot());
  const workDir = mkdtempSync(join(options.tmpDir ?? process.env.TMPDIR ?? '/tmp', 'prontidao-run-'));
  const runBin = options.runBin ?? defaultRunBin;
  const bins = {
    gitleaks: options.bins?.gitleaks ?? 'gitleaks',
    hadolint: options.bins?.hadolint ?? 'hadolint',
    trivy: options.bins?.trivy ?? 'trivy',
    testssl: options.bins?.testssl ?? 'testssl.sh',
  };

  const coverage = [];
  const findings = [];
  let anchorFile = 'package.json';
  let tlsAnchorFile = 'package.json';

  try {
    // 1. Análise estática e requisitos de prontidão (prontidao-audit)
    try {
      const audit = auditRepositoryReadiness(repoRoot);
      anchorFile = audit.anchorFile;
      tlsAnchorFile = audit.tlsAnchorFile ?? audit.anchorFile;
      for (const f of audit.findings) findings.push(normalizeFinding(f, repoRoot, anchorFile));
      for (const c of audit.coverage) coverage.push(normalizeCoverageRow(c));
    } catch {
      coverage.push(normalizeCoverageRow({
        tool: 'prontidao-audit',
        version: AUDIT_VERSION,
        status: 'failed',
        detail: 'Falha na análise estática de prontidão.',
      }));
    }

    // 2. gitleaks (segredos fora do código)
    const gitleaksVer = probeVersion(runBin, bins.gitleaks, ['version'], /([0-9]+\.[0-9]+\.[0-9]+)/) ?? 'desconhecida';
    let scan;
    try {
      scan = runGitleaks(runBin, bins.gitleaks, repoRoot, workDir, anchorFile);
    } catch {
      scan = {detail: 'Falha ao preparar ou ler a varredura isolada do gitleaks.'};
    }
    if (scan.findings) findings.push(...scan.findings);
    coverage.push(
      normalizeCoverageRow({
        tool: 'gitleaks',
        version: gitleaksVer,
        status: scan.findings ? 'ok' : 'failed',
        detail: scan.detail ?? `Varredura dos arquivos do snapshot concluída; ${scan.findings.length} segredo(s) encontrado(s).`,
      }),
      normalizeCoverageRow({
        tool: 'gitleaks:historico',
        version: gitleaksVer,
        status: 'skipped',
        detail: 'Histórico Git fora do escopo do snapshot de arquivos examinado.',
      }),
    );

    // 3. hadolint (Dockerfiles)
    const hadolintVer = probeVersion(runBin, bins.hadolint, ['--version'], /([0-9]+\.[0-9]+\.[0-9]+)/) ?? 'desconhecida';
    const {files: dockerfiles, omitted: dockerfilesOmitted} = findDockerfiles(repoRoot);
    if (dockerfilesOmitted) {
      coverage.push(normalizeCoverageRow({
        tool: 'hadolint:limites', version: hadolintVer, status: 'failed', detail: dockerfilesOmitted,
      }));
    }
    if (hadolintVer === 'desconhecida' && dockerfiles.length === 0) {
      const probe = runBin(bins.hadolint, ['--version'], {timeout: 10_000});
      if (probe.error) {
        coverage.push(normalizeCoverageRow({
          tool: 'hadolint',
          version: 'desconhecida',
          status: 'failed',
          detail: `Binário hadolint indisponível (${toolExit(probe)}).`,
        }));
      } else {
        coverage.push(normalizeCoverageRow({
          tool: 'hadolint',
          version: hadolintVer,
          status: 'skipped',
          detail: 'Nenhum Dockerfile encontrado no repositório.',
        }));
      }
    } else if (dockerfiles.length === 0) {
      coverage.push(normalizeCoverageRow({
        tool: 'hadolint',
        version: hadolintVer,
        status: 'skipped',
        detail: 'Nenhum Dockerfile encontrado no repositório.',
      }));
    } else {
      const hlRes = runBin(bins.hadolint, ['--no-fail', '-f', 'json', ...dockerfiles.map(d => d.abs)], {cwd: workDir});
      if (hlRes.error || hlRes.status !== 0) {
        coverage.push(normalizeCoverageRow({
          tool: 'hadolint',
          version: hadolintVer,
          status: 'failed',
          detail: `Falha ao executar hadolint (${toolExit(hlRes)}).`,
        }));
      } else {
        try {
          const hlFindings = parseHadolintJson(hlRes.stdout, repoRoot, anchorFile);
          findings.push(...hlFindings);
          coverage.push(normalizeCoverageRow({
            tool: 'hadolint',
            version: hadolintVer,
            status: 'ok',
            detail: `${dockerfiles.length} Dockerfile(s) analisado(s); ${hlFindings.length} achado(s).`,
          }));
          for (const df of dockerfiles) {
            const count = hlFindings.filter(f => f.file === df.rel).length;
            coverage.push(normalizeCoverageRow({
              tool: 'hadolint:arquivo',
              version: hadolintVer,
              status: 'ok',
              detail: `${df.rel}: ${count} achado(s).`,
            }));
          }
        } catch {
          coverage.push(normalizeCoverageRow({
            tool: 'hadolint',
            version: hadolintVer,
            status: 'failed',
            detail: 'Saída JSON inválida do hadolint.',
          }));
        }
      }
    }

    // 4. trivy config (IaC / Dockerfile / Compose no contêiner sem rede)
    const trivyVer = probeVersion(runBin, bins.trivy, ['--version'], /Version:\s*v?([0-9]+\.[0-9]+\.[0-9]+)\b/i) ?? 'desconhecida';
    const trivyOut = join(workDir, 'trivy-config.json');
    const trivyCache = join(workDir, 'trivy-cache');
    mkdirSync(trivyCache, {recursive: true});
    const trivyArgs = ['config', '--skip-check-update', '--skip-version-check', '--disable-telemetry', '--quiet', '--cache-dir', trivyCache, '--format', 'json', '--output', trivyOut, repoRoot];
    const trRes = runBin(bins.trivy, trivyArgs, {cwd: workDir});
    if (trRes.error || trRes.status !== 0 || !existsSync(trivyOut)) {
      coverage.push(normalizeCoverageRow({
        tool: 'trivy',
        version: trivyVer,
        status: 'failed',
        detail: `Falha ao executar trivy config (${toolExit(trRes)}).`,
      }));
    } else {
      try {
        const {findings: trFindings, targets: trTargets} = parseTrivyConfigJson(readFileSync(trivyOut, 'utf8'), repoRoot, anchorFile);
        findings.push(...trFindings);
        coverage.push(normalizeCoverageRow({
          tool: 'trivy',
          version: trivyVer,
          status: 'ok',
          detail: `Trivy config offline em ${trTargets.length} alvo(s) IaC; ${trFindings.length} achado(s).`,
        }));
        for (const target of trTargets.slice(0, 100)) {
          const count = trFindings.filter(f => f.file === target).length;
          coverage.push(normalizeCoverageRow({
            tool: 'trivy:arquivo',
            version: trivyVer,
            status: 'ok',
            detail: `${target}: ${count} achado(s) de configuração.`,
          }));
        }
        if (trTargets.length > 100) {
          coverage.push(normalizeCoverageRow({
            tool: 'trivy:limites', version: trivyVer, status: 'skipped',
            detail: `${trTargets.length - 100} alvo(s) analisado(s) sem linha de cobertura individual pelo limite de 100 linhas.`,
          }));
        }
      } catch {
        coverage.push(normalizeCoverageRow({
          tool: 'trivy',
          version: trivyVer,
          status: 'failed',
          detail: 'Saída JSON inválida do trivy.',
        }));
      }
    }

    // 5. Medição passiva de certificado TLS e cabeçalhos (evidência estruturada confiável do adaptador do produto)
    const evidenceFile = options.evidenceFile ?? process.env.AC_PRONTIDAO_EVIDENCE_FILE ?? '';
    if (options.passiveTlsEvidence !== undefined || evidenceFile) {
      try {
        const evidence = options.passiveTlsEvidence !== undefined
          ? options.passiveTlsEvidence
          : readTrustedEvidenceFile(evidenceFile, repoRoot);
        const evaluated = evaluatePassiveTlsEvidence(evidence, repoRoot, tlsAnchorFile);
        findings.push(...evaluated.findings);
        coverage.push(...evaluated.coverage);
      } catch {
        coverage.push(normalizeCoverageRow({
          tool: 'prontidao-tls-passivo',
          version: AUDIT_VERSION,
          status: 'failed',
          detail: 'Evidência passiva TLS inválida ou ilegível.',
        }));
      }
    } else {
      coverage.push(normalizeCoverageRow({
        tool: 'prontidao-tls-passivo',
        version: AUDIT_VERSION,
        status: 'skipped',
        detail: 'Nenhuma origem HTTPS autorizada informada; medição passiva ao vivo de certificado TLS e cabeçalhos ignorada no modo offline.',
      }));
    }

    // 6. testssl.sh não é executado contra a rede pelo coletor offline (evita varredura ativa e disfarce de cliente)
    const testsslVer = probeVersion(runBin, bins.testssl, ['--version'], /\bversion\s+([0-9]+\.[0-9]+\.[0-9]+)\b/i) ?? 'desconhecida';
    coverage.push(normalizeCoverageRow({
      tool: 'testssl.sh',
      version: testsslVer,
      status: 'skipped',
      detail: 'Varredura testssl.sh desabilitada no coletor offline (--network none, sem varredura nem disfarce de cliente).',
    }));

    // 7. Cobertura honesta de requisitos operacionais que não podem ser provados por mera configuração estática
    coverage.push(
      normalizeCoverageRow({
        tool: 'prontidao:operacional:restauracao',
        version: AUDIT_VERSION,
        status: 'skipped',
        detail: 'Prova real de restauração em ambiente vivo não executada; configuração estática no repositório não comprova restauração.',
      }),
      normalizeCoverageRow({
        tool: 'prontidao:operacional:alertas',
        version: AUDIT_VERSION,
        status: 'skipped',
        detail: 'Entrega real de alertas operacionais não testada; diretiva estática no repositório não comprova disparo de alerta.',
      }),
      normalizeCoverageRow({
        tool: 'prontidao:operacional:disponibilidade',
        version: AUDIT_VERSION,
        status: 'skipped',
        detail: 'Disponibilidade contínua do serviço publicado não comprovada por configuração estática ou requisição passiva pontual.',
      }),
    );

    return {coverage, findings};
  } finally {
    rmSync(workDir, {recursive: true, force: true});
  }
}

function defaultRepoRoot() {
  if (process.env.AC_REPO_DIR) return process.env.AC_REPO_DIR;
  if (existsSync('/repo')) return '/repo';
  if (existsSync('/repository')) return '/repository';
  return '/repo';
}

function launchedAsEntry() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return import.meta.url === pathToFileURL(argvPath).href;
  } catch {
    return false;
  }
}

if (launchedAsEntry()) {
  if (process.argv[2] === GITLEAKS_PREPARE_ARG) {
    try {
      prepareGitleaksSource(process.argv[3], process.argv[4]);
    } catch (error) {
      if (GITLEAKS_LIMIT_DETAILS.has(error.message)) process.stdout.write(error.message);
      process.exitCode = 1;
    }
  } else {
    const repoRoot = defaultRepoRoot();
    if (!existsSync(repoRoot) || !lstatSync(repoRoot).isDirectory()) {
      console.error('PRONTIDAO_REPO_MISSING');
      process.exit(78);
    }
    const result = runCollector({repoRoot});
    process.stdout.write(`${JSON.stringify(result)}\n`, 'utf8');
  }
}
