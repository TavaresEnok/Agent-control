import {readFile, writeFile} from 'node:fs/promises';
import https from 'node:https';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const outPath = process.argv[2] || '/databases/dependencias/registry.json';
const basePath = join(MODULE_DIR, 'offline-registry.json');

function fetchLatestVersion(pkg) {
  return new Promise(resolve => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
    https
      .get(url, {timeout: 10_000}, res => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(typeof parsed.version === 'string' ? parsed.version : null);
          } catch {
            resolve(null);
          }
        });
      })
      .on('error', () => resolve(null));
  });
}

const base = JSON.parse(await readFile(basePath, 'utf8'));
const updated = {};
for (const pkg of Object.keys(base).sort()) {
  const latest = await fetchLatestVersion(pkg);
  updated[pkg] = latest || base[pkg];
}
await writeFile(outPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
