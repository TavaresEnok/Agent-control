import {lstatSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {limits, requestsPerPhase} from './limits.mjs';
import {command} from './processes.mjs';

const maxSummaryBytes = 64 * 1024;

function buildScript(origin, token, routes) {
  const thresholds = {http_reqs: [`count==${requestsPerPhase * routes.length}`]};
  for (const route of routes) {
    thresholds[`http_reqs{route:${route}}`] = [`count==${requestsPerPhase}`];
    thresholds[`http_req_duration{route:${route}}`] = [`p(95)<=${limits.processMs}`];
    thresholds[`http_req_failed{route:${route}}`] = ['rate==0'];
  }
  const options = {
    scenarios: {
      local: {
        executor: 'per-vu-iterations', vus: limits.vus, iterations: limits.iterationsPerVu,
        maxDuration: `${limits.phaseMs}ms`, gracefulStop: '0s',
      },
    },
    discardResponseBodies: true,
    noConnectionReuse: true,
    summaryTrendStats: ['p(95)'],
    thresholds,
  };
  return `import http from 'k6/http';
import {sleep} from 'k6';

export const options = ${JSON.stringify(options)};
const origin = ${JSON.stringify(origin)};
const token = ${JSON.stringify(token)};
const routes = ${JSON.stringify(routes)};

http.setResponseCallback(http.expectedStatuses(200));
export default function () {
  for (const route of routes) {
    http.get(origin + route, {
      tags: {route}, timeout: '${limits.requestMs}ms', redirects: 0, headers: {'x-qa-carga-fixture': token},
    });
    sleep(0.025);
  }
}
`;
}

function readMetrics(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maxSummaryBytes) throw new Error('QA_CARGA_K6_SUMMARY_LIMIT');
  const summary = JSON.parse(readFileSync(path, 'utf8'));
  return key => summary?.metrics?.[key]?.values ?? summary?.metrics?.[key];
}

export async function measurePhase({binary, cwd, phase, proxy, fixture, routes}) {
  proxy.assertReady();
  const script = join(cwd, `${phase}.js`);
  const summary = join(cwd, `${phase}.json`);
  const paths = routes.map(route => route.path);
  const before = new Map(paths.map(path => [path, fixture.count(path)]));
  writeFileSync(script, buildScript(proxy.origin, fixture.token, paths), {mode: 0o600});
  const result = await command(binary, [
    'run', '--no-usage-report', '--address=127.0.0.1:0', `--summary-export=${summary}`, script,
  ], cwd, proxy.signal, limits.processMs);
  // O k6 usa 99 para limiares violados, preservando as métricas que explicam a violação.
  if (result.code !== 0 && result.code !== 99) throw new Error('QA_CARGA_K6_RUN');
  const metrics = readMetrics(summary);
  const counts = paths.map(path => metrics(`http_reqs{route:${path}}`)?.count ?? 0);
  const consistentCount = counts.every(count => Number.isInteger(count) && count >= 0 && count <= requestsPerPhase) &&
    metrics('http_reqs')?.count === counts.reduce((total, count) => total + count, 0);
  const series = paths.map((path, i) => {
    const tag = `{route:${path}}`;
    const count = counts[i];
    const p95 = metrics(`http_req_duration${tag}`)?.['p(95)'];
    const failure = metrics(`http_req_failed${tag}`);
    const failRate = failure?.rate ?? failure?.value;
    const served = fixture.count(path) - before.get(path);
    const observed = count === requestsPerPhase && Number.isFinite(p95) && p95 >= 0 && p95 <= limits.processMs &&
      Number.isFinite(failRate) && failRate >= 0 && failRate <= 1;
    if (!observed) return [path, {reason: 'série incompleta ou inválida'}];
    const httpOk = failRate === 0 && served === requestsPerPhase && consistentCount;
    return [path, {count, p95, failRate, served, ...(httpOk ? {} : {reason: 'HTTP ou contagem da fixture divergente'})}];
  });
  if (result.code === 99 && series.every(([, sample]) => !sample.reason)) throw new Error('QA_CARGA_K6_EXIT');
  return new Map(series);
}
