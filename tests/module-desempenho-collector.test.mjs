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

test('Lighthouse conserva recursos das páginas externas e omite referências que saem do snapshot', async t => {
  const setup = await fixture(t);
  const {repo} = setup;
  await mkdir(join(repo, 'guias', 'introdução'), {recursive: true});
  await mkdir(join(repo, 'recursos'));
  for (const [file, body] of Object.entries({
    'especial.html': '<h1>Externa</h1><link href="tema.css"><script src="/tema.css"></script>',
    'guias/introdução/index.html': '<h1>Aninhada</h1><link href="local.css"><script src="../comum.js"></script><link href="../../tema.css">',
    'fora.html': '<h1>Externa ambígua</h1><link href="../tema.css">',
    'guias/introdução/fora.html': '<h1>Aninhada ambígua</h1><script src=../../&#46;%2e/tema.css></script>',
    'guias/introdução/base.html': '<base href="../"><h1>Base relativa</h1><img srcset="data:image/png;base64,AAAA 1x, ../../tema.css 2x">',
    'esquema.html': '<h1>Mesmo esquema</h1><link href="http:../tema.css">',
    'guias/introdução/local.css': 'local',
    'guias/comum.js': 'pai',
    'tema.css': 'relativo',
    'recursos/tema.css': 'absoluto',
    'recursos/.ac-perf-pages': 'recurso estático existente',
  })) await writeFile(join(repo, file), body);
  await writeFile(join(repo, 'desempenho.config.json'), JSON.stringify({staticDir: 'recursos', routes: [
    {path: '/especial?modo=teste', file: 'especial.html'},
    {path: '/inicio/nested?modo=teste', file: 'guias/introdução/index.html'},
    {path: '/fora?modo=teste', file: 'fora.html'},
    {path: '/inicio/fora?modo=teste', file: 'guias/introdução/fora.html'},
    {path: '/inicio/base?modo=teste', file: 'guias/introdução/base.html'},
    {path: '/esquema?modo=teste', file: 'esquema.html'},
  ]}));
  const output = await collectSynthetic(setup, {
    lhci: `const assert = require('node:assert/strict');
      const fs = require('node:fs');
      if (process.argv[2] === 'collect') (async () => {
        const {ci} = JSON.parse(fs.readFileSync(process.argv[3].slice(9)));
        assert.equal(ci.collect.url.length, 2);
        const [external, nested] = ci.collect.url;
        assert.ok(new URL(external).pathname.endsWith('/especial.html'));
        assert.ok(new URL(nested).pathname.endsWith('/guias/introdu%C3%A7%C3%A3o/'));
        assert.equal(new URL(nested).search, '?modo=teste');
        for (const [url, title, references] of [[external, /Externa/, ['relativo', 'absoluto']],
          [nested, /Aninhada/, ['local', 'pai', 'relativo']]]) {
          const page = await fetch(url);
          assert.equal(page.status, 200);
          const html = await page.text();
          assert.match(html, title);
          const bodies = [];
          for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
            const asset = await fetch(new URL(match[1], url));
            assert.equal(asset.status, 200);
            bodies.push(await asset.text());
          }
          assert.deepEqual(bodies, references);
          assert.equal((await fetch(new URL('/guias/comum.js', url))).status, 404);
          assert.equal((await fetch(new URL('/especial?modo=teste', url))).status, 404);
          const existing = await fetch(new URL('/.ac-perf-pages', url));
          assert.equal(await existing.text(), 'recurso estático existente');
        }
        fs.mkdirSync('.lighthouseci');
        for (const [i, url] of [external, nested].entries()) {
          fs.writeFileSync('.lighthouseci/lhr-' + i + '.json', JSON.stringify({requestedUrl: url, finalUrl: url,
            categories: {performance: {score: 1}}, audits: {
              'largest-contentful-paint': {numericValue: 100}, 'cumulative-layout-shift': {numericValue: 0},
              'total-blocking-time': {numericValue: 0}}}));
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });`,
    k6: `const assert = require('node:assert/strict');
      const fs = require('node:fs');
      if (process.argv[2] === 'version') console.log('k6 v2.4.0');
      else (async () => {
        const script = fs.readFileSync(process.argv.at(-1), 'utf8');
        const origin = JSON.parse(/const ORIGIN = (.*);/.exec(script)[1]);
        const routes = JSON.parse(/const ROUTES = (.*);/.exec(script)[1]);
        assert.deepEqual(routes, ['/especial?modo=teste', '/inicio/nested?modo=teste', '/fora?modo=teste',
          '/inicio/fora?modo=teste', '/inicio/base?modo=teste', '/esquema?modo=teste']);
        const titles = [/Externa/, /Aninhada/, /Externa ambígua/, /Aninhada ambígua/, /Base relativa/, /Mesmo esquema/];
        const metrics = {};
        for (const [i, route] of routes.entries()) {
          const page = await fetch(origin + route);
          assert.equal(page.status, 200);
          assert.match(await page.text(), titles[i]);
          assert.equal((await fetch(origin + route.split('?')[0])).status, 404);
          metrics['http_reqs{route:' + route + '}'] = {count: 3};
          metrics['http_req_duration{route:' + route + '}'] = {'p(95)': 20};
          metrics['http_req_failed{route:' + route + '}'] = {rate: 0};
        }
        fs.writeFileSync(process.argv.find(v => v.startsWith('--summary-export=')).slice(17), JSON.stringify({metrics}));
      })().catch(error => { console.error(error); process.exitCode = 1; });`,
  });
  assert.deepEqual(output.findings, []);
  const measured = [['/especial?modo=teste', 'especial.html'], ['/inicio/nested?modo=teste', 'guias/introdução/index.html']];
  const omitted = [['/fora?modo=teste', 'fora.html'], ['/inicio/fora?modo=teste', 'guias/introdução/fora.html'],
    ['/inicio/base?modo=teste', 'guias/introdução/base.html'], ['/esquema?modo=teste', 'esquema.html']];
  assert.deepEqual(output.measurement.lighthouse.map(({route, file}) => [route, file]), measured);
  assert.deepEqual(output.measurement.k6Routes.map(({route, file}) => [route, file]), [...measured, ...omitted]);
  for (const [route] of omitted) {
    assert.ok(output.coverage.some(row => row.tool === 'rota-http' && row.status === 'skipped' &&
      row.detail === `rota=${route}; referência relativa sai da raiz do snapshot`));
  }
});

