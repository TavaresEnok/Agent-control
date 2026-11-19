import {readFile, writeFile} from 'node:fs/promises';
import {isUtf8} from 'node:buffer';
import https from 'node:https';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import semver from 'semver';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const NPM_REGISTRY = 'https://registry.npmjs.org/';

function fetchRelease(pkg, release, {get = https.get, timeoutMs = 10_000, maxBytes = 1024 * 1024} = {}) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let request;
    const finish = (err, metadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolvePromise(metadata);
    };
    const timer = setTimeout(() => {
      finish(new Error('timeout'));
      request?.destroy();
    }, timeoutMs);
    try {
      request = get(`${NPM_REGISTRY}${encodeURIComponent(pkg)}/${encodeURIComponent(release)}`, res => {
        res.on('error', err => finish(err));
        res.on('aborted', () => finish(new Error('resposta interrompida')));
        if (res.statusCode !== 200) {
          finish(Object.assign(new Error(`HTTP ${res.statusCode}`), {statusCode: res.statusCode}));
          res.destroy();
          request?.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new Error('limite de bytes'));
            res.destroy();
            request.destroy();
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks);
            if (!isUtf8(body)) throw new Error('resposta não é UTF-8');
            finish(null, JSON.parse(body.toString('utf8')));
          } catch (err) { finish(err); }
        });
      });
      request.on('error', err => finish(err));
    } catch (err) { finish(err); }
  });
}

export async function fetchLatestVersion(pkg, options) {
  const version = (await fetchRelease(pkg, 'latest', options))?.version;
  if (!semver.valid(version)) throw new Error('versão inválida');
  return version;
}

/** Confirms the exact published release of the package proposed by NCU. */
export async function fetchRegistryVersion(pkg, version, options) {
  try {
    const metadata = await fetchRelease(pkg, version, options);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || typeof metadata.name !== 'string' || !semver.valid(metadata.version)) throw new Error('metadados de versão inválidos');
    return metadata.name === pkg && metadata.version === version ? version : null;
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function main() {
  const base = JSON.parse(await readFile(join(MODULE_DIR, 'offline-registry.json'), 'utf8'));
  const updated = {};
  let failures = 0;
  for (const pkg of Object.keys(base).sort()) {
    try { updated[pkg] = await fetchLatestVersion(pkg); }
    catch (err) {
      failures += 1;
      updated[pkg] = base[pkg];
      process.stderr.write(`${pkg}: ${err.message}\n`);
    }
  }
  await writeFile(process.argv[2] || '/databases/dependencias/registry.json', `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  if (failures) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
