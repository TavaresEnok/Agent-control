import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

type CoverageRow = {tool: string; version: string; status: 'ok' | 'failed' | 'skipped'; detail: string};
type Finding = {
  tool: string;
  rule: string;
  file: string;
  line: number;
  severity: 'alta' | 'media' | 'baixa' | 'informativa';
  message: string;
  evidence: string;
};

type K6Source = {file: string; line: number; kind: 'declaration' | 'document'};

type LibModule = {
  DEFAULT_THRESHOLDS: Record<string, number>;
  normalizeRepoRelativePath: (rawPath: string, prefixes?: string[]) => string | null;
  validateConfig: (raw: unknown) => {
    staticDir?: string;
    routes: {path: string; file?: string}[];
    server?: {entry: string; readyPath: string; portEnv: string};
    cpuFunctions: {file: string; functionName: string}[];
    cpuOmissions: number;
    migrationsDir?: string;
    migrations: string[];
    sqlDir?: string;
    sqlQueries: string[];
    pgStatStatementsFile?: string;
    baselineFile?: string;
    thresholds: Record<string, number>;
  };
  validateModuleOutput: (output: unknown) => {coverage: CoverageRow[]; findings: Finding[]};
  evaluateLighthouseLhr: (lhr: unknown, routeInfo: {path: string; file?: string}, thresholds: Record<string, number>) => {
    metrics: {route: string; formFactor: string; file: string; score: number | null; lcp: number | null; cls: number | null; tbt: number | null};
    findings: Finding[];
  };
  evaluateK6Summary: (
    summary: unknown,
    exitCode: number,
    routeTargets: {path: string; file?: string; source?: K6Source}[],
    thresholds: Record<string, number>,
  ) => {
    routeMetrics: {route: string; file: string; source: K6Source | null; p95: number | null; avg: number | null; max: number | null; failRate: number | null}[];
    findings: Finding[];
  };

};

const libUrl = new URL('../deploy/modules/desempenho/lib.mjs', import.meta.url).href;
const staticServerUrl = new URL('../deploy/modules/desempenho/static-server.mjs', import.meta.url).href;

