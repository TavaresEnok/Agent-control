import {constants, openSync, readSync, closeSync, fstatSync, readdirSync} from 'node:fs';
import {basename, join, relative, sep} from 'node:path';
import {passiveHeaderFacts} from './header-facts.mjs';

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
const COMPOSE_EXTERNAL_LOG_DRIVERS = new Set([
  'none', 'journald', 'syslog', 'gelf', 'fluentd', 'awslogs', 'splunk', 'etwlogs', 'gcplogs',
]);

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
const YAML_ANCHOR = /^&[\w.-]+(?:\s+|$)/;

function withoutYamlAnchor(value) {
  return value.replace(YAML_ANCHOR, '');
}

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
  const offsets = [];
  let quote = null;
  let start = 1;
  let offset = 0;
  let entryOffset = null;
  const finishEntry = end => {
    entries.push(value.slice(start, end).trim());
    offsets.push(entryOffset ?? offset);
    entryOffset = null;
  };
  for (let i = 0; ; i++) {
    if (i >= value.length) {
      const next = nextLine?.();
      if (next === undefined) return null;
      value += '\n' + next;
    }
    const ch = value[i];
    if (ch === '\n') offset++;
    if (i >= start && entryOffset === null && !/\s/.test(ch) && !',}]'.includes(ch)) entryOffset = offset;
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
        if (value.slice(start, i).trim()) finishEntry(i);
        return {entries, offsets, value};
      }
    } else if (ch === ',' && stack.length === 1) {
      finishEntry(i);
      start = i + 1;
    }
  }
}

