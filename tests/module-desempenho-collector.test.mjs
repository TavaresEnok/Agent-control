import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {planStaticRoutes} from '../deploy/modules/desempenho/collector.mjs';
import {loadConfig} from '../deploy/modules/desempenho/lib.mjs';
import {compareIndependentMeasurement, validatePerformanceMeasurement} from '../deploy/modules/desempenho/references.mjs';
import {startStaticServer} from '../deploy/modules/desempenho/static-server.mjs';

const run = promisify(execFile);
const collector = new URL('../deploy/modules/desempenho/collector.mjs', import.meta.url).href;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ac-perf-collector-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const browsers = join(root, 'browsers');
  await mkdir(join(repo, 'public'), {recursive: true});
  await mkdir(bin);
  await mkdir(join(browsers, 'chromium-fake', 'chrome-linux64'), {recursive: true});
  await writeFile(join(browsers, 'chromium-fake', 'chrome-linux64', 'chrome'), '');
  for (let i = 0; i < 9; i++) {
    await writeFile(join(repo, 'public', `page-${i}.html`), '\n\n<!doctype html><h1>página de teste</h1>');
  }
  await writeFile(join(repo, 'especial.html'), '\n<!doctype html><h1>declarada</h1>');
  await writeFile(join(repo, 'desempenho.config.json'), [
    '{', ' "routes": [', '  {"path": "/ignorada"}', ' ],',
    ' "routes": [', '  {"file": "especial.html",', '   "path": "/\\u0065special?modo=teste"},',
    '  "/page-8.html",', '  {"file": "public/page-7.html", "path": "/alias"},',
    '  {"file": "ausente.html", "path": "/ausente"}', ' ]', '}',
  ].join('\r\n'));
  return {root, repo, bin, browsers};
}

test('ordena declarações antes da descoberta, informa omissões individuais e serve o alias exato', async t => {
  const {repo} = await fixture(t);
  const plan = planStaticRoutes(repo, loadConfig(repo));
  assert.equal(plan.targets.length, 8);
  assert.deepEqual(plan.targets.slice(0, 3).map(item => item.path), ['/especial?modo=teste', '/page-8.html', '/alias']);
  assert.deepEqual(plan.targets.slice(0, 4).map(item => [item.source.kind, item.source.line]),
    [['declaration', 7], ['declaration', 8], ['declaration', 9], ['document', 3]]);
  assert.deepEqual(plan.coverage.map(row => row.detail.split(';')[0]),
    ['rota=/ausente', 'rota=/page-5.html', 'rota=/page-6.html', 'rota=/page-7.html']);
  const server = await startStaticServer(plan.rootDir, {aliasRoot: repo, aliases: plan.aliases});
  try {
    assert.match(await (await fetch(server.origin + '/especial?modo=teste')).text(), /declarada/);
    assert.equal((await fetch(server.origin + '/especial')).status, 404);
  } finally { await server.close(); }
});

test('descoberta conserva a página servível quando a declaração associa a rota a um backend', async t => {
  const {repo} = await fixture(t);
  await writeFile(join(repo, 'desempenho.config.json'), JSON.stringify({
    server: {entry: 'server.mjs'}, routes: [{path: '/page-0.html', file: 'server.mjs'}],
  }));
  await writeFile(join(repo, 'server.mjs'), '// backend sintético');
  const plan = planStaticRoutes(repo, loadConfig(repo));
  assert.equal(plan.targets[0]?.file, 'public/page-0.html');
  assert.deepEqual(plan.targets[0]?.source, {file: 'public/page-0.html', line: 3, kind: 'document'});
  assert.match(plan.coverage[0].detail, /rota=\/page-0.html.*arquivo da declaração indisponível/);
});

