/** Servidor estático local (127.0.0.1) somente leitura, GET/HEAD, sem listagem de diretórios. */
import {createServer} from 'node:http';
import {readFile, realpath, stat} from 'node:fs/promises';
import {extname, isAbsolute, join, relative, sep} from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function staysInside(rootReal, candidate) {
  const rel = relative(rootReal, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function parseUrlParts(urlPath) {
  const raw = String(urlPath ?? '/').split('?')[0] ?? '/';
  if (raw.length < 1 || raw.length > 2048) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const parts = [];
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts;
}

async function resolveTarget(rootReal, parts) {
  let candidate = rootReal;
  for (const part of parts) {
    candidate = join(candidate, part);
  }
  if (!staysInside(rootReal, candidate)) return null;
  let real;
  try {
    real = await realpath(candidate);
  } catch {
    return null;
  }
  if (!staysInside(rootReal, real)) return null;
  const info = await stat(real).catch(() => undefined);
  if (!info) return null;
  if (info.isDirectory()) {
    const indexPath = join(real, 'index.html');
    const indexReal = await realpath(indexPath).catch(() => null);
    if (!indexReal || !staysInside(rootReal, indexReal)) return null;
    const indexInfo = await stat(indexReal).catch(() => undefined);
    if (!indexInfo?.isFile()) return null;
    return {real: indexReal, size: indexInfo.size};
  }
  if (!info.isFile()) return null;
  return {real, size: info.size};
}

export async function startStaticServer(rootDir, {aliasRoot = rootDir, aliases = new Map(), mount} = {}) {
  const rootReal = await realpath(rootDir);
  const aliasRootReal = aliases.size ? await realpath(aliasRoot) : rootReal;
  const mountRootReal = mount && await realpath(mount.root);
  const server = createServer((req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, {'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD', 'cache-control': 'no-store'});
      res.end('método não permitido');
      return;
    }
    const parts = parseUrlParts(req.url ?? '/');
    if (!parts) {
      res.writeHead(404, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
      res.end('ausente');
      return;
    }
    const alias = aliases.get(req.url);
    let target;
    if (alias) target = resolveTarget(aliasRootReal, alias.split('/'));
    else if (mount && parts[0] === mount.segment) target = resolveTarget(mountRootReal, parts.slice(1));
    else target = resolveTarget(rootReal, parts);
    target
      .then(async found => {
        if (!found) {
          res.writeHead(404, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
          res.end('ausente');
          return;
        }
        const type = MIME_TYPES[extname(found.real).toLowerCase()] ?? 'application/octet-stream';
        if (method === 'HEAD') {
          res.writeHead(200, {'content-type': type, 'content-length': String(found.size), 'cache-control': 'no-store'});
          res.end();
          return;
        }
        const body = await readFile(found.real);
        res.writeHead(200, {'content-type': type, 'content-length': String(body.length), 'cache-control': 'no-store'});
        res.end(body);
      })
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
          res.end('erro');
        } else {
          res.destroy();
        }
      });
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolveClose => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    }),
  };
}

// CLI separado: o processo do coletor pode aguardar ferramentas síncronas sem bloquear HTTP.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const server = await startStaticServer(process.argv[2]);
  process.stdout.write(`${server.origin}\n`);
  process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
}
