import {readFile, writeFile} from 'node:fs/promises';
import https from 'node:https';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import semver from 'semver';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function fetchLatestVersion(pkg, {get = https.get, timeoutMs = 10_000, maxBytes = 1024 * 1024} = {}) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let request;
    const finish = (err, version) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolvePromise(version);
    };
    const timer = setTimeout(() => {
      finish(new Error('timeout'));
      request?.destroy();
    }, timeoutMs);
    try {
      request = get(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, res => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            request.destroy();
            finish(new Error('limite de bytes'));
          } else chunks.push(chunk);
        });
        res.on('error', err => finish(err));
        res.on('aborted', () => finish(new Error('resposta interrompida')));
        res.on('end', () => {
          try {
            const version = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.version;
            if (!semver.valid(version)) throw new Error('versão inválida');
            finish(null, version);
          } catch (err) { finish(err); }
        });
      });
      request.on('error', err => finish(err));
    } catch (err) { finish(err); }
  });
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
