/**
 * Conferência de integridade dos lockfiles do Módulo 2 (QA pesado).
 * Executado no build da imagem antes do `npm ci` e também nos testes.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const baseDirectory = dirname(fileURLToPath(import.meta.url));
const versionPattern = /^\d+\.\d+\.\d+$/;
const pythonMeasurementTools = ['mutmut', 'pytest', 'hypothesis', 'libcst'];

function checkFileHash(file, expected) {
  const raw = readFileSync(file);
  if (createHash('sha256').update(raw).digest('hex') !== expected) {
    throw new Error(`QA_LANGUAGE_MEASUREMENT_LOCK_MISMATCH: ${file}`);
  }
  return raw.toString('utf8');
}

function verifyLanguageMeasurementLocks(baseDir, measurements) {
  const dir = join(baseDir, 'mutacao-linguagens');
  const {python, go} = measurements ?? {};
  const requirements = checkFileHash(join(dir, 'requirements.lock'), python?.requirementsSha256).split('\n');
  for (const tool of pythonMeasurementTools) {
    const version = python.versions?.[tool];
    if (!versionPattern.test(version) || !requirements.includes(`${tool}==${version} \\`)) {
      throw new Error(`QA_PYTHON_MEASUREMENT_PIN_INVALID: ${tool}`);
    }
  }

  const mod = checkFileHash(join(dir, 'go-mutesting/go.mod'), go?.modSha256).split('\n');
  const sums = checkFileHash(join(dir, 'go-mutesting/go.sum'), go?.sumSha256).split('\n');
  const module = 'github.com/avito-tech/go-mutesting';
  if (go.module !== module || !/^v\d+\.\d+\.\d+-\d{14}-[a-f0-9]{12}$/.test(go.version) ||
      !mod.includes(`require ${module} ${go.version}`) || ['', '/go.mod'].some(suffix =>
        !sums.some(line => line.startsWith(`${module} ${go.version}${suffix} h1:`)))) {
    throw new Error('QA_GO_MEASUREMENT_PIN_INVALID');
  }
}

function verifyInstalledLanguageTools(baseDir, {python, go}) {
  const dir = join(baseDir, 'mutacao-linguagens');
  const options = {encoding: 'utf8', timeout: 10_000};
  const installed = JSON.parse(execFileSync('/usr/local/bin/python3.12',
    ['-I', '-S', '-B', join(dir, 'python-runner.py'), 'probe', 'plan'], options));
  const planner = JSON.parse(execFileSync(join(dir, 'go-mutesting-plan'), ['--version'], options));
  if (pythonMeasurementTools.some(tool => installed[tool] !== python.versions[tool]) || planner !== go.version) {
    throw new Error('QA_LANGUAGE_MEASUREMENT_VERSION_MISMATCH');
  }
}

export function verifyQaLockfiles(baseDir = baseDirectory, verifyInstalled = false) {
  const pkgRaw = readFileSync(join(baseDir, 'package.json'), 'utf8');
  const lockRaw = readFileSync(join(baseDir, 'package-lock.json'));
  const pinRaw = readFileSync(join(baseDir, 'qa-tools.lock.json'), 'utf8');

  const pkg = JSON.parse(pkgRaw);
  const lock = JSON.parse(lockRaw.toString('utf8'));
  const pin = JSON.parse(pinRaw);

  const computedSha256 = createHash('sha256').update(lockRaw).digest('hex');
  if (computedSha256 !== pin.packageLockSha256) {
    throw new Error(`QA_LOCK_SHA256_MISMATCH: esperado ${pin.packageLockSha256}, obtido ${computedSha256}`);
  }

  if (!/^sha256:[a-f0-9]{64}$/.test(String(pin.baseImage?.digest ?? ''))) {
    throw new Error('QA_BASE_IMAGE_DIGEST_INVALID');
  }

  const {python, go, coverage} = pin.languageRuntimes ?? {};
  for (const [name, runtime] of [['python', python], ['golang', go]]) {
    if (!/^\d+\.\d+\.\d+$/.test(runtime?.version) ||
        !runtime.image?.startsWith(`docker.io/library/${name}:${runtime.version}-`) ||
        !/@sha256:[a-f0-9]{64}$/.test(runtime.image)) throw new Error('QA_LANGUAGE_RUNTIME_PIN_INVALID');
  }
  if (!/^\d+\.\d+\.\d+$/.test(coverage?.version) || !/^[a-f0-9]{64}$/.test(coverage.sha256) ||
      !coverage.url?.startsWith('https://files.pythonhosted.org/packages/') ||
      !coverage.url.endsWith(`/coverage-${coverage.version}-py3-none-any.whl`)) {
    throw new Error('QA_PYTHON_COVERAGE_PIN_INVALID');
  }
  verifyLanguageMeasurementLocks(baseDir, pin.languageMeasurements);
  if (verifyInstalled) verifyInstalledLanguageTools(baseDir, pin.languageMeasurements);

  const declaredDeps = pkg.dependencies ?? {};
  const pinnedDeps = pin.dependencies ?? {};
  const lockPackages = lock.packages ?? {};
  if (!pinnedDeps['playwright-core'] || !pin.baseImage.tag?.startsWith(`v${pinnedDeps['playwright-core'].version}-`)) {
    throw new Error('QA_PLAYWRIGHT_IMAGE_VERSION_MISMATCH');
  }

  for (const [name, meta] of Object.entries(pinnedDeps)) {
    if (declaredDeps[name] !== meta.version) {
      throw new Error(`QA_PKG_VERSION_MISMATCH: ${name}`);
    }
    const lockEntry = lockPackages[`node_modules/${name}`];
    if (!lockEntry) {
      throw new Error(`QA_LOCK_ENTRY_MISSING: ${name}`);
    }
    if (lockEntry.version !== meta.version) {
      throw new Error(`QA_LOCK_VERSION_MISMATCH: ${name}`);
    }
    if (lockEntry.integrity !== meta.integrity || !/^sha512-[A-Za-z0-9+/=]+$/.test(meta.integrity)) {
      throw new Error(`QA_LOCK_INTEGRITY_MISMATCH: ${name}`);
    }
    if (lockEntry.resolved !== meta.resolved || !meta.resolved.startsWith('https://registry.npmjs.org/')) {
      throw new Error(`QA_LOCK_RESOLVED_MISMATCH: ${name}`);
    }
  }

  for (const [pkgPath, entry] of Object.entries(lockPackages)) {
    if (pkgPath === '') continue;
    if (typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+/.test(entry.version)) {
      throw new Error(`QA_TRANSITIVE_VERSION_INVALID: ${pkgPath}`);
    }
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      throw new Error(`QA_TRANSITIVE_RESOLVED_INVALID: ${pkgPath}`);
    }
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      throw new Error(`QA_TRANSITIVE_INTEGRITY_INVALID: ${pkgPath}`);
    }
  }

  return {
    ok: true,
    packageLockSha256: computedSha256,
    toolCount: Object.keys(pinnedDeps).length,
    totalLockedPackages: Object.keys(lockPackages).length - 1,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyQaLockfiles(baseDirectory, process.argv.includes('--language-tools-installed'));
}
