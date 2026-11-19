import {isUtf8} from 'node:buffer';
import {execFile as execFileCb} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, extname, isAbsolute, join, posix, relative, resolve, sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import semver from 'semver';
import {minimatch} from 'minimatch';
import {validateCycloneDx} from './cyclonedx.mjs';
import {fetchRegistryVersion, NPM_REGISTRY} from './fetch-registry.mjs';

const execFile = promisify(execFileCb);
const require = createRequire(import.meta.url);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 20 * 1024 * 1024;
const MAX_MANIFESTS = 50;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_FILES = 2000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_CODEMOD_TIME_MS = 600_000;
const MAX_CODEMOD_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_CODEMOD_FINDINGS = 5_000;
const MAX_SBOM_BYTES = 64 * 1024 * 1024;
const MAX_SBOM_COMPONENTS = 20_000;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  'tmp',
  '.venv',
  'venv',
  'vendor',
  'target',
]);

const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const NPM_LOCKFILE_NAMES = ['npm-shrinkwrap.json', 'package-lock.json'];
const LOCKFILE_NAMES = [...NPM_LOCKFILE_NAMES, 'yarn.lock', 'pnpm-lock.yaml'];
const SBOM_CANDIDATE_FILES = [
  '/databases/syft.cdx.json',
  '/databases/sbom.cdx.json',
  '/input/syft.cdx.json',
  '/input/sbom.cdx.json',
];
const DEFAULT_REGISTRY_PATHS = [
  '/databases/dependencias/registry.json',
  join(MODULE_DIR, 'offline-registry.json'),
  '/opt/dependencias-tools/offline-registry.json',
];

const VALID_STATUS = new Set(['ok', 'failed', 'skipped']);
const VALID_SEVERITY = new Set(['alta', 'media', 'baixa', 'informativa']);
const NPM_NAME = /^(?:@[\w.~-]+\/)?[\w.~-]+$/;
const NPM_ALIAS = /^npm:((?:@[\w.~-]+\/)?[\w.~-]+)@(.+)$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Normalizes any path to a clean repository-relative POSIX path without traversal. */
export function toRepoRelPath(rawPath, fallback = 'package.json') {
  if (typeof rawPath !== 'string') return fallback;
  const cleaned = rawPath
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '')
    .replace(/\0/g, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned.split('/').includes('..')) return fallback;
  return cleaned;
}

/** Reads from the validated descriptor and keeps limits distinct from absence and I/O failure. */
async function readArtifact(filePath, maxBytes, remainingBytes = maxBytes, binary = false) {
  try {
    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return {kind: 'unreadable'};
      if (info.size > maxBytes) return {kind: 'fileLimit'};
      if (info.size > remainingBytes) return {kind: 'totalLimit'};
      const buffer = Buffer.allocUnsafe(info.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const {bytesRead} = await handle.read(buffer, bytes, buffer.length - bytes, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
      }
      if (bytes > maxBytes) return {kind: 'fileLimit'};
      if (bytes > remainingBytes) return {kind: 'totalLimit'};
      if (bytes !== info.size) return {kind: 'unreadable'};
      const content = binary ? buffer.subarray(0, bytes) : buffer.toString('utf8', 0, bytes);
      return {kind: 'ok', content, bytes};
    } finally {
      await handle.close();
    }
  } catch (err) {
    return {kind: err?.code === 'ENOENT' ? 'missing' : 'unreadable'};
  }
}

/** Reads a regular non-symlink file bounded by maxBytes. Returns null if rejected or missing. */
export async function readSafeRegularFile(filePath, maxBytes = MAX_FILE_BYTES) {
  return (await readArtifact(filePath, maxBytes)).content ?? null;
}

function registryVersion(registry, pkg) {
  const versions = registry?.versions;
  if (!versions || !Object.hasOwn(versions, pkg)) return {kind: 'missing'};
  const version = versions[pkg];
  return typeof version === 'string' && semver.valid(version)
    ? {kind: 'ok', version}
    : {kind: 'invalid'};
}

/** Reads installed tool version from its package.json or falls back to binary --version. */
async function resolveInstalledVersion(pkgName, fallbackBin, args = ['--version']) {
  const pkgPaths = [
    join(MODULE_DIR, 'node_modules', pkgName, 'package.json'),
    join('/opt/dependencias-tools/node_modules', pkgName, 'package.json'),
  ];
  for (const pkgPath of pkgPaths) {
    const raw = await readSafeRegularFile(pkgPath, 256 * 1024);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
          return parsed.version.trim();
        }
      } catch {
        // ignore and try next
      }
    }
  }
  if (fallbackBin) {
    try {
      const {stdout} = await execFile(fallbackBin, args, {timeout: 5000, maxBuffer: 1024 * 1024});
      const match = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/.exec(stdout);
      if (match) return match[0];
    } catch {
      // ignore
    }
  }
  return 'desconhecida';
}

/** Verifies installed tool versions in node_modules match dependencias-tools.lock.json. */
export async function verifyToolsAgainstLock(toolsRoot = MODULE_DIR) {
  const rawLock = await readSafeRegularFile(join(toolsRoot, 'dependencias-tools.lock.json'), 256 * 1024);
  if (!rawLock) {
    throw new Error('dependencias-tools.lock.json ausente ou ilegível.');
  }
  const lockMeta = JSON.parse(rawLock);
  const deps = lockMeta?.dependencies || {};
  const verified = {};
  for (const [pkgName, expected] of Object.entries(deps)) {
    const pkgPath = join(toolsRoot, 'node_modules', pkgName, 'package.json');
    const rawPkg = await readSafeRegularFile(pkgPath, 256 * 1024);
    if (!rawPkg) {
      throw new Error(`Ferramenta travada ausente em node_modules: ${pkgName}`);
    }
    const parsedPkg = JSON.parse(rawPkg);
    if (parsedPkg.version !== expected.version) {
      throw new Error(`Versão divergente para ${pkgName}: esperado ${expected.version}, instalado ${parsedPkg.version}`);
    }
    verified[pkgName] = parsedPkg.version;
  }
  return verified;
}

/** Walks repository safely, ignoring symlinks and ignored/oversized paths. */
export async function discoverRepoFiles(repoRoot) {
  const manifests = [];
  const lockfiles = new Map();
  const sourceFiles = [];
  const sbomFiles = [];
  let hasJavaProject = false;
  let skippedSymlinks = 0;
  let skippedOversized = 0;
  let skippedManifestLimit = 0;
  let skippedSourceLimit = 0;
  let skippedSourceBytes = 0;
  let sourceBytes = 0;
  let readErrors = 0;

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, {withFileTypes: true});
    } catch {
      readErrors += 1;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.includes('\0')) continue;
      const fullPath = join(currentDir, entry.name);
      let info;
      try {
        info = await lstat(fullPath);
      } catch {
        readErrors += 1;
        continue;
      }
      if (info.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (info.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(fullPath);
        continue;
      }
      if (!info.isFile()) continue;
      const rel = toRepoRelPath(relative(repoRoot, fullPath).split(sep).join(posix.sep), '');
      if (!rel) continue;

      if (entry.name === 'pom.xml' || entry.name === 'build.gradle' || entry.name === 'build.gradle.kts' || entry.name.endsWith('.java')) {
        hasJavaProject = true;
      }

      if (entry.name === 'package.json') {
        if (info.size > MAX_FILE_BYTES) {
          skippedOversized += 1;
        } else if (manifests.length < MAX_MANIFESTS) {
          manifests.push({rel, fullPath});
        } else {
          skippedManifestLimit += 1;
        }
        continue;
      }

      if (LOCKFILE_NAMES.includes(entry.name)) {
        lockfiles.set(rel, fullPath);
        if (info.size > MAX_REGISTRY_BYTES) skippedOversized += 1;
        continue;
      }

      if (entry.name === 'syft.cdx.json' || entry.name === 'sbom.cdx.json') {
        sbomFiles.push({rel, fullPath});
        if (info.size > MAX_REGISTRY_BYTES) skippedOversized += 1;
        continue;
      }

      const ext = extname(entry.name).toLowerCase();
      if (JS_TS_EXTENSIONS.has(ext)) {
        if (info.size > MAX_FILE_BYTES) {
          skippedOversized += 1;
        } else if (sourceFiles.length >= MAX_SOURCE_FILES) {
          skippedSourceLimit += 1;
        } else if (sourceBytes + info.size > MAX_SOURCE_BYTES) {
          skippedSourceBytes += 1;
        } else {
          sourceBytes += info.size;
          sourceFiles.push({rel, fullPath, ext, size: info.size});
        }
      }
    }
  }

  await walk(repoRoot);
  return {
    manifests,
    lockfiles,
    sourceFiles,
    sbomFiles,
    hasJavaProject,
    skippedSymlinks,
    skippedOversized, skippedManifestLimit, skippedSourceLimit, skippedSourceBytes, readErrors,
  };
}

/** Finds 1-based line number of a dependency key inside package.json text. */
export function findLineInPackageJson(rawText, pkgName, preferredSection = '') {
  const lines = rawText.split(/\r?\n/);
  const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(`^\\s*"${escaped}"\\s*:`);

  if (preferredSection) {
    const secEscaped = preferredSection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const secPattern = new RegExp(`^\\s*"${secEscaped}"\\s*:\\s*\\{`);
    let inSection = false;
    let braceDepth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!inSection) {
        if (secPattern.test(line)) {
          inSection = true;
          braceDepth = 1;
        }
        continue;
      }
      if (keyPattern.test(line)) return i + 1;
      for (const ch of line) {
        if (ch === '{') braceDepth += 1;
        else if (ch === '}') braceDepth -= 1;
      }
      if (braceDepth <= 0) inSection = false;
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (keyPattern.test(lines[i])) return i + 1;
  }
  return 1;
}

/** Checks if a dependency specifier is unpinned / floating without safe upper bound. */
export function isUnpinnedSpecifier(spec) {
  if (typeof spec !== 'string') return false;
  const trimmed = spec.trim().toLowerCase();
  return (
    trimmed === '*' ||
    trimmed === 'latest' ||
    trimmed === 'next' ||
    trimmed === 'x' ||
    trimmed.startsWith('>=') ||
    trimmed.startsWith('>') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('git+')
  );
}

