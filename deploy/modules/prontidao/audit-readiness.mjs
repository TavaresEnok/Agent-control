import {constants, openSync, readSync, closeSync, readdirSync, lstatSync} from 'node:fs';
import {basename, join, relative, sep} from 'node:path';

export const AUDIT_VERSION = '1.0.0';

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', '__pycache__',
]);

const SECRET_KEY_RE = /(?:^|_)(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY|CLIENT_SECRET|JWT_SECRET|SESSION_SECRET|ENCRYPTION_KEY|SIGNING_KEY)$/i;
const PLACEHOLDER_RE = /^(?:changeme|example|placeholder|dummy|replace[-_]?me|todo|fixme|none|null|true|false|\$\{[^}]+\}|\$[A-Z0-9_]+|<[^>]+>|\*+|x+)$/i;
const URL_CREDS_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^/\s@]+)@[^/\s]+/i;

/** Redacts secret values before placing text into finding evidence or messages. */
export function redactEvidence(text) {
  let out = String(text ?? '').replace(/\s+/g, ' ').trim();
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi, '$1[REDACTED]$3');
  out = out.replace(/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*/g, '$1 [REDACTED]');
  out = out.replace(/([A-Za-z0-9_]*(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY)[A-Za-z0-9_]*\s*[:=]\s*["']?)([^"'\s#]+)(["']?)/gi, '$1[REDACTED]$3');
  return out.slice(0, 240);
}

