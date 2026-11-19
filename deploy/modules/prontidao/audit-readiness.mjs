import {constants, openSync, readSync, closeSync, fstatSync, readdirSync} from 'node:fs';
import {basename, join, relative, sep} from 'node:path';

export const AUDIT_VERSION = '1.0.0';

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 10;
const MAX_SKIP_ROWS = 200;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', '__pycache__',
]);

const SECRET_KEY_RE = /(?:^|_)(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY|CLIENT_SECRET|JWT_SECRET|SESSION_SECRET|ENCRYPTION_KEY|SIGNING_KEY)$/i;
const PLACEHOLDER_RE = /^(?:changeme|example|placeholder|dummy|replace[-_]?me|todo|fixme|none|null|true|false|<[^>]+>|\*+|x+)$/i;
const VARIABLE_REFERENCE = /^\$(?:[A-Z_][A-Z0-9_]*|\{[A-Z_][A-Z0-9_]*(?:(?::?\?)[^{}]*)?\})$/i;
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
  const fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return {skipped: 'arquivo não regular'};
    if (opened.size > MAX_FILE_BYTES) return {failed: 'limite de 1 MiB por arquivo'};
    const buf = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const n = readSync(fd, buf, offset, opened.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    const slice = buf.subarray(0, offset);
    if (slice.includes(0)) return {skipped: 'arquivo binário'};
    return {content: slice.toString('utf8')};
  } finally {
    closeSync(fd);
  }
}

/** Collects regular non-symlink files inside repoRoot as POSIX relative paths. */
export function collectRepoFiles(repoRoot, onSkip = () => {}) {
  const files = [];
  let fileCount = 0;
  const relativePath = abs => relative(repoRoot, abs).split(sep).join('/') || '.';
  const walk = (dir, depth) => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      onSkip('failed', relativePath(dir), 'limite de profundidade (subárvore omitida)');
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      onSkip('failed', relativePath(dir), 'diretório ilegível');
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relativePath(abs);
      if (fileCount >= MAX_FILES) {
        onSkip('failed', rel, `limite de ${MAX_FILES} arquivos (esta entrada e as seguintes em ${relativePath(dir)})`);
        break;
      }
      if (entry.isSymbolicLink()) {
        onSkip('skipped', rel, 'link simbólico');
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) onSkip('skipped', rel, 'diretório excluído do escopo estático');
        else walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        onSkip('skipped', rel, 'arquivo não regular');
        continue;
      }
      fileCount++;
      try {
        const read = readRegularUtf8(abs);
        if (read.failed) onSkip('failed', rel, read.failed);
        else if (read.skipped) onSkip('skipped', rel, read.skipped);
        else files.push({rel, content: read.content, lines: read.content.split(/\r?\n/)});
      } catch {
        onSkip('failed', rel, 'arquivo ilegível');
      }
    }
  };
  walk(repoRoot, 0);
  return files;
}