/** Parses a strict/lenient X.Y.Z[-pre][+build] semver string. */
export function parseSemver(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Compares two parsed semver objects (-1, 0, 1). */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const len = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const left = a.pre[i];
    const right = b.pre[i];
    if (left === right) continue;
    const leftNum = /^\d+$/.test(left);
    const rightNum = /^\d+$/.test(right);
    if (leftNum && rightNum) return Number(left) < Number(right) ? -1 : 1;
    if (leftNum) return -1;
    if (rightNum) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function semverIntervals(spec) {
  if (!nonemptyString(spec) || semver.validRange(spec) === null) return [];
  const intervals = [];
  for (const comparators of new semver.Range(spec).set) {
    const range = comparators.map(comparator => comparator.value).join(' ');
    const minimum = semver.minVersion(range);
    if (!minimum) continue;
    const hasFloor = comparators.some(c => c.value && ['', '>', '>='].includes(c.operator));
    intervals.push({range, minimum, hasFloor});
  }
  return intervals;
}

function minimumOfIntervals(intervals) {
  return intervals.reduce((min, interval) => !min || semver.lt(interval.minimum, min) ? interval.minimum : min, null);
}

/** Extracts minimal concrete semver from a range specifier like ^4.17.1 or ~1.2. */
export function minVersionFromSpec(spec) {
  const min = minimumOfIntervals(semverIntervals(spec));
  return min && {major: min.major, minor: min.minor, patch: min.patch, pre: min.prerelease};
}

/** Checks if concrete version satisfies a standard npm comparator/range (^, ~, >=, <=, >, <, =, ||). */
export function satisfiesRange(versionStr, rangeSpec) {
  return Boolean(semver.valid(versionStr) && semver.validRange(rangeSpec) !== null && semver.satisfies(versionStr, rangeSpec));
}

/** Classifies update risk and module severity from current and target semver specifiers. */
export function classifySemverRisk(currentSpec, targetSpec) {
  const cur = minVersionFromSpec(String(currentSpec || ''));
  const tgt = minVersionFromSpec(String(targetSpec || ''));
  if (!cur || !tgt) {
    return {diff: 'desconhecida', severity: 'media', rule: 'NCU-OUTDATED-RANGE', riskLabel: 'moderado'};
  }
  let diff = 'outdated';
  if (cur.major !== tgt.major) diff = 'major';
  else if (cur.minor !== tgt.minor) diff = 'minor';
  else if (cur.patch !== tgt.patch) diff = 'patch';
  else if (cur.pre.length > 0 || tgt.pre.length > 0) diff = 'prerelease';

  if (diff === 'major') {
    return {diff, severity: 'alta', rule: 'NCU-OUTDATED-MAJOR', riskLabel: 'alto (mudança major)'};
  }
  if (diff === 'minor') {
    return {diff, severity: 'media', rule: 'NCU-OUTDATED-MINOR', riskLabel: 'médio (mudança minor)'};
  }
  if (diff === 'patch' || diff === 'prerelease') {
    return {diff, severity: 'baixa', rule: 'NCU-OUTDATED-PATCH', riskLabel: 'baixo (correção patch)'};
  }
  return {diff, severity: 'media', rule: 'NCU-OUTDATED-RANGE', riskLabel: 'moderado'};
}

/** Loads offline/mounted JSON registry snapshot safely. */
export async function resolveRegistrySnapshot(customPath, defaultPaths = DEFAULT_REGISTRY_PATHS) {
  const configuredPath = process.env.AC_DEPENDENCIAS_REGISTRY;
  const candidates = [
    customPath,
    configuredPath,
    ...defaultPaths,
  ].filter(Boolean);

  let fallbackError = null;
  for (const candidate of candidates) {
    const explicit = candidate === customPath || candidate === configuredPath;
    const result = candidate.includes('..') || candidate.includes('\0')
      ? {kind: 'unreadable'}
      : await readArtifact(candidate, MAX_REGISTRY_BYTES, MAX_REGISTRY_BYTES, true);
    if (result.kind === 'missing' && !explicit) continue;
    if (result.kind === 'ok' && isUtf8(result.content)) {
      try {
        const parsed = JSON.parse(result.content.toString('utf8'));
        if (isRecord(parsed)) return {path: candidate, versions: parsed};
      } catch { /* Record invalid JSON below. */ }
    }
    const error = result.kind === 'missing' ? 'registro_ausente' :
      result.kind === 'ok' ? 'registro_invalido' : 'registro_ilegivel_ou_acima_do_limite';
    const failure = {path: candidate, versions: {}, error};
    if (explicit) return failure;
    fallbackError ??= failure;
  }
  return fallbackError;
}

function ncuSpecifier(spec) {
  const alias = NPM_ALIAS.exec(spec);
  const range = alias ? alias[2] : spec;
  const intervals = semverIntervals(range);
  if (!intervals.length) return null;
  return {range, registryName: alias?.[1], intervals, minimum: minimumOfIntervals(intervals)};
}

function isForwardUpdate(current, target) {
  // A disjunction can already offer a newer release than its lowest branch.
  return current.intervals.every(({range, minimum, hasFloor}) =>
    hasFloor ? semver.gt(target.minimum, minimum) : semver.gtr(target.minimum, range));
}

function inspectNcuProposal(current, target, pkg, installation) {
  if (!target) return {reason: 'alvo_nao_comparavel'};
  if (current.registryName !== target.registryName) return {reason: 'identidade_alterada'};
  if (!isForwardUpdate(current, target)) return {reason: 'direcao_de_atualizacao_nao_comprovada'};
  if (!installation?.path) return {reason: 'lockfile_ausente'};
  if (!installation.lock?.parsed) return {reason: 'lockfile_nao_verificavel'};
  const match = inspectNpmLockEntry(installation.lock.parsed, installation.workspacePath, pkg, current);
  if (!match.version || match.linked) return {reason: match.reason ?? 'registro_inaplicavel_a_link_local'};
  if (!satisfiesRange(match.version, current.range)) return {reason: 'versao_travada_incompativel_com_declaracao'};
  return match;
}

function dependencyKey(manifest, section, pkg) {
  return JSON.stringify([manifest, section, pkg]);
}

function createOnlineReleaseLookup(get) {
  const confirmations = new Map();
  let timeLeft = TOOL_TIMEOUT_MS;

  return async (pkg, version) => {
    const release = `${pkg}@${version}`;
    if (confirmations.has(release)) return confirmations.get(release);
    if (timeLeft <= 0) return {reason: 'limite_de_tempo_do_registro_online'};

    const start = performance.now();
    const timeoutMs = Math.min(10_000, Math.ceil(timeLeft));
    const confirmation = await fetchRegistryVersion(pkg, version, {get, timeoutMs})
      .then(result => ({version: result}), err => ({error: String(err?.message ?? err).slice(0, 150)}));
    timeLeft -= performance.now() - start;
    confirmations.set(release, confirmation);
    return confirmation;
  };
}

/** Executes npm-check-updates safely on isolated copies of package.json files. */
export async function runNcuCheck({manifests, workRoot, registry, ncuBin, ncuVersion, onlineMode, lookupLock, registryGet}) {
  const coverage = [];
  const findings = [];
  const ncuDetectedPackages = new Set();

  if (manifests.length === 0) {
    coverage.push({
      tool: 'npm-check-updates',
      version: ncuVersion,
      status: 'skipped',
      detail: 'Nenhum arquivo package.json encontrado no repositório.',
    });
    return {coverage, findings, ncuDetectedPackages};
  }

  if (!onlineMode && (!registry || registry.error)) {
    coverage.push({
      tool: 'npm-check-updates',
      version: ncuVersion,
      status: 'skipped',
      detail: `modo=offline-json; motivo=${registry?.error ?? 'registro_ausente'}; prova_parcial=true`,
    });
    return {coverage, findings, ncuDetectedPackages};
  }

  let ncuRegistryPath;
  if (!onlineMode) {
    const validVersions = Object.fromEntries(Object.entries(registry.versions).filter(([, version]) => typeof version === 'string' && semver.valid(version)));
    ncuRegistryPath = join(workRoot, 'valid-registry.json');
    await writeFile(ncuRegistryPath, JSON.stringify(validVersions), 'utf8');
  }

  const ncuCfgDir = join(workRoot, 'ncu-cfg');
  await mkdir(ncuCfgDir, {recursive: true});
  const ncuCfgName = '.ncurc.json';
  await writeFile(join(ncuCfgDir, ncuCfgName), '{}\n', 'utf8');
  const ncuEnv = onlineMode
    ? Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/i.test(name)))
    : process.env;

  let totalDeps = 0;
  let totalMatched = 0;
  let totalMissing = 0;
  let totalUnsupported = 0;
  let totalOmitted = 0;
  let totalOutdated = 0;
  let toolFailed = false;
  let failMessage = '';
  const lookupRelease = onlineMode ? createOnlineReleaseLookup(registryGet) : null;

  for (let idx = 0; idx < manifests.length; idx += 1) {
    const manifest = manifests[idx];
    const raw = await readSafeRegularFile(manifest.fullPath, MAX_FILE_BYTES);
    if (raw === null) {
      coverage.push({
        tool: 'npm-check-updates',
        version: ncuVersion,
        status: 'skipped',
        detail: `arquivo=${manifest.rel}; motivo=ilegivel_ou_acima_do_limite`,
      });
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('raiz inválida');
    } catch {
      toolFailed = true;
      failMessage = `Manifesto inválido: ${manifest.rel}`;
      findings.push({
        tool: 'npm-check-updates',
        rule: 'NCU-INVALID-PACKAGE-JSON',
        file: manifest.rel,
        line: 1,
        severity: 'alta',
        message: 'Manifesto package.json inválido (erro de sintaxe JSON).',
        evidence: 'JSON.parse falhou ao ler o manifesto.',
      });
      coverage.push({
        tool: 'npm-check-updates',
        version: ncuVersion,
        status: 'failed',
        detail: `arquivo=${manifest.rel}; manifesto_invalido=true; achados=1`,
      });
      continue;
    }

    const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const invalidSections = sections.filter(sec => parsed[sec] !== undefined && (!parsed[sec] || typeof parsed[sec] !== 'object' || Array.isArray(parsed[sec]) || Object.values(parsed[sec]).some(value => typeof value !== 'string')));
    if (invalidSections.length) {
      toolFailed = true; failMessage = `Dependências inválidas: ${manifest.rel}`;
      coverage.push({tool: 'npm-check-updates', version: ncuVersion, status: 'failed', detail: `arquivo=${manifest.rel}; secoes_invalidas=${invalidSections.join(',')}`});
    }
    const sanitized = {
      name: typeof parsed.name === 'string' ? parsed.name : 'projeto',
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    };
    const depLocations = new Map();
    const registryScopes = new Set();
    const fileMissingSet = new Set();
    let fileOmitted = 0;
    let fileFailed = false;
    let fileDepCount = 0;
    let fileRegistryMatches = 0;
    let fileMissingCount = 0;
    let fileInvalidMeta = 0;
    let fileUnsupported = 0;
    function omit(pkg, section, reason) {
      fileOmitted += 1;
      totalOmitted += 1;
      coverage.push({tool: 'npm-check-updates', version: ncuVersion, status: 'skipped',
        detail: `arquivo=${manifest.rel}; pacote=${pkg}; secao=${section}; motivo=${reason}; prova_parcial=true`});
    }

    for (const sec of sections) {
      const block = parsed[sec];
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      sanitized[sec] = Object.create(null);
      for (const [pkg, spec] of Object.entries(block)) {
        if (typeof spec !== 'string') continue;
        fileDepCount += 1;
        totalDeps += 1;
        if (isUnpinnedSpecifier(spec)) {
          const line = findLineInPackageJson(raw, pkg, sec);
          findings.push({
            tool: 'npm-check-updates',
            rule: 'NCU-UNPINNED-RANGE',
            file: manifest.rel,
            line,
            severity: 'alta',
            message: `Dependência "${pkg}" usa faixa não fixada ("${spec}"), sujeita a atualizações quebradoras ou não reproduzíveis.`,
            evidence: `${sec}: "${pkg}": "${spec}"`,
          });
        }
        const current = NPM_NAME.test(pkg) ? ncuSpecifier(spec) : null;
        if (!depLocations.has(pkg)) depLocations.set(pkg, []);
        const entry = {section: sec, spec, current};
        depLocations.get(pkg).push(entry);
        if (!current) {
          fileUnsupported += 1;
          totalUnsupported += 1;
          omit(pkg, sec, 'declaracao_nao_comparavel');
          continue;
        }
        sanitized[sec][pkg] = spec;
        const registryName = current.registryName ?? pkg;
        if (onlineMode) {
          if (registryName.startsWith('@')) registryScopes.add(registryName.split('/')[0]);
        } else {
          const meta = registryVersion(registry, registryName);
          if (meta.kind === 'ok') {
            fileRegistryMatches += 1;
          } else {
            fileMissingCount += 1;
            if (meta.kind === 'invalid') fileInvalidMeta += 1;
            fileMissingSet.add(pkg);
          }
        }
      }
    }

    const isoDir = join(workRoot, 'ncu', String(idx));
    await mkdir(isoDir, {recursive: true});
    const isoPkgPath = join(isoDir, 'package.json');
    await writeFile(isoPkgPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');

    const args = [
      '--jsonUpgraded',
      '--dep',
      'prod,dev,optional,peer',
      '--configFilePath',
      ncuCfgDir,
      '--configFileName',
      ncuCfgName,
      '--packageFile',
      isoPkgPath,
    ];
    if (onlineMode) {
      args.push('--registryType', 'npm', '--registry', NPM_REGISTRY, '--removeRange');
      const scopeConfig = Array.from(registryScopes, scope => `${scope}:registry=${NPM_REGISTRY}\n`);
      await writeFile(join(isoDir, '.npmrc'), scopeConfig.join(''), 'utf8');
    } else {
      args.push('--registryType', 'json', '--registry', ncuRegistryPath);
    }

    let ncuStdout = '';
    try {
      const res = await execFile(ncuBin, args, {
        cwd: isoDir,
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...ncuEnv,
          HOME: workRoot,
          TMPDIR: workRoot,
          NO_UPDATE_NOTIFIER: '1',
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
          ...(onlineMode
            ? {NPM_CONFIG_USERCONFIG: join(isoDir, '.npmrc')}
            : {NPM_CONFIG_OFFLINE: 'true'}),
        },
      });
      ncuStdout = res.stdout;
    } catch (err) {
      toolFailed = true;
      const errDetail = err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : 'Falha ao executar npm-check-updates';
      failMessage = errDetail.slice(0, 240);
      coverage.push({
        tool: 'npm-check-updates',
        version: ncuVersion,
        status: 'failed',
        detail: `arquivo=${manifest.rel}; erro=${failMessage}`,
      });
      continue;
    }

    let upgraded;
    try {
      if (!ncuStdout.trim()) throw new Error('saída vazia');
      upgraded = JSON.parse(ncuStdout);
      if (!isRecord(upgraded)) throw new Error('raiz inválida');
    } catch (err) {
      toolFailed = true;
      failMessage = `Saída JSON inválida de npm-check-updates: ${err.message.slice(0, 150)}`;
      coverage.push({
        tool: 'npm-check-updates',
        version: ncuVersion,
        status: 'failed',
        detail: `arquivo=${manifest.rel}; erro=${failMessage}`,
      });
      continue;
    }

    let fileOutdated = 0;
    let installation;
    for (const [pkg, targetSpec] of Object.entries(upgraded)) {
      const entries = depLocations.get(pkg);
      if (!entries || typeof targetSpec !== 'string') {
        fileFailed = true;
        failMessage = `Proposta inválida de npm-check-updates em ${manifest.rel}`;
        toolFailed = true;
        coverage.push({tool: 'npm-check-updates', version: ncuVersion, status: 'failed',
          detail: `arquivo=${manifest.rel}; pacote=${pkg}; erro=${entries ? 'tipo_alvo_invalido' : 'pacote_nao_declarado'}`});
        continue;
      }
      const target = ncuSpecifier(targetSpec);
      for (const entry of entries) {
        if (!entry.current) continue;
        if (target && installation === undefined) {
          installation = await lookupLock?.(manifest) ?? null;
        }
        const {version, key, registryName, reason} = inspectNcuProposal(entry.current, target, pkg, installation);
        if (reason) {
          omit(pkg, entry.section, reason);
          continue;
        }

        let publishedVersion;
        if (onlineMode) {
          if (!semver.valid(target.range)) {
            omit(pkg, entry.section, 'alvo_online_sem_versao_exata');
            continue;
          }
          const confirmation = await lookupRelease(registryName, target.range);
          if (confirmation.reason) {
            omit(pkg, entry.section, confirmation.reason);
            continue;
          }
          if (Object.hasOwn(confirmation, 'error')) {
            toolFailed = fileFailed = true;
            failMessage = `Falha na confirmação online de ${registryName}@${target.range}: ${confirmation.error}`;
            coverage.push({tool: 'npm-check-updates', version: ncuVersion, status: 'failed',
              detail: `arquivo=${manifest.rel}; pacote=${pkg}; secao=${entry.section}; erro=consulta_registro_online; detalhe=${confirmation.error}`});
            continue;
          }
          publishedVersion = confirmation.version;
          if (publishedVersion) fileRegistryMatches += 1;
          else fileMissingCount += 1;
        } else {
          publishedVersion = registryVersion(registry, registryName).version;
        }
        if (!publishedVersion || !satisfiesRange(publishedVersion, target.range)) {
          omit(pkg, entry.section, 'alvo_nao_confirmado_no_registro');
          continue;
        }
        if (!semver.gt(publishedVersion, version)) {
          omit(pkg, entry.section, 'registro_nao_supera_versao_travada');
          continue;
        }
        if (semver.lt(target.minimum, version)) {
          omit(pkg, entry.section, 'alvo_admite_versao_inferior_ao_lock');
          continue;
        }
        const risk = classifySemverRisk(version, publishedVersion);
        const line = findLineInPackageJson(raw, pkg, entry.section);
        fileOutdated += 1;
        totalOutdated += 1;
        ncuDetectedPackages.add(dependencyKey(manifest.rel, entry.section, pkg));
        findings.push({
          tool: 'npm-check-updates',
          rule: risk.rule,
          file: manifest.rel,
          line,
          severity: risk.severity,
          message: `Dependência "${pkg}" desatualizada (${entry.spec} -> ${targetSpec}; risco ${risk.riskLabel}).`,
          evidence: `${entry.section}: "${pkg}": "${entry.spec}" -> "${pkg}": "${targetSpec}"; ${installation.path}#${key}="${version}"; registro="${publishedVersion}"` +
            (onlineMode ? `; origem=${NPM_REGISTRY}` : ''),
        });
      }
    }

    totalMatched += fileRegistryMatches;
    totalMissing += fileMissingCount;
    if (!onlineMode && fileDepCount > 0 && fileRegistryMatches === 0) {
      coverage.push({
        tool: 'npm-check-updates',
        version: ncuVersion,
        status: fileFailed ? 'failed' : 'skipped',
        detail: `arquivo=${manifest.rel}; dependencias=${fileDepCount}; verificadas_registro=0; sem_metadados=${fileMissingCount}; faixas_nao_verificadas=${fileUnsupported}; desatualizadas=0; atualizacoes_omitidas=${fileOmitted}; motivo=${fileMissingCount ? 'nenhuma_dependencia_no_registro_offline' : 'faixas_nao_semver_offline'}`,
      });
    } else {
      coverage.push({
        tool: 'npm-check-updates',
        version: ncuVersion,
        status: fileFailed ? 'failed' : fileOmitted ? 'skipped' : 'ok',
        detail: `arquivo=${manifest.rel}; dependencias=${fileDepCount}; verificadas_registro=${fileRegistryMatches}; sem_metadados=${fileMissingCount}; desatualizadas=${fileOutdated}; atualizacoes_omitidas=${fileOmitted}`,
      });
    }

    if (fileInvalidMeta > 0) {
      coverage.push({tool: 'npm-check-updates', version: ncuVersion, status: 'skipped', detail: `arquivo=${manifest.rel}; metadados_invalidos=${fileInvalidMeta}; prova_parcial=true`});
    }
    if (!onlineMode && fileMissingSet.size > 0) {
      const missingList = Array.from(fileMissingSet).sort();
      const preview = missingList.slice(0, 50).join(',');
      const suffix = missingList.length > 50 ? `,+${missingList.length - 50}` : '';
      coverage.push({
        tool: 'npm-check-updates',
        version: ncuVersion,
        status: 'skipped',
        detail: `arquivo=${manifest.rel}; sem_metadados=${fileMissingCount}; pacotes=${preview}${suffix}; motivo=ausente_no_registro_offline`,
      });
    }
  }

  let summaryStatus = 'ok';
  let summaryDetail = `manifestos=${manifests.length}; dependencias=${totalDeps}; verificadas_registro=${totalMatched}; sem_metadados=${totalMissing}; desatualizadas=${totalOutdated}; atualizacoes_omitidas=${totalOmitted}; modo=${onlineMode ? 'online' : 'offline-json'}`;
  if (toolFailed) {
    summaryStatus = 'failed';
    summaryDetail = failMessage;
  } else if (!onlineMode && totalDeps > 0 && totalMatched === 0) {
    summaryStatus = 'skipped';
    summaryDetail = `manifestos=${manifests.length}; dependencias=${totalDeps}; verificadas_registro=0; sem_metadados=${totalMissing}; faixas_nao_verificadas=${totalUnsupported}; desatualizadas=${totalOutdated}; modo=offline-json; motivo=${totalMissing ? 'nenhuma_dependencia_no_registro_offline' : 'faixas_nao_semver_offline'}`;
  } else if (totalOmitted) {
    summaryStatus = 'skipped';
  }

  coverage.unshift({
    tool: 'npm-check-updates',
    version: ncuVersion,
    status: summaryStatus,
    detail: summaryDetail,
  });

  return {coverage, findings, ncuDetectedPackages};
}

