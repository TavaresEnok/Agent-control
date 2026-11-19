/**
 * Conferência de integridade dos lockfiles do Módulo 2 (QA pesado).
 * Executado no build da imagem antes do `npm ci` e também nos testes.
 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function verifyQaLockfiles(baseDir = dirname(fileURLToPath(import.meta.url))) {
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

  const declaredDeps = pkg.dependencies ?? {};
  const pinnedDeps = pin.dependencies ?? {};
  const lockPackages = lock.packages ?? {};

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

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyQaLockfiles();
}