test('localiza a declaração servível e segue os últimos campos do JSON com chaves repetidas', async t => {
  const {repo} = await fixture(t);
  await writeFile(join(repo, 'desempenho.config.json'), [
    '{',
    ' "__proto__": {"path": "/fora"}, "__proto__": null,',
    ' "routes": ["/descartada"],',
    ' "rout\\u0065s": [',
    '  {"path": "/escolhida", "file": "ausente.html"},',
    '  {"path": "/escolhida", "file": "../invalido.html"},',
    '  {"path": "/antiga", "__proto__": {}, "__proto__": [],',
    '   "file": "ausente.html", "file": "public/page-0.html",',
    '   "p\\u0061th": "/escolhida"},',
    '  {"path": "/escolhida", "file": "public/page-1.html"},',
    '  {"path": "/page-2.html", "file": "../invalido.html"},',
    '  {"path": "/alternativa", "file": "public/page-3.html", "path": null}',
    ' ]',
    '}',
  ].join('\r\n'));
  const config = loadConfig(repo);
  assert.equal(config.routeOmissions, 1);
  const plan = planStaticRoutes(repo, config);
  assert.deepEqual(plan.targets.filter(route => route.path === '/escolhida'), [{
    path: '/escolhida', file: 'public/page-0.html', page: true,
    source: {file: 'desempenho.config.json', line: 9, kind: 'declaration'},
  }]);
  assert.ok(!plan.targets.some(route => ['/antiga', '/descartada', '/alternativa'].includes(route.path)));
  assert.equal(plan.targets.find(route => route.path === '/page-2.html')?.source.kind, 'document');
  assert.equal(plan.coverage.filter(row => row.detail.startsWith('rota=/escolhida; arquivo da declaração')).length, 2);
});

async function collectSynthetic({root, repo, bin, browsers}, scripts) {
  for (const [tool, source] of Object.entries(scripts)) {
    await writeFile(join(bin, tool), '#!' + process.execPath + '\n' + source, {mode: 0o700});
  }
  const code = `import {collectPerformance} from ${JSON.stringify(collector)};
    console.log(JSON.stringify(await collectPerformance(process.argv[1], 'static')));`;
  const {stdout} = await run(process.execPath, ['--input-type=module', '-e', code, repo], {
    env: {PATH: bin, TMPDIR: root, PLAYWRIGHT_BROWSERS_PATH: browsers}, timeout: 15_000,
  });
  return JSON.parse(stdout);
}

test('coleta sintética preserva medições parciais e trata baseline do snapshot como orçamento', async t => {
  const setup = await fixture(t);
  await writeFile(join(setup.repo, 'desempenho.baseline.json'),
    JSON.stringify({k6Routes: [{route: '/especial?modo=teste', p95: 1}],
      lighthouse: [{route: '/especial?modo=teste', formFactor: 'desktop', lcp: 1}]}));
  const output = await collectSynthetic(setup, {
    lhci: `const fs = require('node:fs');
      if (process.argv[2] === 'collect') {
        const config = JSON.parse(fs.readFileSync(process.argv[3].slice(9)));
        const url = config.ci.collect.url[0];
        fs.mkdirSync('.lighthouseci');
        fs.writeFileSync('.lighthouseci/lhr-0.json', JSON.stringify({requestedUrl: url, finalUrl: url,
          categories: {performance: {score: 1}}, audits: {
            'largest-contentful-paint': {numericValue: 400}, 'cumulative-layout-shift': {numericValue: 0},
            'total-blocking-time': {numericValue: 0}}}));
        process.exitCode = 1;
      }`,
    k6: `const fs = require('node:fs');
      if (process.argv[2] === 'version') console.log('k6 v2.4.0');
      else {
        const route = '/especial?modo=teste';
        fs.writeFileSync(process.argv.find(v => v.startsWith('--summary-export=')).slice(17), JSON.stringify({metrics: {
          ['http_reqs{route:' + route + '}']: {count: 3}, ['http_req_duration{route:' + route + '}']: {'p(95)': 240},
          ['http_req_failed{route:' + route + '}']: {rate: 0}}}));
        process.exitCode = 99;
      }`,
  });
  assert.equal(output.measurement.k6Routes[0]?.p95, 240);
  assert.equal(output.measurement.lighthouse[0]?.lcp, 400);
  assert.ok(output.coverage.some(row => row.tool === 'lighthouse-ci:collect' && row.status === 'failed'));
  for (const tool of ['k6', 'lighthouse-ci']) {
    assert.ok(output.coverage.some(row => row.tool === `${tool}:rota:/alias` && row.status === 'failed' && row.detail.includes('rota=/alias')));
  }
  assert.deepEqual(output.findings.map(finding => finding.rule).sort(), [
    'DESEMPENHO-ORCAMENTO-LCP', 'DESEMPENHO-ORCAMENTO-ROTA', 'K6-THRESHOLD-LATENCY-P95',
  ]);
  const k6 = output.findings.filter(finding => finding.tool === 'k6');
  assert.ok(k6.every(finding => finding.file === 'desempenho.config.json' && finding.line === 7 &&
    finding.evidence.includes('declaração da rota') && finding.evidence.includes('arquivo associado=especial.html')));
  assert.ok(output.coverage.some(row => row.tool === 'orcamento-declarado' && /2 acima do orçamento/.test(row.detail)));
});