function readRegularUtf8(absPath) {
  const info = lstatSync(absPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES) return null;
  let fd;
  try {
    fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const opened = lstatSync(absPath);
    if (opened.isSymbolicLink() || !opened.isFile() || opened.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const n = readSync(fd, buf, offset, opened.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const slice = buf.subarray(0, offset);
    if (slice.includes(0)) return null;
    return slice.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Collects regular non-symlink files inside repoRoot as POSIX relative paths. */
export function collectRepoFiles(repoRoot) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 10 || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = join(dir, entry.name);
      const rel = relative(repoRoot, abs).split(sep).join('/');
      if (!rel || rel.startsWith('..') || rel.startsWith('/')) continue;
      const content = readRegularUtf8(abs);
      if (content === null) continue;
      files.push({rel, content, lines: content.split(/\r?\n/)});
    }
  };
  walk(repoRoot, 0);
  return files;
}

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
    } else if (ch === '\'' || ch === '"') {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Line-aware parser for Docker Compose services and readiness attributes. */
export function parseComposeServices(content) {
  const lines = content.split(/\r?\n/);
  const services = [];
  let inServices = false;
  let servicesIndent = -1;
  let current = null;
  let currentIndent = -1;
  let section = null;
  let sectionIndent = -1;
  let subSection = null;
  let subIndent = -1;
  let leafSection = null;
  let leafIndent = -1;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = stripYamlComment(lines[idx]);
    if (!raw.trim()) continue;
    const indent = raw.search(/\S/);
    const trimmed = raw.trim();

    if (!inServices) {
      if (/^services\s*:\s*$/.test(trimmed)) {
        inServices = true;
        servicesIndent = indent;
      }
      continue;
    }
    if (indent <= servicesIndent && !trimmed.startsWith('-')) {
      inServices = false;
      current = null;
      continue;
    }
    if (current === null || indent <= currentIndent) {
      const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
      if (m && indent > servicesIndent) {
        current = {
          name: m[1],
          line: lineNo,
          image: '',
          restart: null,
          hasDeployRestart: false,
          hasHealthcheck: false,
          hasMemLimit: false,
          hasPidsLimit: false,
          hasVolumes: false,
          logDriver: null,
          hasLogMaxSize: false,
          hasLogMaxFile: false,
          hasEnvFile: false,
          hasSecrets: false,
          environment: [],
        };
        services.push(current);
        currentIndent = indent;
        section = null;
        subSection = null;
        leafSection = null;
      }
      continue;
    }

    if (indent <= sectionIndent) {
      section = null;
      subSection = null;
      leafSection = null;
    } else if (indent <= subIndent) {
      subSection = null;
      leafSection = null;
    } else if (indent <= leafIndent) {
      leafSection = null;
    }

    if (section === 'environment') {
      if (trimmed.startsWith('-')) {
        const item = unquote(trimmed.slice(1));
        const eq = item.indexOf('=');
        if (eq > 0) {
          current.environment.push({key: item.slice(0, eq).trim(), value: item.slice(eq + 1).trim(), line: lineNo});
        }
      } else {
        const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
        if (kv) current.environment.push({key: kv[1], value: unquote(kv[2]), line: lineNo});
      }
      continue;
    }

    if (section === 'logging') {
      if (/^driver\s*:/.test(trimmed)) {
        current.logDriver = unquote(trimmed.split(':').slice(1).join(':'));
      } else if (/^options\s*:\s*$/.test(trimmed)) {
        subSection = 'options';
        subIndent = indent;
      } else if (subSection === 'options') {
        if (/^max-size\s*:/.test(trimmed)) current.hasLogMaxSize = true;
        if (/^max-file\s*:/.test(trimmed)) current.hasLogMaxFile = true;
      }
      continue;
    }

    if (section === 'deploy') {
      if (/^restart_policy\s*:/.test(trimmed)) {
        current.hasDeployRestart = true;
      } else if (/^resources\s*:\s*$/.test(trimmed)) {
        subSection = 'resources';
        subIndent = indent;
      } else if (subSection === 'resources' && /^limits\s*:\s*$/.test(trimmed)) {
        leafSection = 'limits';
        leafIndent = indent;
      } else if (leafSection === 'limits') {
        if (/^memory\s*:/.test(trimmed)) current.hasMemLimit = true;
        if (/^pids\s*:/.test(trimmed)) current.hasPidsLimit = true;
      }
      continue;
    }

    const prop = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!prop) continue;
    const [, key, rest] = prop;
    if (key === 'image') current.image = unquote(rest);
    else if (key === 'restart') current.restart = unquote(rest);
    else if (key === 'mem_limit') current.hasMemLimit = true;
    else if (key === 'pids_limit') current.hasPidsLimit = true;
    else if (key === 'healthcheck') current.hasHealthcheck = true;
    else if (key === 'volumes') current.hasVolumes = true;
    else if (key === 'env_file') current.hasEnvFile = true;
    else if (key === 'secrets') current.hasSecrets = true;
    else if (key === 'logging' || key === 'deploy' || key === 'environment') {
      section = key;
      sectionIndent = indent;
    }
  }
  return services;
}

function isComposeFile(rel) {
  const base = basename(rel).toLowerCase();
  return /^(?:docker-)?compose(?:\.[a-z0-9_-]+)?\.ya?ml$/.test(base);
}

function isCaddyFile(rel) {
  const base = basename(rel).toLowerCase();
  return base === 'caddyfile' || base.startsWith('caddyfile.') || base.endsWith('.caddy');
}

function isNginxFile(rel) {
  const lower = rel.toLowerCase();
  const base = basename(lower);
  return base === 'nginx.conf' || (base.endsWith('.conf') && lower.includes('nginx'));
}

function isSystemdService(rel) {
  return rel.toLowerCase().endsWith('.service');
}

function isCommittedEnv(rel) {
  const base = basename(rel).toLowerCase();
  if (!base.startsWith('.env')) return false;
  return !/\.(?:example|sample|template|dist|schema)$/i.test(base);
}

function isCodeOrConfig(rel) {
  return /\.(?:ts|tsx|js|mjs|cjs|py|go|ya?ml|json|conf|caddy|env.*)$/i.test(basename(rel))
    && !/\.(?:test|spec)\.[a-z]+$/i.test(rel)
    && !rel.startsWith('tests/');
}

