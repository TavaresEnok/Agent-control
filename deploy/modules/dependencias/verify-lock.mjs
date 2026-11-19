import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const root = process.argv[2] || '/opt/dependencias-tools';
const lockMeta = JSON.parse(readFileSync(join(root, 'dependencias-tools.lock.json'), 'utf8'));
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

for (const [name, expected] of Object.entries(lockMeta.dependencies)) {
  const pkg = npmLock.packages?.[`node_modules/${name}`];
  if (!pkg) throw new Error(`Missing package-lock entry for ${name}`);
  if (pkg.version !== expected.version || pkg.integrity !== expected.integrity || pkg.resolved !== expected.resolved) {
    throw new Error(`Lock entry mismatch for ${name}`);
  }
}

console.log('Integrity check OK:', Object.keys(lockMeta.dependencies).join(', '));
