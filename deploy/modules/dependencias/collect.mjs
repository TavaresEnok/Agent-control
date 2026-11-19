import {execFile as execFileCb} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, extname, join, posix, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFile = promisify(execFileCb);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 20 * 1024 * 1024;
const MAX_MANIFESTS = 50;
const MAX_SOURCE_FILES = 2000;
const TOOL_TIMEOUT_MS = 120_000;

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
const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
const SBOM_CANDIDATE_FILES = [
  '/databases/syft.cdx.json',
  '/databases/sbom.cdx.json',
  '/input/syft.cdx.json',
  '/input/sbom.cdx.json',
];

const VALID_STATUS = new Set(['ok', 'failed', 'skipped']);
const VALID_SEVERITY = new Set(['alta', 'media', 'baixa', 'informativa']);

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

/** Reads a regular non-symlink file bounded by maxBytes. Returns null if rejected or missing. */
export async function readSafeRegularFile(filePath, maxBytes = MAX_FILE_BYTES) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) return null;
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
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

/** Walks repository safely, ignoring symlinks and ignored/oversized paths. */
export async function discoverRepoFiles(repoRoot) {
  const manifests = [];
  const lockfiles = new Map();
  const sourceFiles = [];
  const sbomFiles = [];
  let hasJavaProject = false;
  let skippedSymlinks = 0;
  let skippedOversized = 0;

  async function walk(currentDir) {
    let entries;
    try {
      entries = await readdir(currentDir, {withFileTypes: true});
    } catch {
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
        }
        continue;
      }

      if (LOCKFILE_NAMES.includes(entry.name)) {
        if (info.size <= MAX_REGISTRY_BYTES) {
          lockfiles.set(rel, fullPath);
        }
        continue;
      }

      if (entry.name === 'syft.cdx.json' || entry.name === 'sbom.cdx.json') {
        if (info.size <= MAX_REGISTRY_BYTES) {
          sbomFiles.push({rel, fullPath});
        }
        continue;
      }

      const ext = extname(entry.name).toLowerCase();
      if (JS_TS_EXTENSIONS.has(ext)) {
        if (info.size > MAX_FILE_BYTES) {
          skippedOversized += 1;
        } else if (sourceFiles.length < MAX_SOURCE_FILES) {
          sourceFiles.push({rel, fullPath, ext});
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
    skippedOversized,
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

/** Extracts minimal concrete semver from a range specifier like ^4.17.1 or ~1.2. */
export function minVersionFromSpec(spec) {
  if (typeof spec !== 'string') return null;
  const firstClause = spec.split('||')[0].trim();
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(firstClause);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Checks if concrete version satisfies a standard npm comparator/range (^, ~, >=, <=, >, <, =, ||). */
export function satisfiesRange(versionStr, rangeSpec) {
  const ver = parseSemver(versionStr);
  if (!ver || typeof rangeSpec !== 'string') return false;
  const trimmed = rangeSpec.trim();
  if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'x') return true;
  const clauses = trimmed.split('||').map(s => s.trim()).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.some(clause => {
    const tokens = clause.split(/\s+/).filter(Boolean);
    return tokens.every(token => {
      if (token === '*' || token.toLowerCase() === 'x') return true;
      if (token.startsWith('^')) {
        const base = minVersionFromSpec(token.slice(1));
        if (!base || compareSemver(ver, base) < 0) return false;
        if (base.major > 0) return ver.major === base.major;
        if (base.minor > 0) return ver.major === 0 && ver.minor === base.minor;
        return ver.major === 0 && ver.minor === 0 && ver.patch === base.patch;
      }
      if (token.startsWith('~')) {
        const base = minVersionFromSpec(token.slice(1));
        if (!base || compareSemver(ver, base) < 0) return false;
        return ver.major === base.major && ver.minor === base.minor;
      }
      if (token.startsWith('>=')) {
        const base = minVersionFromSpec(token.slice(2));
        return Boolean(base && compareSemver(ver, base) >= 0);
      }
      if (token.startsWith('<=')) {
        const base = minVersionFromSpec(token.slice(2));
        return Boolean(base && compareSemver(ver, base) <= 0);
      }
      if (token.startsWith('>')) {
        const base = minVersionFromSpec(token.slice(1));
        return Boolean(base && compareSemver(ver, base) > 0);
      }
      if (token.startsWith('<')) {
        const base = minVersionFromSpec(token.slice(1));
        return Boolean(base && compareSemver(ver, base) < 0);
      }
      const exact = parseSemver(token.replace(/^=/, ''));
      return Boolean(exact && compareSemver(ver, exact) === 0);
    });
  });
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
async function resolveRegistrySnapshot(customPath) {
  const candidates = [
    customPath,
    process.env.AC_DEPENDENCIAS_REGISTRY,
    '/databases/dependencias/registry.json',
    join(MODULE_DIR, 'offline-registry.json'),
    '/opt/dependencias-tools/offline-registry.json',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (String(candidate).includes('..') || String(candidate).includes('\0')) continue;
    const content = await readSafeRegularFile(candidate, MAX_REGISTRY_BYTES);
    if (!content) continue;
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {path: candidate, versions: parsed};
      }
    } catch {
      // ignore invalid candidate
    }
  }
  return null;
}

/** Executes npm-check-updates safely on isolated copies of package.json files. */
export async function runNcuCheck({manifests, workRoot, registry, ncuBin, ncuVersion, onlineMode}) {
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

  if (!onlineMode && !registry) {
    coverage.push({
      tool: 'npm-check-updates',
      version: ncuVersion,
      status: 'failed',
      detail: 'Registro offline JSON ausente e rede desabilitada.',
    });
    return {coverage, findings, ncuDetectedPackages};
  }

  const emptyCfgDir = join(workRoot, 'empty-cfg');
  await mkdir(emptyCfgDir, {recursive: true});

  let totalDeps = 0;
  let totalMatched = 0;
  let totalOutdated = 0;
  let toolFailed = false;
  let failMessage = '';

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
    } catch {
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
        status: 'ok',
        detail: `arquivo=${manifest.rel}; manifesto_invalido=true; achados=1`,
      });
      continue;
    }

    const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
    const sanitized = {
      name: typeof parsed.name === 'string' ? parsed.name : 'projeto',
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    };
    const depLocations = new Map();
    let fileDepCount = 0;
    let fileRegistryMatches = 0;

    for (const sec of sections) {
      const block = parsed[sec];
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      sanitized[sec] = {};
      for (const [pkg, spec] of Object.entries(block)) {
        if (typeof spec !== 'string') continue;
        sanitized[sec][pkg] = spec;
        fileDepCount += 1;
        totalDeps += 1;
        if (!depLocations.has(pkg)) depLocations.set(pkg, []);
        depLocations.get(pkg).push({section: sec, spec});
        if (registry && typeof registry.versions[pkg] === 'string') {
          fileRegistryMatches += 1;
          totalMatched += 1;
        }
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
      emptyCfgDir,
      '--configFileName',
      '.ncurc.nonexistent',
      '--packageFile',
      isoPkgPath,
    ];
    if (!onlineMode) {
      args.push('--registryType', 'json', '--registry', registry.path);
    }

    let ncuStdout = '';
    try {
      const res = await execFile(ncuBin, args, {
        cwd: isoDir,
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: workRoot,
          TMPDIR: workRoot,
          NO_UPDATE_NOTIFIER: '1',
          NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        },
      });
      ncuStdout = res.stdout;
    } catch (err) {
      toolFailed = true;
      failMessage = err instanceof Error ? err.message.slice(0, 240) : 'Falha ao executar npm-check-updates';
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
      upgraded = ncuStdout.trim() ? JSON.parse(ncuStdout) : {};
    } catch {
      toolFailed = true;
      failMessage = 'Saída JSON inválida de npm-check-updates.';
      coverage.push({
        tool: 'npm-check-updates',
        version: ncuVersion,
        status: 'failed',
        detail: `arquivo=${manifest.rel}; erro=${failMessage}`,
      });
      continue;
    }

    let fileOutdated = 0;
    for (const [pkg, targetSpec] of Object.entries(upgraded)) {
      if (typeof targetSpec !== 'string') continue;
      const entries = depLocations.get(pkg) || [{section: 'dependencies', spec: ''}];
      for (const entry of entries) {
        const risk = classifySemverRisk(entry.spec, targetSpec);
        const line = findLineInPackageJson(raw, pkg, entry.section);
        fileOutdated += 1;
        totalOutdated += 1;
        ncuDetectedPackages.add(`${manifest.rel}:${pkg}`);
        findings.push({
          tool: 'npm-check-updates',
          rule: risk.rule,
          file: manifest.rel,
          line,
          severity: risk.severity,
          message: `Dependência "${pkg}" desatualizada (${entry.spec} -> ${targetSpec}; risco ${risk.riskLabel}).`,
          evidence: `${entry.section}: "${pkg}": "${entry.spec}" -> "${pkg}": "${targetSpec}"`,
        });
      }
    }

    coverage.push({
      tool: 'npm-check-updates',
      version: ncuVersion,
      status: 'ok',
      detail: `arquivo=${manifest.rel}; dependencias=${fileDepCount}; verificadas_registro=${fileRegistryMatches}; desatualizadas=${fileOutdated}`,
    });
  }

  coverage.unshift({
    tool: 'npm-check-updates',
    version: ncuVersion,
    status: toolFailed ? 'failed' : 'ok',
    detail: toolFailed
      ? failMessage
      : `manifestos=${manifests.length}; dependencias=${totalDeps}; verificadas_registro=${totalMatched}; desatualizadas=${totalOutdated}; modo=${onlineMode ? 'online' : 'offline-json'}`,
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

/** Parses ast-grep --json=compact output into normalized findings. */
export function parseAstGrepJson(rawStdout, srcRootDir) {
  const trimmed = rawStdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) throw new Error('Saída ast-grep não é um array JSON.');

  const prefix = srcRootDir.endsWith(sep) ? srcRootDir : `${srcRootDir}${sep}`;
  const findings = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const rawFile = typeof item.file === 'string' ? item.file : '';
    const stripped = rawFile.startsWith(prefix) ? rawFile.slice(prefix.length) : rawFile;
    const file = toRepoRelPath(stripped, 'src');
    const zeroLine = item.range?.start?.line;
    const line = typeof zeroLine === 'number' && Number.isInteger(zeroLine) && zeroLine >= 0 ? zeroLine + 1 : 1;
    const ruleId = String(item.ruleId || 'ast-grep-rule')
      .replace(/-(ts|tsx|js|jsx)$/i, '')
      .toUpperCase();
    const rule = `ASTGREP-${ruleId}`;
    const severity = mapAstGrepSeverity(item.severity);
    const message = typeof item.message === 'string' && item.message.trim()
      ? item.message.trim()
      : `Padrão de API incompatível detectado pela regra ${rule}.`;
    const before = typeof item.text === 'string' ? item.text.trim() : '';
    const replacement = typeof item.replacement === 'string' ? item.replacement.trim() : '';
    const evidence = replacement
      ? `Original: ${before} | Reescrita pronta: ${replacement}`
      : before || String(item.lines || '').trim();
    findings.push({
      tool: 'ast-grep',
      rule,
      file,
      line,
      severity,
      message,
      evidence: evidence.slice(0, 600),
    });
  }
  return findings;
}

