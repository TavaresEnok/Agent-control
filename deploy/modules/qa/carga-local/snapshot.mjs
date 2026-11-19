import {randomBytes} from 'node:crypto';
import {closeSync, constants, fstatSync, openSync, readSync, realpathSync} from 'node:fs';
import {createServer} from 'node:http';
import {extname, join} from 'node:path';
import {limits, phases, requestsPerPhase} from './limits.mjs';

export const manifestFile = 'qa-carga-local.json';
export const loopback = '127.0.0.1';

const segment = '[A-Za-z0-9][A-Za-z0-9._-]*';
const routePath = new RegExp(`^/(?:${segment}(?:/${segment})*)?$`);
const publicFile = new RegExp(`^public/${segment}(?:/${segment})*$`);
const mime = new Map([
  ['.json', 'application/json'],
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
]);

function readBounded(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('QA_CARGA_FILE_LIMIT');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const size = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!size) break;
      offset += size;
    }
    if (offset > maxBytes) throw new Error('QA_CARGA_FILE_LIMIT');
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function readSnapshotFile(root, file, maxBytes) {
  const path = join(root, file);
  if (realpathSync(path) !== path) throw new Error('QA_CARGA_FILE_LINK');
  return readBounded(path, maxBytes);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validRoute(route) {
  return exactKeys(route, ['path', 'file']) &&
    typeof route.path === 'string' && route.path.length <= 80 && routePath.test(route.path) &&
    route.path.trim() === route.path &&
    typeof route.file === 'string' && route.file.length <= 120 && publicFile.test(route.file) &&
    mime.has(extname(route.file));
}

export function readLoadPlan(workspace, copiedFiles) {
  const files = new Set(copiedFiles);
  if (!files.has(manifestFile)) return {status: 'skipped', reason: `${manifestFile} ausente do snapshot`};
  let root;
  let plan;
  try {
    root = realpathSync(workspace);
    plan = JSON.parse(readSnapshotFile(root, manifestFile, limits.manifestBytes).toString('utf8'));
  } catch {
    return {status: 'failed', reason: 'manifesto ilegível, inválido ou acima de 4 KiB'};
  }
  if (!exactKeys(plan, ['version', 'routes']) || plan.version !== 1 || !Array.isArray(plan.routes) ||
      !plan.routes.length || plan.routes.length > limits.routes || !plan.routes.every(validRoute) ||
      new Set(plan.routes.map(route => route.path)).size !== plan.routes.length) {
    return {status: 'failed', reason: 'declaração inválida de rotas GET estáticas'};
  }
  const routes = plan.routes.map(route => {
    if (!files.has(route.file)) return {...route, status: 'skipped', reason: 'arquivo ausente do snapshot'};
    try {
      const body = readSnapshotFile(root, route.file, limits.bodyBytes);
      return {...route, body, contentType: mime.get(extname(route.file))};
    } catch {
      return {...route, status: 'failed', reason: 'arquivo ilegível, não regular ou acima de 4 KiB'};
    }
  });
  return {routes};
}

// Adaptado do servidor estático do módulo 7. As respostas vêm apenas dos arquivos já validados.
export async function startStaticFixture(routes) {
  const token = randomBytes(16).toString('hex');
  const entries = new Map(routes.map(route => [route.path, {...route, count: 0}]));
  const server = createServer({maxHeaderSize: 4096}, (req, res) => {
    const entry = entries.get(req.url);
    const headers = {'cache-control': 'no-store', connection: 'close'};
    if (req.headers['x-qa-carga-fixture'] !== token || !entry) {
      res.writeHead(404, headers).end();
    } else if (req.method !== 'GET') {
      res.writeHead(405, {...headers, allow: 'GET'}).end();
    } else if (entry.count >= requestsPerPhase * phases.length) {
      res.writeHead(429, headers).end();
    } else {
      entry.count++;
      res.writeHead(200, {...headers, 'content-type': entry.contentType, 'content-length': entry.body.length});
      res.end(entry.body);
    }
  });
  server.requestTimeout = limits.requestMs;
  server.headersTimeout = limits.requestMs;
  server.maxConnections = limits.vus * 2;
  server.maxRequestsPerSocket = 1;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, loopback, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    token,
    count: path => entries.get(path).count,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}
