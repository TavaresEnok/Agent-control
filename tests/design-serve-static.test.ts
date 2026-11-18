import {test} from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest, type Server} from 'node:http';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Refusal} from '../src/contracts.ts';
import {parseDesignArgs, parseDesignInvocation} from '../src/design-command.ts';
import {designCliFailureText, routesFromStaticFolder} from '../src/personal-design-cli.ts';

const {createStaticServer} = await import(new URL('../deploy/design-tools/serve-static.mjs', import.meta.url).href) as {
  createStaticServer: (root?: string) => Server;
};

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const HTML = '<!doctype html><title>inicio</title>';
const CSS = 'body{color:#123}';
const SECRET = 'NAO-VAZAR-FORA';

function call(port: number, path: string, method = 'GET'): Promise<{status: number; type: string; cache: string; body: Buffer; ms: number}> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest({hostname: '127.0.0.1', port, path, method}, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const type = res.headers['content-type'];
        const cache = res.headers['cache-control'];
        resolve({
          status: res.statusCode ?? 0,
          type: Array.isArray(type) ? type.join(',') : type ?? '',
          cache: Array.isArray(cache) ? cache.join(',') : cache ?? '',
          body: Buffer.concat(chunks),
          ms: performance.now() - started,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('sem porta'));
        return;
      }
      resolve(address.port);
    });
  });
}

test('serve-static entrega MIME, recusa POST, bloqueia .. e não lista diretório', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'design-static-'));
  const root = join(parent, 'site');
  const previous = process.env.DESIGN_STATIC_ROOT;
  process.env.DESIGN_STATIC_ROOT = root;
  let server: Server | undefined;
  try {
    await mkdir(join(root, 'sem-indice'), {recursive: true});
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'index.html'), HTML);
    await writeFile(join(root, 'site.css'), CSS);
    await writeFile(join(root, 'pixel.png'), PNG);
    await writeFile(join(root, 'sem-indice', 'irmao.txt'), 'nao-listar');
    await writeFile(join(root, 'vizinho.html'), '<p>vizinho</p>');
    await writeFile(join(root, 'docs', 'index.html'), '<p>indice-docs</p>');
    await writeFile(join(parent, 'segredo.txt'), SECRET);
    await symlink(join(parent, 'segredo.txt'), join(root, 'atalho.txt'));
    const running = createStaticServer();
    server = running;
    const port = await listen(running);

    const home = await call(port, '/');
    assert.equal(home.status, 200);
    assert.equal(home.type, 'text/html; charset=utf-8');
    assert.equal(home.cache, 'no-store');
    assert.equal(home.body.toString('utf8'), HTML);
    assert.ok(home.ms < 500);

    const index = await call(port, '/index.html');
    assert.equal(index.status, 200);
    assert.equal(index.type, 'text/html; charset=utf-8');
    assert.equal(index.body.toString('utf8'), HTML);

    const css = await call(port, '/site.css');
    assert.equal(css.status, 200);
    assert.equal(css.type, 'text/css; charset=utf-8');
    assert.equal(css.body.toString('utf8'), CSS);

    const png = await call(port, '/pixel.png');
    assert.equal(png.status, 200);
    assert.equal(png.type, 'image/png');
    assert.equal(png.body.equals(PNG), true);

    const posted = await call(port, '/', 'POST');
    assert.equal(posted.status, 405);

    for (const path of ['/../segredo.txt', '/%2e%2e/segredo.txt', '/css/../../segredo.txt', '/atalho.txt']) {
      const escaped = await call(port, path);
      assert.notEqual(escaped.status, 200);
      assert.equal(escaped.body.includes(SECRET), false);
    }

    for (const path of ['/sem-indice', '/sem-indice/']) {
      const listed = await call(port, path);
      assert.equal(listed.status, 404);
      assert.equal(listed.body.toString('utf8').includes('irmao.txt'), false);
      assert.equal(listed.body.toString('utf8').includes('vizinho.html'), false);
    }

    const nested = await call(port, '/docs');
    assert.equal(nested.status, 200);
    assert.equal(nested.type, 'text/html; charset=utf-8');
    assert.equal(nested.body.toString('utf8').includes('indice-docs'), true);
  } finally {
    if (previous === undefined) delete process.env.DESIGN_STATIC_ROOT;
    else process.env.DESIGN_STATIC_ROOT = previous;
    const running = server;
    if (running) await new Promise<void>(resolve => running.close(() => resolve()));
    await rm(parent, {recursive: true, force: true});
  }
});

test('URL 127.0.0.1 sem --servir é inalcançável e com --servir a invocação guarda a pasta', () => {
  const projectId = randomUUID();
  const folder = 'painel_provedores/html_app';
  assert.throws(
    () => parseDesignInvocation(['instalacao.json', projectId, '--url', 'http://127.0.0.1:8080']),
    (error: unknown) => {
      assert.ok(error instanceof Refusal);
      assert.equal(error.code, 'DESIGN_TARGET_UNREACHABLE');
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.throws(
    () => parseDesignArgs(['instalacao.json', projectId, '--url', 'http://localhost:8080']),
    (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_TARGET_UNREACHABLE' && error.status === 400,
  );
  const invocation = parseDesignInvocation(['instalacao.json', projectId, '--servir', folder, '--url', 'http://127.0.0.1:8080']);
  assert.equal(invocation.kind, 'exam');
  if (invocation.kind !== 'exam') return;
  assert.equal(invocation.serveDir, folder);
  const text = designCliFailureText(new Refusal('DESIGN_TARGET_UNREACHABLE', 400));
  assert.match(text, /--servir <pasta>/);
  assert.match(text, /localhost/);
  assert.match(designCliFailureText(new Refusal('DESIGN_SERVE_INVALID', 400)), /diretório/);
  const allowed = parseDesignInvocation(['instalacao.json', projectId, '--url', 'http://design-lab.local:8080']);
  assert.equal(allowed.kind, 'exam');
  if (allowed.kind === 'exam') assert.equal(allowed.serveDir, undefined);
});

test('a descoberta de --servir mapeia index, ignora node_modules e limita a profundidade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-routes-'));
  try {
    await mkdir(join(root, 'item'), {recursive: true});
    await mkdir(join(root, 'node_modules'), {recursive: true});
    await mkdir(join(root, 'a', 'b', 'c', 'd'), {recursive: true});
    await writeFile(join(root, 'index.html'), '<p>raiz</p>\n');
    await writeFile(join(root, 'painel.html'), '<p>painel</p>\n');
    await writeFile(join(root, 'item', 'detalhe.html'), '<p>detalhe</p>\n');
    await writeFile(join(root, 'node_modules', 'skip.html'), '<p>nao</p>\n');
    await writeFile(join(root, 'a', 'b', 'c', 'ok.html'), '<p>quatro</p>\n');
    await writeFile(join(root, 'a', 'b', 'c', 'd', 'fundo.html'), '<p>fundo</p>\n');
    const routes = (await routesFromStaticFolder(root)).map(item => item.route);
    assert.deepEqual(routes, ['/a/b/c/ok.html', '/', '/item/detalhe.html', '/painel.html']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