test('Dockerfile e lockfiles de desempenho fixam base por digest, usuário 65532 e integridade SHA', async () => {
  const baseDir = new URL('../deploy/modules/desempenho/', import.meta.url);
  const dockerfile = await readFile(new URL('Dockerfile', baseDir), 'utf8');
  const entrypoint = await readFile(new URL('entrypoint.sh', baseDir), 'utf8');
  const lockJson = JSON.parse(await readFile(new URL('desempenho-tools.lock.json', baseDir), 'utf8')) as {
    baseImage: {name: string; version: string; digest: string};
    packageLockSha256: string;
    npmDependencies: Record<string, {version: string; integrity: string}>;
    tools: {name: string; version: string; sha256: string; url: string}[];
  };
  const pkgLockBytes = await readFile(new URL('package-lock.json', baseDir));
  const actualLockSha = createHash('sha256').update(pkgLockBytes).digest('hex');

  assert.match(dockerfile, /^FROM\s+mcr\.microsoft\.com\/playwright:v1\.65\.1-noble@sha256:[a-f0-9]{64}/m);
  assert.equal(dockerfile.includes('latest'), false);
  assert.match(dockerfile, /USER 65532:65532/);
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/local\/bin\/desempenho-entrypoint\.sh"\]/);
  assert.match(dockerfile, /sha256sum -c checksums\.txt/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /LABEL org.agent-control.performance.protocol="6"/);
  assert.match(dockerfile, /npm ci --prefix cpu-parser --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /^COPY .*http-link\.mjs .*cpu-metrics\.mjs postgres-metrics\.mjs /m);

  assert.equal(actualLockSha, lockJson.packageLockSha256);
  assert.match(lockJson.baseImage.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(lockJson.tools.length, 1);
  assert.equal(lockJson.tools[0]?.name, 'k6');
  assert.match(lockJson.tools[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.ok(lockJson.npmDependencies['@lhci/cli']?.integrity.startsWith('sha512-'));
  assert.ok(lockJson.npmDependencies.lighthouse?.integrity.startsWith('sha512-'));
  assert.ok(lockJson.npmDependencies.pg?.integrity.startsWith('sha512-'));

  assert.match(entrypoint, /PERF_PATH_FORBIDDEN/);
  assert.match(entrypoint, /PERF_SOCKET_FORBIDDEN/);
  assert.match(entrypoint, /PERF_NETWORK_FORBIDDEN/);
  assert.match(entrypoint, /for name in[\s\S]*GITHUB_TOKEN[\s\S]*unset "\$name"/);
});

test('normalização de caminho relativo e validação de saída rejeitam escapes e valores inválidos', async () => {
  const lib = await import(libUrl) as LibModule;

  assert.equal(lib.normalizeRepoRelativePath('/repo/src/server.mjs'), 'src/server.mjs');
  assert.equal(lib.normalizeRepoRelativePath('file:///tmp/work-repo/queries/lenta.sql'), 'queries/lenta.sql');
  assert.equal(lib.normalizeRepoRelativePath('./public/index.html'), 'public/index.html');
  assert.equal(lib.normalizeRepoRelativePath('/etc/passwd'), null);
  assert.equal(lib.normalizeRepoRelativePath('../segredo.txt'), null);
  assert.equal(lib.normalizeRepoRelativePath('src/../segredo.txt'), null);
  assert.equal(lib.normalizeRepoRelativePath('a\\b.js'), null);
  assert.equal(lib.normalizeRepoRelativePath('a\0b.js'), null);

  const valid = lib.validateModuleOutput({
    coverage: [
      {tool: 'lighthouse-ci', version: '0.16.1', status: 'ok', detail: '1 tela medida'},
      {tool: 'k6', version: 'v2.4.0', status: 'failed', detail: 'k6 ausente'},
      {tool: 'pg_stat_statements', version: 'PostgreSQL 16', status: 'skipped', detail: 'sem SQL'},
    ],
    findings: [
      {
        tool: 'lighthouse-ci',
        rule: 'LH-CLS-SHIFT',
        file: '/repo/public/index.html',
        line: 1,
        severity: 'alta',
        message: 'CLS elevado',
        evidence: 'CLS=0.41',
      },
    ],
  });
  assert.equal(valid.coverage.length, 3);
  assert.equal(valid.findings[0]?.file, 'public/index.html');
  assert.equal(valid.findings[0]?.line, 1);

  assert.throws(() => lib.validateModuleOutput({
    coverage: [{tool: 'k6', version: '1', status: 'unknown', detail: 'x'}],
    findings: [],
  }));
  assert.throws(() => lib.validateModuleOutput({
    coverage: [],
    findings: [{tool: 'k6', rule: 'R', file: '../fora.js', line: 1, severity: 'alta', message: 'x', evidence: 'y'}],
  }));
  assert.throws(() => lib.validateModuleOutput({
    coverage: [],
    findings: [{tool: 'k6', rule: 'R', file: 'a.js', line: 0, severity: 'alta', message: 'x', evidence: 'y'}],
  }));
});

test('validateConfig recusa caminhos fora do repositório e preserva limites válidos', async () => {
  const lib = await import(libUrl) as LibModule;
  const parsed = lib.validateConfig({
    server: {entry: 'server.mjs', routes: ['/', '/api/relatorio'], readyPath: '/health'},
    routes: [{path: '/', file: 'public/index.html'}],
    migrationsDir: 'migrations',
    sqlDir: 'queries',
    thresholds: {k6P95Ms: 120, sqlMeanMs: 25},
  });
  assert.equal(parsed.server?.entry, 'server.mjs');
  assert.equal(parsed.thresholds.k6P95Ms, 120);
  assert.equal(parsed.thresholds.sqlMeanMs, 25);

  assert.throws(() => lib.validateConfig({server: {entry: '../../etc/passwd'}}));
  assert.throws(() => lib.validateConfig({migrationsDir: '/abs/path'}));
  const cpu = lib.validateConfig({cpuFunctions: [
    {file: 'work.mjs', functionName: 'sample'},
    {file: 'work.mjs', functionName: 'sample'},
    {file: '../outside.js', functionName: 'sample'},
    {file: 'work.mjs', functionName: 'not a name'},
  ], cpuWorkloads: ['legacy.mjs']});
  assert.deepEqual(cpu.cpuFunctions, [{file: 'work.mjs', functionName: 'sample'}]);
  assert.equal(cpu.cpuOmissions, 3);
});

test('avaliadores HTTP identificam limites e credenciam achados k6 à origem localizada', async () => {
  const lib = await import(libUrl) as LibModule;
  const thresholds = {...lib.DEFAULT_THRESHOLDS, performanceScore: 0.85, k6P95Ms: 120};

  // Lighthouse
  const lhBad = lib.evaluateLighthouseLhr({
    configSettings: {formFactor: 'desktop'},
    categories: {performance: {score: 0.42}},
    audits: {
      'largest-contentful-paint': {numericValue: 4200},
      'cumulative-layout-shift': {numericValue: 0.34},
      'total-blocking-time': {numericValue: 710},
    },
  }, {path: '/', file: 'public/index.html'}, thresholds);
  assert.equal(lhBad.findings.length, 4);
  assert.ok(lhBad.findings.every(f => f.file === 'public/index.html' && f.line >= 1));

  const lhClean = lib.evaluateLighthouseLhr({
    configSettings: {formFactor: 'desktop'},
    categories: {performance: {score: 0.99}},
    audits: {
      'largest-contentful-paint': {numericValue: 320},
      'cumulative-layout-shift': {numericValue: 0},
      'total-blocking-time': {numericValue: 0},
    },
  }, {path: '/', file: 'public/index.html'}, thresholds);
  assert.equal(lhClean.findings.length, 0);

  // k6
  const k6Bad = lib.evaluateK6Summary({
    metrics: {
      'http_req_duration{route:/}': {'p(95)': 12, avg: 8, max: 18},
      'http_req_failed{route:/}': {rate: 0},
      'http_req_duration{route:/api/relatorio}': {'p(95)': 235, avg: 221, max: 250},
      'http_req_failed{route:/api/relatorio}': {rate: 0},
    },
  }, 99, [
    {path: '/', file: 'public/index.html'},
    {path: '/api/relatorio', file: 'server.mjs',
      source: {file: 'desempenho.config.json', line: 12, kind: 'declaration'}},
  ], thresholds);
  assert.equal(k6Bad.findings.length, 1);
  assert.equal(k6Bad.findings[0]?.rule, 'K6-THRESHOLD-LATENCY-P95');
  assert.equal(k6Bad.findings[0]?.file, 'desempenho.config.json');
  assert.equal(k6Bad.findings[0]?.line, 12);
  assert.match(k6Bad.findings[0]!.evidence, /declaração da rota.*arquivo associado=server.mjs/);

  const k6Clean = lib.evaluateK6Summary({
    metrics: {
      'http_req_duration{route:/}': {'p(95)': 10, avg: 6, max: 14},
      'http_req_failed{route:/}': {rate: 0},
      'http_req_duration{route:/api/relatorio}': {'p(95)': 15, avg: 9, max: 20},
      'http_req_failed{route:/api/relatorio}': {rate: 0},
    },
  }, 0, [
    {path: '/', file: 'public/index.html'},
    {path: '/api/relatorio', file: 'server.mjs',
      source: {file: 'desempenho.config.json', line: 12, kind: 'declaration'}},
  ], thresholds);
  assert.equal(k6Clean.findings.length, 0);


});

test('servidor estático local serve arquivos válidos e recusa escapes ou symlinks externos', async () => {
  const {startStaticServer} = await import(staticServerUrl) as {
    startStaticServer: (rootDir: string) => Promise<{origin: string; close: () => Promise<void>}>;
  };
  const root = await mkdtemp(join(tmpdir(), 'perf-static-'));
  const outside = await mkdtemp(join(tmpdir(), 'perf-outside-'));
  try {
    await writeFile(join(root, 'index.html'), '<h1>ok</h1>');
    await writeFile(join(outside, 'secret.txt'), 'segredo');
    await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt'));

    const srv = await startStaticServer(root);
    try {
      const okRes = await fetch(`${srv.origin}/`);
      assert.equal(okRes.status, 200);
      assert.equal(await okRes.text(), '<h1>ok</h1>');

      const escapeRes = await fetch(`${srv.origin}/../etc/passwd`);
      assert.equal(escapeRes.status, 404);

      const symRes = await fetch(`${srv.origin}/leak.txt`);
      assert.equal(symRes.status, 404);
    } finally {
      await srv.close();
    }
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});

test('fixtures defeituosa e controle limpo têm configuração válida e simétrica', async () => {
  const lib = await import(libUrl) as LibModule;
  const defectiveCfg = lib.validateConfig(JSON.parse(await readFile(
    new URL('./fixtures/module-desempenho/defective/desempenho.config.json', import.meta.url),
    'utf8',
  )));
  const cleanCfg = lib.validateConfig(JSON.parse(await readFile(
    new URL('./fixtures/module-desempenho/clean/desempenho.config.json', import.meta.url),
    'utf8',
  )));
  assert.deepEqual(defectiveCfg.thresholds, cleanCfg.thresholds);
  assert.deepEqual(defectiveCfg.routes, cleanCfg.routes);
  assert.deepEqual(defectiveCfg.cpuFunctions, [{file: 'server.mjs', functionName: 'computeHeavyReport'}]);
  assert.deepEqual(cleanCfg.cpuFunctions, [{file: 'server.mjs', functionName: 'computeCachedReport'}]);
});


test('rotas e séries exigem correspondência exata e limites incluem a igualdade', async () => {
  const lib = await import(libUrl) as LibModule;
  const cfg = lib.validateConfig({routes: ['//outra-origem/a', '/%2e%2e/pagina', '/pagina?modo=mobile', '/']});
  assert.deepEqual(cfg.routes.map(r => r.path), ['/pagina?modo=mobile', '/']);
  const targets = [{path: '/', file: 'index.html'}, {path: '/produtos', file: 'produtos.html',
    source: {file: 'produtos.html', line: 5, kind: 'document' as const}}, {path: '/pagina?modo=mobile', file: 'pagina.html'}];
  const thresholds = {...lib.DEFAULT_THRESHOLDS, k6P95Ms: 100, k6FailRate: 0};
  const result = lib.evaluateK6Summary({metrics: {
    'http_req_duration{route:/produtos}': {values: {'p(95)': 101}},
    'http_req_failed{route:/produtos}': {values: {rate: 0}},
    'http_req_duration{route:/pagina?modo=mobile}': {values: {'p(95)': 100}},
    'http_req_failed{route:/pagina?modo=mobile}': {values: {rate: 0}},
    http_req_duration: {values: {'p(95)': 10}}, http_req_failed: {values: {rate: 0}},
  }}, 0, targets, thresholds);
  assert.equal(result.routeMetrics[0]?.p95, null);
  assert.equal(result.routeMetrics[0]?.failRate, null);
  assert.equal(result.routeMetrics[1]?.p95, 101);
  assert.equal(result.routeMetrics[2]?.p95, 100);
  assert.deepEqual(result.findings.map(f => [f.file, f.line]), [['produtos.html', 5]]);
  assert.match(result.findings[0]!.evidence, /primeiro conteúdo/);
  const unlocated = lib.evaluateK6Summary({metrics: {
    'http_req_duration{route:/}': {values: {'p(95)': 200}},
    'http_req_failed{route:/}': {values: {rate: 0.5}},
  }}, 99, [targets[0]!], thresholds);
  assert.equal(unlocated.routeMetrics[0]?.p95, 200);
  assert.deepEqual(unlocated.findings, []);
});

test('servidor estático responde enquanto o coletor aguarda processo síncrono', async () => {
  const script = fileURLToPath(new URL('../deploy/modules/desempenho/static-server.mjs', import.meta.url));
  const fixture = fileURLToPath(new URL('./fixtures/module-desempenho/clean/public/', import.meta.url));
  const child = spawn(process.execPath, [script, fixture], {stdio: ['ignore', 'pipe', 'pipe']});
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('servidor não iniciou')), 5000);
      child.stdout.once('data', data => { clearTimeout(timer); resolve(String(data).trim()); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('servidor terminou')); });
    });
    const request = spawnSync(process.execPath, ['-e', 'fetch(process.argv[1]).then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))', origin], {timeout: 5000});
    assert.equal(request.status, 0, String(request.stderr));
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
  }
});
