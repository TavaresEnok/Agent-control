import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, request as httpRequest, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {assertTargetOnly, dynamicScanPlan} from '../src/verify-dynamic.ts';

// Laboratório fora do npm test: o classificador procura docker run neste arquivo.

type CommandResult = {code: number; stdout: string; stderr: string};

function run(bin: string, args: string[], timeoutMs = 20000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({code: code ?? 1, stdout, stderr}); });
  });
}

async function which(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const full = join(dir, name);
    try { await access(full, constants.X_OK); return full; }
    catch { /* próximo diretório */ }
  }
  return null;
}

async function runtimeBin(): Promise<string | null> {
  const specifier = '../src/verify-image.ts';
  try {
    const mod = await import(specifier) as {VERIFY_RUNTIME_BIN?: string};
    const candidate = mod.VERIFY_RUNTIME_BIN;
    if (typeof candidate === 'string' && candidate.length > 0) {
      if (candidate.includes('/')) {
        try { await access(candidate, constants.X_OK); return candidate; }
        catch { /* o caminho exportado não é executável */ }
      }
      const found = await which(candidate);
      if (found) return found;
    }
  } catch { /* a imagem ainda não exporta o binário */ }
  try { await access('/usr/bin/docker', constants.X_OK); return '/usr/bin/docker'; }
  catch { return null; }
}

function listen(body: string): Promise<{port: number; hits: () => number; close: () => Promise<void>}> {
  return new Promise(resolve => {
    let hits = 0;
    const server = createServer((req, res) => { hits += 1; res.end(body); void req; });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('HTTP fora de 127.0.0.1');
      resolve({
        port: address.port,
        hits: () => hits,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

test('processo na rede de homologação alcança a URL declarada e não alcança o segundo porto', async t => {
  const bin = await runtimeBin();
  if (!bin) { t.skip('binário do runtime de contêiner ausente'); return; }
  const image = await run(bin, ['image', 'inspect', 'node:20']);
  if (image.code !== 0) { t.skip('imagem node:20 ausente; sem baixar'); return; }
  const allowed = await listen('declarado');
  const other = await listen('outro');
  const declared = `http://127.0.0.1:${allowed.port}/saude`;
  const plan = dynamicScanPlan(declared);
  assert.equal(plan.network, 'verify-homologation');
  assert.equal(plan.allowedHost, '127.0.0.1');
  assert.equal(plan.allowedPort, allowed.port);
  assert.doesNotThrow(() => assertTargetOnly(declared, `${plan.allowedHost}:${plan.allowedPort}`));
  assert.throws(() => assertTargetOnly(declared, `127.0.0.1:${other.port}`), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_TARGET_ESCAPE');
  const network = `verify-homologation-${process.pid.toString(16)}`;
  const scratch = await mkdtemp(join(tmpdir(), 'ac-verify-dynamic-'));
  const probe = join(scratch, 'probe.mjs');
  let forwarder: Server | null = null;
  try {
    const created = await run(bin, ['network', 'create', '--internal', network]);
    assert.equal(created.code, 0, created.stderr);
    const inspected = await run(bin, ['network', 'inspect', network, '--format', '{{(index .IPAM.Config 0).Gateway}}']);
    const gateway = inspected.stdout.trim();
    assert.match(gateway, /^\d{1,3}(?:\.\d{1,3}){3}$/);
    const proxyPort = await new Promise<number>(resolve => {
      forwarder = createServer((req, res) => {
        const upstream = httpRequest({
          host: '127.0.0.1', port: allowed.port, path: req.url, method: req.method ?? 'GET',
          headers: {host: `127.0.0.1:${allowed.port}`},
        }, up => { res.writeHead(up.statusCode ?? 200); up.pipe(res); });
        upstream.on('error', () => { res.statusCode = 502; res.end(); });
        req.pipe(upstream);
      });
      forwarder.listen(0, gateway, () => {
        const address = forwarder?.address();
        if (!address || typeof address === 'string') throw new Error('encaminhador sem porto');
        resolve(address.port);
      });
    });
    await writeFile(probe, `
const route = await import('node:fs').then(fs => fs.readFileSync('/proc/net/route', 'utf8'));
const hasDefault = route.trim().split('\\n').slice(1).some(line => line.split('\\t')[1] === '00000000');
const [proxy, directAllowed, otherGateway, otherLoopback] = process.argv.slice(2);
async function hit(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const response = await fetch(url, {signal: ctrl.signal, redirect: 'manual'});
    return {ok: true, status: response.status, body: await response.text()};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.name : 'erro'};
  } finally { clearTimeout(timer); }
}
const results = {};
for (const [name, url] of [['proxy', proxy], ['directAllowed', directAllowed], ['otherGateway', otherGateway], ['otherLoopback', otherLoopback]]) results[name] = await hit(url);
console.log(JSON.stringify({hasDefault, results}));
`, {mode: 0o644});
    const probed = await run(bin, [
      'run', '--rm', '--network', network, '-v', `${probe}:/probe.mjs:ro`, 'node:20', 'node', '/probe.mjs',
      `http://${gateway}:${proxyPort}/saude`,
      `http://${gateway}:${allowed.port}/saude`,
      `http://${gateway}:${other.port}/saude`,
      `http://127.0.0.1:${other.port}/saude`,
    ], 30000);
    assert.equal(probed.code, 0, probed.stderr);
    const report = JSON.parse(probed.stdout) as {hasDefault: boolean; results: Record<string, {ok: boolean; body?: string}>};
    assert.equal(report.hasDefault, false);
    assert.equal(report.results.proxy.ok, true);
    assert.equal(report.results.proxy.body, 'declarado');
    assert.equal(report.results.directAllowed.ok, false);
    assert.equal(report.results.otherGateway.ok, false);
    assert.equal(report.results.otherLoopback.ok, false);
    assert.equal(allowed.hits(), 1);
    assert.equal(other.hits(), 0);
  } finally {
    if (forwarder) await new Promise<void>(done => forwarder?.close(() => done()));
    await allowed.close();
    await other.close();
    await run(bin, ['network', 'rm', network]);
    await rm(scratch, {recursive: true, force: true});
  }
});