function isSecretValueExposed(key, rawValue) {
  const value = unquote(rawValue);
  if (!value || PLACEHOLDER_RE.test(value)) return false;
  if (URL_CREDS_RE.test(value)) {
    const m = URL_CREDS_RE.exec(value);
    return Boolean(m?.[1] && !PLACEHOLDER_RE.test(m[1]));
  }
  return SECRET_KEY_RE.test(key);
}

function addFinding(findings, pillarCounts, pillar, item) {
  pillarCounts[pillar] = (pillarCounts[pillar] ?? 0) + 1;
  findings.push({
    tool: 'prontidao-audit',
    rule: item.rule,
    file: item.file,
    line: Math.max(1, Math.trunc(item.line || 1)),
    severity: item.severity,
    message: item.message,
    evidence: redactEvidence(item.evidence),
  });
}

function checkCaddy(file, findings, pillarCounts) {
  let hasTlsOff = false;
  let hasNonLocalHttpBlock = false;
  let hasHsts = false;
  let hasNoSniff = false;
  let hasFrameGuard = false;
  let blockStartLine = 1;
  let firstHostLine = 1;

  for (let i = 0; i < file.lines.length; i++) {
    const lineNo = i + 1;
    const line = file.lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    if (firstHostLine === 1 && line.endsWith('{')) firstHostLine = lineNo;
    if (/^\btls\s+off\b/i.test(line)) {
      hasTlsOff = true;
      addFinding(findings, pillarCounts, 'tls-cabecalhos', {
        rule: 'PRONTIDAO-TLS-DESATIVADO',
        file: file.rel,
        line: lineNo,
        severity: 'alta',
        message: 'Configuração Caddy desativa TLS explicitamente ("tls off").',
        evidence: line,
      });
    }
    const httpSite = /^(?:http:\/\/)([^\s{]+)/i.exec(line);
    if (httpSite && line.endsWith('{')) {
      const host = httpSite[1].toLowerCase();
      if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1') && !host.startsWith(':80')) {
        hasNonLocalHttpBlock = true;
        blockStartLine = lineNo;
      }
    }
    if (/strict-transport-security/i.test(line)) hasHsts = true;
    if (/x-content-type-options/i.test(line)) hasNoSniff = true;
    if (/x-frame-options|frame-ancestors/i.test(line)) hasFrameGuard = true;
  }

  if (hasNonLocalHttpBlock && !hasTlsOff && !/redir\s+https:\/\//i.test(file.content)) {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-TLS-DESATIVADO',
      file: file.rel,
      line: blockStartLine,
      severity: 'alta',
      message: 'Bloco de site público em HTTP sem redirecionamento ou terminação HTTPS.',
      evidence: file.lines[blockStartLine - 1]?.trim() ?? 'http://',
    });
  }
  if (!hasHsts) {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-HSTS-AUSENTE',
      file: file.rel,
      line: firstHostLine,
      severity: 'media',
      message: 'Configuração Caddy sem cabeçalho Strict-Transport-Security (HSTS).',
      evidence: 'Strict-Transport-Security ausente nas diretivas header.',
    });
  }
  if (!hasNoSniff || !hasFrameGuard) {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-SEGURANCA-AUSENTE',
      file: file.rel,
      line: firstHostLine,
      severity: 'baixa',
      message: 'Configuração Caddy sem cabeçalhos básicos de proteção (X-Content-Type-Options e X-Frame-Options/CSP frame-ancestors).',
      evidence: `X-Content-Type-Options=${hasNoSniff}; X-Frame-Options/frame-ancestors=${hasFrameGuard}`,
    });
  }
}