/** Runs ast-grep scan on isolated copy of JS/TS files. */
export async function runAstGrepCheck({sourceFiles, isoSrcDir, astGrepBin, astGrepVersion, sgConfigPath}) {
  const coverage = [];
  let findings = [];

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
  let exitCode = 0;
  let spawnError = null;
  try {
    const res = await execFile(
      astGrepBin,
      ['scan', '--config', sgConfigPath, '--json=compact', isoSrcDir],
      {
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
      }
    );
    stdout = res.stdout;
  } catch (err) {
    if (err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string') {
      stdout = err.stdout;
      exitCode = typeof err.code === 'number' ? err.code : 1;
    } else {
      spawnError = err instanceof Error ? err.message : 'Falha ao executar ast-grep';
    }
  }

  if (spawnError) {
    coverage.push({
      tool: 'ast-grep',
      version: astGrepVersion,
      status: 'failed',
      detail: spawnError.slice(0, 240),
    });
    return {coverage, findings};
  }

  try {
    findings = parseAstGrepJson(stdout, isoSrcDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Saída JSON inválida do ast-grep';
    coverage.push({
      tool: 'ast-grep',
      version: astGrepVersion,
      status: 'failed',
      detail: `exit=${exitCode}; erro=${msg.slice(0, 200)}`,
    });
    return {coverage, findings: []};
  }

  const countByFile = new Map();
  for (const f of findings) {
    countByFile.set(f.file, (countByFile.get(f.file) ?? 0) + 1);
  }

  coverage.push({
    tool: 'ast-grep',
    version: astGrepVersion,
    status: 'ok',
    detail: `arquivos=${sourceFiles.length}; achados=${findings.length}`,
  });
  for (const src of sourceFiles) {
    coverage.push({
      tool: 'ast-grep',
      version: astGrepVersion,
      status: 'ok',
      detail: `arquivo=${src.rel}; achados=${countByFile.get(src.rel) ?? 0}`,
    });
  }

  return {coverage, findings};
}

/** Runs jscodeshift codemod transforms on isolated writable copy and computes ready diffs. */
export async function runJscodeshiftCheck({
  sourceFiles,
  isoSrcDir,
  isoCodemodDir,
  workRoot,
  jscodeshiftBin,
  jscodeshiftVersion,
  transformPath,
}) {
  const coverage = [];
  const findings = [];

  if (sourceFiles.length === 0) {
    coverage.push({
      tool: 'jscodeshift',
      version: jscodeshiftVersion,
      status: 'skipped',
      detail: 'Nenhum arquivo JS/TS encontrado para codemods jscodeshift.',
    });
    return {coverage, findings};
  }

  const byParser = new Map([
    ['ts', []],
    ['tsx', []],
    ['babel', []],
  ]);

  for (const src of sourceFiles) {
    const target = join(isoCodemodDir, src.rel);
    if (src.ext === '.tsx' || src.ext === '.jsx') byParser.get('tsx').push(target);
    else if (src.ext === '.ts' || src.ext === '.mts' || src.ext === '.cts') byParser.get('ts').push(target);
    else byParser.get('babel').push(target);
  }

  const reportNdjson = join(workRoot, 'jscodeshift-matches.ndjson');
  await writeFile(reportNdjson, '', 'utf8');

  for (const [parser, files] of byParser.entries()) {
    if (files.length === 0) continue;
    try {
      await execFile(
        jscodeshiftBin,
        ['--run-in-band', '--silent', `--parser=${parser}`, '-t', transformPath, ...files],
        {
          timeout: TOOL_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
          env: {
            ...process.env,
            HOME: workRoot,
            TMPDIR: workRoot,
            AC_JSCODESHIFT_REPORT: reportNdjson,
          },
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 240) : 'Falha ao executar jscodeshift';
      coverage.push({
        tool: 'jscodeshift',
        version: jscodeshiftVersion,
        status: 'failed',
        detail: `parser=${parser}; erro=${msg}`,
      });
      return {coverage, findings: []};
    }
  }

  const rawReport = await readSafeRegularFile(reportNdjson, MAX_FILE_BYTES) || '';
  const matchEvents = [];
  for (const line of rawReport.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      matchEvents.push(JSON.parse(line));
    } catch {
      // ignore malformed line
    }
  }

  const prefix = isoCodemodDir.endsWith(sep) ? isoCodemodDir : `${isoCodemodDir}${sep}`;
  const countByFile = new Map();

  for (const src of sourceFiles) {
    const origText = await readFile(join(isoSrcDir, src.rel), 'utf8');
    const modText = await readFile(join(isoCodemodDir, src.rel), 'utf8');
    if (origText === modText) continue;

    const origLines = origText.split(/\r?\n/);
    const modLines = modText.split(/\r?\n/);
    const fileEvents = matchEvents.filter(ev => {
      const evFile = typeof ev.file === 'string' && ev.file.startsWith(prefix) ? ev.file.slice(prefix.length) : ev.file;
      return toRepoRelPath(evFile, '') === src.rel;
    });

    if (fileEvents.length > 0) {
      for (const ev of fileEvents) {
        const lineNum = typeof ev.line === 'number' && Number.isInteger(ev.line) && ev.line >= 1 ? ev.line : 1;
        const origLine = (origLines[lineNum - 1] ?? ev.before ?? '').trim();
        const modLine = (modLines[lineNum - 1] ?? ev.after ?? '').trim();
        const sev = VALID_SEVERITY.has(ev.severity) ? ev.severity : 'media';
        findings.push({
          tool: 'jscodeshift',
          rule: typeof ev.rule === 'string' && ev.rule ? ev.rule : 'JSCODESHIFT-REWRITE',
          file: src.rel,
          line: lineNum,
          severity: sev,
          message: typeof ev.message === 'string' && ev.message ? ev.message : 'Reescrita automática disponível via jscodeshift.',
          evidence: `Patch pronto:\n- ${origLine}\n+ ${modLine}`.slice(0, 600),
        });
        countByFile.set(src.rel, (countByFile.get(src.rel) ?? 0) + 1);
      }
    } else {
      let firstChangedLine = 1;
      for (let i = 0; i < Math.max(origLines.length, modLines.length); i += 1) {
        if (origLines[i] !== modLines[i]) {
          firstChangedLine = i + 1;
          break;
        }
      }
      findings.push({
        tool: 'jscodeshift',
        rule: 'JSCODESHIFT-AST-REWRITE',
        file: src.rel,
        line: firstChangedLine,
        severity: 'media',
        message: 'Transformação de atualização aplicável via jscodeshift.',
        evidence: `Patch pronto:\n- ${(origLines[firstChangedLine - 1] ?? '').trim()}\n+ ${(modLines[firstChangedLine - 1] ?? '').trim()}`.slice(0, 600),
      });
      countByFile.set(src.rel, (countByFile.get(src.rel) ?? 0) + 1);
    }
  }

  coverage.push({
    tool: 'jscodeshift',
    version: jscodeshiftVersion,
    status: 'ok',
    detail: `arquivos=${sourceFiles.length}; reescritas=${findings.length}`,
  });
  for (const src of sourceFiles) {
    coverage.push({
      tool: 'jscodeshift',
      version: jscodeshiftVersion,
      status: 'ok',
      detail: `arquivo=${src.rel}; reescritas=${countByFile.get(src.rel) ?? 0}`,
    });
  }

  return {coverage, findings};
}

/** Parses npm package name from CycloneDX purl (pkg:npm/...) or component.name. */
function npmNameFromCycloneDx(component) {
  if (typeof component?.purl === 'string' && component.purl.startsWith('pkg:npm/')) {
    const rest = component.purl.slice('pkg:npm/'.length).split('@')[0];
    return decodeURIComponent(rest);
  }
  return typeof component?.name === 'string' ? component.name : '';
}

/** Checks lockfile consistency and reuses Module 1 CycloneDX SBOM when present. */
export async function analyzeLockfileAndSbom({
  manifests,
  lockfiles,
  sbomFiles,
  registry,
  ncuDetectedPackages,
}) {
  const coverage = [];
  const findings = [];
  let checkedFiles = 0;
  let componentsScanned = 0;

  for (const manifest of manifests) {
    const rawPkg = await readSafeRegularFile(manifest.fullPath, MAX_FILE_BYTES);
    if (!rawPkg) continue;
    let parsedPkg;
    try {
      parsedPkg = JSON.parse(rawPkg);
    } catch {
      continue;
    }

    const dir = posix.dirname(manifest.rel);
    const lockRel = dir === '.' ? 'package-lock.json' : `${dir}/package-lock.json`;
    const hasAnyLock = LOCKFILE_NAMES.some(name => lockfiles.has(dir === '.' ? name : `${dir}/${name}`));

    const declaredEntries = [];
    for (const sec of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const block = parsedPkg[sec];
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      for (const [pkg, spec] of Object.entries(block)) {
        if (typeof spec === 'string') declaredEntries.push({sec, pkg, spec});
      }
    }

    if (declaredEntries.length > 0 && !hasAnyLock) {
      findings.push({
        tool: 'sbom-lockfile',
        rule: 'LOCKFILE-MISSING',
        file: manifest.rel,
        line: 1,
        severity: 'media',
        message: `Manifesto "${manifest.rel}" declara ${declaredEntries.length} dependência(s) sem arquivo de lock (package-lock.json/yarn.lock/pnpm-lock.yaml).`,
        evidence: `Manifesto ${manifest.rel} sem lockfile no diretório.`,
      });
      coverage.push({
        tool: 'sbom-lockfile',
        version: '1.0.0',
        status: 'ok',
        detail: `arquivo=${manifest.rel}; lockfile=ausente; achados=1`,
      });
      continue;
    }

    const lockFullPath = lockfiles.get(lockRel);
    if (!lockFullPath) continue;

    const rawLock = await readSafeRegularFile(lockFullPath, MAX_REGISTRY_BYTES);
    if (!rawLock) continue;

    let parsedLock;
    try {
      parsedLock = JSON.parse(rawLock);
    } catch {
      findings.push({
        tool: 'sbom-lockfile',
        rule: 'LOCKFILE-INVALID-JSON',
        file: lockRel,
        line: 1,
        severity: 'alta',
        message: `Arquivo ${lockRel} contém JSON inválido.`,
        evidence: 'JSON.parse falhou em package-lock.json.',
      });
      continue;
    }

    checkedFiles += 1;
    let fileFindings = 0;
    const packagesMap = parsedLock.packages && typeof parsedLock.packages === 'object' ? parsedLock.packages : {};
    const legacyDepsMap = parsedLock.dependencies && typeof parsedLock.dependencies === 'object' ? parsedLock.dependencies : {};

    for (const {sec, pkg, spec} of declaredEntries) {
      const pkgEntry = packagesMap[`node_modules/${pkg}`] ?? legacyDepsMap[pkg];
      const resolvedVer = typeof pkgEntry?.version === 'string' ? pkgEntry.version : null;

      if (!resolvedVer) {
        fileFindings += 1;
        findings.push({
          tool: 'sbom-lockfile',
          rule: 'LOCKFILE-DRIFT',
          file: lockRel,
          line: 1,
          severity: 'media',
          message: `Dependência "${pkg}" declarada em ${manifest.rel} (${sec}: "${spec}") está ausente de ${lockRel}.`,
          evidence: `Ausente em ${lockRel}: node_modules/${pkg}`,
        });
        continue;
      }

      componentsScanned += 1;
      const validSpec = Boolean(minVersionFromSpec(spec)) || isUnpinnedSpecifier(spec);
      if (validSpec && !satisfiesRange(resolvedVer, spec)) {
        fileFindings += 1;
        const line = findLineInPackageJson(rawLock, `node_modules/${pkg}`);
        findings.push({
          tool: 'sbom-lockfile',
          rule: 'LOCKFILE-VERSION-MISMATCH',
          file: lockRel,
          line,
          severity: 'alta',
          message: `Versão travada de "${pkg}" (${resolvedVer}) em ${lockRel} não satisfaz a faixa "${spec}" de ${manifest.rel}.`,
          evidence: `${manifest.rel}="${spec}" vs ${lockRel}="${resolvedVer}"`,
        });
        continue;
      }

      const latest = registry?.versions?.[pkg];
      const parsedResolved = parseSemver(resolvedVer);
      const parsedLatest = typeof latest === 'string' ? parseSemver(latest) : null;
      if (
        parsedResolved &&
        parsedLatest &&
        compareSemver(parsedResolved, parsedLatest) < 0 &&
        !ncuDetectedPackages.has(`${manifest.rel}:${pkg}`)
      ) {
        const risk = classifySemverRisk(resolvedVer, latest);
        fileFindings += 1;
        const line = findLineInPackageJson(rawLock, `node_modules/${pkg}`);
        findings.push({
          tool: 'sbom-lockfile',
          rule: 'LOCKFILE-OUTDATED-RESOLVED',
          file: lockRel,
          line,
          severity: risk.severity,
          message: `Versão travada em ${lockRel} para "${pkg}" (${resolvedVer}) está atrás da mais recente (${latest}; risco ${risk.riskLabel}).`,
          evidence: `${lockRel}: "${pkg}"@${resolvedVer} -> ${latest}`,
        });
      }
    }

    coverage.push({
      tool: 'sbom-lockfile',
      version: '1.0.0',
      status: 'ok',
      detail: `arquivo=${lockRel}; dependencias_verificadas=${declaredEntries.length}; achados=${fileFindings}`,
    });
  }

  // Reuse Module 1 CycloneDX SBOM if present in /databases, /input, or /repo
  const externalSboms = [];
  for (const path of SBOM_CANDIDATE_FILES) {
    const content = await readSafeRegularFile(path, MAX_REGISTRY_BYTES);
    if (content !== null) externalSboms.push({rel: path, content});
  }
  for (const sb of sbomFiles) {
    const content = await readSafeRegularFile(sb.fullPath, MAX_REGISTRY_BYTES);
    if (content !== null) externalSboms.push({rel: sb.rel, content});
  }

  for (const sb of externalSboms) {
    let parsed;
    try {
      parsed = JSON.parse(sb.content);
    } catch {
      continue;
    }
    if (!parsed || parsed.bomFormat !== 'CycloneDX' || !Array.isArray(parsed.components)) continue;
    checkedFiles += 1;
    let sbomFindings = 0;
    for (const comp of parsed.components) {
      const name = npmNameFromCycloneDx(comp);
      const version = typeof comp?.version === 'string' ? comp.version : '';
      const parsedVersion = parseSemver(version);
      if (!name || !parsedVersion) continue;
      componentsScanned += 1;
      const latest = registry?.versions?.[name];
      const parsedLatest = typeof latest === 'string' ? parseSemver(latest) : null;
      if (parsedLatest && compareSemver(parsedVersion, parsedLatest) < 0) {
        const alreadyReported = findings.some(f => f.evidence.includes(`"${name}"`)) ||
          Array.from(ncuDetectedPackages).some(k => k.endsWith(`:${name}`));
        if (alreadyReported) continue;
        const risk = classifySemverRisk(version, latest);
        sbomFindings += 1;
        const fileRef = sb.rel.startsWith('/') ? 'package.json' : sb.rel;
        findings.push({
          tool: 'sbom-lockfile',
          rule: 'SBOM-OUTDATED-COMPONENT',
          file: fileRef,
          line: 1,
          severity: risk.severity,
          message: `Componente SBOM "${name}"@${version} está desatualizado (mais recente: ${latest}; risco ${risk.riskLabel}).`,
          evidence: `SBOM (${sb.rel}): ${name}@${version} -> ${latest}`,
        });
      }
    }
    coverage.push({
      tool: 'sbom-lockfile',
      version: '1.0.0',
      status: 'ok',
      detail: `sbom=${sb.rel}; componentes=${parsed.components.length}; achados=${sbomFindings}`,
    });
  }

  coverage.unshift({
    tool: 'sbom-lockfile',
    version: '1.0.0',
    status: checkedFiles > 0 || findings.length > 0 ? 'ok' : 'skipped',
    detail: checkedFiles > 0 || findings.length > 0
      ? `artefatos=${checkedFiles}; componentes=${componentsScanned}; achados=${findings.length}`
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

    for (const src of discovered.sourceFiles) {
      const srcDest = join(isoSrcDir, src.rel);
      const codemodDest = join(isoCodemodDir, src.rel);
      await mkdir(dirname(srcDest), {recursive: true});
      await mkdir(dirname(codemodDest), {recursive: true});
      await copyFile(src.fullPath, srcDest);
      await copyFile(src.fullPath, codemodDest);
    }

    const ncuRes = await runNcuCheck({
      manifests: discovered.manifests,
      workRoot,
      registry,
      ncuBin,
      ncuVersion,
      onlineMode,
    });

    const astGrepRes = await runAstGrepCheck({
      sourceFiles: discovered.sourceFiles,
      isoSrcDir,
      astGrepBin,
      astGrepVersion,
      sgConfigPath,
    });

    const jscodeshiftRes = await runJscodeshiftCheck({
      sourceFiles: discovered.sourceFiles,
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

    if (discovered.skippedSymlinks > 0 || discovered.skippedOversized > 0) {
      optionalCoverage.push({
        tool: 'repo-guard',
        version: '1.0.0',
        status: 'ok',
        detail: `symlinks_ignorados=${discovered.skippedSymlinks}; arquivos_grandes_ignorados=${discovered.skippedOversized}`,
      });
    }

    const output = {
      coverage: [
        ...ncuRes.coverage,
        ...astGrepRes.coverage,
        ...jscodeshiftRes.coverage,
        ...sbomLockRes.coverage,
        ...optionalCoverage,
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