function* composeLines(content, onIncomplete) {
  const lines = content.split(/\r?\n/);
  function* expand(text, indent, line) {
    const property = YAML_PROPERTY.exec(text);
    const value = property && withoutYamlAnchor(property[2]);
    if (value?.startsWith('{') && value !== '{}') {
      if (indent > 128) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      yield {text: `${property[1]}:`, indent, line};
      const flow = flowEntries(value);
      if (!flow) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      for (const [index, entry] of flow.entries.entries()) yield* expand(entry, indent + 2, line + flow.offsets[index]);
    } else {
      yield {text, indent, line};
    }
  }
  for (let i = 0; i < lines.length; i++) {
    let raw = stripYamlComment(lines[i]);
    if (!raw.trim()) continue;
    const line = i + 1;
    const indent = raw.search(/\S/);
    if (raw.slice(0, indent).includes('\t')) onIncomplete();
    const text = raw.trim();
    if (text === '---' && line === 1) continue;
    if (text === '...') {
      if (lines.slice(i + 1).some(rest => stripYamlComment(rest).trim())) onIncomplete();
      return;
    }
    if (/^(?:---|%|\?\s)/.test(text)) onIncomplete();
    if (text.startsWith('{')) raw = `__root__: ${text}`;
    const prop = YAML_PROPERTY.exec(raw.trim());
    const sequence = /^-\s+(.*)$/.exec(text);
    const value = withoutYamlAnchor(prop?.[2] ?? sequence?.[1] ?? '');
    if (prop && /^[{\[]/.test(value)) {
      const flow = flowEntries(value, () => i + 1 < lines.length ? stripYamlComment(lines[++i]) : undefined);
      if (!flow) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      raw = `${prop[1]}: ${flow.value}`;
    }
    if (YAML_BLOCK.test(value)) {
      const scalar = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim() && next.search(/\S/) <= indent) break;
        scalar.push(lines[++i].trimStart());
      }
      yield {text, indent, line, scalarBlock: scalar.join('\n')};
    } else {
      // Multiline quoted/plain scalars and YAML tags need a full YAML parser.
      if (/^[!&|>]/.test(value)
        || (value.startsWith('"') && !/^"(?:\\.|[^"\\])*"$/.test(value))
        || (value.startsWith("'") && !/^'(?:''|[^'])*'$/.test(value))) {
        onIncomplete();
        if (/^['"]/.test(value)) {
          // Do not reinterpret lines inside a quoted value as separate declarations.
          while (i + 1 < lines.length && (!lines[i + 1].trim() || lines[i + 1].search(/\S/) > indent)) i++;
        }
      }
      if (text.startsWith('{')) {
        const flow = flowEntries(YAML_PROPERTY.exec(raw.trim())?.[2] ?? '');
        if (!flow) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
        for (const [index, entry] of flow.entries.entries()) yield* expand(entry, indent, line + flow.offsets[index]);
      } else {
        yield* expand(raw.trim(), indent, line);
      }
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
  const serviceNames = new Set();
  const seenSettings = new Set();
  const resourceLimits = new Map();
  let rootIndent;
  let sawServices = false;

  const addEnvironment = (key, value, line, interpolate = true) => {
    if (isSecretValueExposed(key, value, interpolate)) current.environment.push({line});
  };

  const addAssignment = (item, line) => {
    const value = withoutYamlAnchor(item.trim());
    if (/^[*!&]/.test(value)) {
      onIncomplete();
      return;
    }
    const assignment = unquote(value);
    const eq = assignment.indexOf('=');
    if (eq > 0) addEnvironment(assignment.slice(0, eq).trim(), assignment.slice(eq + 1), line);
  };

  for (const {text, indent, line, scalarBlock} of composeLines(content, onIncomplete)) {
    const property = YAML_PROPERTY.exec(text);
    const key = property ? unquote(property[1]) : null;
    const value = withoutYamlAnchor(property?.[2] ?? '');
    rootIndent ??= indent;
    if (servicesIndent === null || indent <= servicesIndent) {
      if (indent !== rootIndent) continue;
      if (key === 'include') onIncomplete();
      if (!key) onIncomplete();
      servicesIndent = key === 'services' ? indent : null;
      current = null;
      serviceIndent = -1;
      if (servicesIndent !== null) {
        if (sawServices) onIncomplete();
        sawServices = true;
        if (value && value !== '{}') throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      }
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
      if (!key) {
        onIncomplete();
        continue;
      }
      if (value && value !== '{}') throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      if (serviceNames.has(key)) onIncomplete();
      serviceNames.add(key);
      current = {
        name: key, line, image: '', restart: null, hasDeployRestart: false, deployRestartCondition: null,
        hasHealthcheck: false, healthcheckDisabled: false, hasMemLimit: false, hasPidsLimit: false,
        hasVolumes: false, logDriver: null, hasLogMaxSize: false, hasLogMaxFile: false,
        hasEnvFile: false, hasSecrets: false, environment: [],
      };
      services.push(current);
      serviceIndent = indent;
      path.length = 0;
      seenSettings.clear();
      resourceLimits.clear();
      healthcheckList = [];
      continue;
    }

    const isListItem = /^-\s+/.test(text);
    while (path.length && (path.at(-1).indent > indent || (path.at(-1).indent === indent && !isListItem))) path.pop();
    const parent = path.map(part => part.key.replaceAll('.', '\0')).join('.');
    if (parent === 'environment' && isListItem) {
      addAssignment(scalarBlock ?? text.slice(1), line);
      continue;
    }
    if (parent === 'healthcheck.test' && isListItem) {
      healthcheckList.push(unquote(text.slice(1)));
      current.hasHealthcheck = ['CMD', 'CMD-SHELL'].includes(healthcheckList[0]) && healthcheckList.length > 1;
      continue;
    }
    if (!key) {
      if (!isListItem) onIncomplete();
      continue;
    }

    const setting = parent ? `${parent}.${key.replaceAll('.', '\0')}` : key.replaceAll('.', '\0');
    if (/^(?:(?:deploy|logging|healthcheck|environment)(?:\.|$)|image$|restart$|mem_limit$|pids_limit$)/.test(setting)) {
      if (seenSettings.has(setting)) onIncomplete();
      seenSettings.add(setting);
    }
    const scalar = scalarBlock?.trim() ?? unquote(value);
    if (/^(?:deploy|deploy\.resources|deploy\.resources\.limits|deploy\.restart_policy|logging|logging\.options|healthcheck)$/.test(setting)
      && value && value !== '{}' && !/^(?:null|~)$/i.test(value)) onIncomplete();
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
      case 'extends': onIncomplete(); break;
      case 'mem_limit':
      case 'deploy.resources.limits.memory':
        resourceLimits.set(setting, byteLimit(scalar));
        current.hasMemLimit = consistentLimit(resourceLimits, 'mem_limit', 'deploy.resources.limits.memory');
        break;
      case 'pids_limit':
      case 'deploy.resources.limits.pids':
        resourceLimits.set(setting, positiveInteger(scalar) ? Number(scalar) : 0);
        current.hasPidsLimit = consistentLimit(resourceLimits, 'pids_limit', 'deploy.resources.limits.pids');
        break;
      case 'volumes': current.hasVolumes = true; break;
      case 'env_file': current.hasEnvFile = true; break;
      case 'secrets': current.hasSecrets = true; break;
      case 'logging.driver': current.logDriver = /^(?:null|~)?$/i.test(value) ? null : scalar; break;
      case 'logging.options.max-size': current.hasLogMaxSize = byteLimit(scalar) > 0; break;
      case 'logging.options.max-file': current.hasLogMaxFile = positiveInteger(scalar); break;
      case 'environment':
        if (value.startsWith('[')) {
          const flow = flowEntries(value);
          if (!flow) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
          for (const [index, item] of flow.entries.entries()) addAssignment(item, line + flow.offsets[index]);
        } else if (value && value !== '{}' && !/^(?:null|~)$/i.test(value)) {
          onIncomplete();
        }
        break;
      default:
        if (parent === 'environment') {
          if (scalarBlock !== undefined || !/^(?:null|~)$/i.test(value)) addEnvironment(key, scalar, line);
        }
    }
    if (!value && scalarBlock === undefined) path.push({key, indent});
  }
  return services;
}

