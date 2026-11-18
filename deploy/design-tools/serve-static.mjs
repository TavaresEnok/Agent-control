/** Servidor estático sem atraso. Só GET e HEAD, sem listar diretório. */
import {createServer} from 'node:http';
import {readFile, realpath, stat} from 'node:fs/promises';
import {extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function staysInside(rootReal, candidate) {
  const rel = relative(rootReal, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function relativeParts(urlPath) {
  const raw = String(urlPath ?? '/').split('?')[0] ?? '';
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

async function locate(root, parts) {
  let rootReal;
  try {
    rootReal = await realpath(root);
  } catch {
    return null;
  }
  const rootInfo = await stat(rootReal).catch(() => undefined);
  if (!rootInfo?.isDirectory()) return null;
  let candidate = rootReal;
  for (const part of parts) candidate = join(candidate, part);
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
    let indexReal;
    try {
      indexReal = await realpath(indexPath);
    } catch {
      return null;
    }
    if (!staysInside(rootReal, indexReal)) return null;
    const indexInfo = await stat(indexReal).catch(() => undefined);
    if (!indexInfo?.isFile()) return null;
    return {real: indexReal, info: indexInfo};
  }
  if (!info.isFile()) return null;
  return {real, info};
}

function write(res, status, method, body, headers) {
  res.writeHead(status, {'cache-control': 'no-store', ...headers});
  if (method === 'HEAD') res.end();
  else res.end(body);
}

/**
 * @param {string} [root] pasta dos arquivos. Sem argumento, usa DESIGN_STATIC_ROOT ou `/srv`.
 * @returns {import('node:http').Server}
 */
export function createStaticServer(root) {
  const fromEnv = process.env.DESIGN_STATIC_ROOT;
  const base = typeof root === 'string' && root.length > 0
    ? root
    : (typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : '/srv');
  return createServer((req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    const fail = status => write(res, status, method === 'HEAD' ? 'HEAD' : 'GET', status === 405 ? 'método não permitido' : 'ausente', {
      'content-type': 'text/plain; charset=utf-8',
      ...(status === 405 ? {allow: 'GET, HEAD'} : {}),
    });
    if (method !== 'GET' && method !== 'HEAD') {
      write(res, 405, method, 'método não permitido', {'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD'});
      return;
    }
    const parts = relativeParts(req.url ?? '/');
    if (!parts) {
      fail(404);
      return;
    }
    locate(base, parts).then(async found => {
      if (!found) {
        fail(404);
        return;
      }
      const type = TYPES[extname(found.real).toLowerCase()] ?? 'application/octet-stream';
      if (method === 'HEAD') {
        write(res, 200, method, '', {'content-type': type, 'content-length': String(found.info.size)});
        return;
      }
      const bytes = await readFile(found.real);
      write(res, 200, method, bytes, {'content-type': type, 'content-length': String(bytes.length)});
    }).catch(() => {
      if (!res.headersSent) fail(404);
      else res.destroy();
    });
  });
}

function chosenRoot() {
  const fromEnv = process.env.DESIGN_STATIC_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const arg = process.argv[2];
  if (typeof arg === 'string' && arg.length > 0 && !arg.startsWith('-')) return arg;
  return '/srv';
}

const entryArg = process.argv[1];
if (entryArg && import.meta.url === pathToFileURL(resolve(entryArg)).href) {
  const parsed = Number(process.env.DESIGN_STATIC_PORT ?? 8080);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 8080;
  createStaticServer(chosenRoot()).listen(port, '0.0.0.0');
}