/** Maps ast-grep severity string to module severity. */
function mapAstGrepSeverity(sev) {
  switch (String(sev || '').toLowerCase()) {
    case 'error':
      return 'alta';
    case 'warning':
      return 'media';
    case 'info':
      return 'baixa';
    default:
      return 'informativa';
  }
}

function astGrepDiagnostics(rawStdout) {
  const parsed = JSON.parse(rawStdout);
  if (!Array.isArray(parsed)) throw new Error('Saída ast-grep não é um array JSON.');
  return parsed;
}

function astGrepFile(item, srcRootDir) {
  if (!nonemptyString(item?.file) || item.file.includes('\0')) return null;
  const file = relative(srcRootDir, resolve(srcRootDir, item.file)).split(sep).join('/');
  return file && !isAbsolute(file) && !file.split('/').includes('..') ? file : null;
}

function astGrepFinding(item, file) {
  const zeroLine = item?.range?.start?.line;
  if (!nonemptyString(item?.ruleId) || !Number.isSafeInteger(zeroLine) ||
      zeroLine < 0 || zeroLine >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Diagnóstico ast-grep inválido.');
  }
  const rule = `ASTGREP-${item.ruleId.replace(/-(ts|tsx|js|jsx)$/i, '').toUpperCase()}`;
  const message = nonemptyString(item.message)
    ? item.message.trim()
    : `Padrão de API incompatível detectado pela regra ${rule}.`;
  const before = nonemptyString(item.text) ? item.text : '';
  const evidence = `Revisão necessária: ${before || String(item.lines || '').trim()}`;
  return {tool: 'ast-grep', rule, file, line: zeroLine + 1,
    severity: mapAstGrepSeverity(item.severity), message, evidence: evidence.slice(0, 600)};
}

