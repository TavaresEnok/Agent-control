import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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

type LibModule = {
  DEFAULT_THRESHOLDS: Record<string, number>;
  normalizeRepoRelativePath: (rawPath: string, prefixes?: string[]) => string | null;
  validateConfig: (raw: unknown) => {
    staticDir?: string;
    routes: {path: string; file?: string}[];
    server?: {entry: string; routes: string[]; readyPath: string; portEnv: string; cpuProfile: boolean};
    cpuWorkloads: {file: string; args: string[]}[];
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
    routeTargets: {path: string; file?: string; line?: number}[],
    thresholds: Record<string, number>,
  ) => {
    routeMetrics: {route: string; file: string; line: number; p95: number | null; avg: number | null; max: number | null; failRate: number}[];
    findings: Finding[];
  };
  analyzeCpuProfile: (profileJson: unknown, workRoot: string, thresholds: Record<string, number>) => {
    totalDurationMs: number;
    userActiveMs: number;
    sampleCount: number;
    hotspots: {file: string; line: number; functionName: string; selfMs: number; pct: number}[];
    findings: Finding[];
  };
  evaluatePgStatStatements: (
    rows: unknown[],
    explainPlans: unknown[],
    sqlSources: {file: string; line: number; sql: string}[],
    thresholds: Record<string, number>,
  ) => {
    analyzedQueries: {file: string; line: number; calls: number; meanMs: number; maxMs: number; totalMs: number; query: string}[];
    findings: Finding[];
  };
  evaluateBaselineRegression: (
    current: {lighthouse?: unknown[]; k6Routes?: unknown[]; sqlQueries?: unknown[]},
    baseline: unknown,
    thresholds: Record<string, number>,
  ) => Finding[];
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
});

