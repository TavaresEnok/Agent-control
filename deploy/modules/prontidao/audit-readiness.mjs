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

const YAML_PROPERTY = /^(?:("(?:\\.|[^"\\])*"|'(?:''|[^'])*')\s*:|([A-Za-z0-9_.-]+|<<)\s*:(?=\s|$))\s*(.*)$/s;
const YAML_FLOW_PROPERTY = /^(?:("(?:\\.|[^"\\])*"|'(?:''|[^'])*')\s*:|([A-Za-z0-9_.-]+|<<)\s*:(?=\s|[{}\[\]]|$))\s*(.*)$/s;
const YAML_BLOCK = /^[|>](?:[+-]?[1-9]?|[1-9][+-])$/;
const YAML_ANCHOR = /^&[\w.-]+(?:\s+|$)/;

function withoutYamlAnchor(value) {
  return value.replace(YAML_ANCHOR, '');
}

function yamlProperty(text, flow) {
  const match = (flow ? YAML_FLOW_PROPERTY : YAML_PROPERTY).exec(text);
  return match && {key: match[1] ?? match[2], value: match[3]};
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
  const endedWithNewline = lines.at(-1) === '';
  if (endedWithNewline) lines.pop();
  let rootIndent;
  function* expand(text, indent, line, inFlow = false) {
    const property = yamlProperty(text, inFlow);
    const value = property && withoutYamlAnchor(property.value);
    if (value?.startsWith('{') && value !== '{}') {
      if (indent > 128) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      yield {key: property.key, value: '', text, indent, line};
      const flow = flowEntries(value);
      if (!flow) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      for (const [index, entry] of flow.entries.entries()) yield* expand(entry, indent + 2, line + flow.offsets[index], true);
    } else {
      yield {key: property?.key, value, text, indent, line};
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
    rootIndent ??= indent;
    if (/^(?:---|%|\?\s)/.test(text)) onIncomplete();
    if (text.startsWith('{')) raw = `__root__: ${text}`;
    const prop = yamlProperty(raw.trim());
    const sequence = /^-\s+(.*)$/.exec(text);
    const value = withoutYamlAnchor(prop?.value ?? sequence?.[1] ?? '');
    if (prop && /^[{\[]/.test(value)) {
      const flow = flowEntries(value, () => i + 1 < lines.length ? stripYamlComment(lines[++i]) : undefined);
      if (!flow) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
      raw = `${prop.key}: ${flow.value}`;
    }
    if (indent === rootIndent && prop && unquote(prop.key).startsWith('x-')) {
      // Root extensions are metadata. Aliases and merges in services are checked at their use sites.
      while (i + 1 < lines.length) {
        const next = stripYamlComment(lines[i + 1]);
        const nextIndent = next.search(/\S/);
        if (nextIndent >= 0 && nextIndent <= indent && !(nextIndent === indent && /^-\s/.test(next.trimStart()))) break;
        i++;
      }
      yield {key: prop.key, text, indent, line};
      continue;
    }
    if (YAML_BLOCK.test(value)) {
      let scalar = '';
      let scalarIndent = Number(/\d/.exec(value)?.[0]) + indent;
      let written = false;
      let unresolved = false;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextIndent = next.search(/[^ ]/);
        if (nextIndent >= 0 && nextIndent <= indent) break;
        i++;
        if (nextIndent >= 0) {
          if (Number.isNaN(scalarIndent)) scalarIndent = nextIndent;
          if (nextIndent < scalarIndent) onIncomplete();
          if (value.startsWith('>') && written) unresolved = true;
          written = true;
        }
        if (nextIndent >= 0 || Number.isFinite(scalarIndent)) scalar += next.slice(scalarIndent);
        if (i < lines.length - 1 || endedWithNewline) scalar += '\n';
      }
      if (value.includes('-')) scalar = scalar.replace(/\n+$/, '');
      else if (!value.includes('+')) scalar = written ? scalar.replace(/\n+$/, '\n') : '';
      yield {key: prop?.key, value, text, indent, line, scalarBlock: scalar, scalarUnresolved: unresolved};
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
        const flow = flowEntries(yamlProperty(raw.trim())?.value ?? '');
        if (!flow) throw new Error('COMPOSE_ESTRUTURA_INVALIDA');
        for (const [index, entry] of flow.entries.entries()) yield* expand(entry, indent, line + flow.offsets[index], true);
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

  for (const {key: rawKey, value: rawValue, text, indent, line, scalarBlock, scalarUnresolved} of composeLines(content, onIncomplete)) {
    const key = rawKey === undefined ? null : unquote(rawKey);
    const value = rawValue ?? '';
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
    if (key === '<<' || value.startsWith('*')) {
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
      if (scalarUnresolved) onIncomplete();
      else addAssignment(scalarBlock ?? text.slice(1), line);
      continue;
    }
    if (parent === 'healthcheck.test' && isListItem) {
      if (scalarUnresolved) onIncomplete();
      healthcheckList.push(scalarBlock ?? unquote(text.slice(1)));
      current.hasHealthcheck = ['CMD', 'CMD-SHELL'].includes(healthcheckList[0]) && healthcheckList.length > 1;
      continue;
    }
    if (!key) {
      if (!isListItem) onIncomplete();
      continue;
    }

    const setting = parent ? `${parent}.${key.replaceAll('.', '\0')}` : key.replaceAll('.', '\0');
    if (/^(?:(?:deploy|logging|healthcheck|environment)(?:\.|$)|image$|restart$|mem_limit$|pids_limit$)/.test(setting)) {
      const extension = key.startsWith('x-') && parent !== 'environment';
      if (seenSettings.has(setting) || (scalarUnresolved && !extension)) onIncomplete();
      seenSettings.add(setting);
    }
    const literal = scalarBlock ?? unquote(value);
    const scalar = scalarBlock?.trim() ?? literal;
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
      case 'logging.driver': current.logDriver = /^(?:null|~)?$/i.test(value) ? null : literal; break;
      case 'logging.options.max-size':
        current.hasLogMaxSize = !/[\t\r\n]| {2}/.test(literal) && byteLimit(literal.replace(/([kmgtp])ib$/i, '$1b')) > 0;
        break;
      case 'logging.options.max-file': current.hasLogMaxFile = positiveInteger(literal.replace(/^\+/, '')); break;
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
const HTTPS_REDIRECT_STATUSES = /^(?:301|302|303|307|308)$/;
const NGINX_HEADER_STATUSES = new Set([200, 201, 204, 206, 301, 302, 303, 304, 307, 308]);
const NGINX_SLASH_REDIRECT_HANDLERS = new Set([
  'proxy_pass', 'fastcgi_pass', 'uwsgi_pass', 'scgi_pass', 'memcached_pass', 'grpc_pass',
]);

function httpsDestination(value, proxy) {
  if (!/^https:\/\//i.test(value ?? '') || /[\s\\\x00-\x1f\x7f<>"\x60]|%(?![\da-f]{2})/i.test(value)) return false;
  const substitutions = proxy === 'Caddy'
    ? {
        host: 'fixture.invalid', 'http.request.host': 'fixture.invalid',
        hostport: 'fixture.invalid:443', 'http.request.hostport': 'fixture.invalid:443',
        uri: '/path', 'http.request.uri': '/path',
      }
    : {host: 'fixture.invalid', request_uri: '/path', uri: '/path', server_port: '443'};
  const placeholder = proxy === 'Caddy' ? /\{([\w.]+)\}/g : /\$(?:\{(\w+)\}|(\w+))/g;
  const expanded = value.replace(placeholder, (match, first, second) => {
    const name = first ?? second;
    return Object.hasOwn(substitutions, name) ? substitutions[name] : match;
  });
  // URL normalizes forms such as empty ports and extra slashes. Require an explicit authority first.
  const authority = /^https:\/\/([^/?#]+)/i.exec(expanded)?.[1];
  const candidate = expanded.replace(placeholder, 'fixture.invalid');
  if (!authority || /[{}]/.test(candidate)) return false;
  if (authority.match(placeholder)) return null;
  if (!/^(?:[^:[\]@]*(?::[^:[\]@]*)?@)?(?:\[[^\]]+\]|[^:[\]@]+)(?::\d+)?$/.test(authority)
    || !URL.canParse(candidate)) return false;
  return expanded === candidate ? true : null;
}

function checkProxyHeaders(file, line, proxy, headers, findings, pillarCounts) {
  const facts = passiveHeaderFacts(Object.fromEntries(headers));
  if (facts.hsts === 'absent' || facts.hsts === 'invalid') {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-CABECALHO-HSTS-AUSENTE',
      file: file.rel, line, severity: 'media',
      message: 'Bloco ' + proxy + ' sem diretiva HSTS válida identificada.',
      evidence: 'Declaração estática de Strict-Transport-Security ausente ou inválida.',
    });
  } else if (facts.hsts === 'insufficient') {
    addFinding(findings, pillarCounts, 'tls-cabecalhos', {
      rule: 'PRONTIDAO-HSTS-FRACO',
      file: file.rel, line, severity: 'media',
      message: 'Bloco ' + proxy + ' declara HSTS com duração inferior a 180 dias.',
      evidence: 'max-age abaixo do mínimo da auditoria. O valor zero desativa HSTS.',
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
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (!scheme && host && port && ![80, 443].includes(Number(port))) return null;
  const local = /^(?:localhost\.?|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(host);
  const http = scheme ? scheme.toLowerCase() === 'http' : Number(port) === 80 || (!host && Number(port) !== 443);
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
    let routingUnknown = false;
    let headersUnknown = false;
    const headers = new Map();
    const deferred = new Map();
    for (const directive of children) {
      const [name, ...args] = directive.words;
      if (name === 'tls' && args[0] === 'off') routingUnknown = true;
      if (name === 'redir') {
        const matcher = args[0] === '*' || /^[@/]/.test(args[0] ?? '');
        const conditional = matcher && args[0] !== '*' && args[0] !== '/*';
        const [destination = '', status = '', ...extra] = matcher ? args.slice(1) : args;
        const supportedStatus = !status || HTTPS_REDIRECT_STATUSES.test(status) || /^(?:permanent|temporary)$/.test(status);
        const target = httpsDestination(destination, 'Caddy');
        const https = target === true && supportedStatus && !extra.length;
        redirect ||= https && !conditional;
        otherRedirect ||= !https;
        if (extra.length || !destination || target === null || /^\{/.test(destination) || directive.children
          || (!supportedStatus && !/^\d{3}$|^html$/.test(status))) routingUnknown = true;
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
      const deferRules = rules.some(rule => /^(?:defer$|[->?])/.test(rule.words[0] ?? ''));
      for (const rule of rules) {
        const [field = '', ...values] = rule.words;
        const key = field.replace(/^[-+>?]/, '').toLowerCase();
        if (!PROTECTION_HEADERS.has(key)) {
          if ((field.startsWith('-') && field.includes('*')) || field === 'match') headersUnknown = true;
          continue;
        }
        const deletion = field.startsWith('-');
        if (/^[+?]/.test(field) || (deletion ? values.length !== 0 : values.length !== 1 || /[{}]/.test(values[0]))) {
          headersUnknown = true;
          continue;
        }
        const mutations = deferRules ? deferred : headers;
        if (mutations.has(key) && mutations.get(key) !== values[0]) headersUnknown = true;
        mutations.set(key, values[0]);
      }
    }
    for (const [key, value] of deferred) {
      if (value === undefined) headers.delete(key);
      else headers.set(key, value);
    }
    routingUnknown ||= redirect && otherRedirect;
    if (routingUnknown) onIncomplete(line, 'rotas ou imports Caddy exigem avaliação adicional');
    if (headersUnknown) onIncomplete(line, 'política Caddy de cabeçalhos condicional ou dinâmica');
    const publicHttp = addresses.some(address => address.http && !address.local);
    if (publicHttp && !redirect && !routingUnknown) addProxyHttpFinding(file, line, 'Caddy', findings, pillarCounts);
    if (addresses.some(address => !address.http) && !routingUnknown && !headersUnknown) {
      checkProxyHeaders(file, line, 'Caddy', headers, findings, pillarCounts);
    }
  }
}

function parseNginx(content) {
  const root = {name: '', args: [], line: 1, children: [], directives: [], sequence: []};
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
        const block = {name, args, line: directiveLine, children: [], directives: [], sequence: []};
        parent.children.push(block);
        parent.sequence.push(block);
        stack.push(block);
      } else if (token === '}' && !name && stack.length > 1) {
        stack.pop();
      } else if (token === ';' && name) {
        const item = {name, args, line: directiveLine};
        parent.directives.push(item);
        parent.sequence.push(item);
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

function nginxErrorPages(block, inherited, onIncomplete) {
  const declarations = block.directives.filter(item => item.name === 'error_page');
  if (!declarations.length) return inherited;
  const statuses = new Set();
  for (const {args, line} of declarations) {
    const codes = args.slice(0, -1);
    if (codes.at(-1)?.startsWith('=')) {
      if (!/^=(?:[1-5]\d\d)?$/.test(codes.pop())) {
        onIncomplete(line, 'status de substituição Nginx não reconhecido');
        return null;
      }
    }
    if (!codes.length || !args.at(-1) || !codes.every(code => /^[3-5]\d\d$/.test(code))) {
      onIncomplete(line, 'status de error_page Nginx não reconhecido');
      return null;
    }
    for (const code of codes) statuses.add(Number(code));
  }
  return statuses;
}

function nginxErrorPageAffects(statuses, status) {
  if (status === undefined) return statuses === null || statuses.size > 0;
  return status >= 300 && status !== 444 && (statuses === null || statuses.has(status));
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
      if (!field || args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== 'always')
        || (PROTECTION_HEADERS.has(key) && /\$/.test(value))) {
        onIncomplete(line, 'valor dinâmico ou inválido em add_header Nginx');
        unknown = true;
      } else if (PROTECTION_HEADERS.has(key)) {
        local.set(key, [...(local.get(key) ?? []), {value, always: args[2] === 'always'}]);
      }
    }
  }
  const headers = new Map(mode === 'merge' || (mode === 'on' && !replaces) ? inherited.headers : []);
  for (const [key, values] of local) headers.set(key, [...values, ...(headers.get(key) ?? [])]);
  return {headers, mode, unknown, external, errorPages: nginxErrorPages(block, inherited.errorPages, onIncomplete)};
}

function nginxResponse(block) {
  for (const {name, args} of block.sequence) {
    if (name === 'if' || name === 'rewrite') return {unknown: true};
    if (name === 'break') return args.length ? {unknown: true} : {};
    if (name !== 'return') continue;
    const [first, destination, ...extra] = args;
    if (extra.length || !first) return {unknown: true};
    if (/^[1-5]\d\d$/.test(first)) {
      const redirect = HTTPS_REDIRECT_STATUSES.test(first);
      const target = redirect ? httpsDestination(destination, 'Nginx') : false;
      return {
        status: Number(first),
        redirectsHttps: target === true,
        unknown: target === null || (redirect && /^\$/.test(destination ?? '')),
      };
    }
    if (destination === undefined && /^(?:https?:\/\/|\$scheme\b|\$\{scheme\})/i.test(first)) {
      const target = httpsDestination(first, 'Nginx');
      return {status: 302, redirectsHttps: target === true, unknown: target === null || first.startsWith('$')};
    }
    return {unknown: true};
  }
  return {};
}

function nginxHttpRedirect(server, policy, onIncomplete) {
  const response = nginxResponse(server);
  if (policy.external || response.unknown) return null;
  if (response.status !== undefined) {
    return nginxErrorPageAffects(policy.errorPages, response.status) ? null : response.redirectsHttps;
  }

  // Assess literal path locations. Regex and nested locations may change which block handles a request.
  const locations = server.children.filter(child => child.name === 'location');
  const paths = locations.map(({args}) => {
    if (args.length === 1 && args[0].startsWith('/')) return args[0];
    if (args.length === 2 && args[1].startsWith('/')) {
      if (args[0] === '^~') return args[1];
      if (args[0] === '=') return args.join(' ');
    }
    return null;
  });
  const pathSet = new Set(paths);
  if (pathSet.has(null) || pathSet.size !== paths.length) return null;
  if (!pathSet.has('/')) {
    return nginxErrorPageAffects(policy.errorPages, 404) ? null : false;
  }
  const redirects = locations.map((location, index) => {
    if (location.children.some(child => child.name === 'location')
      || location.directives.some(item => item.name === 'include')) return null;
    const errorPages = nginxErrorPages(location, policy.errorPages, onIncomplete);
    const internal = location.directives.some(item => item.name === 'internal');
    const path = paths[index];
    // Location lookup can append a slash before location-level rewrite directives run.
    if (!internal && path.startsWith('/') && path.length > 1 && path.endsWith('/') && !pathSet.has('= ' + path.slice(0, -1))
      && location.directives.some(item => NGINX_SLASH_REDIRECT_HANDLERS.has(item.name))) {
      return nginxErrorPageAffects(errorPages, 301) ? null : false;
    }
    const response = nginxResponse(location);
    if (response.unknown || nginxErrorPageAffects(errorPages, internal ? 404 : response.status)) return null;
    return !internal && response.redirectsHttps === true;
  });
  return redirects.includes(null) ? null : redirects.every(Boolean);
}

function nginxPort(address = '') {
  const port = /^(?:(?:\[[^\]]+\]|[\w.*-]+):)?(\d+)$/.exec(address)?.[1];
  if (port !== undefined) return Number(port) > 0 && Number(port) <= 65535 ? Number(port) : null;
  if (/^(?:\*|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:]+\])$/i.test(address)) return 80;
  return null;
}

function nginxHeadersForStatus(headers, status) {
  const active = new Map();
  for (const [key, declarations] of headers) {
    const values = declarations.filter(({always}) => always || status === undefined || NGINX_HEADER_STATUSES.has(status))
      .map(({value}) => value).filter(Boolean);
    if (values.length) active.set(key, values);
  }
  return active;
}

function checkNginx(file, findings, pillarCounts, onIncomplete) {
  const root = parseNginx(file.content);
  const initial = {headers: new Map(), mode: 'on', unknown: false, external: false, errorPages: new Set()};
  const protocolAt = (block, inherited) => block.directives.find(item => item.name === 'ssl_protocols') ?? inherited;
  const checkHeaders = (block, policy, parentHeaders) => {
    const response = nginxResponse(block);
    const errorPage = nginxErrorPageAffects(policy.errorPages, response.status);
    if (!policy.unknown) {
      if (response.unknown && response.status === undefined) {
        onIncomplete(block.line, 'fluxo da resposta Nginx depende de condição ou reescrita');
      }
      const headers = nginxHeadersForStatus(policy.headers, response.status);
      const signature = JSON.stringify([...headers]);
      if (errorPage) {
        onIncomplete(block.line, 'página de erro pode trocar o contexto dos cabeçalhos Nginx');
      } else if (response.status !== 444) {
        if (signature !== parentHeaders) checkProxyHeaders(file, block.line, 'Nginx', headers, findings, pillarCounts);
        parentHeaders = signature;
      }
      const facts = passiveHeaderFacts(Object.fromEntries(headers));
      if (response.status === undefined && policy.headers.size
        && JSON.stringify(facts) !== JSON.stringify(passiveHeaderFacts(Object.fromEntries(nginxHeadersForStatus(policy.headers, 404))))) {
        onIncomplete(block.line, 'cabeçalhos Nginx sem always dependem do status da resposta');
      }
    }
    if (response.status !== undefined && !response.unknown && !policy.external && !errorPage) return;
    for (const child of block.children) {
      if (child.name === 'location' || child.name === 'if') {
        checkHeaders(child, nginxHeaderPolicy(child, policy, onIncomplete), parentHeaders);
      }
    }
  };
  const checkServer = (server, parentPolicy, parentProtocol, tlsPorts, contextUsesLegacySsl) => {
    const policy = nginxHeaderPolicy(server, parentPolicy, onIncomplete);
    const protocol = protocolAt(server, parentProtocol);
    const listeners = server.directives.filter(item => item.name === 'listen');
    const legacySsl = contextUsesLegacySsl || server.directives.some(item => item.name === 'ssl');
    let https = false;
    if (!listeners.length) onIncomplete(server.line, 'endereço Nginx implícito, depende da instalação');
    for (const {args, line} of listeners) {
      const port = nginxPort(args[0]);
      if (port === null || args.includes('quic') || legacySsl) onIncomplete(line, 'tipo de listener Nginx não inferido com segurança');
      else if (args.includes('ssl')) https = true;
      else if (tlsPorts.has(port)) onIncomplete(line, 'listener Nginx pode compartilhar a configuração TLS da porta');
      else {
        const redirect = nginxHttpRedirect(server, policy, onIncomplete);
        if (redirect === null) onIncomplete(line, 'redirecionamento Nginx depende de reescrita ou configuração adicional');
        else if (!redirect) addProxyHttpFinding(file, line, 'Nginx', findings, pillarCounts);
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
    if (https) checkHeaders(server, policy);
  };
  const contexts = [root, ...root.children.filter(block => block.name === 'http')];
  let foundServer = false;
  for (const context of contexts) {
    const policy = nginxHeaderPolicy(context, initial, onIncomplete);
    const servers = context.children.filter(child => child.name === 'server');
    const contextUsesLegacySsl = context.directives.some(item => item.name === 'ssl');
    const tlsPorts = new Set();
    for (const server of servers) {
      for (const {name, args} of server.directives) {
        if (name === 'listen' && args.includes('ssl')) tlsPorts.add(nginxPort(args[0]));
      }
    }
    foundServer ||= servers.length > 0;
    for (const server of servers) checkServer(server, policy, protocolAt(context), tlsPorts, contextUsesLegacySsl);
  }
  if (!foundServer && root.sequence.length && !root.directives.some(item => item.name === 'include')) {
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

const SHELL_CONTINUATION = /(?<!\\)(?:\\\\)*\\$/;

function shellHeredocs(parsed) {
  const docs = [];
  for (const [position, word] of parsed.words.entries()) {
    if (!word.operator || !/^\d*<<-?$/.test(word.text)) continue;
    const next = parsed.words[position + 1];
    if (!next?.raw || /\$['"]/.test(next.raw)) return null;
    // Spaces inside ${...} can belong to the same Bash word. A split token is unsafe as a delimiter.
    const unquoted = next.raw.replace(/"(?:\\.|[^"\\])*"|'[^']*'|\\./g, ' ');
    if (unquoted.includes('${')) return null;
    const delimiter = next.raw.replace(/"(?:\\.|[^"\\])*"|'[^']*'|\\./g, part =>
      part.startsWith('"') ? part.slice(1, -1).replace(/\\([$"\\\x60])/g, '$1')
        : part.startsWith("'") ? part.slice(1, -1) : part.slice(1));
    docs.push({delimiter, quoted: /['"\\]/.test(next.raw), stripTabs: word.text.endsWith('-')});
  }
  if (docs.length && parsed.words.some(word =>
    word.operator ? !/^\d*(?:<<-?|>>?|<)$/.test(word.text)
      : /[\x60]|\$\(/.test(word.raw) || /[()]/.test(word.raw.replace(/"(?:\\.|[^"\\])*"|'[^']*'|\\./g, '')))) return null;
  return docs;
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
  if (systemCron || userCron) {
    for (const [index, raw] of file.lines.entries()) {
      const text = raw.trim();
      if (!text || text.startsWith('#') || /^\w+\s*=/.test(text)) continue;
      const command = cronCommand(text, systemCron);
      if (command) yield {command: command.split(/(?<!\\)%/, 1)[0], line: index + 1};
      else onIncomplete(index + 1, 'declaração cron não reconhecida');
    }
    return;
  }
  if (!shell) return;
  let heredocs = [];
  let docIndex = 0;
  let bodyLine = '';
  let pending;
  let start = 1;
  // Shell delimiters must preserve literal carriage returns and physical line boundaries.
  const lines = file.content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const [index, raw] of lines.entries()) {
    const doc = heredocs[docIndex];
    if (doc) {
      const {delimiter, quoted, stripTabs} = doc;
      if (!quoted && SHELL_CONTINUATION.test(raw)) {
        bodyLine += raw.slice(0, -1);
        continue;
      }
      bodyLine += raw;
      if (bodyLine === delimiter || (stripTabs && bodyLine.replace(/^\t+/, '') === delimiter)) docIndex++;
      bodyLine = '';
      continue;
    }
    if (pending === undefined) start = index + 1;
    const continued = SHELL_CONTINUATION.test(raw);
    const command = (pending ?? '') + raw;
    const parsed = shellWords(continued ? command.slice(0, -1) : command);
    if (!parsed || command.includes('\r')) {
      onIncomplete(start, 'delimitação de shell não interpretada');
      return;
    }
    if (continued && !parsed.comment) {
      pending = command.slice(0, -1);
      continue;
    }
    pending = undefined;
    if (command.includes('<<')) {
      const docs = shellHeredocs(parsed);
      if (!docs) {
        onIncomplete(start, 'delimitador de here-doc não interpretado');
        return;
      }
      heredocs = docs;
      docIndex = 0;
    }
    if (parsed.words.length) yield {command: command.replace(/^[ \t]+/, ''), line: start};
  }
  if (pending !== undefined || heredocs[docIndex]) onIncomplete(start, 'declaração de shell incompleta');
}

// Literal command words and redirections. Expansion, shell control flow and scripts invoked
// indirectly stay outside the static proof.
function shellWords(command) {
  const tokens = /#[^\r\n]*|\d*(?:<<<|<<-?)|(?:\d*>>?|[|;&<>])[&|]?|(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^ \t\n"'\\|;&<>])+|[ \t\n]+/gy;
  const words = [];
  let operator = false;
  while (tokens.lastIndex < command.length) {
    const token = tokens.exec(command)?.[0];
    if (!token) return null;
    if (token.startsWith('#')) return {words, operator, comment: true};
    if (/^[ \t\n]/.test(token)) continue;
    if (/^\d*[|;&<>]/.test(token)) {
      operator ||= !/^1?>>?$/.test(token) && !/^2>>?$/.test(token);
      words.push({text: token, operator: true});
    } else {
      words.push({raw: token, text: token.replace(/"(?:\\.|[^"\\])*"|'[^']*'|\\./g, part =>
        part.startsWith('\\') ? part.slice(1) : part.slice(1, -1))});
    }
  }
  return {words, operator};
}

const RESTIC_SHARED_VALUE_OPTIONS = /^(?:-r|--repo|--repository-file|-p|--password-file|-H|--host|--path|--tag)$/;
const RESTIC_RESTORE_VALUE_OPTIONS = /^--(?:include|exclude|target)$/;
const RESTIC_RETENTION_COUNT = /^--keep-(?:last|hourly|daily|weekly|monthly|yearly)$/;
const RESTIC_RETENTION_WINDOW = /^--keep-within(?:-(?:hourly|daily|weekly|monthly|yearly))?$/;

// Undefined means invalid. Zero disables an individual policy and contributes no retention.
function resticRetention(name, value) {
  if (RESTIC_RETENTION_COUNT.test(name)) {
    return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) > 0 : undefined;
  }
  if (RESTIC_RETENTION_WINDOW.test(name)) {
    return /^(?=\d)(?:\d+y)?(?:\d+m)?(?:\d+d)?(?:\d+h)?$/.test(value) ? /[1-9]/.test(value) : undefined;
  }
  if (name === '--keep-tag') return value.split(',').every(tag => tag.trim()) ? true : undefined;
}

function resticRoutine(subcommand, args, onIncomplete) {
  const options = new Map();
  const retention = new Map();
  const positionals = [];
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positionalOnly || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (/^(?:--no-lock|--quiet|-q)$/.test(arg)
      || (subcommand === 'restore' ? arg === '--verify' : arg === '--prune')) continue;
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const allowed = subcommand === 'restore' ? RESTIC_RESTORE_VALUE_OPTIONS.test(name)
      : name === '--group-by' || name === '--keep-tag' || RESTIC_RETENTION_COUNT.test(name) || RESTIC_RETENTION_WINDOW.test(name);
    if (!allowed && !RESTIC_SHARED_VALUE_OPTIONS.test(name)) {
      onIncomplete();
      return false;
    }
    const value = equals === -1 ? args[++i] : arg.slice(equals + 1);
    if (!value || (equals === -1 && value.startsWith('-'))) return false;
    if (subcommand === 'forget' && name.startsWith('--keep-')) {
      if (value.includes('$')) {
        onIncomplete();
        return false;
      }
      const enabled = resticRetention(name, value);
      if (enabled === undefined) return false;
      retention.set(name, enabled);
    }
    options.set(name, value);
  }
  const snapshotId = /^[\da-f]{1,64}$/i;
  if (subcommand === 'restore') {
    const [snapshot] = positionals;
    if (positionals.length !== 1 || !options.has('--target')) return false;
    const target = options.get('--target');
    if (!target.trim()) return false;
    if (/^[$~]/.test(target)) {
      onIncomplete();
      return false;
    }
    if (snapshot === 'latest' || snapshotId.test(snapshot)) return true;
    onIncomplete();
    return false;
  }
  if (positionals.length) {
    if (positionals.every(snapshot => snapshotId.test(snapshot))) return true;
    onIncomplete();
    return false;
  }
  return [...retention.values()].includes(true);
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
    const resticDeclared = binary === 'restic' && !dryRun && /^(?:restore|forget)$/.test(subcommand ?? '')
      && resticRoutine(subcommand, parameters, () => onIncomplete(line, 'argumentos de restauração ou retenção Restic não resolvidos'));
    restore ||= routine === 'restore-proof' || restoresDb
      || (subcommand === 'restore' && resticDeclared)
      || (!dryRun && binary === 'borg' && subcommand === 'extract');
    rotation ||= routine === 'backup-rotate'
      || (subcommand === 'forget' && resticDeclared)
      || (!dryRun && binary === 'borg' && subcommand === 'prune')
      || (binary === 'find' && /-mtime\s+\+\d+\s+.*-delete|-mtime\s+\+\d+\s+-delete/.test(invocation));
  }
  return {backup, restore, catalog, rotation};
}

/** Runs all passive production-readiness checks across a repository directory. */
export function auditRepositoryReadiness(repoRoot) {
  const skipCoverage = [];
  const partialFiles = new Set();
  const partialPillars = new Set();
  let skipped = 0;
  let failed = 0;
  const recordSkip = (status, rel, reason) => {
    if (status === 'failed') {
      failed++;
      partialFiles.add(rel);
    } else skipped++;
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
  if (failed) {
    for (const pillar of Object.keys(pillarCounts)) partialPillars.add(pillar);
  }
  const recordPartial = (file, reason, ...pillars) => {
    for (const pillar of pillars) partialPillars.add(pillar);
    recordSkip('failed', file, reason);
  };

  let hasDeployable = false;
  let hasStateful = false;
  let hasBackup = false;
  let hasRestoreRoutine = false;
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
        recordPartial(file.rel, 'estrutura Compose inválida ou referência YAML não resolvida',
          'alertas-logs', 'reinicio-automatico', 'disco-memoria', 'segredos-fora-codigo');
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
        const driver = svc.logDriver;
        if (driver === 'none') {
          recordSkip('skipped', file.rel, `linha ${svc.line}, logs desativados para este serviço Compose`);
        } else if (COMPOSE_EXTERNAL_LOG_DRIVERS.has(driver)) {
          recordSkip('skipped', file.rel, `linha ${svc.line}, retenção de logs depende do driver externo ou do host`);
        } else if (driver !== null && driver !== 'json-file' && driver !== 'local') {
          recordPartial(file.rel, `linha ${svc.line}, política de rotação de driver Compose não reconhecida`, 'alertas-logs');
        } else if (!svc.hasLogMaxSize || !svc.hasLogMaxFile) {
          addFinding(findings, pillarCounts, 'alertas-logs', {
            rule: 'PRONTIDAO-LOG-SEM-ROTACAO',
            file: file.rel,
            line: svc.line,
            severity: 'media',
            message: 'Serviço Compose sem limites explícitos válidos para a rotação local de logs.',
            evidence: 'Confira logging.options.max-size e max-file. Padrões do driver e do host ficam fora da análise estática.',
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
        recordPartial(file.rel, `linha ${line}, ${reason}`, 'tls-cabecalhos');
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
      if (incomplete) recordPartial(file.rel, 'sintaxe dotenv inválida ou não coberta', 'segredos-fora-codigo');
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
      (line, reason) => recordPartial(file.rel, `linha ${line}, ${reason}`, 'backup-restauracao'));
    if (routines.backup) checksApplied.push('backup');
    if (routines.restore) checksApplied.push('restore-declaration');
    if (routines.catalog) checksApplied.push('backup-catalog-check');
    if (routines.rotation) checksApplied.push('backup-retention');
    hasBackup ||= routines.backup;
    hasRestoreRoutine ||= routines.restore;
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
        status: partialFiles.has(file.rel) ? 'failed' : 'ok',
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
    if (!hasRestoreRoutine) {
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
      detail: `Análise estática de TLS e cabeçalhos com ${pillarCounts['tls-cabecalhos']} achado(s). Certificados e respostas efetivas exigem evidência em execução.`,
    },
    {
      tool: 'prontidao:requisito:backup-restauracao',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Análise estática com ${pillarCounts['backup-restauracao']} achado(s). Backup ${hasBackup ? 'identificado' : 'não identificado'}, checagem de catálogo ${hasCatalogCheck ? 'identificada' : 'não identificada'}, rotina de restauração ${hasRestoreRoutine ? 'identificada' : 'não identificada'} e retenção de backup ${hasBackupRotation ? 'identificada' : 'não identificada'}. A prova de restauração requer execução e verificação dos dados restaurados.`,
    },
    {
      tool: 'prontidao:requisito:alertas-logs',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Análise estática de alertas e rotação de logs com ${pillarCounts['alertas-logs']} achado(s). Diretiva de alerta ${hasAlerting ? 'identificada' : 'não identificada'} e logrotate ${hasLogrotate ? 'identificado' : 'não identificado'}. A entrega de alertas exige verificação em execução.`,
    },
    {
      tool: 'prontidao:requisito:reinicio-automatico',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Análise estática de reinício automático e healthcheck com ${pillarCounts['reinicio-automatico']} achado(s). A disponibilidade exige observação do serviço em execução.`,
    },
    {
      tool: 'prontidao:requisito:disco-memoria',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Análise estática de disco e memória com ${pillarCounts['disco-memoria']} achado(s). Rotina de disco ${hasDiskMonitoring ? 'identificada' : 'não identificada'}. O uso de recursos exige medição no host.`,
    },
    {
      tool: 'prontidao:requisito:segredos-fora-codigo',
      version: AUDIT_VERSION,
      status: 'ok',
      detail: `Segredos fora do código (análise estática): ${pillarCounts['segredos-fora-codigo']} achado(s).`,
    },
  ].map(row => partialPillars.has(row.tool.slice('prontidao:requisito:'.length))
    ? {...row, status: 'failed', detail: `${row.detail} Cobertura parcial. Consulte os avisos por arquivo.`}
    : row);

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