function astGrepSourcePositions(source) {
  const lineStarts = [0];
  const columns = new Uint32Array(source.length + 1);
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === 0x0a) {
      lineStarts.push(i + 1);
    } else {
      // UTF-8 continuation bytes don't advance the Unicode column.
      columns[i + 1] = columns[i] + Number((source[i] & 0xc0) !== 0x80);
    }
  }
  return {lineStarts, columns};
}

function matchesAstGrepRange(item, source, {lineStarts, columns}) {
  const {byteOffset, start, end} = item?.range ?? {};
  const first = byteOffset?.start;
  const last = byteOffset?.end;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) ||
      first < 0 || last <= first || last > source.length || !nonemptyString(item.text)) return false;

  function matchesPosition(offset, position) {
    const {line, column} = position ?? {};
    return Number.isSafeInteger(line) && line >= 0 && line < lineStarts.length &&
      offset >= lineStarts[line] && offset < (lineStarts[line + 1] ?? source.length + 1) &&
      (source[offset] & 0xc0) !== 0x80 && column === columns[offset];
  }
  return matchesPosition(first, start) && matchesPosition(last, end) &&
    source.toString('utf8', first, last) === item.text;
}

/** Parses ast-grep --json=compact output into normalized findings. */
export function parseAstGrepJson(rawStdout, srcRootDir) {
  if (!rawStdout.trim()) return [];
  return astGrepDiagnostics(rawStdout).map(item => {
    const file = astGrepFile(item, srcRootDir);
    if (!file) throw new Error('Diagnóstico ast-grep fora da cópia de análise.');
    return astGrepFinding(item, file);
  });
}

function sourceParser(ext) {
  if (ext === '.tsx') return 'tsx';
  if (['.ts', '.mts', '.cts'].includes(ext)) return 'ts';
  return 'babel';
}

/** Runs ast-grep scan on isolated copy of JS/TS files. */
export async function runAstGrepCheck({sourceFiles, isoSrcDir, astGrepBin, astGrepVersion, sgConfigPath}) {
  const coverage = [];
  const findings = [];

  if (sourceFiles.length === 0) {
    coverage.push({
      tool: 'ast-grep',
      version: astGrepVersion,
      status: 'skipped',
      detail: 'Nenhum arquivo JS/TS encontrado para análise ast-grep.',
    });
    return {coverage, findings};
  }

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let spawnError = null;
  try {
    const res = await execFile(
      astGrepBin,
      ['scan', '--config', sgConfigPath, '--json=compact', isoSrcDir, '--inspect', 'entity',
        '--no-ignore', 'hidden', '--no-ignore', 'dot', '--no-ignore', 'vcs', '--no-ignore', 'global', '--no-ignore', 'exclude'],
      {
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
      }
    );
    stdout = res.stdout;
    stderr = res.stderr;
  } catch (err) {
    if (err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string') {
      stdout = err.stdout;
      stderr = typeof err.stderr === 'string' ? err.stderr : '';
      if (typeof err.code === 'number' && !err.killed && !err.signal) exitCode = err.code;
      else spawnError = err instanceof Error ? err.message : 'Falha ao executar ast-grep';
    } else {
      spawnError = err instanceof Error ? err.message : 'Falha ao executar ast-grep';
    }
  }

  let toolError = spawnError?.slice(0, 240);
  let diagnostics = [];
  if (!toolError && exitCode !== 0 && exitCode !== 1) {
    const errText = stderr.trim() || 'ast-grep retornou erro sem saída JSON.';
    toolError = `exit=${exitCode}; erro=${errText.slice(0, 200)}`;
  }

  if (!toolError) {
    try {
      if (!stdout.trim()) throw new Error('Saída JSON vazia do ast-grep');
      diagnostics = astGrepDiagnostics(stdout);
      if (exitCode === 1 && diagnostics.length === 0) throw new Error('ast-grep retornou erro sem diagnósticos');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Saída JSON inválida do ast-grep';
      toolError = `exit=${exitCode}; erro=${msg.slice(0, 200)}`;
    }
  }
  const diagnosticsByFile = new Map(sourceFiles.map(src => [src.rel, []]));
  let unattributed = 0;
  for (const diagnostic of diagnostics) {
    const list = diagnosticsByFile.get(astGrepFile(diagnostic, isoSrcDir));
    if (list) list.push(diagnostic);
    else unattributed += 1;
  }

  const scanned = new Set();
  for (const entry of stderr.split(/\r?\n/)) {
    const match = /^sg: entity\|file\|(.+): language=[^,]+,appliedRuleCount=(\d+)$/.exec(entry);
    if (match && Number(match[2]) > 0) scanned.add(match[1]);
  }
  const getParser = toolError ? null : require('jscodeshift/src/getParser');
  let failures = 0;
  let skipped = 0;
  for (const src of sourceFiles) {
    const target = resolve(isoSrcDir, src.rel);
    const row = {tool: 'ast-grep', version: astGrepVersion};
    const artifact = await readArtifact(target, MAX_FILE_BYTES, MAX_FILE_BYTES, true);
    const source = artifact.kind === 'ok' ? artifact.content : null;
    if (source !== null && !isUtf8(source)) {
      failures += 1;
      coverage.push({...row, status: 'failed', detail: `arquivo=${src.rel}; erro=fonte_nao_utf8`});
      continue;
    }
    if (toolError) continue;

    const fileDiagnostics = diagnosticsByFile.get(src.rel);
    if (!scanned.has(target)) {
      if (fileDiagnostics.length) {
        failures += 1;
        coverage.push({...row, status: 'failed', detail: `arquivo=${src.rel}; erro=achado_sem_prova_de_varredura`});
      } else {
        skipped += 1;
        coverage.push({...row, status: 'skipped', detail: `arquivo=${src.rel}; motivo=varredura_nao_confirmada; prova_parcial=true`});
      }
      continue;
    }
    try {
      if (source === null) throw new Error('fonte_ilegivel');
      getParser(sourceParser(src.ext)).parse(source.toString('utf8'));
    } catch (err) {
      failures += 1;
      const reason = source === null ? err.message : `sintaxe_invalida; detalhe=${err.message.slice(0, 150)}`;
      coverage.push({...row, status: 'failed', detail: `arquivo=${src.rel}; erro=${reason}`});
      continue;
    }
    try {
      if (fileDiagnostics.length) {
        const positions = astGrepSourcePositions(source);
        if (fileDiagnostics.some(item => !matchesAstGrepRange(item, source, positions))) {
          throw new Error('Trecho ou intervalo divergente da cópia analisada.');
        }
      }
      const fileFindings = fileDiagnostics.map(item => astGrepFinding(item, src.rel));
      for (const finding of fileFindings) findings.push(finding);
      coverage.push({...row, status: 'ok', detail: `arquivo=${src.rel}; achados=${fileFindings.length}`});
    } catch (err) {
      failures += 1;
      coverage.push({...row, status: 'failed', detail: `arquivo=${src.rel}; erro=diagnostico_invalido; detalhe=${err.message}`});
    }
  }

  coverage.unshift({tool: 'ast-grep', version: astGrepVersion,
    status: toolError || failures || unattributed ? 'failed' : skipped ? 'skipped' : 'ok',
    detail: toolError ?? `arquivos=${sourceFiles.length}; falhas=${failures}; diagnosticos_sem_arquivo=${unattributed}; prova_parcial=${skipped}; achados=${findings.length}`});
  return {coverage, findings};
}