function positiveInteger(value) {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function byteLimit(value) {
  const parsed = /^(\d+(?:\.\d+)?)(?:[ \t]*(b|[kmgtp]b?))?$/i.exec(value);
  if (!parsed) return 0;
  const unit = parsed[2]?.[0].toLowerCase() ?? 'b';
  const bytes = Math.floor(Number(parsed[1]) * 1024 ** 'bkmgtp'.indexOf(unit));
  return Number.isSafeInteger(bytes) ? bytes : 0;
}

function consistentLimit(values, local, deploy) {
  const limit = values.get(local) ?? values.get(deploy) ?? 0;
  return limit > 0 && (!values.has(deploy) || values.get(deploy) === limit);
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

function isSecretValueExposed(key, parsedValue, interpolate = true) {
  const value = parsedValue.trim();
  if (!value || PLACEHOLDER_RE.test(value) || (interpolate && VARIABLE_REFERENCE.test(value))) return false;
  if (URL_CREDS_RE.test(value)) {
    const m = URL_CREDS_RE.exec(value);
    return Boolean(m?.[1] && !PLACEHOLDER_RE.test(m[1]) && !(interpolate && VARIABLE_REFERENCE.test(m[1])));
  }
  return SECRET_KEY_RE.test(key);
}

function checkDotenv(file, findings, pillarCounts, onIncomplete) {
  for (let i = 0; i < file.lines.length; i++) {
    const first = file.lines[i].trim();
    if (!first || first.startsWith('#')) continue;
    const assignment = /^(?:export\s+)?([\w.-]+)\s*(=|:(?=\s))(.*)$/.exec(first);
    if (!assignment) {
      onIncomplete();
      continue;
    }
    const [, key, , rawValue] = assignment;
    const initial = rawValue.trimStart();
    const line = i + 1;
    const quote = initial[0];
    let value = initial;
    if (quote && `"'\``.includes(quote)) {
      const parts = [];
      let part = initial.slice(1);
      let end = -1;
      while (true) {
        for (let j = 0; j < part.length; j++) {
          if (part[j] === '\\' && (part[j + 1] === quote || part[j + 1] === '\\')) j++;
          else if (part[j] === quote) {
            end = j;
            break;
          }
        }
        if (end !== -1 || i + 1 === file.lines.length) break;
        parts.push(part);
        part = file.lines[++i];
      }
      if (end === -1 || !/^\s*(?:#.*)?$/.test(part.slice(end + 1))) onIncomplete();
      parts.push(end === -1 ? part : part.slice(0, end));
      value = parts.join('\n');
    } else {
      value = rawValue.split(/[ \t]+#/, 1)[0].trim();
    }
    if (isSecretValueExposed(key, value, quote !== "'" && quote !== '`')) {
      addSecretFinding(findings, pillarCounts, 'PRONTIDAO-SEGREDO-ARQUIVO-ENV', file.rel, line,
        'Possível segredo em arquivo protegido.');
    }
  }
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

const PROTECTION_HEADERS = new Set([
  'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'content-security-policy',
]);

function checkProxyHeaders(file, line, proxy, headers, findings, pillarCounts) {
  const facts = passiveHeaderFacts(Object.fromEntries(headers));
  if (facts.hsts === 'absent' || facts.hsts === 'invalid') {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-HSTS-AUSENTE',
      file: file.rel, line, severity: 'media',
      message: 'Bloco ' + proxy + ' sem diretiva HSTS válida identificada.',
      evidence: 'Declaração estática de Strict-Transport-Security ausente ou inválida.',
    });
  }
  if (!facts.noSniff || !facts.antiFrame) {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-SEGURANCA-AUSENTE',
      file: file.rel, line, severity: 'baixa',
      message: 'Bloco ' + proxy + ' sem X-Content-Type-Options ou proteção contra enquadramento.',
      evidence: 'Diretivas de proteção incompletas no bloco.',
    });
  }
}

function addProxyHttpFinding(file, line, proxy, findings, pillarCounts) {
  addFinding(findings, pillarCounts, 'tls-cabecalhos', {
    rule: 'PRONTIDAO-TLS-DESATIVADO',
    file: file.rel, line, severity: 'alta',
    message: 'Bloco ' + proxy + ' em HTTP sem redirecionamento incondicional para HTTPS identificado.',
    evidence: 'Nenhum redirecionamento HTTPS incondicional no bloco.',
  });
}

function parseCaddy(content) {
  const root = {children: []};
  const stack = [root];
  let words = [];
  let line = 1;
  let startLine = 1;
  let end = 0;
  const tokens = /#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|\x60[^\x60]*\x60|[^\s"\x60][^\s]*|[^\S\n]+|\n/g;
  const finish = () => {
    if (!words.length) return;
    const parent = stack.at(-1);
    const opens = words.at(-1) === '{';
    if (opens) words.pop();
    if (words.includes('{') || words.includes('}')) {
      if (words.length !== 1 || words[0] !== '}' || opens || stack.length === 1) throw new Error('CADDY_INCOMPLETO');
      stack.pop();
    } else {
      const directive = {words, line: startLine, children: opens ? [] : null};
      parent.children.push(directive);
      if (opens) stack.push(directive);
    }
    words = [];
  };

  for (const match of content.matchAll(tokens)) {
    const token = match[0];
    if (match.index !== end) throw new Error('CADDY_INCOMPLETO');
    end += token.length;
    if (token === '\n') {
      if (stack.length > 1 || !words.at(-1)?.endsWith(',')) finish();
    } else if (!/^[#\s]/.test(token)) {
      if (!words.length) startLine = line;
      words.push(token.startsWith('\x60') ? token.slice(1, -1) : unquote(token));
    }
    line += token.split('\n').length - 1;
  }
  if (end !== content.length) throw new Error('CADDY_INCOMPLETO');
  finish();
  if (stack.length !== 1) throw new Error('CADDY_INCOMPLETO');
  return root.children;
}

function caddyAddress(raw) {
  if (/[{}*]/.test(raw)) return null;
  const address = /^(?:(https?):\/\/)?(\[[^\]]+\]|[^:/\s]*)(?::(\d+))?$/i.exec(raw);
  if (!address) return null;
  const [, scheme, host, port] = address;
  if (!host && !port) return null;
  const local = /^(?:localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(host);
  const http = scheme?.toLowerCase() === 'http' || (!scheme && port === '80');
  if (!scheme && port && port !== '80' && port !== '443') return null;
  return {http, local};
}

function checkCaddy(file, findings, pillarCounts, onIncomplete) {
  const entries = parseCaddy(file.content);
  const declarations = [];
  let globalUnknown = false;
  for (const entry of entries) {
    const [name] = entry.words;
    if (!name && entry.children) {
      if (entry.children.some(item => /^(?:import|order|servers|http_port|https_port|auto_https)$/.test(item.words[0]))) {
        globalUnknown = true;
        onIncomplete(entry.line, 'opções globais Caddy alteram a interpretação local');
      }
    } else if (name === 'import') {
      globalUnknown = true;
      onIncomplete(entry.line, 'import Caddy não expandido');
    } else if (!(entry.children && /^\(.+\)$/.test(name))) {
      declarations.push(entry);
    }
  }

  if (!declarations.length || globalUnknown) return;
  // A single site may omit its outer braces.
  const first = declarations[0];
  const sites = first.children ? declarations : [{...first, children: declarations.slice(1)}];
  if (!first.children && declarations.slice(1).some(entry => entry.children && caddyAddress(entry.words[0]) && /[.:/]/.test(entry.words[0]))) {
    onIncomplete(first.line, 'delimitação dos sites Caddy não reconhecida');
    return;
  }

  for (const {words, line, children} of sites) {
    const addresses = words.flatMap(word => word.split(',')).filter(Boolean).map(caddyAddress);
    if (!children || !addresses.length || addresses.some(address => !address)) {
      onIncomplete(line, 'endereço ou bloco de site Caddy não reconhecido');
      continue;
    }
    let redirect = false;
    let otherRedirect = false;
    let tlsOff = false;
    let routingUnknown = false;
    let headersUnknown = false;
    const headers = new Map();
    for (const directive of children) {
      const [name, ...args] = directive.words;
      if (name === 'tls' && args[0] === 'off') {
        tlsOff = true;
        addFinding(findings, pillarCounts, 'tls-cabecalhos', {
          rule: 'PRONTIDAO-TLS-DESATIVADO',
          file: file.rel, line: directive.line, severity: 'alta',
          message: 'Configuração Caddy declara tls off no site.',
          evidence: 'Diretiva tls off.',
        });
      }
      if (name === 'redir') {
        const conditional = /^[@/]/.test(args[0] ?? '');
        const [destination = '', status = ''] = conditional || args[0] === '*' ? args.slice(1) : args;
        const https = /^https:\/\/[^\s/?#]+/i.test(destination) && /^(?:30[1278]|permanent|temporary)?$/.test(status);
        redirect ||= https && !conditional;
        otherRedirect ||= !https;
        if (!conditional && !https && /^\{/.test(destination)) routingUnknown = true;
      }
      if (name === 'import' || /^(?:route|handle(?:_path|_errors)?|invoke)$/.test(name)) {
        routingUnknown = true;
        continue;
      }
      if (name !== 'header') continue;
      const policy = args[0] === '*' ? args.slice(1) : args;
      const rules = directive.children ?? [{words: policy}];
      if ((directive.children && policy.length) || /^[@/]/.test(policy[0] ?? '')) {
        headersUnknown = true;
        continue;
      }
      for (const rule of rules) {
        const [field = '', ...values] = rule.words;
        const key = field.replace(/^[-+>?]/, '').toLowerCase();
        if (!PROTECTION_HEADERS.has(key)) {
          if (field === '-*' || field === 'match') headersUnknown = true;
          continue;
        }
        if (field.startsWith('-')) headers.delete(key);
        else if (/^[+?]/.test(field) || values.length !== 1 || /[{}]/.test(values[0])) headersUnknown = true;
        else headers.set(key, values[0]);
      }
    }
    routingUnknown ||= redirect && otherRedirect;
    if (routingUnknown) onIncomplete(line, 'rotas ou imports Caddy exigem avaliação adicional');
    if (headersUnknown) onIncomplete(line, 'política Caddy de cabeçalhos condicional ou dinâmica');
    const publicHttp = addresses.some(address => address.http && !address.local);
    if (publicHttp && !tlsOff && !redirect && !routingUnknown) addProxyHttpFinding(file, line, 'Caddy', findings, pillarCounts);
    if ((!redirect || addresses.some(address => !address.http)) && !routingUnknown && !headersUnknown) {
      checkProxyHeaders(file, line, 'Caddy', headers, findings, pillarCounts);
    }
  }
}

function parseNginx(content) {
  const root = {name: '', args: [], line: 1, children: [], directives: []};
  const stack = [root];
  const tokens = /#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\$\{[^}\s]+\}|\\[\s\S]|[^\s;{}#'"\\$]+|[;{}$]|\s+/g;
  let directive = [];
  let word = '';
  let line = 1;
  let directiveLine = 1;
  let end = 0;
  const finishWord = () => {
    if (word) directive.push(unquote(word));
    word = '';
  };

  for (const match of content.matchAll(tokens)) {
    const token = match[0];
    if (match.index !== end) throw new Error('NGINX_INCOMPLETO');
    end += token.length;
    if (token.startsWith('#') || /^\s/.test(token)) {
      finishWord();
    } else if (token === '{' || token === '}' || token === ';') {
      finishWord();
      const [name, ...args] = directive;
      const parent = stack.at(-1);
      if (token === '{' && name) {
        const block = {name, args, line: directiveLine, children: [], directives: []};
        parent.children.push(block);
        stack.push(block);
      } else if (token === '}' && !name && stack.length > 1) {
        stack.pop();
      } else if (token === ';' && name) {
        parent.directives.push({name, args, line: directiveLine});
      } else {
        throw new Error('NGINX_INCOMPLETO');
      }
      directive = [];
    } else {
      if (!directive.length && !word) directiveLine = line;
      word += token;
    }
    line += token.split('\n').length - 1;
  }
  if (end !== content.length || word || directive.length || stack.length !== 1) throw new Error('NGINX_INCOMPLETO');
  return root;
}

function nginxHeaderPolicy(block, inherited, onIncomplete) {
  const local = new Map();
  let replaces = false;
  let mode = inherited.mode;
  let unknown = inherited.unknown;
  let external = inherited.external;
  for (const {name, args, line} of block.directives) {
    const [field, value] = args;
    if (name === 'include' || /^more_(?:set|clear)_headers$/.test(name)) {
      onIncomplete(line, 'diretiva Nginx de política externa ou não resolvida');
      unknown = true;
      external ||= name === 'include';
    } else if (name === 'add_header_inherit') {
      if (args.length === 1 && /^(?:on|off|merge)$/.test(field)) mode = field;
      else {
        onIncomplete(line, 'modo de herança Nginx não reconhecido');
        unknown = true;
      }
    } else if (name === 'add_header') {
      replaces = true;
      const key = field?.toLowerCase();
      if (PROTECTION_HEADERS.has(key)) {
        if (value === undefined || /\$/.test(value)) {
          onIncomplete(line, 'valor dinâmico ou inválido em add_header Nginx');
          unknown = true;
        } else {
          local.set(key, [...(local.get(key) ?? []), value]);
        }
      }
    }
  }
  const headers = new Map(mode === 'merge' || (mode === 'on' && !replaces) ? inherited.headers : []);
  for (const [key, values] of local) headers.set(key, [...values, ...(headers.get(key) ?? [])]);
  return {headers, mode, unknown, external};
}

function checkNginx(file, findings, pillarCounts, onIncomplete) {
  const root = parseNginx(file.content);
  const initial = {headers: new Map(), mode: 'on', unknown: false, external: false};
  const protocolAt = (block, inherited) => block.directives.find(item => item.name === 'ssl_protocols') ?? inherited;
  const checkHeaders = (block, policy, server, parentHeaders) => {
    if (!policy.unknown) {
      // Identical effective declarations need only one finding, at the enclosing block.
      const headers = JSON.stringify([...policy.headers]);
      if (server || headers !== parentHeaders) checkProxyHeaders(file, block.line, 'Nginx', policy.headers, findings, pillarCounts);
      parentHeaders = headers;
    }
    for (const child of block.children) {
      if (child.name === 'location' || child.name === 'if') {
        checkHeaders(child, nginxHeaderPolicy(child, policy, onIncomplete), false, parentHeaders);
      }
    }
  };
  const checkServer = (server, parentPolicy, parentProtocol) => {
    const policy = nginxHeaderPolicy(server, parentPolicy, onIncomplete);
    const protocol = protocolAt(server, parentProtocol);
    const listeners = server.directives.filter(item => item.name === 'listen');
    const rewriteDirectives = server.directives.filter(item => /^(?:rewrite|return)$/.test(item.name));
    const redirect = rewriteDirectives.find(item => item.name === 'return');
    const redirectsHttps = /^30[1278]$/.test(redirect?.args[0] ?? '') && /^https:\/\/.+/i.test(redirect?.args[1] ?? '');
    const routingUnknown = policy.external || rewriteDirectives[0]?.name === 'rewrite'
      || (redirect && server.children.some(child => child.name === 'if'));
    let https = false;
    if (!listeners.length) onIncomplete(server.line, 'endereço Nginx implícito, depende da instalação');
    for (const {args, line} of listeners) {
      const port = /^(?:(?:\[[^\]]+\]|[^:\s]+):)?(\d+)$/.exec(args[0] ?? '')?.[1];
      if (args.includes('ssl') && !args.includes('quic')) https = true;
      else if (!port || port === '443' || args.includes('quic')) onIncomplete(line, 'tipo de listener Nginx não inferido com segurança');
      else if (port === '80') {
        if (routingUnknown) onIncomplete(line, 'redirecionamento Nginx depende de reescrita ou configuração adicional');
        else if (!redirectsHttps) addProxyHttpFinding(file, line, 'Nginx', findings, pillarCounts);
      }
    }
    const localProtocol = server.directives.includes(protocol);
    if (https && (localProtocol || !policy.external)
      && protocol?.args.some(arg => /^(?:SSLv2|SSLv3|TLSv1(?:\.0|\.1)?)$/i.test(arg))) {
      addFinding(findings, pillarCounts, 'tls-cabecalhos', {
        rule: 'PRONTIDAO-TLS-PROTOCOLO-FRACO',
        file: file.rel, line: localProtocol ? protocol.line : server.line, severity: 'alta',
        message: 'Bloco HTTPS Nginx declara ou herda protocolo TLS/SSL legado.',
        evidence: 'Diretiva ssl_protocols com protocolo legado.',
      });
    }
    if (https) checkHeaders(server, policy, true);
  };
  const rootPolicy = nginxHeaderPolicy(root, initial, onIncomplete);
  let foundServer = false;
  for (const block of root.children) {
    if (block.name === 'server') {
      foundServer = true;
      checkServer(block, rootPolicy, protocolAt(root));
    }
    if (block.name === 'http') {
      const policy = nginxHeaderPolicy(block, rootPolicy, onIncomplete);
      for (const server of block.children.filter(child => child.name === 'server')) {
        foundServer = true;
        checkServer(server, policy, protocolAt(block));
      }
    }
  }
  if (!foundServer && (root.children.length || root.directives.length) && !rootPolicy.external) {
    onIncomplete(1, 'contexto HTTP dos blocos Nginx não encontrado no arquivo');
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
  return {writesFileLog: [...logs.values()].some(value => /^(?:file|append|truncate):/i.test(value))};
}

const CRON_FIELDS = [
  [/^\d{1,2}$/, 0, 59],
  [/^\d{1,2}$/, 0, 23],
  [/^\d{1,2}$/, 1, 31],
  [/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2})$/i, 1, 12],
  [/^(?:sun|mon|tue|wed|thu|fri|sat|\d{1,2})$/i, 0, 7],
];

function cronCommand(text, systemCron) {
  const macro = /^@(?:reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)\s+(.+)$/.exec(text);
  const schedule = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(text);
  const validField = (field, index) => {
    const [syntax, min, max] = CRON_FIELDS[index];
    return field.split(',').every(part => {
      const [range, step, extra] = part.split('/');
      if (extra !== undefined || (step !== undefined && !positiveInteger(step))) return false;
      if (range === '*') return true;
      const bounds = range.split('-');
      return bounds.length <= 2 && bounds.every(bound => syntax.test(bound)
        && (!/^\d/.test(bound) || (Number(bound) >= min && Number(bound) <= max)));
    });
  };
  const command = macro?.[1] ?? (schedule?.slice(1, 6).every(validField) ? schedule[6] : undefined);
  return systemCron ? /^\w[\w.-]*\s+(.+)$/.exec(command ?? '')?.[1] : command;
}

// Count executable declarations only. Documentation and command arguments alone are not evidence of a routine.
function* operationalCommands(file, onIncomplete) {
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
  const systemCron = /(?:^|\/)cron\.d\/[^/]+$/.test(file.rel) || /(?:^|\/)etc\/crontab$/.test(file.rel);
  const userCron = /(?:^|\/)(?:crontab|[^/]+\.crontab|(?:crontabs|spool\/cron)\/[^/]+)$/.test(file.rel);
  if (!shell && !systemCron && !userCron) return;
  let heredoc;
  let pending = '';
  let start = 1;
  for (const [index, raw] of file.lines.entries()) {
    if (heredoc) {
      if (raw.trimStart() === heredoc) heredoc = undefined;
      continue;
    }
    const text = raw.trim();
    if (!text || text.startsWith('#')) continue;
    if (systemCron || userCron) {
      if (/^\w+\s*=/.test(text)) continue;
      const command = cronCommand(text, systemCron);
      if (command) yield {command: command.split(/(?<!\\)%/, 1)[0], line: index + 1};
      else onIncomplete(index + 1, 'declaração cron não reconhecida');
      continue;
    }
    if (!pending) start = index + 1;
    if (/(?<!\\)(?:\\\\)*\\$/.test(text)) {
      pending += text.slice(0, -1) + ' ';
      continue;
    }
    const command = pending + text;
    pending = '';
    heredoc = /(?:^|\s)<<-?\s*(['"]?)([\w-]+)\1(?:\s|$)/.exec(command)?.[2];
    yield {command, line: start};
  }
  if (pending || heredoc) onIncomplete(start, 'declaração de shell incompleta');
}

// Literal command words and redirections. Expansion, shell control flow and scripts invoked
// indirectly stay outside the static proof.
function shellWords(command) {
  const tokens = /#[^\r\n]*|(?:\d*>>?|[|;&<>])[&|]?|(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s"'\\|;&<>])+|\s+/gy;
  const words = [];
  let operator = false;
  while (tokens.lastIndex < command.length) {
    const token = tokens.exec(command)?.[0];
    if (!token) return null;
    if (token.startsWith('#')) break;
    if (/^\s/.test(token)) continue;
    if (/[|;&<>]/.test(token[0]) || /^\d+>/.test(token)) {
      operator ||= !/^1?>>?$/.test(token) && !/^2>>?$/.test(token);
      words.push({text: token, operator: true});
    } else {
      words.push({text: token.replace(/"(?:\\.|[^"\\])*"|'[^']*'|\\./g, part =>
        part.startsWith('\\') ? part.slice(1) : part.slice(1, -1))});
    }
  }
  return {words, operator};
}

function dumpDestination(binary, words) {
  for (const [index, word] of words.entries()) {
    if (word.operator && /^1?>>?$/.test(word.text)) return words[index + 1]?.text;
    const pattern = {
      pg_dump: /^(?:-f(.*)|--file(?:=(.*))?)$/,
      mysqldump: /^(?:-r(.*)|--result-file(?:=(.*))?)$/,
      mongodump: /^(?:--out(?:=(.*))?|--archive=(.*))$/,
    }[binary];
    const option = !word.operator && pattern.exec(word.text);
    if (option) return option[1] || option[2] || words[index + 1]?.text;
  }
}

function resticCommand(args) {
  let first = 0;
  while (args[first]?.startsWith('-')) {
    const option = args[first++];
    if (/^(?:--no-lock|--quiet|-q)$/.test(option)) continue;
    if (/^(?:-r|--repo|--repository-file|-p|--password-file)(?:=.+)?$/.test(option)) {
      if (!option.includes('=')) first++;
    } else {
      return args;
    }
  }
  return args.slice(first);
}

function checkBackup(file, findings, pillarCounts, onIncomplete) {
  let backup = false;
  let restore = false;
  let catalog = false;
  let rotation = false;
  for (const {command, line} of operationalCommands(file, onIncomplete)) {
    const shell = /^(?:\S*\/)?(?:ba|da|k|z)?sh\s+-[a-z]*c\s+(.+)$/i.exec(command);
    const invocation = shell ? unquote(shell[1]) : command;
    const candidates = /\b(?:pg_dump|mysqldump|mongodump|pg_restore|restic|borg|sqlite3|personal:(?:backup|restore)|personal-(?:backup|restore)|find)\b/;
    if (!candidates.test(invocation)) continue;
    const parsed = shellWords(invocation);
    if (!parsed) {
      onIncomplete(line, 'comando de backup ou restauração com sintaxe não coberta');
      continue;
    }
    const words = [...parsed.words];
    while (!words[0]?.operator && /^(?:exec|command|(?:\S*\/)?env|[\w]+=.*)$/.test(words[0]?.text ?? '')) words.shift();
    const binary = basename(words.shift()?.text ?? '');
    const args = words.filter(word => !word.operator).map(word => word.text);
    const [subcommand, ...parameters] = binary === 'restic' ? resticCommand(args) : args;
    const routine = ['npm', 'pnpm'].includes(binary) && /^run(?:-script)?$/.test(subcommand ?? '')
      ? /^personal:(backup(?:-rotate)?|restore-(?:check|proof))$/.exec(parameters[0] ?? '')?.[1]
      : binary === 'node' ? /^personal-(backup(?:-rotate)?|restore-(?:check|proof))(?:\.[cm]?js)?$/.exec(basename(subcommand ?? ''))?.[1] : undefined;
    if (parsed.operator || (['restic', 'borg'].includes(binary) && subcommand?.startsWith('-'))) {
      onIncomplete(line, 'comando composto ou opções globais exigem avaliação adicional');
      continue;
    }
    if (args.some(arg => /^(?:--help|--version|-h)$/.test(arg))) continue;

    const dump = /^(?:pg_dump|mysqldump|mongodump)$/.test(binary);
    if (dump || routine === 'backup'
      || (binary === 'restic' && subcommand === 'backup')
      || (binary === 'borg' && subcommand === 'create')
      || (binary === 'sqlite3' && args.some(arg => /^\.backup(?:\s|$)/.test(arg)))) {
      backup = true;
    }
    if (dump) {
      const destination = dumpDestination(binary, words);
      if (destination && /^(?:\$|~)/.test(destination)) {
        onIncomplete(line, 'destino de dump depende de expansão');
      } else if (destination && destination !== '-' && (!destination.startsWith('/') || /^\/tmp(?:\/|$)/.test(destination))) {
        addFinding(findings, pillarCounts, 'backup-restauracao', {
          rule: 'PRONTIDAO-BACKUP-DESTINO-INSEGURO',
          file: file.rel, line, severity: 'media',
          message: 'Comando de backup grava saída em /tmp ou em caminho relativo ao diretório de trabalho.',
          evidence: 'Detectado destino temporário ou relativo na rotina de backup.',
        });
      }
    }
    const listOnly = binary === 'pg_restore' && args.some(arg => arg === '--list' || /^-[vl]*l[vl]*$/.test(arg));
    catalog ||= listOnly || ((binary === 'restic' || binary === 'borg') && subcommand === 'check');
    const restoresDb = binary === 'pg_restore' && !listOnly && args.some((arg, index) =>
      /^(?:-d|--dbname=).+$/.test(arg)
      || (/^(?:-d|--dbname)$/.test(arg) && args[index + 1] && !args[index + 1].startsWith('-')));
    const dryRun = args.includes('--dry-run') || (binary === 'borg' && args.includes('-n'));
    if (routine === 'restore-check') onIncomplete(line, 'nome da rotina não distingue catálogo de restauração');
    restore ||= routine === 'restore-proof' || restoresDb
      || (!dryRun && ((binary === 'restic' && subcommand === 'restore' && parameters.some(arg => /^--target(?:=|$)/.test(arg)))
        || (binary === 'borg' && subcommand === 'extract')));
    rotation ||= routine === 'backup-rotate'
      || (!dryRun && ((binary === 'restic' && subcommand === 'forget' && parameters.length > 0)
        || (binary === 'borg' && subcommand === 'prune')))
      || (binary === 'find' && /-mtime\s+\+\d+\s+.*-delete|-mtime\s+\+\d+\s+-delete/.test(invocation));
  }
  return {backup, restore, catalog, rotation};
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
  let hasCatalogCheck = false;
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
        for (const {line} of svc.environment) {
          addSecretFinding(findings, pillarCounts, 'PRONTIDAO-SEGREDO-COMPOSE-INLINE', file.rel, line,
            'Possível segredo literal no environment do Compose.');
        }
        if (incomplete) continue;
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
        const driver = svc.logDriver?.toLowerCase() ?? 'json-file';
        if (!['json-file', 'local'].includes(driver) && !COMPOSE_EXTERNAL_LOG_DRIVERS.has(driver)) {
          recordSkip('failed', file.rel, `linha ${svc.line}, política de rotação de driver Compose não reconhecida`);
        } else if (!COMPOSE_EXTERNAL_LOG_DRIVERS.has(driver) && (!svc.hasLogMaxSize || !svc.hasLogMaxFile)) {
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
      }
    }

    const proxy = isCaddyFile(file.rel) ? 'Caddy' : isNginxFile(file.rel) ? 'Nginx' : null;
    if (proxy) {
      hasDeployable = true;
      if (tlsAnchorFile === null) tlsAnchorFile = file.rel;
      let incomplete = false;
      const onIncomplete = (line, reason) => {
        incomplete = true;
        recordSkip('failed', file.rel, `linha ${line}, ${reason}`);
      };
      try {
        const check = proxy === 'Caddy' ? checkCaddy : checkNginx;
        check(file, findings, pillarCounts, onIncomplete);
      } catch {
        onIncomplete(1, `sintaxe ${proxy} inválida ou não coberta`);
      }
      if (!incomplete) checksApplied.push(`${proxy.toLowerCase()}-tls-headers`);
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
      let incomplete = false;
      checkDotenv(file, findings, pillarCounts, () => { incomplete = true; });
      if (incomplete) recordSkip('failed', file.rel, 'sintaxe dotenv inválida ou não coberta');
      else checksApplied.push('env-secrets');
    }

    if (!isCommittedEnv(file.rel) && isCodeOrConfig(file.rel)) {
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

    const protectedEnv = isCommittedEnv(file.rel);
    if (!protectedEnv && (/logrotate/i.test(file.rel) || (/\brotate\s+\d+\b/.test(lowerContent) && /\b(?:daily|weekly|maxsize|size)\b/.test(lowerContent)))) {
      hasLogrotate = true;
      checksApplied.push('logrotate');
    }
    const routines = checkBackup(file, findings, pillarCounts,
      (line, reason) => recordSkip('failed', file.rel, `linha ${line}, ${reason}`));
    if (routines.backup) checksApplied.push('backup');
    if (routines.restore) checksApplied.push('restore-declaration');
    if (routines.catalog) checksApplied.push('backup-catalog-check');
    hasBackup ||= routines.backup;
    hasRestoreProof ||= routines.restore;
    hasCatalogCheck ||= routines.catalog;
    hasBackupRotation ||= routines.rotation;
    if (!protectedEnv && /(?:personal:watch|alertmanager|OnFailure=|deliverPersonalPush|sendAlert|alert_webhook|WEBHOOK_ALERT|SLACK_WEBHOOK|DISK_ALERT)/i.test(file.content)) {
      hasAlerting = true;
      checksApplied.push('alerting');
    }
    if (!protectedEnv && /(?:statfs|DISK_ALERT|diskUsedPercent|df\s+-[Ph]|docker\s+(?:system|builder)\s+prune|personal:maintenance)/i.test(file.content)) {
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
        message: 'Nenhuma rotina que restaure dados em um destino foi identificada no repositório.',
        evidence: 'Verificações de catálogo ou de integridade não demonstram restauração dos dados.',
      });
    }
    if (hasBackup && !hasBackupRotation) {
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
        evidence: 'StandardOutput ou StandardError com file:, append: ou truncate: sem configuração logrotate.',
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
      detail: `Backup e restauração (configuração estática no repositório): scriptBackup=${hasBackup ? 'declarado' : 'ausente'}, checagemCatalogo=${hasCatalogCheck ? 'declarada' : 'ausente'}, rotinaRestauracao=${hasRestoreProof ? 'declarada' : 'ausente'}; restauração real não comprovada por configuração; ${pillarCounts['backup-restauracao']} achado(s).`,
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
