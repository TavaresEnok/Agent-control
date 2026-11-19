import assert from 'node:assert/strict';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer, get} from 'node:http';
import {basename, dirname, join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const [, executable, ...args] = process.argv;
const modeFile = join(dirname(executable), 'mode');
const mode = existsSync(modeFile) ? readFileSync(modeFile, 'utf8') : '';
const loopback = '127.0.0.1';

async function listen(server) {
  await new Promise(resolve => server.listen(0, loopback, resolve));
  return server.address().port;
}

async function json(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function runProxy() {
  assert.deepEqual(args, ['-host=127.0.0.1', '-port=0']);
  writeFileSync(join(dirname(executable), 'proxy.pid'), String(process.pid));
  let proxy;
  let toxic;
  let delay = 0;
  await listen(createServer(async (request, response) => {
    const send = (status, body) => response.writeHead(status, {'content-type': 'application/json'})
      .end(body === undefined ? undefined : JSON.stringify(body));
    switch (`${request.method} ${request.url}`) {
      case 'POST /proxies': {
        assert.equal(proxy, undefined);
        proxy = await json(request);
        assert.deepEqual({...proxy, upstream: ''}, {name: 'qa-carga', listen: '127.0.0.1:0', upstream: '', enabled: true});
        assert.match(proxy.upstream, /^127\.0\.0\.1:\d+$/);
        const upstreamPort = Number(proxy.upstream.split(':')[1]);
        const port = await listen(createServer((incoming, outgoing) => {
          assert.equal(incoming.method, 'GET');
          assert.equal(incoming.url.startsWith('/'), true);
          const latency = delay;
          get({
            hostname: loopback, port: upstreamPort, path: incoming.url, agent: false,
            headers: {'x-qa-carga-fixture': incoming.headers['x-qa-carga-fixture']},
          }, upstream => {
            upstream.pause();
            setTimeout(() => {
              outgoing.writeHead(upstream.statusCode, upstream.headers);
              upstream.pipe(outgoing);
            }, latency);
          }).once('error', () => outgoing.writeHead(502).end());
        }));
        send(201, {...proxy, listen: `${loopback}:${port}`});
        break;
      }
      case 'POST /proxies/qa-carga/toxics':
        assert.equal(toxic, undefined);
        toxic = await json(request);
        assert.deepEqual(toxic, {
          name: 'qa-latencia', type: 'latency', stream: 'downstream', toxicity: 1,
          attributes: {latency: 250, jitter: 0},
        });
        if (mode !== 'no-delay') delay = toxic.attributes.latency;
        send(200, toxic);
        break;
      case 'DELETE /proxies/qa-carga/toxics/qa-latencia':
        assert.equal(toxic.name, 'qa-latencia');
        if (mode === 'delete-fails') {
          send(500);
          break;
        }
        toxic = undefined;
        if (mode !== 'sticky-delay') delay = 0;
        send(204);
        break;
      case 'GET /proxies/qa-carga/toxics':
        send(200, toxic ? [toxic] : []);
        break;
      default:
        send(404);
    }
  }));
}

async function timeGet(origin, route, token) {
  const start = performance.now();
  const response = await fetch(origin + route, {
    redirect: 'manual', headers: {'x-qa-carga-fixture': token},
    signal: AbortSignal.timeout(1000),
  });
  await response.arrayBuffer();
  return {duration: performance.now() - start, failed: response.status !== 200};
}

async function runK6() {
  const [run, usage, address, summaryArg, scriptFile] = args;
  assert.deepEqual([run, usage, address], ['run', '--no-usage-report', '--address=127.0.0.1:0']);
  assert.ok(summaryArg.startsWith('--summary-export='));
  const script = readFileSync(scriptFile, 'utf8');
  const field = name => JSON.parse(script.match(new RegExp(`^(?:export )?const ${name} = (.*);$`, 'm'))[1]);
  const {scenarios, discardResponseBodies, noConnectionReuse} = field('options');
  assert.equal(discardResponseBodies, true);
  assert.equal(noConnectionReuse, true);
  assert.deepEqual(scenarios.local, {
    executor: 'per-vu-iterations', vus: 2, iterations: 4, maxDuration: '5000ms', gracefulStop: '0s',
  });
  assert.match(script, /timeout: '1000ms', redirects: 0/);
  const origin = field('origin');
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const routes = field('routes');
  const token = field('token');
  const samples = new Map(routes.map(route => [route, []]));
  const partial = mode === 'partial' && basename(scriptFile) === 'degradada.js';
  await Promise.all(Array.from({length: scenarios.local.vus}, async () => {
    for (let i = 0; i < scenarios.local.iterations; i++) {
      for (const route of routes) {
        if (partial && route === '/catalogo' && i === 0) continue;
        samples.get(route).push(await timeGet(origin, route, token));
        await sleep(25);
      }
    }
  }));
  const metrics = {http_reqs: {values: {count: [...samples.values()].reduce((total, series) => total + series.length, 0)}}};
  for (const [path, series] of samples) {
    const tag = `{route:${path}}`;
    const durations = series.map(sample => sample.duration).sort((a, b) => a - b);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    metrics[`http_reqs${tag}`] = {values: {count: series.length}};
    metrics[`http_req_failed${tag}`] = {values: {rate: series.filter(sample => sample.failed).length / series.length}};
    metrics[`http_req_duration${tag}`] = {values: {'p(95)': p95}};
  }
  writeFileSync(summaryArg.slice('--summary-export='.length), JSON.stringify({metrics}));
  if (partial) process.exitCode = 99;
}

if (basename(executable) === 'k6') {
  if (args[0] === 'version') console.log(mode === 'wrong-version' ? 'k6 v2.4.1' : 'k6 v2.4.0');
  else await runK6();
} else if (args[0] === '-version') {
  console.log('toxiproxy-server version 2.12.0');
} else {
  await runProxy();
}