function parseCodemodReport(raw, target, nonce, original) {
  const [header, ...lines] = raw.split(/\r?\n/).filter(Boolean);
  const handshake = header && JSON.parse(header);
  const digest = createHash('sha256').update(original).digest('hex');
  if (!isRecord(handshake) || handshake.kind !== 'source' || handshake.file !== target ||
      handshake.nonce !== nonce || handshake.sha256 !== digest) {
    throw new Error('Confirmação do codemod ausente ou inválida.');
  }
  return lines.map(line => {
    const event = JSON.parse(line);
    if (!isRecord(event) || event.file !== target ||
        !Number.isSafeInteger(event.line) || event.line < 1 ||
        !Number.isSafeInteger(event.column) || event.column < 0 ||
        !nonemptyString(event.rule) || !VALID_SEVERITY.has(event.severity) ||
        !nonemptyString(event.message) || !nonemptyString(event.before) ||
        (event.review !== true && (event.review !== false ||
          typeof event.after !== 'string' || event.after === event.before))) {
      throw new Error('Evento de codemod inválido.');
    }
    return event;
  });
}

function matchesCodemodEvidence(events, before, after) {
  if (after === null) return false;
  if (events.length === 0) return before === after;

  const starts = [0];
  for (const newline of before.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) {
    starts.push(newline.index + newline[0].length);
  }
  const edits = [];
  for (const event of events) {
    const lineStart = starts[event.line - 1];
    const start = lineStart + event.column;
    const next = starts[event.line] ?? before.length;
    if (lineStart === undefined || start >= next || /[\r\n\u2028\u2029]/.test(before[start]) ||
        !before.startsWith(event.before, start)) return false;
    if (!event.review) edits.push({start, end: start + event.before.length, after: event.after});
  }
  if (edits.length === 0) return before === after;
  if (before === after) return false;
  edits.sort((a, b) => a.start - b.start);
  const pieces = [];
  let lastEnd = 0;
  for (const edit of edits) {
    if (edit.start < lastEnd) return false;
    pieces.push(before.slice(lastEnd, edit.start), edit.after);
    lastEnd = edit.end;
  }
  pieces.push(before.slice(lastEnd));
  return pieces.join('') === after;
}

/** Runs jscodeshift on isolated writable copies and verifies the emitted report. */
export async function runJscodeshiftCheck({
  sourceFiles,
  isoSrcDir,
  isoCodemodDir,
  workRoot,
  jscodeshiftBin,
  jscodeshiftVersion,
  transformPath,
  fileTimeoutMs = TOOL_TIMEOUT_MS,
  totalTimeoutMs = MAX_CODEMOD_TIME_MS,
}) {
  const coverage = [];
  const findings = [];
  const tool = {tool: 'jscodeshift', version: jscodeshiftVersion};

  if (sourceFiles.length === 0) {
    coverage.push({...tool, status: 'skipped', detail: 'Nenhum arquivo JS/TS encontrado para codemods jscodeshift.'});
    return {coverage, findings};
  }

  let failures = 0;
  let skipped = 0;
  let reportBytes = 0;
  const deadline = performance.now() + totalTimeoutMs;
  const remainingTime = () => Math.floor(deadline - performance.now());
  const checkDeadline = () => {
    const remaining = remainingTime();
    if (remaining < 1) throw new Error('prazo total esgotado');
    return remaining;
  };
  for (const src of sourceFiles) {
    const remainingMs = remainingTime();
    const remainingBytes = MAX_CODEMOD_REPORT_BYTES - reportBytes;
    const remainingFindings = MAX_CODEMOD_FINDINGS - findings.length;
    const limit = remainingMs < 1 ? 'limite_tempo_total' :
      remainingBytes === 0 ? 'limite_bytes_total' :
      remainingFindings === 0 ? 'limite_achados_total' : '';
    if (limit) {
      skipped += 1;
      coverage.push({...tool, status: 'skipped', detail: `arquivo=${src.rel}; motivo=${limit}; prova_parcial=true`});
      continue;
    }

    const parser = sourceParser(src.ext);
    const target = join(isoCodemodDir, src.rel);
    const nonce = randomUUID();
    const report = join(workRoot, `matches-${nonce}.ndjson`);
    let phase = 'leitura_origem';
    let execution;
    let reason = '';
    let failure = '';
    let accepted = [];
    try {
      const original = await readSafeRegularFile(join(isoSrcDir, src.rel));
      const executionBudget = checkDeadline();
      if (original === null) throw new Error('cópia de origem ilegível');
      const timeoutMs = Math.min(executionBudget, fileTimeoutMs);
      const signal = AbortSignal.timeout(timeoutMs);
      execution = {signal, timeoutMs, budget: executionBudget <= fileTimeoutMs ? 'total' : 'arquivo'};
      phase = 'execucao';
      await execFile(jscodeshiftBin,
        ['--run-in-band', '--fail-on-error', `--parser=${parser}`,
          `--extensions=${extname(target).slice(1)}`, '-t', transformPath, target],
        {signal, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024,
          env: {...process.env, HOME: workRoot, TMPDIR: workRoot,
            AC_JSCODESHIFT_REPORT: report, AC_JSCODESHIFT_NONCE: nonce}});
      checkDeadline();

      phase = 'relatorio_ilegivel';
      const result = await readArtifact(report, MAX_FILE_BYTES, remainingBytes);
      checkDeadline();
      if (result.kind === 'fileLimit' || result.kind === 'totalLimit') {
        reason = result.kind === 'fileLimit' ? 'limite_relatorio' : 'limite_bytes_total';
      } else {
        if (result.kind !== 'ok') throw new Error(result.kind === 'missing' ? 'relatório ausente' : 'erro de leitura');
        reportBytes += result.bytes;

        phase = 'relatorio_invalido';
        const [marker, after] = await Promise.all([
          readArtifact(`${report}.limit`, 32), readSafeRegularFile(target),
        ]);
        checkDeadline();
        if (marker.kind !== 'missing' && (marker.kind !== 'ok' || marker.content !== 'limit')) {
          throw new Error('marcador de limite inválido');
        }
        const events = parseCodemodReport(result.content, target, nonce, original);
        if (!matchesCodemodEvidence(events, original, after)) {
          throw new Error('origem ou alterações reportadas não conferem com as cópias');
        }
        reason = events.length > remainingFindings ? 'limite_achados_total' :
          marker.kind === 'ok' ? 'limite_relatorio' : '';
        accepted = events.slice(0, remainingFindings).map(event => {
          const evidence = event.review ? `Revisão necessária: ${event.before}` :
            `Patch pronto:\n- ${event.before}\n+ ${event.after}`;
          return {tool: tool.tool, rule: event.rule, file: src.rel, line: event.line,
            severity: event.severity, message: event.message, evidence: evidence.slice(0, 600)};
        });
        checkDeadline();
      }
    } catch (err) {
      if (phase === 'execucao' && err?.code === 'ABORT_ERR' && execution.signal.aborted) {
        failure = `timeout; timeout_ms=${execution.timeoutMs}; prazo=${execution.budget}; fase=execucao`;
      } else if (remainingTime() < 1) {
        failure = `timeout; timeout_ms=${totalTimeoutMs}; prazo=total; fase=${phase}`;
      } else {
        const detail = err?.stderr?.trim() || err?.stdout?.trim() || String(err?.message ?? err);
        const signalDetail = err?.signal ? `sinal=${err.signal}; ` : '';
        const codeDetail = err?.code === undefined ? '' : `codigo=${err.code}; `;
        failure = `${phase}; ${signalDetail}${codeDetail}detalhe=${detail.slice(0, 200)}`;
      }
    }
    try {
      await rm(report, {force: true, recursive: true});
      await rm(`${report}.limit`, {force: true, recursive: true});
    } catch (err) {
      failure ||= `limpeza_relatorio; detalhe=${err.message.slice(0, 200)}`;
    }
    if (remainingTime() < 1) failure ||= `timeout; timeout_ms=${totalTimeoutMs}; prazo=total; fase=limpeza_relatorio`;
    if (failure) {
      failures += 1;
      coverage.push({...tool, status: 'failed', detail: `arquivo=${src.rel}; parser=${parser}; erro=${failure}`});
      continue;
    }
    if (reason) skipped += 1;
    for (const finding of accepted) findings.push(finding);
    const detail = reason ? `motivo=${reason}; prova_parcial=true; ` : '';
    coverage.push({...tool, status: reason ? 'skipped' : 'ok',
      detail: `arquivo=${src.rel}; ${detail}correspondencias=${accepted.length}`});
  }
  coverage.unshift({...tool,
    status: failures ? 'failed' : skipped ? 'skipped' : 'ok',
    detail: `arquivos=${sourceFiles.length}; falhas=${failures}; prova_parcial=${skipped}; bytes_relatorios=${reportBytes}; achados=${findings.length}`});

  return {coverage, findings};
}