function checkNginx(file, findings, pillarCounts) {
  let hasHsts = /strict-transport-security/i.test(file.content);
  let hasNoSniff = /x-content-type-options/i.test(file.content);
  let hasFrame = /x-frame-options|frame-ancestors/i.test(file.content);
  let serverLine = 1;

  for (let i = 0; i < file.lines.length; i++) {
    const lineNo = i + 1;
    const line = file.lines[i].replace(/#.*$/, '').trim();
    if (!line) continue;
    if (serverLine === 1 && /^server\s*\{/i.test(line)) serverLine = lineNo;
    if (/^ssl_protocols\b/i.test(line) && /\b(?:SSLv2|SSLv3|TLSv1(?:\.0)?|TLSv1\.1)\b/i.test(line)) {
      addFinding(findings, pillarCounts, 'tls-cabecalhos', {
        rule: 'PRONTIDAO-TLS-PROTOCOLO-FRACO',
        file: file.rel,
        line: lineNo,
        severity: 'alta',
        message: 'Nginx habilita protocolo TLS/SSL legado (TLSv1.0/1.1 ou SSLv2/3).',
        evidence: line,
      });
    }
    if (/^listen\s+(?:\[::\]:)?80\b/i.test(line) && !/return\s+30[18]\s+https:\/\//i.test(file.content)) {
      addFinding(findings, pillarCounts, 'tls-cabecalhos', {
        rule: 'PRONTIDAO-TLS-DESATIVADO',
        file: file.rel,
        line: lineNo,
        severity: 'alta',
        message: 'Nginx escuta na porta 80 sem redirecionamento para HTTPS.',
        evidence: line,
      });
    }
  }
  if (/listen\s+[^;]*443\b/i.test(file.content) && !hasHsts) {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-HSTS-AUSENTE',
      file: file.rel,
      line: serverLine,
      severity: 'media',
      message: 'Bloco HTTPS Nginx sem cabeçalho Strict-Transport-Security.',
      evidence: 'add_header Strict-Transport-Security ausente.',
    });
  }
  if (!hasNoSniff || !hasFrame) {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-SEGURANCA-AUSENTE',
      file: file.rel,
      line: serverLine,
      severity: 'baixa',
      message: 'Nginx sem cabeçalhos X-Content-Type-Options ou X-Frame-Options/frame-ancestors.',
      evidence: `X-Content-Type-Options=${hasNoSniff}; X-Frame-Options/frame-ancestors=${hasFrame}`,
    });
  }
}

function checkSystemd(file, findings, pillarCounts) {
  let typeVal = 'simple';
  let hasRestart = false;
  let hasMemoryMax = false;
  let serviceLine = 1;
  let writesFileLog = false;

  for (let i = 0; i < file.lines.length; i++) {
    const lineNo = i + 1;
    const line = file.lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (/^\[Service\]/i.test(line)) serviceLine = lineNo;
    if (/^Type\s*=\s*(.+)$/i.test(line)) typeVal = RegExp.$1.trim().toLowerCase();
    if (/^Restart\s*=\s*(always|on-failure|on-abnormal|on-watchdog)/i.test(line)) hasRestart = true;
    if (/^Memory(?:Max|High)\s*=\s*\S+/i.test(line)) hasMemoryMax = true;
    if (/^Standard(?:Output|Error)\s*=\s*(?:file|append):/i.test(line)) writesFileLog = true;
    const envMatch = /^Environment\s*=\s*(.+)$/i.exec(line);
    if (envMatch) {
      const parts = envMatch[1].match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
      for (const part of parts) {
        const clean = unquote(part);
        const eq = clean.indexOf('=');
        if (eq > 0 && isSecretValueExposed(clean.slice(0, eq), clean.slice(eq + 1))) {
          addFinding(findings, pillarCounts, 'segredos-fora-codigo', {
            rule: 'PRONTIDAO-SEGREDO-SYSTEMD-INLINE',
            file: file.rel,
            line: lineNo,
            severity: 'alta',
            message: `Unit systemd expõe segredo inline na diretiva Environment (${clean.slice(0, eq)}).`,
            evidence: line,
          });
        }
      }
    }
  }
  if (typeVal !== 'oneshot') {
    if (!hasRestart) {
      addFinding(findings, pillarCounts, 'reinicio-automatico', {
        rule: 'PRONTIDAO-SYSTEMD-REINICIO-AUSENTE',
        file: file.rel,
        line: serviceLine,
        severity: 'alta',
        message: 'Unit systemd de longa duração sem política Restart=always ou Restart=on-failure.',
        evidence: `[Service] em ${file.rel} sem Restart=`,
      });
    }
    if (!hasMemoryMax) {
      addFinding(findings, pillarCounts, 'disco-memoria', {
        rule: 'PRONTIDAO-SYSTEMD-MEMORIA-AUSENTE',
        file: file.rel,
        line: serviceLine,
        severity: 'media',
        message: 'Unit systemd sem limite de memória (MemoryMax= ou MemoryHigh=).',
        evidence: `[Service] em ${file.rel} sem MemoryMax=`,
      });
    }
  }
  return {writesFileLog};
}