function syntheticLighthouse(check) {
  return `const assert = require('node:assert/strict');
    const fs = require('node:fs');
    if (process.argv[2] === 'collect') (async () => {
      const {ci} = JSON.parse(fs.readFileSync(process.argv[3].slice(9)));
      const urls = ci.collect.url;
      await (${check.toString()})(assert, urls);
      fs.mkdirSync('.lighthouseci');
      for (const [i, url] of urls.entries()) {
        fs.writeFileSync('.lighthouseci/lhr-' + i + '.json', JSON.stringify({requestedUrl: url, finalUrl: url,
          categories: {performance: {score: 1}}, audits: {
            'largest-contentful-paint': {numericValue: 100}, 'cumulative-layout-shift': {numericValue: 0},
            'total-blocking-time': {numericValue: 0}}}));
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
}

test('Lighthouse seleciona a primeira base HTML com href e serve somente os arquivos do snapshot', async t => {
  const setup = await fixture(t);
  const {root, repo} = setup;
  await mkdir(join(repo, 'recursos', 'tema'), {recursive: true});
  await mkdir(join(repo, 'guias'));
  const bases = {
    relativa: '<base target="_self"><base href="../recursos/tema/">',
    ausente: '<base target="_self">',
    invalida: '<base href="http://["><base href="about:blank">',
    data: '<base href="data:text/plain,base"><base href="about:blank">',
    javascript: '<base href="javascript:"><base href="about:blank">',
    vazia: '<base href=""><base href="about:blank">',
    inerte: '<template><base href="about:blank"></template>',
    semOrigem: '<base href="about:blank">',
  };
  const routes = Object.entries(bases).map(([name]) => ({path: `/${name}?modo=teste`, file: `guias/${name}.html`}));
  for (const [name, base] of Object.entries(bases)) {
    await writeFile(join(repo, `guias/${name}.html`), `<!doctype html>${base}<link rel="stylesheet" href="estilo.css"><h1>${name}</h1>`);
  }
  await writeFile(join(repo, 'guias', 'estilo.css'), '/* estilo do documento */');
  await writeFile(join(repo, 'recursos', 'tema', 'estilo.css'), '/* estilo da base */');
  await writeFile(join(root, 'avulso.css'), '/* fora do snapshot declarado */');
  await writeFile(join(repo, 'desempenho.config.json'), JSON.stringify({staticDir: 'recursos', routes}));

  const output = await collectSynthetic(setup, {lhci: syntheticLighthouse(async (assert, urls) => {
    assert.equal(urls.length, 7);
    for (const url of urls) {
      const page = new URL(url);
      assert.equal(page.hostname, '127.0.0.1');
      assert.equal(page.search, '?modo=teste');
      const name = page.pathname.split('/').at(-1).replace('.html', '');
      const response = await fetch(page);
      assert.equal(response.status, 200);
      assert.match(await response.text(), new RegExp(`<h1>${name}</h1>`));
      const assetBase = name === 'relativa' ? new URL('../recursos/tema/', page) : page;
      const asset = await fetch(new URL('estilo.css', assetBase));
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), name === 'relativa' ? '/* estilo da base */' : '/* estilo do documento */');
      assert.equal((await fetch(new URL('/avulso.css', page))).status, 404);
      const segment = page.pathname.split('/')[1];
      assert.equal((await fetch(new URL(`/${segment}/avulso.css`, page))).status, 404);
    }
  })});
  assert.deepEqual(output.measurement.lighthouse.map(({route, file}) => ({path: route, file})), routes.slice(0, -1));
  assert.ok(output.coverage.some(row => row.tool === 'rota-http' && row.status === 'skipped' &&
    row.detail === 'rota=/semOrigem?modo=teste; escopo parcial: base HTML fora da origem do servidor estático'));
});

test('Lighthouse registra escopo parcial para formas de documento embutido nas duas raízes estáticas', async t => {
  const setup = await fixture(t);
  const {repo} = setup;
  const pages = [
    ['public/controle.html', '<template><iframe srcdoc="<p>Inerte</p>"></iframe></template><iframe title="Vazio"></iframe>'],
    ['public/inline.html', '<iframe srcdoc="&lt;p&gt;Documento&lt;/p&gt;" src="suporte.html"></iframe>', 'iframe[srcdoc]'],
    ['public/vazio.html', '<iframe srcdoc=""></iframe>', 'iframe[srcdoc]'],
    ['public/frame.html', '<!doctype html><frameset><frame src="suporte.html"></frameset>', 'frame[src]'],
    ['externo.html', '<iframe src="public/suporte.html"></iframe>', 'iframe[src]'],
    ['public/objeto.html', '<object data="suporte.html" type="text/html"></object>', 'object[data]'],
    ['public/embed.html', '<embed src="suporte.html" type="text/html">', 'embed[src]'],
  ];
  const routes = pages.map(([file], i) => ({file, path: `/declarada-${i}`}));
  for (const [file, html] of pages) await writeFile(join(repo, file), html);
  await writeFile(join(repo, 'public', 'suporte.html'), '<p>Documento sintético de apoio</p>');
  await writeFile(join(repo, 'desempenho.config.json'), JSON.stringify({routes: [
    ...routes, {path: '/suporte', file: 'public/suporte.html', page: false},
  ]}));

  const output = await collectSynthetic(setup, {lhci: syntheticLighthouse(async (assert, urls) => {
    assert.deepEqual(urls.map(url => new URL(url).pathname), ['/controle.html']);
    const response = await fetch(urls[0]);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Inerte/);
  })});
  assert.deepEqual(output.measurement.lighthouse.map(({route, file}) => ({path: route, file})), routes.slice(0, 1));
  const omissions = output.coverage.filter(row => row.tool === 'rota-http' && row.status === 'skipped' &&
    row.detail.includes('documento embutido'));
  assert.deepEqual(omissions.map(row => row.detail), pages.slice(1).map(([, , element], i) =>
    `rota=${routes[i + 1].path}; escopo parcial: documento embutido em ${element} fora da interpretação estática`));
});

test('Lighthouse mantém imagens raster confirmadas pelo servidor nas duas origens estáticas', async t => {
  const setup = await fixture(t);
  const {root, repo} = setup;
  await mkdir(join(repo, 'site'));
  const pages = [
    ['site/imagens.html', '<object data="pixel.png?tema=claro"></object><embed src="pixel.png" type="image/png">'],
    ['galeria.html', '<base href="site/"><object data="pixel.png" type="image/png"></object>'],
    ['site/ausente.html', '<object data="ausente.png" type="image/png"></object>'],
    ['site/documento.html', '<object data="suporte.html" type="image/png"></object>'],
    ['site/vetor.html', '<object data="vetor.svg" type="image/svg+xml"></object>'],
  ];
  const routes = pages.map(([file]) => ({file, path: '/' + file.replace(/^site\//, '')}));
  for (const [file, html] of pages) await writeFile(join(repo, file), `<!doctype html>${html}`);
  await writeFile(join(repo, 'site', 'pixel.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPrsAAAAASUVORK5CYII=', 'base64'));
  await writeFile(join(repo, 'site', 'suporte.html'), '<p>Documento sintético de apoio</p>');
  await writeFile(join(repo, 'site', 'vetor.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  await writeFile(join(root, 'avulso.css'), '/* fora do snapshot declarado */');
  await writeFile(join(repo, 'desempenho.config.json'), JSON.stringify({staticDir: 'site', routes: [
    ...routes, {path: '/suporte.html', file: 'site/suporte.html', page: false},
  ]}));

  const output = await collectSynthetic(setup, {lhci: syntheticLighthouse(async (assert, urls) => {
    assert.equal(urls.length, 2);
    const [canonical, mounted] = urls.map(url => new URL(url));
    assert.equal(canonical.pathname, '/imagens.html');
    assert.match(mounted.pathname, /^\/[^/]+\/galeria\.html$/);
    assert.notEqual(canonical.origin, mounted.origin);
    for (const [page, assetPath] of [[canonical, 'pixel.png?tema=claro'], [mounted, 'site/pixel.png']]) {
      assert.equal(page.hostname, '127.0.0.1');
      assert.equal((await fetch(page)).status, 200);
      const image = await fetch(new URL(assetPath, page));
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.equal((await fetch(new URL('/avulso.css', page))).status, 404);
    }
  })});
  assert.deepEqual(output.measurement.lighthouse.map(({route, file}) => ({path: route, file})), routes.slice(0, 2));
  const omissions = output.coverage.filter(row => row.tool === 'rota-http' && row.status === 'skipped' &&
    row.detail.includes('documento embutido'));
  assert.deepEqual(omissions.map(row => row.detail), routes.slice(2).map(({path}) =>
    `rota=${path}; escopo parcial: documento embutido em object[data] fora da interpretação estática`));
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