const YAML_PROPERTY = /^("(?:\\.|[^"\\])+"|'(?:''|[^'])+'|[A-Za-z0-9_.-]+|<<)\s*:\s*(.*)$/s;
const YAML_BLOCK = /^[|>](?:[+-]?[1-9]?|[1-9][+-])$/;

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"' && ch === '\\') i++;
    else if (ch === quote) quote = null;
    else if (!quote && (ch === "'" || ch === '"') && (i === 0 || /[\s[{:,]/.test(line[i - 1]))) quote = ch;
    else if (!quote && ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1).replace(/\\(x[\da-f]{2}|u[\da-f]{4}|U[\da-f]{8}|[0abtnvfre "\\/N_LP])/gi, (_, escape) => {
        const yaml = {'0': '\0', e: '\x1b', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029'};
        return yaml[escape] ?? decodeSystemdEscape(escape);
      });
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

// Splits the flow forms used for Compose maps and environment/healthcheck lists.
function flowEntries(value, nextLine) {
  const stack = [];
  const entries = [];
  let quote = null;
  let start = 1;
  for (let i = 0; ; i++) {
    if (i >= value.length) {
      const next = nextLine?.();
      if (next === undefined) return null;
      value += '\n' + next;
    }
    const ch = value[i];
    if (quote) {
      if (quote === '"' && ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if ((ch === "'" || ch === '"') && /[\s[{:,]/.test(value[i - 1] ?? '')) quote = ch;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      if (!stack.length) {
        if (value.slice(i + 1).trim()) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
        const tail = value.slice(start, i).trim();
        if (tail) entries.push(tail);
        return {entries, value};
      }
    } else if (ch === ',' && stack.length === 1) {
      entries.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
}

function* composeLines(content) {
  const lines = content.split(/\r?\n/);
  function* expand(text, indent, line) {
    const property = YAML_PROPERTY.exec(text);
    if (property?.[2].startsWith('{') && property[2] !== '{}') {
      if (indent > 128) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      yield {text: `${property[1]}:`, indent, line};
      for (const entry of flowEntries(property[2])?.entries ?? []) yield* expand(entry, indent + 2, line);
    } else {
      yield {text, indent, line};
    }
  }
  for (let i = 0; i < lines.length; i++) {
    let raw = stripYamlComment(lines[i]);
    if (!raw.trim()) continue;
    const line = i + 1;
    const indent = raw.search(/\S/);
    const text = raw.trim();
    if (text.startsWith('{')) raw = `__root__: ${text}`;
    const prop = YAML_PROPERTY.exec(raw.trim());
    if (prop && /^[{\[]/.test(prop[2])) {
      const flow = flowEntries(prop[2], () => i + 1 < lines.length ? stripYamlComment(lines[++i]) : undefined);
      if (!flow) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      raw = `${prop[1]}: ${flow.value}`;
    }
    if (YAML_BLOCK.test(prop?.[2] ?? '') || /^-\s+[|>]/.test(text)) {
      const scalar = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() && next.search(/\S/) <= indent) break;
        scalar.push(lines[++i].trimStart());
      }
      yield {text, indent, line, scalarBlock: scalar.join('\n')};
    } else {
      yield* expand(raw.trim(), indent, line);
    }
  }
}

/** Reads declaration lines without executing Compose, resolving external files or interpolating variables. */
export function parseComposeServices(content, onIncomplete = () => {}) {
  const services = [];
  let servicesIndent = null;
  let current = null;
  let serviceIndent = -1;
  const path = [];
  let healthcheckList = [];

  const addAssignment = (item, line) => {
    const assignment = unquote(item);
    const eq = assignment.indexOf('=');
    if (eq > 0) current.environment.push({key: assignment.slice(0, eq).trim(), value: assignment.slice(eq + 1).trim(), line});
  };

  for (const {text, indent, line, scalarBlock} of composeLines(content)) {
    const property = YAML_PROPERTY.exec(text);
    const key = property ? unquote(property[1]) : null;
    const value = property?.[2].replace(/^&[\w.-]+(?:\s+|$)/, '') ?? '';
    if (servicesIndent === null || indent <= servicesIndent) {
      servicesIndent = key === 'services' ? indent : null;
      current = null;
      serviceIndent = -1;
      if (servicesIndent !== null && value && value !== '{}') throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      continue;
    }
    if (key === '<<' || /^\*[\w.-]+$/.test(value)) {
      if (!current || indent <= serviceIndent) {
        serviceIndent = indent;
        current = null;
      }
      onIncomplete();
      continue;
    }
    if (!current || indent <= serviceIndent) {
      if (!current && serviceIndent >= 0 && indent > serviceIndent) continue;
      if (!key) continue;
      if (value && value !== '{}') throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      current = {
        name: key, line, image: '', restart: null, hasDeployRestart: false, deployRestartCondition: null,
        hasHealthcheck: false, healthcheckDisabled: false, hasMemLimit: false, hasPidsLimit: false,
        hasVolumes: false, logDriver: null, hasLogMaxSize: false, hasLogMaxFile: false,
        hasEnvFile: false, hasSecrets: false, environment: [],
      };
      services.push(current);
      serviceIndent = indent;
      path.length = 0;
      healthcheckList = [];
      continue;
    }

    const isListItem = /^-\s+/.test(text);
    while (path.length && (path.at(-1).indent > indent || (path.at(-1).indent === indent && !isListItem))) path.pop();
    const parent = path.map(part => part.key).join('.');
    if (parent === 'environment' && isListItem) {
      addAssignment(scalarBlock ?? text.slice(1), line);
      continue;
    }
    if (parent === 'healthcheck.test' && isListItem) {
      healthcheckList.push(unquote(text.slice(1)));
      current.hasHealthcheck = ['CMD', 'CMD-SHELL'].includes(healthcheckList[0]) && healthcheckList.length > 1;
      continue;
    }
    if (!key) continue;

    const setting = parent ? `${parent}.${key}` : key;
    const scalar = scalarBlock?.trim() ?? unquote(value);
    if (parent === 'deploy.restart_policy') current.hasDeployRestart = true;
    switch (setting) {
      case 'image': current.image = scalar; break;
      case 'restart': current.restart = scalar; break;
      case 'deploy.restart_policy': current.hasDeployRestart = value === '{}'; break;
      case 'deploy.restart_policy.condition': current.deployRestartCondition = /^(?:null|~)?$/i.test(scalar) ? null : scalar; break;
      case 'healthcheck.disable': current.healthcheckDisabled = scalar.toLowerCase() === 'true'; break;
      case 'healthcheck.test': {
        const entries = value.startsWith('[') ? flowEntries(value)?.entries ?? [] : null;
        current.hasHealthcheck = entries
          ? ['CMD', 'CMD-SHELL'].includes(unquote(entries[0] ?? '')) && entries.length > 1
          : Boolean(scalar);
        break;
      }
      case 'mem_limit':
      case 'deploy.resources.limits.memory': current.hasMemLimit = true; break;
      case 'pids_limit':
      case 'deploy.resources.limits.pids': current.hasPidsLimit = true; break;
      case 'volumes': current.hasVolumes = true; break;
      case 'env_file': current.hasEnvFile = true; break;
      case 'secrets': current.hasSecrets = true; break;
      case 'logging.driver': current.logDriver = scalar; break;
      case 'logging.options.max-size': current.hasLogMaxSize = true; break;
      case 'logging.options.max-file': current.hasLogMaxFile = true; break;
      case 'environment':
        if (value.startsWith('[')) {
          for (const item of flowEntries(value)?.entries ?? []) addAssignment(item, line);
        }
        break;
      default:
        if (parent === 'environment') {
          const entry = {key, value: scalar, line};
          if (scalarBlock === undefined && /^(?:null|~)$/i.test(value)) {
            entry.value = '';
          }
          current.environment.push(entry);
        }
    }
    if (!value) path.push({key, indent});
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

function isSecretValueExposed(key, rawValue, interpolate = true) {
  const value = unquote(rawValue);
  if (!value || PLACEHOLDER_RE.test(value) || (interpolate && VARIABLE_REFERENCE.test(value))) return false;
  if (URL_CREDS_RE.test(value)) {
    const m = URL_CREDS_RE.exec(value);
    return Boolean(m?.[1] && !PLACEHOLDER_RE.test(m[1]) && !(interpolate && VARIABLE_REFERENCE.test(m[1])));
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
        evidence: 'Diretiva tls off.',
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
      evidence: 'Bloco de site público em HTTP sem redirecionamento HTTPS.',
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

// Nginx permits comments, quoted arguments, and directives on the same line as a block.
function checkNginx(file, findings, pillarCounts) {
  const blocks = [];
  const servers = [];
  const headers = new Set();
  const tokens = /#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\$\{[^}]*\}|\\[\s\S]|[^\s;{}#'"\\$]+|[;{}$]|\s+/g;
  let directive = [];
  let word = '';
  let line = 1;
  let directiveLine = 1;
  const finishWord = () => {
    if (word) directive.push(unquote(word));
    word = '';
  };

  for (const [token] of file.content.matchAll(tokens)) {
    if (token.startsWith('#') || /^\s/.test(token)) {
      finishWord();
    } else if (token === '{' || token === '}' || token === ';') {
      finishWord();
      const [name, ...args] = directive;
      if (token === '{') {
        const server = name === 'server' ? {line: directiveLine, httpLines: [], https: false, redirect: false} : null;
        blocks.push(server);
        if (server) servers.push(server);
      } else if (token === '}') {
        blocks.pop();
      } else {
        const server = blocks.at(-1);
        if (server && name === 'listen') {
          if (/(?:^|:)80$/.test(args[0] ?? '')) server.httpLines.push(directiveLine);
          if (/(?:^|:)443$/.test(args[0] ?? '')) server.https = true;
        }
        if (server && name === 'return' && /^30[1278]$/.test(args[0] ?? '') && /^https:\/\//i.test(args[1] ?? '')) {
          server.redirect = true;
        }
        if (name === 'add_header') {
          const header = args[0]?.toLowerCase();
          if (header === 'content-security-policy' && /(?:^|;)\s*frame-ancestors\s/i.test(args[1] ?? '')) {
            headers.add('frame-ancestors');
          } else {
            headers.add(header);
          }
        }
        if (name === 'ssl_protocols' && args.some(arg => /^(?:SSLv2|SSLv3|TLSv1(?:\.0|\.1)?)$/i.test(arg))) {
          addFinding(findings, pillarCounts, 'tls-cabecalhos', {
            rule: 'PRONTIDAO-TLS-PROTOCOLO-FRACO',
            file: file.rel,
            line: directiveLine,
            severity: 'alta',
            message: 'Nginx habilita protocolo TLS/SSL legado (TLS 1.0/1.1 ou SSL 2/3).',
            evidence: 'Diretiva ssl_protocols com protocolo legado.',
          });
        }
      }
      directive = [];
    } else {
      if (!directive.length && !word) directiveLine = line;
      word += token;
    }
    line += token.split('\n').length - 1;
  }

  for (const server of servers) {
    if (server.redirect) continue;
    for (const listenLine of server.httpLines) {
      addFinding(findings, pillarCounts, 'tls-cabecalhos', {
        rule: 'PRONTIDAO-TLS-DESATIVADO',
        file: file.rel,
        line: listenLine,
        severity: 'alta',
        message: 'Nginx escuta na porta 80 sem redirecionamento para HTTPS no bloco server.',
        evidence: 'Diretiva listen na porta 80 sem return HTTPS no mesmo bloco.',
      });
    }
  }
  const serverLine = servers[0]?.line ?? 1;
  const httpsServer = servers.find(server => server.https);
  if (httpsServer && !headers.has('strict-transport-security')) {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-HSTS-AUSENTE',
      file: file.rel,
      line: httpsServer.line,
      severity: 'media',
      message: 'Bloco HTTPS Nginx sem cabeçalho Strict-Transport-Security.',
      evidence: 'add_header Strict-Transport-Security ausente.',
    });
  }
  if (!headers.has('x-content-type-options') || (!headers.has('x-frame-options') && !headers.has('frame-ancestors'))) {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-SEGURANCA-AUSENTE',
      file: file.rel,
      line: serverLine,
      severity: 'baixa',
      message: 'Nginx sem cabeçalhos X-Content-Type-Options ou proteção contra enquadramento.',
      evidence: 'Diretivas add_header de proteção incompletas.',
    });
  }
}

const SECRET_EVIDENCE = 'Localização informada pelo coletor; conteúdo protegido.';

function addSecretFinding(findings, pillarCounts, rule, file, line, message) {
  addFinding(findings, pillarCounts, 'segredos-fora-codigo', {
    rule, file, line, severity: 'alta', message, evidence: SECRET_EVIDENCE,
  });
}

function decodeSystemdEscape(escape) {
  const common = {a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', s: ' '};
  if (escape.length === 1) return common[escape] ?? escape;
  const octal = /^[0-7]/.test(escape);
  const point = Number.parseInt(octal ? escape : escape.slice(1), octal ? 8 : 16);
  return point <= 0x10ffff ? String.fromCodePoint(point) : '';
}

function* systemdDirectives(lines) {
  let pending = '';
  let start = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (!pending) start = i + 1;
    if (line.endsWith('\\')) {
      pending += line.slice(0, -1) + ' ';
      continue;
    }
    yield {line: start, text: pending + line};
    pending = '';
  }
  if (pending) yield {line: start, text: pending.trim()};
}

function checkSystemd(file, findings, pillarCounts) {
  let type = 'simple';
  let restart = '';
  const memory = new Map();
  const logs = new Map();
  let serviceLine = 1;
  let section = '';

  for (const {line, text} of systemdDirectives(file.lines)) {
    const heading = /^\[([^\]]+)\]$/.exec(text);
    if (heading) {
      section = heading[1].toLowerCase();
      if (section === 'service') serviceLine = line;
      continue;
    }
    if (section !== 'service') continue;
    const match = /^(\w+)\s*=\s*(.*)$/.exec(text);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2];
    if (key === 'type') type = value.toLowerCase();
    if (key === 'restart') restart = value.toLowerCase();
    if (key === 'memorymax' || key === 'memoryhigh') memory.set(key, value);
    if (key === 'standardoutput' || key === 'standarderror') logs.set(key, value);
    if (key !== 'environment') continue;
    const assignments = value.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\\.|[^\s"'\\])+/g);
    for (const [item] of assignments) {
      const decoded = item.replace(/^(['"])([\s\S]*)\1$/, '$2')
        .replace(/\\(x[\da-f]{2}|u[\da-f]{4}|U[\da-f]{8}|[0-7]{3}|.)/gi, (_, escape) => decodeSystemdEscape(escape));
      const eq = decoded.indexOf('=');
      if (eq > 0 && isSecretValueExposed(decoded.slice(0, eq), decoded.slice(eq + 1), false)) {
        addSecretFinding(findings, pillarCounts, 'PRONTIDAO-SEGREDO-SYSTEMD-INLINE', file.rel, line,
          'Possível segredo literal na diretiva Environment do systemd.');
      }
    }
  }

  if (type !== 'oneshot') {
    if (!/^(?:always|on-failure|on-abnormal|on-watchdog|on-abort)$/.test(restart)) {
      addFinding(findings, pillarCounts, 'reinicio-automatico', {
        rule: 'PRONTIDAO-SYSTEMD-REINICIO-AUSENTE',
        file: file.rel,
        line: serviceLine,
        severity: 'alta',
        message: 'Unit systemd de longa duração sem política de reinício após falha.',
        evidence: 'Diretiva Restart ausente ou sem reinício após falha em [Service].',
      });
    }
    if (![...memory.values()].some(value => value && !/^infinity$/i.test(value))) {
      addFinding(findings, pillarCounts, 'disco-memoria', {
        rule: 'PRONTIDAO-SYSTEMD-MEMORIA-AUSENTE',
        file: file.rel,
        line: serviceLine,
        severity: 'media',
        message: 'Unit systemd sem limite de memória (MemoryMax= ou MemoryHigh=).',
        evidence: 'MemoryMax e MemoryHigh ausentes ou sem limite em [Service].',
      });
    }
  }
  return {writesFileLog: [...logs.values()].some(value => /^(?:file|append):/i.test(value))};
}

// Count executable declarations only. Documentation and command arguments alone are not evidence of a routine.
function* operationalCommands(file) {
  const base = basename(file.rel);
  if (base === 'package.json') {
    let scripts;
    try {
      scripts = JSON.parse(file.content)?.scripts;
    } catch {
      return;
    }
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
      for (const command of Object.values(scripts)) {
        if (typeof command === 'string') yield {command, line: 1};
      }
    }
    return;
  }
  if (isSystemdService(file.rel)) {
    let service = false;
    for (const {line, text} of systemdDirectives(file.lines)) {
      if (text.startsWith('[')) service = /^\[Service\]$/i.test(text);
      const command = service && /^Exec(?:Start(?:Pre|Post)?|Stop(?:Post)?)\s*=\s*[-+!:@]*(.+)$/i.exec(text)?.[1];
      if (command) yield {command, line};
    }
    return;
  }

  const shell = /\.(?:sh|bash)$/i.test(base) || /^#![^\n]*\b(?:ba|da|k|z)?sh\b/.test(file.content);
  const cron = /(?:^|\/)(?:cron\.d\/[^/]+|crontab)$/.test(file.rel);
  if (!shell && !cron) return;
  let heredoc;
  for (const [index, raw] of file.lines.entries()) {
    if (heredoc) {
      if (raw.trimStart() === heredoc) heredoc = undefined;
      continue;
    }
    const text = stripYamlComment(raw).trim();
    if (!text) continue;
    heredoc = /(?:^|\s)<<-?\s*(['"]?)([\w-]+)\1(?:\s|$)/.exec(text)?.[2];
    const command = cron
      ? /^(?:@\w+|(?:[\d*][\w*,/-]*\s+){4}[\d*][\w*,/-]*)\s+(?:\w+\s+)?(.+)$/.exec(text)?.[1]
      : text;
    if (command) yield {command, line: index + 1};
  }
}

function checkBackup(file, findings, pillarCounts) {
  let backup = false;
  let restore = false;
  let rotation = false;
  for (const {command, line} of operationalCommands(file)) {
    const shell = /^(?:\S*\/)?(?:ba|da|k|z)?sh\s+-[a-z]*c\s+(.+)$/i.exec(command);
    const invocation = (shell ? unquote(shell[1]) : command)
      .replace(/^\s*(?:(?:exec|command|(?:\S*\/)?env)\s+|[\w]+=(?:\S+|"[^"]*"|'[^']*')\s+)*/, '');
    const routine = /^(?:(?:npm|pnpm)\s+run(?:-script)?\s+personal:|node\s+(?:\S+\/)?personal-)(backup(?:-rotate)?|restore-(?:check|proof))(?:\.[cm]?js)?(?:\s|$)/.exec(invocation)?.[1];
    const dump = /^(?:[^\s]*\/)?(?:pg_dump|mysqldump|mongodump)(?:\s|$)/i.test(invocation);
    if (dump || routine === 'backup'
      || /^(?:[^\s]*\/)?(?:restic\s+backup|borg\s+create|sqlite3\s+.*\.backup\b)/i.test(invocation)) {
      backup = true;
      if (dump && /(?:>|(?:^|\s)(?:-[fF]|--file)(?:=|\s|(?=\/|\.)))\s*['"]?(?:\/tmp\/|\.\.?\/)/.test(invocation)) {
        addFinding(findings, pillarCounts, 'backup-restauracao', {
          rule: 'PRONTIDAO-BACKUP-DESTINO-INSEGURO',
          file: file.rel,
          line,
          severity: 'media',
          message: 'Script de backup grava saída em /tmp ou em caminho relativo ao diretório de trabalho.',
          evidence: 'Detectado destino temporário ou relativo na rotina de backup.',
        });
      }
    }
    if (routine === 'restore-proof' || routine === 'restore-check'
      || /^(?:[^\s]*\/)?(?:pg_restore|restic\s+check|borg\s+check)(?:\s|$)/i.test(invocation)) restore = true;
    if (routine === 'backup-rotate'
      || /^(?:[^\s]*\/)?(?:restic\s+forget\s+--keep|borg\s+prune|find\s+.+\s-mtime\s+\+\d+\s+.*-delete)(?:\s|$)/i.test(invocation)) rotation = true;
  }
  return {backup, restore, rotation};
}

/** Runs all passive production-readiness checks across a repository directory. */
export function auditRepositoryReadiness(repoRoot) {
  const skipCoverage = [];
  let skipped = 0;
  let failed = 0;
  const recordSkip = (status, rel, reason) => {
    if (status === 'failed') failed++;
    else skipped++;
    if (skipCoverage.length < MAX_SKIP_ROWS) {
      skipCoverage.push({tool: 'prontidao:arquivo', version: AUDIT_VERSION, status, detail: `${rel}: ${reason}.`});
    }
  };
  const files = collectRepoFiles(repoRoot, recordSkip);
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
    const findingsBeforeFile = findings.length;

    if (isComposeFile(file.rel)) {
      hasDeployable = true;
      checksApplied.push('compose');
      let services = [];
      let incomplete = false;
      try {
        services = parseComposeServices(file.content, () => { incomplete = true; });
      } catch {
        incomplete = true;
      }
      if (incomplete) {
        checksApplied.pop();
        recordSkip('failed', file.rel, 'estrutura Compose inválida ou referência YAML não resolvida');
      }
      for (const svc of services) {
        if (svc.hasVolumes || /postgres|mysql|mariadb|mongo|redis|minio/i.test(svc.image)) {
          hasStateful = true;
        }
        const restartVal = (svc.restart ?? '').toLowerCase();
        const restarts = svc.hasDeployRestart
          ? /^(?:any|on-failure)$/.test(svc.deployRestartCondition ?? 'any')
          : /^(?:always|unless-stopped|on-failure(?::\d+)?)$/.test(restartVal);
        if (!restarts) {
          addFinding(findings, pillarCounts, 'reinicio-automatico', {
            rule: 'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE',
            file: file.rel,
            line: svc.line,
            severity: 'alta',
            message: 'Serviço do Compose sem política ativa de reinício automático.',
            evidence: 'Política de reinício ausente ou desativada.',
          });
        }
        if (!svc.hasHealthcheck || svc.healthcheckDisabled) {
          addFinding(findings, pillarCounts, 'reinicio-automatico', {
            rule: 'PRONTIDAO-HEALTHCHECK-COMPOSE-AUSENTE',
            file: file.rel,
            line: svc.line,
            severity: 'media',
            message: 'Serviço do Compose sem healthcheck ativo declarado.',
            evidence: 'Healthcheck ausente ou desativado.',
          });
        }
        const externalDriver = svc.logDriver && !['json-file', 'local'].includes(svc.logDriver.toLowerCase());
        if (!externalDriver && (!svc.hasLogMaxSize || !svc.hasLogMaxFile)) {
          addFinding(findings, pillarCounts, 'alertas-logs', {
            rule: 'PRONTIDAO-LOG-SEM-ROTACAO',
            file: file.rel,
            line: svc.line,
            severity: 'media',
            message: 'Serviço Compose sem rotação de logs (logging.options.max-size e max-file).',
            evidence: 'Serviço Compose sem logging com max-size/max-file',
          });
        }
        if (!svc.hasMemLimit) {
          addFinding(findings, pillarCounts, 'disco-memoria', {
            rule: 'PRONTIDAO-LIMITE-MEMORIA-AUSENTE',
            file: file.rel,
            line: svc.line,
            severity: 'media',
            message: 'Serviço Compose sem limite de memória (mem_limit ou deploy.resources.limits.memory).',
            evidence: 'Serviço Compose sem limite de memória',
          });
        }
        if (!svc.hasPidsLimit) {
          addFinding(findings, pillarCounts, 'disco-memoria', {
            rule: 'PRONTIDAO-LIMITE-PIDS-AUSENTE',
            file: file.rel,
            line: svc.line,
            severity: 'baixa',
            message: 'Serviço Compose sem pids_limit para conter explosão de processos.',
            evidence: 'Serviço Compose sem pids_limit',
          });
        }
        for (const env of svc.environment) {
          if (isSecretValueExposed(env.key, env.value)) {
            addSecretFinding(findings, pillarCounts, 'PRONTIDAO-SEGREDO-COMPOSE-INLINE', file.rel, env.line,
              'Possível segredo literal no environment do Compose.');
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
        const match = /^(?:export\s+)?([\w.-]+)\s*[:=]\s*(.*)$/.exec(stripYamlComment(line));
        if (match && isSecretValueExposed(match[1], match[2], !match[2].startsWith("'"))) {
          addSecretFinding(findings, pillarCounts, 'PRONTIDAO-SEGREDO-ARQUIVO-ENV', file.rel, i + 1,
            'Possível segredo em arquivo protegido.');
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
            evidence: 'Diretiva de validação de certificado TLS desabilitada.',
          });
        }
      }
    }

    const privateKeyLine = file.lines.findIndex(line => /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(line));
    if (privateKeyLine >= 0) {
      addSecretFinding(findings, pillarCounts, 'PRONTIDAO-CHAVE-PRIVADA-NO-REPOSITORIO', file.rel, privateKeyLine + 1,
        'Possível chave privada em arquivo protegido.');
    }

    if (/logrotate/i.test(file.rel) || (/\brotate\s+\d+\b/.test(lowerContent) && /\b(?:daily|weekly|maxsize|size)\b/.test(lowerContent))) {
      hasLogrotate = true;
      checksApplied.push('logrotate');
    }
    const routines = checkBackup(file, findings, pillarCounts);
    if (routines.backup) checksApplied.push('backup');
    if (routines.restore) checksApplied.push('restore-proof');
    hasBackup ||= routines.backup;
    hasRestoreProof ||= routines.restore;
    hasBackupRotation ||= routines.rotation;
    if (/(?:personal:watch|alertmanager|OnFailure=|deliverPersonalPush|sendAlert|alert_webhook|WEBHOOK_ALERT|SLACK_WEBHOOK|DISK_ALERT)/i.test(file.content)) {
      hasAlerting = true;
      checksApplied.push('alerting');
    }
    if (/(?:statfs|DISK_ALERT|diskUsedPercent|df\s+-[Ph]|docker\s+(?:system|builder)\s+prune|personal:maintenance)/i.test(file.content)) {
      hasDiskMonitoring = true;
      checksApplied.push('disk-monitor');
    }

    if (checksApplied.length > 0) {
      const fileCount = findings.length - findingsBeforeFile;
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

  const omittedSkipRows = skipped + failed - skipCoverage.length;
  if (omittedSkipRows > 0) {
    skipCoverage.push({
      tool: 'prontidao:limites', version: AUDIT_VERSION, status: failed ? 'failed' : 'skipped',
      detail: `${omittedSkipRows} registro(s) de entrada(s) omitida(s) sem linha de cobertura individual pelo limite de ${MAX_SKIP_ROWS}.`,
    });
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
        status: failed ? 'failed' : 'ok',
        detail: `Analisados ${files.length} arquivo(s) nos 6 requisitos estáticos de prontidão; ${findings.length} achado(s); ${failed} omissão(ões) por falha ou limite e ${skipped} exclusão(ões) de escopo.`,
      },
      ...requirementCoverage,
      ...fileCoverage,
      ...skipCoverage,
    ],
  };
}
