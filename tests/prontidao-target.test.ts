import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import type {RequestListener} from 'node:http';
import {createServer, type Server} from 'node:https';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import type {Installation} from '../src/installation.ts';
import {
  authorizeProjectHttpsOrigin,
  MAX_PRONTIDAO_ORIGINS,
  probePublishedHttpsOrigins,
  resolveProjectAuthorizedOrigins,
} from '../src/prontidao-target.ts';

test('autoriza todas as origens declaradas, deduplica e mantém seleção individual acima da cota de medição', () => {
  const origins = Array.from({length: MAX_PRONTIDAO_ORIGINS}, (_, i) => `https://site-${i}.example.invalid`);
  const extra = 'https://outro.example.invalid:8443';
  const project = {id: 'fixture', publishedOrigin: `${origins[0]}/`, publishedOrigins: origins};
  const config = {project, projects: []} as unknown as Installation;
  assert.deepEqual(authorizeProjectHttpsOrigin(config, project.id), origins);
  const aboveLimit = {...config, publishedOrigins: [extra]};
  assert.deepEqual(resolveProjectAuthorizedOrigins(aboveLimit, project.id), [...origins, extra]);
  assert.deepEqual(authorizeProjectHttpsOrigin(aboveLimit, project.id, extra), [extra]);
  assert.deepEqual(authorizeProjectHttpsOrigin(aboveLimit, project.id), [...origins, extra]);
  assert.throws(() => authorizeProjectHttpsOrigin(config, project.id, extra),
    (err: unknown) => err instanceof Refusal && err.code === 'PRONTIDAO_ORIGIN_UNAUTHORIZED');
});

test('HTTPS local mede cada origem uma vez e cancela a requisição ativa e a fila', {timeout: 15_000}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'prontidao-target-'));
  const servers: Server[] = [];
  try {
    const crt = join(root, 'fixture.crt');
    const key = join(root, 'fixture.key');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', crt,
    ], {stdio: 'ignore'});
    const material = {cert: readFileSync(crt), key: readFileSync(key)};
    const start = async (handler: RequestListener) => {
      const server = createServer(material, handler);
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      return `https://127.0.0.1:${address.port}`;
    };

    const seen: {name: string; method: string | undefined; url: string | undefined; cookie: boolean; auth: boolean}[] = [];
    const second = await start((req, res) => {
      seen.push({name: 'second', method: req.method, url: req.url, cookie: req.headers.cookie !== undefined, auth: req.headers.authorization !== undefined});
      res.end('ok');
    });
    const disconnected = await start((_req, res) => {
      res.writeHead(200, {'Content-Length': '200'});
      res.write('texto parcial', () => { res.destroy(); });
    });
    let paused = false;
    let markInFlight!: () => void;
    let markClosed!: () => void;
    const inFlight = new Promise<void>(resolve => { markInFlight = resolve; });
    const closed = new Promise<void>(resolve => { markClosed = resolve; });
    const first = await start((req, res) => {
      seen.push({name: 'first', method: req.method, url: req.url, cookie: req.headers.cookie !== undefined, auth: req.headers.authorization !== undefined});
      if (paused) {
        res.once('close', markClosed);
        markInFlight();
        return;
      }
      res.writeHead(302, {
        Location: `${second}/redirect-nao-seguido`,
        'Set-Cookie': 'session=fixture-cookie',
        'Content-Security-Policy': "script-src 'nonce-dado-sintetico'; frame-ancestors 'self'",
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end('a'.repeat(4096));
    });
    const options = {ca: material.cert, maxResponseBytes: 64, timeoutMs: 3000};
    const evidence = await probePublishedHttpsOrigins([first, second], options);
    assert.deepEqual(seen, [
      {name: 'first', method: 'GET', url: '/', cookie: false, auth: false},
      {name: 'second', method: 'GET', url: '/', cookie: false, auth: false},
    ]);
    assert.deepEqual(evidence.targets.map(target => [target.origin, target.status]), [[first, 'ok'], [second, 'ok']]);
    assert.equal(evidence.targets[0]?.redirectTargetOrigin, second);
    assert.equal(evidence.targets[0]?.redirectCrossOrigin, true);
    assert.equal(evidence.targets[0]?.bytesRead, 64);
    assert.equal(evidence.targets[0]?.truncated, true);
    assert.equal(JSON.stringify(evidence).includes('fixture-cookie'), false);
    assert.equal(JSON.stringify(evidence).includes('nonce-dado-sintetico'), false);
    assert.deepEqual(evidence.targets[0]?.headers, {});
    assert.deepEqual(evidence.targets[0]?.headerFacts, {hsts:'adequate', noSniff:true, antiFrame:true});

    const limited = await probePublishedHttpsOrigins([
      ...Array<string>(MAX_PRONTIDAO_ORIGINS).fill(second), 'https://fora-da-cota.example.invalid',
    ], options);
    assert.equal(limited.targets.length, MAX_PRONTIDAO_ORIGINS);
    assert.deepEqual(limited.unmeasuredOrigins, ['https://fora-da-cota.example.invalid']);
    const partial = await probePublishedHttpsOrigins([disconnected], options);
    assert.equal(partial.targets[0]?.status, 'failed');
    assert.equal(partial.targets[0]?.errorCode, 'ECONNRESET');
    seen.length = 0;

    paused = true;
    const controller = new AbortController();
    const failure = new Refusal('VERIFY_LEASE_LOST');
    const probing = probePublishedHttpsOrigins([first, second], {...options, signal: controller.signal});
    const stopped = assert.rejects(probing, failure);
    await inFlight;
    controller.abort(failure);
    await Promise.all([stopped, closed]);
    assert.deepEqual(seen.map(request => request.name), ['first']);
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    })));
    rmSync(root, {recursive: true, force: true});
  }
});