test('nomeia rotas selecionadas mesmo quando as ferramentas não produzem relatórios', async t => {
  const setup = await fixture(t);
  const output = await collectSynthetic(setup, {lhci: 'process.exit(1)', k6: 'process.exit(1)'});
  for (const tool of ['k6', 'lighthouse-ci']) {
    const routes = output.coverage.filter(row => row.tool.startsWith(tool + ':rota:') && row.status === 'failed');
    assert.equal(routes.length, 8);
    assert.ok(routes.some(row => row.detail.startsWith('rota=/especial?modo=teste;')));
  }
  assert.deepEqual(output.findings, []);
});

test('Lighthouse carrega recursos no caminho canônico e k6 mede o alias HTTP declarado', async t => {
  const setup = await fixture(t);
  const {repo} = setup;
  await mkdir(join(repo, 'public', 'artigos'));
  await writeFile(join(repo, 'public', 'artigos', 'index.html'),
    '<link href="local.css"><script src="/global.js"></script><h1>Artigos</h1>');
  await writeFile(join(repo, 'public', 'artigos', 'local.css'), 'h1 {}');
  await writeFile(join(repo, 'public', 'global.js'), '/* asset global */');
  await writeFile(join(repo, 'desempenho.config.json'), JSON.stringify({
    routes: [{path: '/alias?modo=teste', file: 'public/artigos/index.html'},
      {path: '/artigos/', file: 'public/page-0.html'}],
  }));
  const output = await collectSynthetic(setup, {
    lhci: `const assert = require('node:assert/strict');
      const fs = require('node:fs');
      if (process.argv[2] === 'collect') (async () => {
        const config = JSON.parse(fs.readFileSync(process.argv[3].slice(9)));
        const url = config.ci.collect.url[0];
        assert.equal(new URL(url).pathname, '/artigos/');
        assert.equal(new URL(url).search, '?modo=teste');
        const html = await (await fetch(url)).text();
        assert.match(html, /Artigos/);
        for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
          const res = await fetch(new URL(match[1], url));
          assert.equal(res.status, 200);
          assert.match(await res.text(), /h1|asset global/);
        }
        fs.mkdirSync('.lighthouseci');
        fs.writeFileSync('.lighthouseci/lhr-0.json', JSON.stringify({requestedUrl: url, finalUrl: url,
          categories: {performance: {score: 1}}, audits: {
            'largest-contentful-paint': {numericValue: 100}, 'cumulative-layout-shift': {numericValue: 0},
            'total-blocking-time': {numericValue: 0}}}));
      })().catch(error => { console.error(error); process.exitCode = 1; });`,
    k6: `const assert = require('node:assert/strict');
      const fs = require('node:fs');
      if (process.argv[2] === 'version') console.log('k6 v2.4.0');
      else (async () => {
        const script = fs.readFileSync(process.argv.at(-1), 'utf8');
        const origin = JSON.parse(/const ORIGIN = (.*);/.exec(script)[1]);
        const [route] = JSON.parse(/const ROUTES = (.*);/.exec(script)[1]);
        assert.equal(route, '/alias?modo=teste');
        const res = await fetch(origin + route);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /Artigos/);
        fs.writeFileSync(process.argv.find(v => v.startsWith('--summary-export=')).slice(17), JSON.stringify({metrics: {
          ['http_reqs{route:' + route + '}']: {count: 3}, ['http_req_duration{route:' + route + '}']: {'p(95)': 20},
          ['http_req_failed{route:' + route + '}']: {rate: 0}}}));
      })().catch(error => { console.error(error); process.exitCode = 1; });`,
  });
  assert.deepEqual(output.findings, []);
  assert.equal(output.measurement.lighthouse[0]?.route, '/alias?modo=teste');
  assert.equal(output.measurement.lighthouse[0]?.file, 'public/artigos/index.html');
  assert.equal(output.measurement.k6Routes[0]?.route, '/alias?modo=teste');
  assert.equal(output.measurement.k6Routes[0]?.p95, 20);
});