/** Runs all passive production-readiness checks across a repository directory. */
export function auditRepositoryReadiness(repoRoot) {
  const files = collectRepoFiles(repoRoot);
  const findings = [];
  const pillarCounts = {
    'tls-cabecalhos': 0,
    'backup-restauracao': 0,
    'alertas-logs': 0,
    'reinicio-automatico': 0,
    'disco-memoria': 0,
    'segredos-fora-codigo': 0,
  };
  const fileCoverage = [];

  let hasDeployable = false;
  let hasStateful = false;
  let hasBackup = false;
  let hasRestoreProof = false;
  let hasBackupRotation = false;
  let hasLogrotate = false;
  let hasAlerting = false;
  let hasDiskMonitoring = false;
  let systemdWritesFileLogs = false;
  let anchorFile = null;
  let tlsAnchorFile = null;

  for (const file of files) {
    if (anchorFile === null && (basename(file.rel) === 'package.json' || isComposeFile(file.rel) || basename(file.rel) === 'Dockerfile')) {
      anchorFile = file.rel;
    }
    const lowerContent = file.content.toLowerCase();
    const checksApplied = [];

    if (isComposeFile(file.rel)) {
      hasDeployable = true;
      checksApplied.push('compose');
      const services = parseComposeServices(file.content);
      for (const svc of services) {
        if (svc.hasVolumes || /postgres|mysql|mariadb|mongo|redis|minio/i.test(svc.image)) {
          hasStateful = true;
        }
        const restartVal = (svc.restart ?? '').toLowerCase();
        if (!svc.hasDeployRestart && (!restartVal || restartVal === 'no' || restartVal === '"no"')) {
          addFinding(findings, pillarCounts, 'reinicio-automatico', {
            rule: 'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE',
            file: file.rel,
            line: svc.line,
            severity: 'alta',
            message: `Serviço "${svc.name}" sem política de reinício automático (restart: unless-stopped/always).`,
            evidence: `services.${svc.name} sem restart`,
          });
        }
        if (!svc.hasHealthcheck) {
          addFinding(findings, pillarCounts, 'reinicio-automatico', {
            rule: 'PRONTIDAO-HEALTHCHECK-COMPOSE-AUSENTE',
            file: file.rel,
            line: svc.line,
            severity: 'media',
            message: `Serviço "${svc.name}" sem healthcheck declarado no Compose.`,
            evidence: `services.${svc.name} sem healthcheck`,
          });
        }
        const externalDriver = svc.logDriver && !['json-file', 'local'].includes(svc.logDriver.toLowerCase());
        if (!externalDriver && (!svc.hasLogMaxSize || !svc.hasLogMaxFile)) {
          addFinding(findings, pillarCounts, 'alertas-logs', {
            rule: 'PRONTIDAO-LOG-SEM-ROTACAO',
            file: file.rel,
            line: svc.line,
            severity: 'media',
            message: `Serviço "${svc.name}" sem rotação de logs (logging.options.max-size e max-file).`,
            evidence: `services.${svc.name} sem logging com max-size/max-file`,
          });
        }
        if (!svc.hasMemLimit) {
          addFinding(findings, pillarCounts, 'disco-memoria', {
            rule: 'PRONTIDAO-LIMITE-MEMORIA-AUSENTE',
            file: file.rel,
            line: svc.line,
            severity: 'media',
            message: `Serviço "${svc.name}" sem limite de memória (mem_limit ou deploy.resources.limits.memory).`,
            evidence: `services.${svc.name} sem limite de memória`,
          });
        }
        if (!svc.hasPidsLimit) {
          addFinding(findings, pillarCounts, 'disco-memoria', {
            rule: 'PRONTIDAO-LIMITE-PIDS-AUSENTE',
            file: file.rel,
            line: svc.line,
            severity: 'baixa',
            message: `Serviço "${svc.name}" sem pids_limit para conter explosão de processos.`,
            evidence: `services.${svc.name} sem pids_limit`,
          });
        }
        for (const env of svc.environment) {
          if (isSecretValueExposed(env.key, env.value)) {
            addFinding(findings, pillarCounts, 'segredos-fora-codigo', {
              rule: 'PRONTIDAO-SEGREDO-COMPOSE-INLINE',
              file: file.rel,
              line: env.line,
              severity: 'alta',
              message: `Variável "${env.key}" no serviço "${svc.name}" contém segredo literal em vez de referência \${VAR}/secrets.`,
              evidence: `${env.key}=${env.value}`,
            });
          }
        }
      }
    }

    if (isCaddyFile(file.rel)) {
      hasDeployable = true;
      if (tlsAnchorFile === null) tlsAnchorFile = file.rel;
      checksApplied.push('caddy-tls-headers');
      checkCaddy(file, findings, pillarCounts);
    }

    if (isNginxFile(file.rel)) {
      hasDeployable = true;
      if (tlsAnchorFile === null) tlsAnchorFile = file.rel;
      checksApplied.push('nginx-tls-headers');
      checkNginx(file, findings, pillarCounts);
    }

    if (isSystemdService(file.rel)) {
      hasDeployable = true;
      checksApplied.push('systemd');
      const res = checkSystemd(file, findings, pillarCounts);
      if (res.writesFileLog) systemdWritesFileLogs = true;
    }

    if (basename(file.rel) === 'Dockerfile' || basename(file.rel).startsWith('Dockerfile.') || file.rel.endsWith('.Dockerfile')) {
      hasDeployable = true;
      checksApplied.push('dockerfile');
    }

    if (isCommittedEnv(file.rel)) {
      checksApplied.push('env-secrets');
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
        const val = line.slice(eq + 1).trim();
        if (isSecretValueExposed(key, val)) {
          addFinding(findings, pillarCounts, 'segredos-fora-codigo', {
            rule: 'PRONTIDAO-SEGREDO-ARQUIVO-ENV',
            file: file.rel,
            line: i + 1,
            severity: 'alta',
            message: `Arquivo ${file.rel} versionado contém credencial ou segredo (${key}).`,
            evidence: `${key}=${val}`,
          });
        }
      }
    }

    if (isCodeOrConfig(file.rel)) {
      checksApplied.push('tls-verify');
      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i];
        if (
          /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/i.test(line)
          || /rejectUnauthorized\s*:\s*false\b/.test(line)
          || /InsecureSkipVerify\s*:\s*true\b/.test(line)
        ) {
          addFinding(findings, pillarCounts, 'tls-cabecalhos', {
            rule: 'PRONTIDAO-TLS-VERIFICACAO-DESABILITADA',
            file: file.rel,
            line: i + 1,
            severity: 'alta',
            message: 'Verificação de certificado TLS desabilitada explicitamente no código ou configuração.',
            evidence: line.trim(),
          });
        }
      }
    }

    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(file.content)) {
      const idx = file.lines.findIndex(l => l.includes('PRIVATE KEY-----'));
      addFinding(findings, pillarCounts, 'segredos-fora-codigo', {
        rule: 'PRONTIDAO-CHAVE-PRIVADA-NO-REPOSITORIO',
        file: file.rel,
        line: idx >= 0 ? idx + 1 : 1,
        severity: 'alta',
        message: 'Chave privada encontrada dentro do repositório.',
        evidence: file.lines[idx] ?? 'BEGIN PRIVATE KEY',
      });
    }

    if (/logrotate/i.test(file.rel) || (/\brotate\s+\d+\b/.test(lowerContent) && /\b(?:daily|weekly|maxsize|size)\b/.test(lowerContent))) {
      hasLogrotate = true;
      checksApplied.push('logrotate');
    }
    if (/(?:pg_dump|mysqldump|mongodump|restic\s+backup|borg\s+create|personal:backup|sqlite3[^\n]*\.backup)/i.test(file.content)) {
      hasBackup = true;
      checksApplied.push('backup');
      const unsafeIdx = file.lines.findIndex(l =>
        /(?:pg_dump|mysqldump|mongodump|tar\b)/.test(l)
        && /(?:>\s*|-[fF]\s*)(?:\/tmp\/|\.\/data|\.\.?\/)/.test(l),
      );
      if (unsafeIdx >= 0) {
        addFinding(findings, pillarCounts, 'backup-restauracao', {
          rule: 'PRONTIDAO-BACKUP-DESTINO-INSEGURO',
          file: file.rel,
          line: unsafeIdx + 1,
          severity: 'media',
          message: 'Script de backup grava saída em /tmp ou dentro do diretório de dados/repositório.',
          evidence: file.lines[unsafeIdx].trim(),
        });
      }
    }
    if (/(?:pg_restore|restore-proof|restore-check|personal:restore-proof|restic\s+check|borg\s+check)/i.test(file.content)) {
      hasRestoreProof = true;
      checksApplied.push('restore-proof');
    }
    if (/(?:backup-rotate|personal:backup-rotate|retention|forget\s+--keep|borg\s+prune|find\s+[^\n]*-mtime\s+\+)/i.test(file.content)) {
      hasBackupRotation = true;
    }
    if (/(?:personal:watch|alertmanager|OnFailure=|deliverPersonalPush|sendAlert|alert_webhook|WEBHOOK_ALERT|SLACK_WEBHOOK|DISK_ALERT)/i.test(file.content)) {
      hasAlerting = true;
      checksApplied.push('alerting');
    }
    if (/(?:statfs|DISK_ALERT|diskUsedPercent|df\s+-[Ph]|docker\s+(?:system|builder)\s+prune|personal:maintenance)/i.test(file.content)) {
      hasDiskMonitoring = true;
      checksApplied.push('disk-monitor');
    }

    if (checksApplied.length > 0 && fileCoverage.length < 200) {
      const fileCount = findings.filter(f => f.file === file.rel).length;
      fileCoverage.push({
        tool: 'prontidao:arquivo',
        version: AUDIT_VERSION,
        status: 'ok',
        detail: `${file.rel}: verificações [${[...new Set(checksApplied)].join(', ')}], ${fileCount} achado(s).`,
      });
    }
  }

  const fallbackFile = anchorFile ?? files[0]?.rel ?? 'package.json';
  if (hasDeployable || hasStateful) {
    if (!hasBackup) {
      addFinding(findings, pillarCounts, 'backup-restauracao', {
        rule: 'PRONTIDAO-BACKUP-AUSENTE',
        file: fallbackFile,
        line: 1,
        severity: 'alta',
        message: 'Sistema publicável ou com estado persistente sem script, rotina ou agendamento de backup identificado.',
        evidence: 'Nenhum script/comando de backup (pg_dump, restic, borg, personal:backup) encontrado.',
      });
    }
    if (!hasRestoreProof) {
      addFinding(findings, pillarCounts, 'backup-restauracao', {
        rule: 'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
        file: fallbackFile,
        line: 1,
        severity: 'media',
        message: 'Não há prova automatizada ou rotina de verificação de restauração de backup.',
        evidence: 'Nenhuma rotina de prova de restauração (pg_restore, restore-proof, restic check) encontrada.',
      });
    } else if (hasBackup && !hasBackupRotation) {
      addFinding(findings, pillarCounts, 'backup-restauracao', {
        rule: 'PRONTIDAO-BACKUP-RETENCAO-AUSENTE',
        file: fallbackFile,
        line: 1,
        severity: 'baixa',
        message: 'Backup identificado sem política explícita de rotação/retenção.',
        evidence: 'Nenhuma diretiva de retenção/rotação de backups identificada.',
      });
    }
    if (systemdWritesFileLogs && !hasLogrotate) {
      addFinding(findings, pillarCounts, 'alertas-logs', {
        rule: 'PRONTIDAO-LOGROTATE-AUSENTE',
        file: fallbackFile,
        line: 1,
        severity: 'baixa',
        message: 'Serviço grava logs em arquivo sem configuração de logrotate no repositório.',
        evidence: 'StandardOutput=file/append sem configuração logrotate.',
      });
    }
    if (!hasAlerting) {
      addFinding(findings, pillarCounts, 'alertas-logs', {
        rule: 'PRONTIDAO-ALERTA-AUSENTE',
        file: fallbackFile,
        line: 1,
        severity: 'media',
        message: 'Não há configuração de alertas operacionais ou vigia de falhas no repositório.',
        evidence: 'Nenhuma rotina de alerta/vigia (watch, alert, OnFailure, webhook/push) identificada.',
      });
    }
    if (!hasDiskMonitoring) {
      addFinding(findings, pillarCounts, 'disco-memoria', {
        rule: 'PRONTIDAO-DISCO-SEM-MONITORAMENTO',
        file: fallbackFile,
        line: 1,
        severity: 'media',
        message: 'Não há verificação de uso de disco ou limpeza periódica configurada.',
        evidence: 'Nenhum monitoramento de disco ou rotina de limpeza (df, statfs, maintenance, prune) encontrado.',
      });
    }
  }

  const requirementCoverage = [
    {
      tool: 'prontidao:requisito:tls-cabecalhos',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `TLS e cabeçalhos (configuração estática no repositório): ${pillarCounts['tls-cabecalhos']} achado(s).`,
    },
    {
      tool: 'prontidao:requisito:backup-restauracao',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Backup e restauração (configuração estática no repositório): scriptBackup=${hasBackup ? 'declarado' : 'ausente'}, scriptProvaRestauracao=${hasRestoreProof ? 'declarado' : 'ausente'}; restauração real não comprovada por configuração; ${pillarCounts['backup-restauracao']} achado(s).`,
    },
    {
      tool: 'prontidao:requisito:alertas-logs',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Alertas e rotação de logs (configuração estática no repositório): diretivaAlerta=${hasAlerting ? 'declarada' : 'ausente'}, logrotate=${hasLogrotate ? 'declarado' : 'ausente'}; entrega real de alertas não comprovada por configuração; ${pillarCounts['alertas-logs']} achado(s).`,
    },
    {
      tool: 'prontidao:requisito:reinicio-automatico',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Reinício automático e healthcheck (configuração estática no repositório): disponibilidade real não comprovada por configuração; ${pillarCounts['reinicio-automatico']} achado(s).`,
    },
    {
      tool: 'prontidao:requisito:disco-memoria',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Disco e memória (configuração estática no repositório): rotinaDisco=${hasDiskMonitoring ? 'declarada' : 'ausente'}; uso real no host não medido; ${pillarCounts['disco-memoria']} achado(s).`,
    },
    {
      tool: 'prontidao:requisito:segredos-fora-codigo',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Segredos fora do código (análise estática): ${pillarCounts['segredos-fora-codigo']} achado(s).`,
    },
  ];

  return {
    filesAnalyzed: files.length,
    anchorFile: fallbackFile,
    tlsAnchorFile: tlsAnchorFile ?? fallbackFile,
    findings,
    coverage: [
      {
        tool: 'prontidao-audit',
        version: AUDIT_VERSION,
        status: 'ok',
        detail: `Analisados ${files.length} arquivo(s) nos 6 requisitos estáticos de prontidão; ${findings.length} achado(s).`,
      },
      ...requirementCoverage,
      ...fileCoverage,
    ],
  };
}