function workspaceMatches(patterns, path) {
  let matched = false;
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const negate = pattern.startsWith('!');
    const glob = (negate ? pattern.slice(1) : pattern).replace(/^\.\//, '').replace(/\/$/, '');
    if (minimatch(path, glob, {dot: true, nonegate: true})) matched = !negate;
  }
  return matched;
}

function lockEntryIsMalformed(entry) {
  return !isRecord(entry) ||
    (Object.hasOwn(entry, 'version') && !nonemptyString(entry.version)) ||
    (Object.hasOwn(entry, 'link') && typeof entry.link !== 'boolean') ||
    (Object.hasOwn(entry, 'resolved') && !nonemptyString(entry.resolved)) ||
    (entry.link === true && !nonemptyString(entry.resolved));
}

function resolveLockedEntry(lock, workspacePath, pkg) {
  if (!lock.packages) {
    if (!workspacePath && Object.hasOwn(lock.dependencies, pkg)) {
      return {section: 'dependencies', key: pkg, entry: lock.dependencies[pkg]};
    }
    return null;
  }
  let dir = workspacePath;
  while (true) {
    const key = dir ? `${dir}/node_modules/${pkg}` : `node_modules/${pkg}`;
    if (Object.hasOwn(lock.packages, key)) return {section: 'packages', key, entry: lock.packages[key]};
    if (!dir) return null;
    dir = posix.dirname(dir);
    if (dir === '.') dir = '';
  }
}