test('identifica declarações excedentes mesmo depois do limite de leitura das rotas', async t => {
  const setup = await fixture(t);
  const routes = Array.from({length: 41}, (_, i) => `/declarada-${i}`);
  await writeFile(join(setup.repo, 'desempenho.config.json'), JSON.stringify({routes}));
  const output = await collectSynthetic(setup, {lhci: 'process.exit(1)', k6: 'process.exit(1)'});
  assert.ok(output.coverage.some(row => row.tool === 'rota-http' && row.status === 'skipped' &&
    row.detail.includes('limite de 40') && row.detail.includes('/declarada-40')));
});

test('só pares independentes com método compatível emitem regressão', () => {
  const imageDigest = 'sha256:' + 'a'.repeat(64);
  const source = {file: 'desempenho.config.json', line: 5, kind: 'declaration'};
  const current = validatePerformanceMeasurement({httpMode: 'isolated',
    versions: {'lighthouse-ci': '1', k6: '2', pg_stat_statements: '16'},
    k6Routes: [{route: '/api', file: 'server.mjs', p95: 50, source}],
    lighthouse: [{route: '/', file: 'public/index.html', lcp: 500, formFactor: 'desktop'}],
    sqlQueries: [{file: 'query.sql', line: 4, statementHash: 'a'.repeat(16), meanMs: 20}]});
  const previous = structuredClone(current);
  previous.imageDigest = imageDigest;
  previous.k6Routes[0].p95 = 20;
  previous.lighthouse[0].lcp = 200;
  previous.sqlQueries[0].meanMs = 4;
  const compare = () => compareIndependentMeasurement(current, {examId: 'independente-1', measurement: previous}, imageDigest);
  assert.deepEqual(compare().findings.map(f => f.rule), [
    'DESEMPENHO-REGRESSAO-ROTA', 'DESEMPENHO-REGRESSAO-LCP', 'DESEMPENHO-REGRESSAO-SQL',
  ]);
  previous.httpMode = 'static';
  previous.sqlQueries[0].statementHash = 'b'.repeat(16);
  assert.equal(compare().coverage.status, 'skipped');
  assert.deepEqual(compare().findings, []);
  previous.httpMode = 'isolated';
  previous.versions = {...current.versions, 'lighthouse-ci': '3', k6: '3'};
  assert.deepEqual(compare().findings, []);
  previous.imageDigest = 'sha256:' + 'b'.repeat(64);
  assert.equal(compare().coverage.status, 'skipped');
});