test('avaliadores de Lighthouse, k6, node --cpu-prof e pg_stat_statements detectam defeitos e ignoram controle limpo', async () => {
  const lib = await import(libUrl) as LibModule;
  const thresholds = {...lib.DEFAULT_THRESHOLDS, performanceScore: 0.85, k6P95Ms: 120, cpuSelfMs: 80, sqlMeanMs: 25, sqlMaxMs: 60, sqlSeqScanCost: 50};

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
    {path: '/', file: 'public/index.html', line: 1},
    {path: '/api/relatorio', file: 'server.mjs', line: 1},
  ], thresholds);
  assert.equal(k6Bad.findings.length, 1);
  assert.equal(k6Bad.findings[0]?.rule, 'K6-THRESHOLD-LATENCY-P95');
  assert.equal(k6Bad.findings[0]?.file, 'server.mjs');

  const k6Clean = lib.evaluateK6Summary({
    metrics: {
      'http_req_duration{route:/}': {'p(95)': 10, avg: 6, max: 14},
      'http_req_failed{route:/}': {rate: 0},
      'http_req_duration{route:/api/relatorio}': {'p(95)': 15, avg: 9, max: 20},
      'http_req_failed{route:/api/relatorio}': {rate: 0},
    },
  }, 0, [
    {path: '/', file: 'public/index.html', line: 1},
    {path: '/api/relatorio', file: 'server.mjs', line: 1},
  ], thresholds);
  assert.equal(k6Clean.findings.length, 0);

  // node --cpu-prof
  const cpuBad = lib.analyzeCpuProfile({
    startTime: 0,
    endTime: 1_500_000,
    nodes: [
      {id: 1, callFrame: {functionName: '(root)', url: '', lineNumber: -1}},
      {id: 2, callFrame: {functionName: 'readFileSync', url: 'node:fs', lineNumber: 10}},
      {id: 3, callFrame: {functionName: 'computeHeavyReport', url: 'file:///tmp/work-repo/server.mjs', lineNumber: 6}},
    ],
    samples: [2, 3, 3, 3, 3],
    timeDeltas: [5000, 300000, 300000, 300000, 300000],
  }, '/tmp/work-repo', thresholds);
  assert.equal(cpuBad.findings.length, 1);
  assert.equal(cpuBad.findings[0]?.rule, 'CPU-PROF-HOTSPOT');
  assert.equal(cpuBad.findings[0]?.file, 'server.mjs');
  assert.equal(cpuBad.findings[0]?.line, 7);

  const cpuClean = lib.analyzeCpuProfile({
    startTime: 0,
    endTime: 50_000,
    nodes: [
      {id: 1, callFrame: {functionName: 'fastHandler', url: 'file:///tmp/work-repo/server.mjs', lineNumber: 9}},
    ],
    samples: [1],
    timeDeltas: [2000],
  }, '/tmp/work-repo', thresholds);
  assert.equal(cpuClean.findings.length, 0);

  // pg_stat_statements + EXPLAIN
  const pgBad = lib.evaluatePgStatStatements(
    [
      {query: 'SELECT pg_stat_statements_reset()', calls: 1, mean_exec_time: 100, max_exec_time: 100, total_exec_time: 100},
      {query: 'EXPLAIN (FORMAT JSON) SELECT 1', calls: 1, mean_exec_time: 100, max_exec_time: 100, total_exec_time: 100},
      {query: 'SELECT count(*), max(md5(observacao)) FROM pedidos_audit WHERE observacao LIKE $1', calls: 5, mean_exec_time: 64.5, max_exec_time: 72.1, total_exec_time: 322.5},
    ],
    [
      {file: 'queries/lenta.sql', line: 1, plan: {Plan: {'Node Type': 'Seq Scan', 'Relation Name': 'pedidos_audit', 'Total Cost': 1420, 'Actual Rows': 2941}}},
    ],
    [{file: 'queries/lenta.sql', line: 1, sql: "SELECT count(*), max(md5(observacao)) FROM pedidos_audit WHERE observacao LIKE '%urgente%'"}],
    thresholds,
  );
  assert.equal(pgBad.analyzedQueries.length, 1);
  assert.equal(pgBad.findings.length, 2);
  assert.equal(pgBad.findings[0]?.file, 'queries/lenta.sql');

  const pgClean = lib.evaluatePgStatStatements(
    [{query: 'SELECT id, codigo, valor FROM pedidos_audit WHERE codigo = $1 LIMIT $2', calls: 5, mean_exec_time: 0.4, max_exec_time: 0.7, total_exec_time: 2.0}],
    [{file: 'queries/rapida.sql', line: 1, plan: {Plan: {'Node Type': 'Index Scan', 'Relation Name': 'pedidos_audit', 'Total Cost': 8.4, 'Actual Rows': 1}}}],
    [{file: 'queries/rapida.sql', line: 1, sql: "SELECT id, codigo, valor FROM pedidos_audit WHERE codigo = 'COD-00042' LIMIT 1"}],
    thresholds,
  );
  assert.equal(pgClean.findings.length, 0);

  // Baseline regression ("se pioraram desde a última vez")
  const regressions = lib.evaluateBaselineRegression(
    {
      k6Routes: [{route: '/api/relatorio', file: 'server.mjs', line: 1, p95: 240}],
      lighthouse: [{route: '/', formFactor: 'desktop', file: 'public/index.html', lcp: 2800}],
      sqlQueries: [{file: 'queries/lenta.sql', line: 1, meanMs: 65}],
    },
    {
      k6Routes: [{route: '/api/relatorio', p95: 20}],
      lighthouse: [{route: '/', formFactor: 'desktop', lcp: 400}],
      sqlQueries: [{file: 'queries/lenta.sql', line: 1, meanMs: 2}],
    },
    thresholds,
  );
  assert.equal(regressions.length, 3);
  assert.ok(regressions.some(r => r.rule === 'DESEMPENHO-REGRESSAO-ROTA'));
  assert.ok(regressions.some(r => r.rule === 'DESEMPENHO-REGRESSAO-LCP'));
  assert.ok(regressions.some(r => r.rule === 'DESEMPENHO-REGRESSAO-SQL'));
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
});