/** Indexes keys of the top-level npm lock maps without confusing them with nested keys. */
function lockEntryLines(raw) {
  const sections = {packages: new Map(), dependencies: new Map()};
  let section = null;
  let depth = 0;
  let line = 1;
  let key;
  let keyLine;
  for (const [token] of raw.matchAll(/"[^"\\]*(?:\\.[^"\\]*)*"|[{}\[\]:,\n]/g)) {
    if (token === '\n') {
      line += 1;
      continue;
    }
    if (token[0] === '"') {
      key = token;
      keyLine = line;
      continue;
    }
    if (token === ':' && key && depth === 1) {
      const name = JSON.parse(key);
      section = Object.hasOwn(sections, name) ? sections[name] : null;
      section?.clear();
    }
    if (token === ':' && key && depth === 2 && section) section.set(JSON.parse(key), keyLine);
    if (token === '{' || token === '[') depth += 1;
    if (token === '}' || token === ']') depth -= 1;
    key = undefined;
  }
  return sections;
}

async function createNpmLockLookup(manifests, lockfiles) {
  const workspaceRoots = [];
  for (const root of manifests) {
    try {
      const obj = JSON.parse(await readSafeRegularFile(root.fullPath, MAX_FILE_BYTES));
      const patterns = Array.isArray(obj?.workspaces) ? obj.workspaces : obj?.workspaces?.packages;
      if (Array.isArray(patterns)) workspaceRoots.push({dir: posix.dirname(root.rel), patterns});
    } catch { /* The manifest itself is reported below and by NCU. */ }
  }
  // An outer installation owns members that its own workspace declaration includes.
  const workspaceDepth = ({dir}) => dir === '.' ? 0 : dir.split('/').length;
  workspaceRoots.sort((a, b) => workspaceDepth(a) - workspaceDepth(b));

  let lastLock;
  return async manifest => {
    const dir = posix.dirname(manifest.rel);
    const workspace = workspaceRoots.find(root => root.dir !== dir &&
      (root.dir === '.' || dir.startsWith(`${root.dir}/`)) &&
      workspaceMatches(root.patterns, posix.relative(root.dir, dir)));
    const lockDir = workspace?.dir ?? dir;
    const lockRel = LOCKFILE_NAMES.map(name => posix.join(lockDir, name)).find(path => lockfiles.has(path));
    const workspacePath = lockDir === dir ? '' : posix.relative(lockDir, dir);
    if (!lockRel || !NPM_LOCKFILE_NAMES.includes(posix.basename(lockRel))) {
      return {lockDir, workspacePath, path: lockRel};
    }

    if (lastLock?.path !== lockRel) {
      const raw = await readArtifact(lockfiles.get(lockRel), MAX_REGISTRY_BYTES, MAX_REGISTRY_BYTES, true);
      lastLock = {path: lockRel, raw};
      if (raw.kind === 'ok') {
        if (!isUtf8(raw.content)) {
          lastLock.error = 'lockfile_nao_utf8';
          return {path: lockRel, lock: lastLock, lockDir, workspacePath};
        }
        raw.content = raw.content.toString('utf8');
        try {
          const parsed = JSON.parse(raw.content);
          if (!isRecord(parsed) ||
              (!Object.hasOwn(parsed, 'packages') && !Object.hasOwn(parsed, 'dependencies')) ||
              (Object.hasOwn(parsed, 'packages') && !isRecord(parsed.packages)) ||
              (Object.hasOwn(parsed, 'dependencies') && !isRecord(parsed.dependencies)) ||
              (parsed.lockfileVersion >= 2 && !parsed.packages)) {
            throw new Error('estrutura inválida');
          }
          lastLock.parsed = parsed;
          const entries = parsed.packages ?? parsed.dependencies;
          lastLock.invalidEntries = Object.values(entries).filter(lockEntryIsMalformed).length;
        } catch (err) {
          lastLock.error = err instanceof SyntaxError ? 'json_invalido' : 'estrutura_invalida';
        }
      }
    }
    return {path: lockRel, lock: lastLock, lockDir, workspacePath};
  };
}

function inspectNpmLockEntry(lock, workspacePath, pkg, declaration) {
  if (workspacePath && !lock.packages) return {reason: 'lock_legado_sem_entrada_workspace'};
  let match = resolveLockedEntry(lock, workspacePath, pkg);
  if (!match) return {reason: 'entrada_lockfile_ausente'};

  const linked = match.entry?.link === true;
  if (linked && !lockEntryIsMalformed(match.entry)) {
    const key = match.entry.resolved;
    if (posix.isAbsolute(key) || key.split('/').includes('..')) return {reason: 'link_externo'};
    match = {section: 'packages', key, entry: lock.packages?.[key]};
  }
  const {key, section, entry} = match;
  if (lockEntryIsMalformed(entry) || entry.link === true) return {key, reason: 'entrada_lockfile_invalida'};
  if (!entry.version) return {key, reason: 'versao_ausente'};

  const legacyAlias = !lock.packages && NPM_ALIAS.exec(entry.version);
  const alias = declaration?.registryName;
  const registryName = alias ?? pkg;
  const lockName = Object.hasOwn(entry, 'name') ? entry.name : undefined;
  const resolvedName = legacyAlias ? legacyAlias[1] : lockName;
  if (alias && resolvedName === undefined) return {key, reason: 'identidade_alias_nao_comprovada'};
  if ((resolvedName !== undefined && resolvedName !== registryName) ||
      (lockName !== undefined && lockName !== registryName) ||
      (legacyAlias && !alias)) {
    return {key, reason: 'identidade_lockfile_divergente'};
  }
  const version = legacyAlias ? legacyAlias[2] : entry.version;
  if (!declaration || !NPM_NAME.test(registryName) || !semver.valid(version)) {
    return {key, reason: 'faixa_ou_versao_nao_semver'};
  }
  return {key, section, linked, registryName, version};
}

function npmComponentIdentity(component) {
  if (component.purl === undefined) return {};
  if (!/^pkg:[a-z][a-z0-9.+-]*\/[^\s?#]+(?:[?#]\S*)?$/.test(component.purl)) {
    return {error: component.purl.startsWith('pkg:npm') ? 'purl_npm_invalida' : 'purl_invalida'};
  }
  if (!component.purl.startsWith('pkg:npm/')) return {};

  const locator = component.purl.slice('pkg:npm/'.length).split(/[?#]/, 1)[0];
  const at = locator.lastIndexOf('@');
  let name;
  let purlVersion;
  try {
    name = decodeURIComponent(at > 0 ? locator.slice(0, at) : locator);
    if (at > 0) purlVersion = decodeURIComponent(locator.slice(at + 1));
  } catch {
    return {error: 'purl_npm_invalida'};
  }
  if (!NPM_NAME.test(name)) return {error: 'purl_npm_invalida'};
  const version = component.version ?? purlVersion;
  if (purlVersion !== undefined && purlVersion !== version) {
    return {error: 'versao_componente_invalida'};
  }
  if (!semver.valid(version)) return {omission: 'versao_componente_nao_comparavel'};
  return {name, version};
}

/** Checks npm lock consistency and compares the available CycloneDX inventory offline. */
export async function analyzeLockfileAndSbom({
  manifests,
  lockfiles,
  sbomFiles,
  registry,
  ncuDetectedPackages,
  mountedSbomPaths = SBOM_CANDIDATE_FILES,
  lookupLock,
}) {
  const coverage = [];
  const findings = [];
  const tool = {tool: 'sbom-lockfile', version: '1.0.0'};
  const checkedFiles = new Set();
  let componentsScanned = 0;
  let totalMissingMeta = 0;
  let totalInvalidMeta = 0;
  let artifactFailures = 0;
  let artifactSkips = 0;

  function record(status, detail) {
    if (status === 'failed') artifactFailures += 1;
    if (status === 'skipped') artifactSkips += 1;
    coverage.push({...tool, status, detail});
  }

  lookupLock ??= await createNpmLockLookup(manifests, lockfiles);

  for (const manifest of manifests) {
    const rawPkg = await readArtifact(manifest.fullPath, MAX_FILE_BYTES);
    if (rawPkg.kind !== 'ok') {
      record(rawPkg.kind === 'fileLimit' ? 'skipped' : 'failed', rawPkg.kind === 'fileLimit'
        ? `arquivo=${manifest.rel}; motivo=limite_bytes; prova_parcial=true`
        : `arquivo=${manifest.rel}; erro=ilegivel`);
      continue;
    }
    let parsedPkg;
    try {
      parsedPkg = JSON.parse(rawPkg.content);
      if (!isRecord(parsedPkg)) throw new Error('raiz inválida');
    } catch {
      record('failed', `arquivo=${manifest.rel}; manifesto_invalido=true`);
      continue;
    }

    const declaredEntries = [];
    for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (!isRecord(parsedPkg[sec])) continue;
      for (const [pkg, spec] of Object.entries(parsedPkg[sec])) {
        if (typeof spec === 'string') declaredEntries.push({sec, pkg, spec});
      }
    }

    const installation = await lookupLock(manifest);
    const {path: lockRel, lockDir, workspacePath, lock} = installation;
    if (!lockRel) {
      if (declaredEntries.length === 0) continue;
      findings.push({
        tool: tool.tool,
        rule: 'LOCKFILE-MISSING',
        file: manifest.rel,
        line: 1,
        severity: 'media',
        message: `Manifesto "${manifest.rel}" declara ${declaredEntries.length} dependência(s) sem arquivo de lock.`,
        evidence: `Manifesto ${manifest.rel} sem lockfile no diretório ${lockDir === '.' ? 'raiz' : lockDir}.`,
      });
      record('ok', `arquivo=${manifest.rel}; lockfile=ausente; diretorio=${lockDir}; achados=1`);
      continue;
    }

    const fileScope = `arquivo=${lockRel}; manifesto=${manifest.rel}`;
    if (!NPM_LOCKFILE_NAMES.includes(posix.basename(lockRel))) {
      record('skipped', `${fileScope}; motivo=formato_nao_analisado`);
      continue;
    }

    const {raw, parsed, error, invalidEntries} = lock;
    if (raw.kind !== 'ok') {
      if (raw.kind === 'fileLimit') record('skipped', `${fileScope}; motivo=limite_bytes; prova_parcial=true`);
      else record('failed', `${fileScope}; erro=${raw.kind === 'missing' ? 'arquivo_ausente' : 'ilegivel'}`);
      continue;
    }
    if (error) {
      record('failed', `${fileScope}; lockfile_invalido=true; erro=${error}`);
      findings.push({
        tool: tool.tool,
        rule: 'LOCKFILE-INVALID-JSON',
        file: lockRel,
        line: 1,
        severity: 'alta',
        message: error === 'lockfile_nao_utf8'
          ? `Arquivo ${lockRel} contém bytes inválidos em UTF-8.`
          : `Arquivo ${lockRel} contém JSON ou estrutura de lock npm inválida.`,
        evidence: `${lockRel}: ${error}`,
      });
      continue;
    }

    checkedFiles.add(lockfiles.get(lockRel));
    let fileFindings = 0;
    let fileMissingMeta = 0;
    let fileInvalidMeta = 0;
    let fileUnverifiable = 0;
    let invalidResolutions = 0;
    for (const {sec, pkg, spec} of declaredEntries) {
      const declaration = ncuSpecifier(spec);
      const match = inspectNpmLockEntry(parsed, workspacePath, pkg, declaration);
      if (match.reason === 'entrada_lockfile_ausente') {
        fileFindings += 1;
        findings.push({
          tool: tool.tool,
          rule: 'LOCKFILE-DRIFT',
          file: lockRel,
          line: 1,
          severity: 'media',
          message: `Dependência "${pkg}" declarada em ${manifest.rel} (${sec}: "${spec}") está ausente de ${lockRel}.`,
          evidence: `Ausente em ${lockRel}: node_modules/${pkg}`,
        });
        continue;
      }
      if (match.reason) {
        const scope = `${fileScope}; pacote=${pkg}${match.key ? `; entrada=${match.key}` : ''}`;
        if (match.reason === 'entrada_lockfile_invalida') {
          invalidResolutions += 1;
          coverage.push({...tool, status: 'failed', detail: `${scope}; erro=${match.reason}`});
        } else {
          fileUnverifiable += 1;
          coverage.push({...tool, status: 'skipped', detail: `${scope}; motivo=${match.reason}`});
        }
        continue;
      }
      const {version: resolvedVer, registryName, linked} = match;
      componentsScanned += 1;
      if (!satisfiesRange(resolvedVer, declaration.range)) {
        fileFindings += 1;
        lock.lines ??= lockEntryLines(raw.content);
        findings.push({
          tool: tool.tool,
          rule: 'LOCKFILE-VERSION-MISMATCH',
          file: lockRel,
          line: lock.lines[match.section].get(match.key) ?? 1,
          severity: 'alta',
          message: `Versão travada de "${pkg}" (${resolvedVer}) em ${lockRel} não satisfaz a faixa "${spec}" de ${manifest.rel}.`,
          evidence: `${manifest.rel}="${spec}" vs ${lockRel}#${match.key}="${resolvedVer}"`,
        });
        continue;
      }

      if (linked) {
        fileUnverifiable += 1;
        coverage.push({...tool, status: 'skipped', detail: `${fileScope}; pacote=${pkg}; entrada=${match.key}; motivo=registro_inaplicavel_a_link_local`});
        continue;
      }
      const meta = registryVersion(registry, registryName);
      if (meta.kind !== 'ok') {
        fileMissingMeta += 1;
        if (meta.kind === 'invalid') fileInvalidMeta += 1;
        continue;
      }
      if (semver.lt(resolvedVer, meta.version) &&
          !ncuDetectedPackages.has(dependencyKey(manifest.rel, sec, pkg)) &&
          !ncuDetectedPackages.has(`${manifest.rel}:${pkg}`)) {
        const risk = classifySemverRisk(resolvedVer, meta.version);
        fileFindings += 1;
        lock.lines ??= lockEntryLines(raw.content);
        findings.push({
          tool: tool.tool,
          rule: 'LOCKFILE-OUTDATED-RESOLVED',
          file: lockRel,
          line: lock.lines[match.section].get(match.key) ?? 1,
          severity: risk.severity,
          message: `Versão travada em ${lockRel} para "${pkg}" (${resolvedVer}) está atrás da mais recente (${meta.version}; risco ${risk.riskLabel}).`,
          evidence: `${lockRel}#${match.key}: "${pkg}"@${resolvedVer} -> ${meta.version}${registryName !== pkg ? `; registro="${registryName}"` : ''}`,
        });
      }
    }

    totalMissingMeta += fileMissingMeta;
    totalInvalidMeta += fileInvalidMeta;
    record(invalidEntries || invalidResolutions || fileInvalidMeta ? 'failed' :
      fileUnverifiable || fileMissingMeta ? 'skipped' : 'ok',
    `${fileScope}; dependencias_verificadas=${declaredEntries.length - fileUnverifiable - invalidResolutions}; faixas_nao_verificadas=${fileUnverifiable}; entradas_invalidas=${invalidEntries}; resolucoes_invalidas=${invalidResolutions}; sem_metadados=${fileMissingMeta}; metadados_invalidos=${fileInvalidMeta}; achados=${fileFindings}`);
  }

  let sbomBytes = 0;
  let inventoryComponents = 0;
  const sbomCandidates = [
    ...mountedSbomPaths.map(path => ({rel: path, fullPath: path, optional: true})),
    ...sbomFiles,
  ];
  for (const sb of sbomCandidates) {
    const scope = `sbom=${sb.rel}`;
    const raw = await readArtifact(sb.fullPath, MAX_REGISTRY_BYTES, MAX_SBOM_BYTES - sbomBytes, true);
    if (raw.kind !== 'ok') {
      if (sb.optional && raw.kind === 'missing') continue;
      if (raw.kind === 'fileLimit' || raw.kind === 'totalLimit') {
        record('skipped', `${scope}; motivo=${raw.kind === 'fileLimit' ? 'limite_bytes' : 'limite_bytes_total'}; prova_parcial=true`);
      } else {
        record('failed', `${scope}; erro=${raw.kind === 'missing' ? 'arquivo_ausente' : 'ilegivel'}`);
      }
      continue;
    }
    sbomBytes += raw.bytes;
    if (!isUtf8(raw.content)) {
      record('failed', `${scope}; erro=sbom_nao_utf8`);
      continue;
    }

    let bom;
    try {
      bom = JSON.parse(raw.content.toString('utf8'));
    } catch {
      record('failed', `${scope}; erro=json_invalido`);
      continue;
    }
    const schemaError = validateCycloneDx(bom);
    if (schemaError) {
      record('failed', `${scope}; ${schemaError}`);
      continue;
    }

    checkedFiles.add(sb.fullPath);
    const errors = new Map();
    let sbomFindings = 0;
    let sbomMissingMeta = 0;
    let sbomInvalidMeta = 0;
    let sbomUnverifiable = 0;
    let componentCount = 0;
    let truncated = false;
    const lists = [(bom.components ?? []).values()];
    if (bom.metadata && Object.hasOwn(bom.metadata, 'component')) {
      lists.push([bom.metadata.component].values());
    }
    while (lists.length) {
      const next = lists.at(-1).next();
      if (next.done) {
        lists.pop();
        continue;
      }
      if (inventoryComponents >= MAX_SBOM_COMPONENTS) {
        truncated = true;
        break;
      }
      inventoryComponents += 1;
      componentCount += 1;
      const component = next.value;
      const identity = npmComponentIdentity(component);
      if (component.components) lists.push(component.components.values());
      if (identity.error) {
        errors.set(identity.error, (errors.get(identity.error) ?? 0) + 1);
        continue;
      }
      if (identity.omission) sbomUnverifiable += 1;
      if (!identity.name) continue;
      componentsScanned += 1;
      const {name, version} = identity;
      const meta = registryVersion(registry, name);
      if (meta.kind !== 'ok') {
        sbomMissingMeta += 1;
        if (meta.kind === 'invalid') sbomInvalidMeta += 1;
        continue;
      }
      if (semver.lt(version, meta.version)) {
        const risk = classifySemverRisk(version, meta.version);
        sbomFindings += 1;
        findings.push({
          tool: tool.tool,
          rule: 'SBOM-OUTDATED-COMPONENT',
          file: sb.rel.startsWith('/') ? 'package.json' : sb.rel,
          line: 1,
          severity: risk.severity,
          message: `Componente SBOM "${name}"@${version} está desatualizado (mais recente: ${meta.version}; risco ${risk.riskLabel}).`,
          evidence: `SBOM (${sb.rel}): ${name}@${version} -> ${meta.version}`,
        });
      }
    }
    totalMissingMeta += sbomMissingMeta;
    totalInvalidMeta += sbomInvalidMeta;
    const issues = Array.from(errors, ([reason, count]) => `${reason}=${count}`).join('; ');
    record(errors.size || sbomInvalidMeta ? 'failed' : truncated || sbomMissingMeta || sbomUnverifiable ? 'skipped' : 'ok',
      `${scope}; componentes=${componentCount}; sem_metadados=${sbomMissingMeta}; metadados_invalidos=${sbomInvalidMeta}; achados=${sbomFindings}${sbomUnverifiable ? `; versao_componente_nao_comparavel=${sbomUnverifiable}` : ''}${issues ? `; ${issues}` : ''}${truncated ? '; motivo=limite_componentes_total; prova_parcial=true' : ''}`);
  }

  if (registry?.error && componentsScanned) record('failed', `registro=offline; erro=${registry.error}`);
  coverage.unshift({...tool,
    status: artifactFailures ? 'failed' : artifactSkips ? 'skipped' : checkedFiles.size || findings.length ? 'ok' : 'skipped',
    detail: checkedFiles.size || findings.length || artifactFailures || artifactSkips
      ? `artefatos=${checkedFiles.size}; componentes=${componentsScanned}; sem_metadados=${totalMissingMeta}; metadados_invalidos=${totalInvalidMeta}; falhas=${artifactFailures}; analises_parciais=${artifactSkips}; bytes_sbom=${sbomBytes}; achados=${findings.length}`
      : 'Nenhum lockfile ou SBOM CycloneDX encontrado para verificação.',
  });

  return {coverage, findings};
}

/** Validates the strict stdout JSON contract before printing. */
export function validateModuleOutput(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Saída inválida: raiz não é objeto.');
  }
  if (!Array.isArray(doc.coverage) || !Array.isArray(doc.findings)) {
    throw new Error('Saída inválida: coverage e findings devem ser arrays.');
  }
  for (const cov of doc.coverage) {
    if (!cov || typeof cov !== 'object') throw new Error('Item de coverage inválido.');
    if (typeof cov.tool !== 'string' || !cov.tool) throw new Error('coverage.tool inválido.');
    if (typeof cov.version !== 'string' || !cov.version) throw new Error('coverage.version inválido.');
    if (!VALID_STATUS.has(cov.status)) throw new Error(`coverage.status inválido: ${cov.status}`);
    if (typeof cov.detail !== 'string') throw new Error('coverage.detail inválido.');
  }
  for (const f of doc.findings) {
    if (!f || typeof f !== 'object') throw new Error('Item de finding inválido.');
    if (typeof f.tool !== 'string' || !f.tool) throw new Error('finding.tool inválido.');
    if (typeof f.rule !== 'string' || !f.rule) throw new Error('finding.rule inválido.');
    if (typeof f.file !== 'string' || !f.file || f.file.startsWith('/') || f.file.split('/').includes('..')) {
      throw new Error(`finding.file inválido: ${f.file}`);
    }
    if (!Number.isInteger(f.line) || f.line < 1) throw new Error(`finding.line inválido: ${f.line}`);
    if (!VALID_SEVERITY.has(f.severity)) throw new Error(`finding.severity inválido: ${f.severity}`);
    if (typeof f.message !== 'string' || !f.message) throw new Error('finding.message inválido.');
    if (typeof f.evidence !== 'string') throw new Error('finding.evidence inválido.');
  }
  return doc;
}

/** Runs the full Module 4 (dependencias) collection against repoRoot. */
export async function runCollection(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.env.AC_MODULE_REPO ?? '/repo');
  const onlineMode = options.onlineMode ?? process.env.AC_DEPENDENCIAS_ONLINE === '1';
  const ncuBin = options.ncuBin ?? 'ncu';
  const astGrepBin = options.astGrepBin ?? 'ast-grep';
  const jscodeshiftBin = options.jscodeshiftBin ?? 'jscodeshift';
  const sgConfigPath = options.sgConfigPath ?? join(MODULE_DIR, 'sgconfig.yml');
  const transformPath = options.transformPath ?? join(MODULE_DIR, 'codemods', 'upgrade-rewrites.cjs');

  const hasLocalNodeModules = Boolean(
    await readSafeRegularFile(join(MODULE_DIR, 'node_modules', 'npm-check-updates', 'package.json'), 256 * 1024)
  );
  if (hasLocalNodeModules && !options.ncuVersion && !options.astGrepVersion && !options.jscodeshiftVersion) {
    await verifyToolsAgainstLock(MODULE_DIR);
  }

  const [ncuVersion, astGrepVersion, jscodeshiftVersion] = await Promise.all([
    options.ncuVersion ?? resolveInstalledVersion('npm-check-updates', ncuBin),
    options.astGrepVersion ?? resolveInstalledVersion('@ast-grep/cli', astGrepBin),
    options.jscodeshiftVersion ?? resolveInstalledVersion('jscodeshift', jscodeshiftBin),
  ]);

  const discovered = await discoverRepoFiles(repoRoot);
  const registry = await resolveRegistrySnapshot(options.registryPath);

  const workRoot = await mkdtemp(join(tmpdir(), `ac-dep-${randomUUID().slice(0, 8)}-`));
  try {
    const isoSrcDir = join(workRoot, 'src');
    const isoCodemodDir = join(workRoot, 'codemod');
    await mkdir(isoSrcDir, {recursive: true});
    await mkdir(isoCodemodDir, {recursive: true});

    const copiedSources = [];
    const copyCoverage = [];
    let copiedBytes = 0;
    for (const src of discovered.sourceFiles) {
      try {
        const info = await lstat(src.fullPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || copiedBytes + info.size > MAX_SOURCE_BYTES) {
          copyCoverage.push({tool: 'repo-guard', version: '1.0.0', status: 'skipped', detail: `arquivo=${src.rel}; motivo=limite_ou_arquivo_alterado; prova_parcial=true`});
          continue;
        }
        const srcDest = join(isoSrcDir, src.rel);
        const codemodDest = join(isoCodemodDir, src.rel);
        await mkdir(dirname(srcDest), {recursive: true});
        await mkdir(dirname(codemodDest), {recursive: true});
        await copyFile(src.fullPath, srcDest);
        const copiedInfo = await lstat(srcDest);
        if (copiedInfo.size > MAX_FILE_BYTES || copiedBytes + copiedInfo.size > MAX_SOURCE_BYTES) throw new Error('limite de bytes');
        await copyFile(srcDest, codemodDest);
        copiedBytes += copiedInfo.size;
        copiedSources.push(src);
      } catch (err) {
        copyCoverage.push({tool: 'repo-guard', version: '1.0.0', status: 'failed', detail: `arquivo=${src.rel}; erro=copia_falhou; prova_parcial=true`});
      }
    }

    const lookupLock = await createNpmLockLookup(discovered.manifests, discovered.lockfiles);
    const ncuRes = await runNcuCheck({
      lookupLock,
      manifests: discovered.manifests,
      workRoot,
      registry,
      ncuBin,
      ncuVersion,
      onlineMode,
      registryGet: options.registryGet,
    });

    const astGrepRes = await runAstGrepCheck({
      sourceFiles: copiedSources,
      isoSrcDir,
      astGrepBin,
      astGrepVersion,
      sgConfigPath,
    });

    const jscodeshiftRes = await runJscodeshiftCheck({
      sourceFiles: copiedSources,
      isoSrcDir,
      isoCodemodDir,
      workRoot,
      jscodeshiftBin,
      jscodeshiftVersion,
      transformPath,
    });

    const sbomLockRes = await analyzeLockfileAndSbom({
      manifests: discovered.manifests,
      lockfiles: discovered.lockfiles,
      sbomFiles: discovered.sbomFiles,
      registry,
      ncuDetectedPackages: ncuRes.ncuDetectedPackages,
      lookupLock,
    });

    const optionalCoverage = [
      {
        tool: 'openrewrite',
        version: 'nao-instalada',
        status: 'skipped',
        detail: discovered.hasJavaProject
          ? 'Projeto Java detectado (pom.xml/build.gradle), mas OpenRewrite não está disponível no modo offline sem cache Maven.'
          : 'Nenhum projeto Java (pom.xml/build.gradle) detectado; OpenRewrite ignorado.',
      },
      {
        tool: 'renovate',
        version: 'nao-instalada',
        status: 'skipped',
        detail: 'Renovate local opcional (AGPL-3.0) não incluído nesta imagem offline.',
      },
    ];

    if (discovered.skippedSymlinks || discovered.skippedOversized || discovered.skippedManifestLimit || discovered.skippedSourceLimit || discovered.skippedSourceBytes || discovered.readErrors) {
      optionalCoverage.push({
        tool: 'repo-guard',
        version: '1.0.0',
        status: discovered.readErrors ? 'failed' : 'skipped',
        detail: `symlinks_ignorados=${discovered.skippedSymlinks}; arquivos_grandes_ignorados=${discovered.skippedOversized}; manifestos_limite=${discovered.skippedManifestLimit}; fontes_limite=${discovered.skippedSourceLimit}; fontes_limite_bytes=${discovered.skippedSourceBytes}; erros_leitura=${discovered.readErrors}; prova_parcial=true`,
      });
    }

    const output = {
      coverage: [
        ...ncuRes.coverage,
        ...astGrepRes.coverage,
        ...jscodeshiftRes.coverage,
        ...sbomLockRes.coverage,
        ...optionalCoverage,
        ...copyCoverage,
      ],
      findings: [
        ...ncuRes.findings,
        ...astGrepRes.findings,
        ...jscodeshiftRes.findings,
        ...sbomLockRes.findings,
      ],
    };

    return validateModuleOutput(output);
  } finally {
    await rm(workRoot, {recursive: true, force: true});
  }
}

async function main() {
  try {
    const result = await runCollection();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fallback = {
      coverage: [
        {
          tool: 'dependencias-collector',
          version: '1.0.0',
          status: 'failed',
          detail: message.slice(0, 400),
        },
      ],
      findings: [],
    };
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    process.exitCode = 1;
  }
}

const isDirectEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectEntry) {
  await main();
}
