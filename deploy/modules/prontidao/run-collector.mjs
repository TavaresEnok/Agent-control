import {spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {AUDIT_VERSION, auditRepositoryReadiness, redactEvidence} from './audit-readiness.mjs';

const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);
const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);

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

function hasExternalNetwork(netDir = '/sys/class/net') {
  try {
    const ifaces = readdirSync(netDir);
    return ifaces.some(name => name !== 'lo');
  } catch {
    return false;
  }
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

function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function probeVersion(runBin, bin, args, regex) {
  const res = runBin(bin, args, {timeout: 15_000});
  if (res.error) return null;
  const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
  if (!text) return null;
  const m = regex ? regex.exec(text) : null;
  return (m?.[1] ?? m?.[0] ?? text.split(/\r?\n/)[0]).trim().slice(0, 80);
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
  const targetRaw = options.targetUrl ?? process.env.AC_TARGET_URL ?? process.env.PRONTIDAO_TARGET_URL ?? '';
  const networkUp = options.hasExternalNetwork ?? hasExternalNetwork();
  const bins = {
    gitleaks: options.bins?.gitleaks ?? 'gitleaks',
    hadolint: options.bins?.hadolint ?? 'hadolint',
    trivy: options.bins?.trivy ?? 'trivy',
    testssl: options.bins?.testssl ?? 'testssl.sh',
  };

  const coverage = [];
  const findings = [];
  let anchorFile = 'package.json';

  try {
    // 1. Análise estática e requisitos de prontidão (prontidao-audit)
    try {
      const audit = auditRepositoryReadiness(repoRoot);
      anchorFile = audit.anchorFile;
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

    // 4. trivy config (IaC / Dockerfile / Compose offline)
    const trivyVer = probeVersion(runBin, bins.trivy, ['--version'], /Version:\s*([^\s]+)/i) ?? 'desconhecida';
    const trivyOut = join(workDir, 'trivy-config.json');
    const trivyCache = join(workDir, 'trivy-cache');
    mkdirSync(trivyCache, {recursive: true});
    const trivyArgs = ['config', '--offline-scan', '--skip-check-update', '--skip-version-check', '--disable-telemetry', '--quiet', '--cache-dir', trivyCache, '--format', 'json', '--output', trivyOut, repoRoot];
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

    // 5. testssl.sh (TLS e cabeçalhos passivos ao vivo quando alvo e rede estão presentes)
    const testsslVer = probeVersion(runBin, bins.testssl, ['--version'], /version\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i) ?? '3.2.5';
    const testsslProbe = runBin(bins.testssl, ['--version'], {timeout: 10_000});
    if (testsslProbe.error) {
      coverage.push(normalizeCoverageRow({
        tool: 'testssl.sh',
        version: testsslVer,
        status: 'failed',
        detail: `Ferramenta testssl.sh indisponível: ${testsslProbe.error.message}`,
      }));
    } else {
      let parsedTarget = null;
      let targetError = null;
      try {
        parsedTarget = validateTargetUrl(targetRaw);
      } catch (err) {
        targetError = err instanceof Error ? err.message : String(err);
      }

      if (targetError) {
        coverage.push(normalizeCoverageRow({
          tool: 'testssl.sh',
          version: testsslVer,
          status: 'failed',
          detail: `URL de alvo inválida (${targetError}).`,
        }));
      } else if (!parsedTarget) {
        coverage.push(normalizeCoverageRow({
          tool: 'testssl.sh',
          version: testsslVer,
          status: 'skipped',
          detail: 'Alvo HTTPS não informado (AC_TARGET_URL); verificação passiva de TLS/cabeçalhos ao vivo ignorada no modo offline.',
        }));
      } else if (parsedTarget.protocol === 'http:') {
        findings.push(normalizeFinding({
          tool: 'testssl.sh',
          rule: 'PRONTIDAO-ALVO-HTTP-SEM-TLS',
          file: anchorFile,
          line: 1,
          severity: 'alta',
          message: `Alvo declarado usa HTTP sem TLS (${parsedTarget.origin}).`,
          evidence: parsedTarget.origin,
        }, repoRoot, anchorFile));
        coverage.push(normalizeCoverageRow({
          tool: 'testssl.sh',
          version: testsslVer,
          status: 'ok',
          detail: `Alvo ${parsedTarget.origin} sem HTTPS; achado de ausência de TLS registrado.`,
        }));
      } else if (!networkUp && !isLoopbackHost(parsedTarget.hostname)) {
        coverage.push(normalizeCoverageRow({
          tool: 'testssl.sh',
          version: testsslVer,
          status: 'skipped',
          detail: `Rede desligada (--network none); verificação passiva de ${parsedTarget.origin} ignorada.`,
        }));
      } else {
        const testsslOut = join(workDir, 'testssl.json');
        const tsArgs = ['--jsonfile', testsslOut, '--warnings', 'off', '--quiet', '--sneaky', '--protocols', '--server-defaults', '--headers', parsedTarget.origin];
        const tsRes = runBin(bins.testssl, tsArgs, {
          cwd: workDir,
          timeout: 180_000,
          env: {...process.env, TESTSSL_INSTALL_DIR: process.env.TESTSSL_INSTALL_DIR || '/opt/testssl'},
        });
        if (tsRes.error || (typeof tsRes.status === 'number' && tsRes.status >= 242) || !existsSync(testsslOut)) {
          coverage.push(normalizeCoverageRow({
            tool: 'testssl.sh',
            version: testsslVer,
            status: 'failed',
            detail: `Falha ao executar testssl.sh contra ${parsedTarget.origin} (${tsRes.error?.message ?? `exit=${tsRes.status}`}).`,
          }));
        } else {
          try {
            const tsFindings = parseTestsslJson(readFileSync(testsslOut, 'utf8'), repoRoot, anchorFile);
            findings.push(...tsFindings);
            coverage.push(normalizeCoverageRow({
              tool: 'testssl.sh',
              version: testsslVer,
              status: 'ok',
              detail: `Inspeção passiva de TLS/cabeçalhos em ${parsedTarget.origin}; ${tsFindings.length} achado(s).`,
            }));
          } catch (err) {
            coverage.push(normalizeCoverageRow({
              tool: 'testssl.sh',
              version: testsslVer,
              status: 'failed',
              detail: `Saída JSON inválida do testssl.sh: ${err instanceof Error ? err.message : String(err)}`,
            }));
          }
        }
      }
    }

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

function parseTargetArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--target=')) return argv[i].slice('--target='.length);
  }
  return undefined;
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
  const targetUrl = parseTargetArg(process.argv.slice(2));
  const result = runCollector({repoRoot, targetUrl});
  process.stdout.write(`${JSON.stringify(result)}\n`, 'utf8');
}
