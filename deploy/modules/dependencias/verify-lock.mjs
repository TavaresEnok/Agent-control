import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Verifies package.json, package-lock.json, offline-registry.json, and
 * (when node_modules is present) installed packages against dependencias-tools.lock.json.
 */
export function verifyDependenciasLock(root = '/opt/dependencias-tools') {
  const lockMeta = JSON.parse(readFileSync(join(root, 'dependencias-tools.lock.json'), 'utf8'));
  const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const npmLockBytes = readFileSync(join(root, 'package-lock.json'));
  const npmLock = JSON.parse(npmLockBytes.toString('utf8'));
  const regBytes = readFileSync(join(root, 'offline-registry.json'));

  const actualLockSha = createHash('sha256').update(npmLockBytes).digest('hex');
  if (actualLockSha !== lockMeta.packageLockSha256) {
    throw new Error(`package-lock.json sha256 mismatch: expected ${lockMeta.packageLockSha256}, got ${actualLockSha}`);
  }

  const actualRegSha = createHash('sha256').update(regBytes).digest('hex');
  if (actualRegSha !== lockMeta.offlineRegistrySha256) {
    throw new Error(`offline-registry.json sha256 mismatch: expected ${lockMeta.offlineRegistrySha256}, got ${actualRegSha}`);
  }

  for (const [name, declaredSpec] of Object.entries(pkgJson.dependencies || {})) {
    const locked = lockMeta.dependencies?.[name];
    if (!locked) {
      throw new Error(`Undeclared tool dependency in package.json: ${name}`);
    }
    if (declaredSpec !== locked.version) {
      throw new Error(`Unpinned or mismatched version in package.json for ${name}: ${declaredSpec} != ${locked.version}`);
    }
  }

  let totalLockedPackages = 0;
  for (const [pkgPath, entry] of Object.entries(npmLock.packages || {})) {
    if (!pkgPath) continue;
    totalLockedPackages += 1;
    if (!entry || typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      throw new Error(`Missing sha512 integrity in package-lock.json for ${pkgPath}`);
    }
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      throw new Error(`Untrusted resolved URL in package-lock.json for ${pkgPath}: ${entry?.resolved}`);
    }
  }

  const hasNodeModules = existsSync(join(root, 'node_modules'));
  for (const [name, expected] of Object.entries(lockMeta.dependencies || {})) {
    const pkg = npmLock.packages?.[`node_modules/${name}`];
    if (!pkg) throw new Error(`Missing package-lock entry for ${name}`);
    if (pkg.version !== expected.version || pkg.integrity !== expected.integrity || pkg.resolved !== expected.resolved) {
      throw new Error(`Lock entry mismatch for ${name}`);
    }
    if (hasNodeModules) {
      const installedPkgPath = join(root, 'node_modules', name, 'package.json');
      if (!existsSync(installedPkgPath)) {
        throw new Error(`Missing installed package in node_modules: ${name}`);
      }
      const installed = JSON.parse(readFileSync(installedPkgPath, 'utf8'));
      if (installed.version !== expected.version) {
        throw new Error(`Installed version mismatch for ${name}: expected ${expected.version}, got ${installed.version}`);
      }
    }
  }

  return {
    ok: true,
    packageLockSha256: actualLockSha,
    offlineRegistrySha256: actualRegSha,
    toolCount: Object.keys(lockMeta.dependencies || {}).length,
    totalLockedPackages,
  };
}

const isDirectEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectEntry) {
  const root = process.argv[2] || '/opt/dependencias-tools';
  const res = verifyDependenciasLock(root);
  const lockMeta = JSON.parse(readFileSync(join(root, 'dependencias-tools.lock.json'), 'utf8'));
  console.log(
    `Integrity check OK (${res.totalLockedPackages} locked packages): ${Object.keys(lockMeta.dependencies).join(', ')}`
  );
}
