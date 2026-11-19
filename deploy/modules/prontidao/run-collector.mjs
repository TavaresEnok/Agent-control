import {spawnSync} from 'node:child_process';
import {closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripVTControlCharacters} from 'node:util';
import {AUDIT_VERSION, auditRepositoryReadiness, redactEvidence} from './audit-readiness.mjs';

const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);
const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);
const MAX_EVIDENCE_BYTES = 512 * 1024;
const MIN_HSTS_MAX_AGE_SECONDS = 15_552_000;
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

export function evaluatePassiveTlsEvidence(evidence, repoRoot, tlsAnchorFile) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('PASSIVE_EVIDENCE_INVALID');
  }
  if (evidence.schemaVersion !== 1 || evidence.collectedBy !== 'agent-control-prontidao-adapter') {
    throw new Error('PASSIVE_EVIDENCE_UNTRUSTED');
  }
  if (!Array.isArray(evidence.targets) || evidence.targets.length === 0 || evidence.targets.length > 16) {
    throw new Error('PASSIVE_EVIDENCE_TARGETS_INVALID');
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
        detail: `Falha na medição passiva de ${origin} (${target.errorCode || 'PROBE_ERROR'}): ${target.errorMessage || 'sem resposta'}.`,
      }));
      continue;
    }

    if (target.status === 'tls_error') {
      const code = String(target.tlsErrorCode || 'TLS_ERROR');
      const rule = mapTlsFailureRule(code, target.tlsErrorMessage);
      findings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule,
        file: tlsAnchorFile,
        line: 1,
        severity: 'alta',
        message: `Falha de validação TLS ao consultar ${origin} (${code}).`,
        evidence: `${origin} [${code}] ${target.tlsErrorMessage || ''}`,
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
    const protocol = String(target.tlsProtocol || '');
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
          evidence: `${origin} validTo=${target.certificate?.validTo ?? 'desconhecido'}`,
        }, repoRoot, tlsAnchorFile));
      } else if (daysRemaining <= EXPIRING_CERT_DAYS) {
        targetFindings.push(normalizeFinding({
          tool: 'prontidao-tls-passivo',
          rule: 'PRONTIDAO-CERT-EXPIRANDO',
          file: tlsAnchorFile,
          line: 1,
          severity: 'media',
          message: `Certificado TLS de ${origin} vence em ${daysRemaining} dia(s).`,
          evidence: `${origin} validTo=${target.certificate?.validTo ?? 'desconhecido'}`,
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
        message: `Origem HTTPS ${origin} respondeu com redirecionamento para HTTP sem TLS (${target.redirectTargetOrigin ?? 'http://'}).`,
        evidence: `${origin} HTTP ${target.httpStatus ?? 302} -> ${target.redirectTargetOrigin ?? 'http://'}`,
      }, repoRoot, tlsAnchorFile));
    }

    const headers = target.headers && typeof target.headers === 'object' ? target.headers : {};
    const hsts = typeof headers['strict-transport-security'] === 'string' ? headers['strict-transport-security'] : '';
    if (!hsts) {
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
      const maxAgeMatch = /(?:^|[;\s])max-age\s*=\s*(\d+)/i.exec(hsts);
      const maxAge = maxAgeMatch ? Number.parseInt(maxAgeMatch[1], 10) : -1;
      if (!Number.isFinite(maxAge) || maxAge < MIN_HSTS_MAX_AGE_SECONDS) {
        targetFindings.push(normalizeFinding({
          tool: 'prontidao-tls-passivo',
          rule: 'PRONTIDAO-HSTS-FRACO',
          file: tlsAnchorFile,
          line: 1,
          severity: 'media',
          message: `Cabeçalho Strict-Transport-Security de ${origin} possui max-age insuficiente (${Number.isFinite(maxAge) && maxAge >= 0 ? maxAge : 'ausente'}).`,
          evidence: `${origin} Strict-Transport-Security: ${hsts}`,
        }, repoRoot, tlsAnchorFile));
      }
    }

    const noSniff = typeof headers['x-content-type-options'] === 'string' ? headers['x-content-type-options'] : '';
    if (noSniff.trim().toLowerCase() !== 'nosniff') {
      targetFindings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule: 'PRONTIDAO-NOSNIFF-AUSENTE',
        file: tlsAnchorFile,
        line: 1,
        severity: 'baixa',
        message: `Resposta HTTPS de ${origin} sem X-Content-Type-Options: nosniff.`,
        evidence: `${origin} HTTP ${target.httpStatus ?? 200}: X-Content-Type-Options=${noSniff || 'ausente'}`,
      }, repoRoot, tlsAnchorFile));
    }

    const xfo = typeof headers['x-frame-options'] === 'string' ? headers['x-frame-options'].trim() : '';
    const csp = typeof headers['content-security-policy'] === 'string' ? headers['content-security-policy'] : '';
    if (!xfo && !/\bframe-ancestors\b/i.test(csp)) {
      targetFindings.push(normalizeFinding({
        tool: 'prontidao-tls-passivo',
        rule: 'PRONTIDAO-FRAME-AUSENTE',
        file: tlsAnchorFile,
        line: 1,
        severity: 'baixa',
        message: `Resposta HTTPS de ${origin} sem proteção contra clickjacking (X-Frame-Options ou CSP frame-ancestors).`,
        evidence: `${origin} HTTP ${target.httpStatus ?? 200}: X-Frame-Options e frame-ancestors ausentes`,
      }, repoRoot, tlsAnchorFile));
    }

    findings.push(...targetFindings);
    const redirectNote = target.redirectCrossOrigin
      ? `; redirecionamento para ${target.redirectTargetOrigin ?? 'outro destino'} não seguido`
      : '';
    const certNote = typeof daysRemaining === 'number' ? `, cert=${daysRemaining}d` : '';
    coverage.push(normalizeCoverageRow({
      tool: 'prontidao-tls-passivo',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Medição passiva em ${origin}: HTTP ${target.httpStatus ?? '-'}, ${protocol || 'TLS'}${certNote}, bytes=${target.bytesRead ?? 0}${redirectNote}; ${targetFindings.length} achado(s).`,
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
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8 || out.length >= 100) return;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= 100 || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const name = entry.name;
        if ((name === 'Dockerfile' || name.startsWith('Dockerfile.') || name.endsWith('.Dockerfile')) && !name.endsWith('.dockerignore')) {
          const abs = join(dir, name);
          const rel = relative(repoRoot, abs).split(sep).join('/');
          out.push({abs, rel});
        }
      }
    }
  };
  walk(repoRoot, 0);
  return out;
}

export function parseGitleaksJson(text, repoRoot, fallbackFile) {
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'null' || trimmed === '[]') return [];
  const parsed = JSON.parse(trimmed);
  if (parsed === null) return [];
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.findings) ? parsed.findings : [];
  return rows.filter(r => r && typeof r === 'object').map(row => normalizeFinding({
    tool: 'gitleaks',
    rule: row.RuleID ?? row.RuleId ?? row.ruleId ?? 'segredo-detectado',
    file: row.File ?? row.file,
    line: row.StartLine ?? row.startLine ?? row.Line ?? row.line ?? 1,
    severity: 'alta',
    message: row.Description ?? row.description ?? 'Possível segredo ou credencial exposta no repositório.',
    evidence: `${row.RuleID ?? 'gitleaks'}: match em ${row.File ?? 'arquivo'}:${row.StartLine ?? 1} [REDACTED]`,
  }, repoRoot, fallbackFile));
}

export function parseHadolintJson(text, repoRoot, fallbackFile) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [];
  return rows.filter(r => r && typeof r === 'object').map(row => normalizeFinding({
    tool: 'hadolint',
    rule: row.code ?? row.rule ?? 'DL0000',
    file: row.file,
    line: row.line ?? 1,
    severity: mapSeverity(row.level ?? 'warning'),
    message: row.message ?? 'Problema de boas práticas no Dockerfile.',
    evidence: `${row.code ?? 'hadolint'} (${row.level ?? 'warning'}): ${row.message ?? ''}`,
  }, repoRoot, fallbackFile));
}

export function parseTrivyConfigJson(text, repoRoot, fallbackFile) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const results = Array.isArray(parsed?.Results) ? parsed.Results : [];
  const out = [];
  const targets = [];
  for (const res of results) {
    if (!res || typeof res !== 'object') continue;
    const target = normalizeRelativeFile(res.Target, repoRoot, fallbackFile);
    targets.push(target);
    const misconfigs = Array.isArray(res.Misconfigurations) ? res.Misconfigurations : [];
    for (const m of misconfigs) {
      if (!m || typeof m !== 'object') continue;
      if (String(m.Status ?? '').toUpperCase() === 'PASS') continue;
      out.push(normalizeFinding({
        tool: 'trivy',
        rule: m.AVDID ?? m.ID ?? 'TRIVY-CONFIG',
        file: target,
        line: m.CauseMetadata?.StartLine ?? 1,
        severity: mapSeverity(m.Severity),
        message: m.Title ?? m.Message ?? m.Description ?? 'Configuração insegura ou não pronta para produção.',
        evidence: `${m.AVDID ?? m.ID ?? 'trivy'}: ${m.Message ?? m.Title ?? ''}`,
      }, repoRoot, fallbackFile));
    }
    const secrets = Array.isArray(res.Secrets) ? res.Secrets : [];
    for (const s of secrets) {
      if (!s || typeof s !== 'object') continue;
      out.push(normalizeFinding({
        tool: 'trivy',
        rule: s.RuleID ?? 'trivy-secret',
        file: target,
        line: s.StartLine ?? 1,
        severity: mapSeverity(s.Severity ?? 'HIGH'),
        message: s.Title ?? 'Segredo detectado pelo Trivy.',
        evidence: `${s.RuleID ?? 'secret'} em ${target}:${s.StartLine ?? 1} [REDACTED]`,
      }, repoRoot, fallbackFile));
    }
  }
  return {findings: out, targets: [...new Set(targets)]};
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
    } catch (err) {
      coverage.push(normalizeCoverageRow({
        tool: 'prontidao-audit',
        version: AUDIT_VERSION,
        status: 'failed',
        detail: `Falha na análise de prontidão: ${err instanceof Error ? err.message : String(err)}`,
      }));
    }

    // 2. gitleaks (segredos fora do código)
    const gitleaksVer = probeVersion(runBin, bins.gitleaks, ['version'], /([0-9]+\.[0-9]+\.[0-9]+)/) ?? 'desconhecida';
    const hasGit = existsSync(join(repoRoot, '.git'));
    const gitleaksOut = join(workDir, 'gitleaks.json');
    const gitleaksArgs = ['detect', ...(hasGit ? [] : ['--no-git']), '--source', repoRoot, '--report-format', 'json', '--report-path', gitleaksOut, '--exit-code', '0', '--no-banner', '--redact', '--log-level', 'error'];
    const glRes = runBin(bins.gitleaks, gitleaksArgs, {cwd: workDir});
    if (glRes.error || glRes.status !== 0 || !existsSync(gitleaksOut)) {
      coverage.push(normalizeCoverageRow({
        tool: 'gitleaks',
        version: gitleaksVer,
        status: 'failed',
        detail: `Falha ao executar gitleaks (${glRes.error?.message ?? `exit=${glRes.status}`}).`,
      }));
    } else {
      try {
        const glFindings = parseGitleaksJson(readFileSync(gitleaksOut, 'utf8'), repoRoot, anchorFile);
        findings.push(...glFindings);
        coverage.push(normalizeCoverageRow({
          tool: 'gitleaks',
          version: gitleaksVer,
          status: 'ok',
          detail: `Varredura ${hasGit ? 'git+arquivos' : 'sem-git'} concluída; ${glFindings.length} segredo(s) encontrado(s).`,
        }));
      } catch (err) {
        coverage.push(normalizeCoverageRow({
          tool: 'gitleaks',
          version: gitleaksVer,
          status: 'failed',
          detail: `Saída JSON inválida do gitleaks: ${err instanceof Error ? err.message : String(err)}`,
        }));
      }
    }

    // 3. hadolint (Dockerfiles)
    const hadolintVer = probeVersion(runBin, bins.hadolint, ['--version'], /([0-9]+\.[0-9]+\.[0-9]+)/) ?? 'desconhecida';
    const dockerfiles = findDockerfiles(repoRoot);
    if (hadolintVer === 'desconhecida' && dockerfiles.length === 0) {
      const probe = runBin(bins.hadolint, ['--version'], {timeout: 10_000});
      if (probe.error) {
        coverage.push(normalizeCoverageRow({
          tool: 'hadolint',
          version: 'desconhecida',
          status: 'failed',
          detail: `Binário hadolint indisponível: ${probe.error.message}`,
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
          detail: `Falha ao executar hadolint (${hlRes.error?.message ?? `exit=${hlRes.status}`}).`,
        }));
      } else {
        try {
          const hlFindings = parseHadolintJson(hlRes.stdout || '[]', repoRoot, anchorFile);
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
        } catch (err) {
          coverage.push(normalizeCoverageRow({
            tool: 'hadolint',
            version: hadolintVer,
            status: 'failed',
            detail: `Saída JSON inválida do hadolint: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      }
    }

    // 4. trivy config (IaC / Dockerfile / Compose no contêiner sem rede)
    const trivyVer = probeVersion(runBin, bins.trivy, ['--version'], /Version:\s*([^\s]+)/i) ?? 'desconhecida';
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
        detail: `Falha ao executar trivy config (${trRes.error?.message ?? `exit=${trRes.status}`}).`,
      }));
    } else {
      try {
        const parsedTrivy = parseTrivyConfigJson(readFileSync(trivyOut, 'utf8'), repoRoot, anchorFile);
        const trFindings = Array.isArray(parsedTrivy) ? parsedTrivy : parsedTrivy.findings;
        const trTargets = Array.isArray(parsedTrivy) ? [] : parsedTrivy.targets;
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
      } catch (err) {
        coverage.push(normalizeCoverageRow({
          tool: 'trivy',
          version: trivyVer,
          status: 'failed',
          detail: `Saída JSON inválida do trivy: ${err instanceof Error ? err.message : String(err)}`,
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
      } catch (err) {
        coverage.push(normalizeCoverageRow({
          tool: 'prontidao-tls-passivo',
          version: AUDIT_VERSION,
          status: 'failed',
          detail: `Evidência passiva TLS inválida: ${err instanceof Error ? err.message : String(err)}`,
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
  const repoRoot = defaultRepoRoot();
  if (!existsSync(repoRoot) || !lstatSync(repoRoot).isDirectory()) {
    console.error('PRONTIDAO_REPO_MISSING');
    process.exit(78);
  }
  const result = runCollector({repoRoot});
  process.stdout.write(`${JSON.stringify(result)}\n`, 'utf8');
}
