/**
 * Coletor real do módulo 7 (desempenho).
 * Executa dentro do contêiner isolado (--network none por padrão, --read-only, UID 65532).
 * Emite um único JSON UTF-8 em stdout: { coverage: [...], findings: [...] }.
 */
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseExpressionAt} from './cpu-parser/node_modules/acorn/dist/acorn.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {collectCpuMetrics} from './cpu-metrics.mjs';
import {startObserverHttpLink} from './http-link.mjs';
import {runPostgresMetrics} from './postgres-metrics.mjs';
import {startStaticServer} from './static-server.mjs';
import {compareDeclaredBudget, validatePerformanceMeasurement} from './references.mjs';
import {
  DEFAULT_THRESHOLDS, MAX_DECLARED_ROUTES, evaluateK6Summary, evaluateLighthouseLhr, loadConfig,
  normalizeCoverageRow, normalizeFinding, readJsonLimited, safeRoutePath, validateModuleOutput,
} from './lib.mjs';

const REPO_ROOT = '/repo';
const MAX_HTTP_ROUTES = 8;
const K6_REQUESTS_PER_ROUTE = 3;
const isHtml = path => /\.html?$/i.test(path);

function toolExit(file, args, {timeout, ...options}) {
  return new Promise(resolveExit => {
    const child = spawn(file, args, {...options, detached: true, stdio: 'ignore'});
    const killGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* grupo já terminou */ }
      }
    };
    const timer = setTimeout(killGroup, timeout);
    child.once('error', () => {}); // close também é emitido quando spawn falha.
    child.once('close', code => {
      clearTimeout(timer);
      killGroup();
      resolveExit(code);
    });
  });
}

function listFilesByExt(rootDir, exts, relDir = '', out = []) {
  const target = relDir ? join(rootDir, relDir) : rootDir;
  let entries;
  try {
    entries = readdirSync(target, {withFileTypes: true});
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      listFilesByExt(rootDir, exts, rel, out);
    } else if (entry.isFile() && exts.includes(extname(entry.name).toLowerCase())) {
      out.push(rel);
    }
  }
  return out;
}

function findChrome() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright', '/ms-playwright'];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('chromium-')) continue;
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const candidate = join(root, entry.name, rel);
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          /* próximo */
        }
      }
    }
  }
  for (const sysBin of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(sysBin)) return sysBin;
  }
  return null;
}

function findPostgresBinDir() {
  const bin = '/usr/lib/postgresql/16/bin';
  return ['initdb', 'pg_ctl', 'postgres'].every(file => existsSync(join(bin, file))) ? bin : null;
}

function getToolVersions(pgBinDir) {
  let lhciVer = 'desconhecida';
  let lhVer = 'desconhecida';
  try {
    lhciVer = JSON.parse(readFileSync('/opt/desempenho-tools/node_modules/@lhci/cli/package.json', 'utf8')).version ?? lhciVer;
  } catch {
    /* ignore */
  }
  try {
    lhVer = JSON.parse(readFileSync('/opt/desempenho-tools/node_modules/lighthouse/package.json', 'utf8')).version ?? lhVer;
  } catch {
    /* ignore */
  }

  let k6Ver = 'desconhecida';
  const k6Res = spawnSync('k6', ['version'], {encoding: 'utf8', timeout: 5000});
  if (k6Res.status === 0 && k6Res.stdout) {
    const match = /v?\d+\.\d+\.\d+/.exec(k6Res.stdout);
    k6Ver = match ? match[0] : k6Res.stdout.trim().slice(0, 60);
  }

  let pgVer = 'desconhecida';
  if (pgBinDir) {
    const pgRes = spawnSync(join(pgBinDir, 'postgres'), ['--version'], {encoding: 'utf8', timeout: 5000});
    if (pgRes.status === 0 && pgRes.stdout) {
      const match = /\d+(?:\.\d+)?/.exec(pgRes.stdout);
      pgVer = match ? `PostgreSQL ${match[0]}` : pgRes.stdout.trim().slice(0, 60);
    }
  }

  return {
    lhci: `${lhciVer} (lighthouse ${lhVer})`,
    k6: k6Ver,
    node: process.version,
    pg: pgVer,
  };
}

async function waitForHttpReady(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(1200)});
      await response.body?.cancel();
      if (response.ok) return true;
    } catch { /* aguarda o início do alvo */ }
    await delay(150);
  }
  return false;
}

function fileExists(root, file) {
  try { return lstatSync(join(root, file)).isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

function discoverStaticWeb(root, config) {
  const roots = [...new Set([config?.staticDir, 'public', 'dist', 'build', 'deploy/pwa', '.'].filter(Boolean))];
  for (const candidate of roots) {
    const rootDir = join(root, candidate);
    const files = candidate === '.'
      ? readdirSync(rootDir, {withFileTypes: true}).filter(entry => entry.isFile() && isHtml(entry.name)).map(entry => entry.name).sort()
      : listFilesByExt(rootDir, ['.html', '.htm']);
    const routes = files.flatMap(file => {
      const encoded = file.split('/').map(encodeURIComponent).join('/');
      const path = safeRoutePath('/' + encoded.replace(/(^|\/)index\.html$/, '$1'));
      return path ? [{path, file: candidate === '.' ? file : `${candidate}/${file}`, page: true}] : [];
    });
    if (routes.length) return {rootDir, routes};
  }
  return null;
}

function readRouteDeclarations(root) {
  const file = 'desempenho.config.json';
  const path = join(root, file);
  if (!fileExists(root, file) || lstatSync(path).size > 256 * 1024) return new Map();
  try {
    const ast = parseExpressionAt(readFileSync(path, 'utf8'), 0, {ecmaVersion: 2022, locations: true});
    const array = ast.properties?.findLast(property => property.key?.value === 'routes')?.value;
    const declarations = new Map();
    for (const node of array?.elements?.slice(0, MAX_DECLARED_ROUTES) ?? []) {
      const literal = node.type === 'ObjectExpression'
        ? node.properties.findLast(property => property.key?.value === 'path')?.value : node;
      const route = safeRoutePath(literal?.value);
      if (route && !declarations.has(route)) declarations.set(route, {kind: 'declaration', file, line: literal.loc.start.line});
    }
    return declarations;
  } catch {
    // A coleta continua quando a declaração não pode ser localizada sem ambiguidade.
    return new Map();
  }
}

function documentSource(root, file) {
  const source = readFileSync(join(root, file), 'utf8');
  const firstContent = /\S/.exec(source);
  return firstContent && {kind: 'document', file, line: source.slice(0, firstContent.index).split(/\r\n|[\r\n]/).length};
}

function routeCoverage(route, detail) {
  return normalizeCoverageRow({tool: 'rota-http', version: '5', status: 'skipped', detail: `rota=${route}; ${detail}`});
}

function declaredRouteOmissions(config) {
  const coverage = [];
  if (!config) return coverage;
  if (config.routeOmissions) coverage.push(normalizeCoverageRow({tool: 'rota-http', version: '5', status: 'skipped',
    detail: `${config.routeOmissions} declaração(ões) de rota inválida(s)`}));
  const prefix = `Declarações após o limite de ${MAX_DECLARED_ROUTES} rotas`;
  let detail = prefix;
  for (const path of config.routesBeyondLimit) {
    if (detail.length + path.length + 2 > 500) {
      coverage.push(normalizeCoverageRow({tool: 'rota-http', version: '5', status: 'skipped', detail}));
      detail = prefix;
    }
    detail += `; ${path}`;
  }
  if (detail !== prefix) coverage.push(normalizeCoverageRow({tool: 'rota-http', version: '5', status: 'skipped', detail}));
  return coverage;
}

function selectTargets(candidates, coverage) {
  for (const route of candidates.slice(MAX_HTTP_ROUTES)) {
    coverage.push(routeCoverage(route.path, `fora do limite de ${MAX_HTTP_ROUTES} rotas por coleta`));
  }
  return candidates.slice(0, MAX_HTTP_ROUTES);
}

export function planStaticRoutes(root, config, declarations = readRouteDeclarations(root)) {
  const slice = discoverStaticWeb(root, config);
  const filesByUrl = new Map();
  for (const route of slice?.routes ?? []) {
    filesByUrl.set(route.path, route.file);
    if (route.path.endsWith('/')) {
      filesByUrl.set(`${route.path}index.html`, route.file);
      if (route.path !== '/') filesByUrl.set(route.path.slice(0, -1), route.file);
    }
  }
  const coverage = [];
  const targets = new Map();
  const declared = new Set();
  const configured = new Set();
  for (const route of config?.routes ?? []) {
    if (declared.has(route.path)) continue;
    declared.add(route.path);
    const pathname = new URL(route.path, 'http://127.0.0.1').pathname;
    const file = route.file ?? filesByUrl.get(pathname);
    if (!file || !isHtml(file) || !fileExists(root, file)) {
      coverage.push(routeCoverage(route.path, 'arquivo da declaração indisponível no recorte estático'));
      continue;
    }
    configured.add(route.path);
    targets.set(route.path, {path: route.path, file, page: route.page ?? true,
      source: declarations.get(route.path)});
  }
  for (const route of slice?.routes ?? []) {
    if (!configured.has(route.path)) targets.set(route.path, route);
  }
  const selected = selectTargets([...targets.values()], coverage).map(route =>
    route.source ? route : {...route, source: documentSource(root, route.file)});
  const selectedAliases = new Map(selected.filter(route => configured.has(route.path)).map(route => [route.path, route.file]));
  return {rootDir: slice?.rootDir ?? root, aliases: selectedAliases, targets: selected, coverage};
}

async function openHttp(root, config, mode) {
  const coverage = [];
  const declarations = readRouteDeclarations(root);
  if (config?.server && mode === 'isolated') {
    let bridge;
    try {
      bridge = await startObserverHttpLink();
      if (await waitForHttpReady(new URL(config.server.readyPath, bridge.origin))) {
        const targets = [];
        const seen = new Set();
        for (const route of config.routes) {
          if (seen.has(route.path)) continue;
          seen.add(route.path);
          if (!route.file || !fileExists(root, route.file)) {
            coverage.push(routeCoverage(route.path, 'arquivo da rota ausente no snapshot'));
            continue;
          }
          targets.push({...route, page: route.page ?? isHtml(route.file), source: declarations.get(route.path)});
        }
        if (targets.length) return {...bridge, mode, targets: selectTargets(targets, coverage), coverage};
      }
    } catch {
      // A preparação do canal também pode falhar antes de uma resposta HTTP.
    }
    await bridge?.close();
  }
  if (config?.server) coverage.push(normalizeCoverageRow({tool: 'servidor-isolado', version: '5', status: 'failed',
    detail: 'Backend isolado indisponível, sem resposta válida ou sem rotas associadas ao snapshot'}));
  const plan = planStaticRoutes(root, config, declarations);
  coverage.push(...plan.coverage);
  if (config?.server) {
    coverage.push(normalizeCoverageRow({tool: 'recorte-http-estatico', version: '5', status: plan.targets.length ? 'ok' : 'skipped',
      detail: `${plan.targets.length} rota(s) estática(s) selecionada(s); rotas dinâmicas e APIs fora deste recorte`}));
  }
  const server = plan.targets.length ? await startStaticServer(plan.rootDir, {aliasRoot: root, aliases: plan.aliases}) : {};
  return {...server, mode: 'static', targets: plan.targets, coverage};
}

function discoverSqlFiles(workRoot, config) {
  const migrations = [];
  if (config?.migrations?.length) {
    for (const m of config.migrations) {
      migrations.push(m);
    }
  } else if (config?.migrationsDir) {
    const base = join(workRoot, config.migrationsDir);
    if (existsSync(base)) {
      for (const f of listFilesByExt(base, ['.sql'])) migrations.push(`${config.migrationsDir}/${f}`);
    }
  } else {
    for (const dir of ['db/migrations', 'migrations']) {
      const full = join(workRoot, dir);
      if (existsSync(full) && statSync(full).isDirectory()) {
        for (const f of listFilesByExt(full, ['.sql'])) migrations.push(`${dir}/${f}`);
        if (migrations.length > 0) break;
      }
    }
    if (migrations.length === 0 && existsSync(join(workRoot, 'schema.sql'))) {
      migrations.push('schema.sql');
    }
  }

  const queries = [];
  if (config?.sqlQueries?.length) {
    for (const q of config.sqlQueries) {
      queries.push(q);
    }
  } else if (config?.sqlDir) {
    const base = join(workRoot, config.sqlDir);
    if (existsSync(base)) {
      for (const f of listFilesByExt(base, ['.sql'])) queries.push(`${config.sqlDir}/${f}`);
    }
  } else {
    for (const dir of ['queries', 'sql/queries']) {
      const full = join(workRoot, dir);
      if (existsSync(full) && statSync(full).isDirectory()) {
        for (const f of listFilesByExt(full, ['.sql'])) queries.push(`${dir}/${f}`);
        if (queries.length > 0) break;
      }
    }
  }

  let snapshotFile = null;
  if (config?.pgStatStatementsFile && existsSync(join(workRoot, config.pgStatStatementsFile))) {
    snapshotFile = config.pgStatStatementsFile;
  } else if (existsSync(join(workRoot, 'pg_stat_statements.json'))) {
    snapshotFile = 'pg_stat_statements.json';
  }

  return {migrations, queries, snapshotFile};
}

async function runLighthouseCi({origin, routes, chromePath, thresholds, version}) {
  const extraCoverage = [];
  const findings = [];
  const measuredMetrics = [];
  const unmeasured = detail => routes.map(route =>
    normalizeCoverageRow({tool: `lighthouse-ci:rota:${route.path}`, version, status: 'failed', detail: `rota=${route.path}; ${detail}`}));

  if (!routes || routes.length === 0 || !origin) {
    return {
      summary: normalizeCoverageRow({
        tool: 'lighthouse-ci',
        version,
        status: 'skipped',
        detail: 'Nenhuma rota web ou página HTML disponível para Lighthouse CI',
      }),
      extraCoverage,
      findings,
      measuredMetrics,
    };
  }
  if (!chromePath) {
    return {
      summary: normalizeCoverageRow({
        tool: 'lighthouse-ci',
        version,
        status: 'failed',
        detail: 'Binário Chromium não encontrado em /ms-playwright para execução do Lighthouse CI',
      }),
      extraCoverage: unmeasured('nenhuma medição Lighthouse disponível'),
      findings,
      measuredMetrics,
    };
  }

  const lhciDir = mkdtempSync(join(tmpdir(), 'ac-perf-lhci-'));
  const urls = routes.map(r => { const url = new URL(r.path, origin); if (url.origin !== origin) throw new Error('origem de rota inválida'); return url.href; });
  const configPath = join(lhciDir, 'lighthouserc.json');
  const rc = {
    ci: {
      collect: {
        url: urls,
        numberOfRuns: 1,
        settings: {
          chromeFlags: '--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-background-networking',
          throttlingMethod: 'provided',
          onlyCategories: ['performance'],
          formFactor: 'desktop',
          screenEmulation: {mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false},
        },
      },
      assert: {
        assertions: {
          'categories:performance': ['warn', {minScore: thresholds.performanceScore}],
          'largest-contentful-paint': ['warn', {maxNumericValue: thresholds.lcpMs}],
          'cumulative-layout-shift': ['warn', {maxNumericValue: thresholds.cls}],
          'total-blocking-time': ['warn', {maxNumericValue: thresholds.tbtMs}],
        },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(rc, null, 2));

  const env = {
    ...process.env,
    CHROME_PATH: chromePath,
    LHCI_BUILD_CONTEXT__CURRENT_HASH: '0000000000000000000000000000000000000000',
    LHCI_BUILD_CONTEXT__COMMIT_TIME: '2026-11-19T00:00:00.000Z',
    LHCI_BUILD_CONTEXT__COMMIT_MESSAGE: 'coleta-desempenho',
    LHCI_BUILD_CONTEXT__AUTHOR: 'desempenho <noreply@localhost>',
  };

  const collectExit = await toolExit('lhci', ['collect', `--config=${configPath}`], {
    cwd: lhciDir,
    env,
    timeout: 180_000,
  });

  const outDataDir = join(lhciDir, '.lighthouseci');
  let lhrFiles = [];
  try {
    lhrFiles = readdirSync(outDataDir)
      .filter(f => f.startsWith('lhr-') && f.endsWith('.json'))
      .sort();
  } catch {
    lhrFiles = [];
  }

  if (lhrFiles.length === 0) {
    return {
      summary: normalizeCoverageRow({
        tool: 'lighthouse-ci',
        version,
        status: 'failed',
        detail: `lhci collect sem relatório válido (exit=${collectExit ?? 'indisponível'})`,
      }),
      extraCoverage: unmeasured('nenhuma medição Lighthouse disponível'),
      findings,
      measuredMetrics,
    };
  }

  if (collectExit !== 0) extraCoverage.push(normalizeCoverageRow({tool: 'lighthouse-ci:collect', version,
    status: 'failed', detail: `lhci collect exit=${collectExit ?? 'indisponível'}; relatórios completos aproveitados`}));
  // Também executa `lhci assert` para validar as asserções nativas do Lighthouse CI
  const assertExit = await toolExit('lhci', ['assert', `--config=${configPath}`], {
    cwd: lhciDir,
    env,
    timeout: 30_000,
  });

  for (const fileName of lhrFiles) {
    let lhr, requested;
    try {
      lhr = readJsonLimited(join(outDataDir, fileName), 16 * 1024 * 1024);
      requested = new URL(lhr.requestedUrl);
    } catch { continue; }
    const routeInfo = routes.find(r => requested.href === new URL(r.path, origin).href);
    if (!routeInfo || requested.origin !== origin || lhr.runtimeError ||
        measuredMetrics.some(m => m.route === routeInfo.path)) continue;
    try { if (new URL(lhr.finalDisplayedUrl ?? lhr.finalUrl).href !== requested.href) continue; } catch { continue; }
    const evaluated = evaluateLighthouseLhr(lhr, routeInfo, thresholds);
    const m = evaluated.metrics;
    if (![m.score, m.lcp, m.cls, m.tbt].every(Number.isFinite)) continue;
    measuredMetrics.push(m);
    findings.push(...evaluated.findings);
  }
  for (const route of routes) {
    const m = measuredMetrics.find(item => item.route === route.path);
    extraCoverage.push(normalizeCoverageRow({tool: `lighthouse-ci:rota:${route.path}`, version,
      status: m ? 'ok' : 'failed', files: m ? [m.file] : [], detail: m ? `arquivo=${m.file}; rota=${route.path}; score=${m.score}; LCP=${m.lcp}ms; CLS=${m.cls}; TBT=${m.tbt}ms` : `rota=${route.path}; LHR correspondente com métricas completas ausente`}));
  }

  if (assertExit !== 0) extraCoverage.push(normalizeCoverageRow({tool: 'lighthouse-ci:assert', version,
    status: 'failed', detail: `lhci assert exit=${assertExit ?? 'indisponível'}`}));
  return {
    summary: normalizeCoverageRow({
      tool: 'lighthouse-ci',
      version,
      status: measuredMetrics.length ? 'ok' : 'failed',
      detail: `assert exit=${assertExit}; ${measuredMetrics.length} tela(s) medida(s) (LCP, CLS, TBT, desempenho); ${findings.length} achado(s)`,
    }),
    extraCoverage,
    findings,
    measuredMetrics,
  };
}

async function runK6LoadTest({origin, routeTargets, thresholds, version}) {
  const extraCoverage = [];
  const findings = [];
  const routeMetrics = [];

  if (!origin || !routeTargets || routeTargets.length === 0) {
    return {
      summary: normalizeCoverageRow({
        tool: 'k6',
        version,
        status: 'skipped',
        detail: 'Nenhuma rota HTTP disponível para teste de carga k6',
      }),
      extraCoverage,
      findings,
      routeMetrics,
    };
  }

  const k6Dir = mkdtempSync(join(tmpdir(), 'ac-perf-k6-'));
  const scriptPath = join(k6Dir, 'script.js');
  const summaryPath = join(k6Dir, 'summary.json');

  const routeThresholdLines = {};
  routeThresholdLines.http_req_failed = [`rate<=${thresholds.k6FailRate}`];
  routeThresholdLines.http_req_duration = [`p(95)<=${thresholds.k6P95Ms}`];
  for (const r of routeTargets) {
    routeThresholdLines[`http_req_duration{route:${r.path}}`] = [`p(95)<=${thresholds.k6P95Ms}`];
    routeThresholdLines[`http_req_failed{route:${r.path}}`] = [`rate<=${thresholds.k6FailRate}`];
    routeThresholdLines[`http_reqs{route:${r.path}}`] = [`count==${K6_REQUESTS_PER_ROUTE}`];
  }

  const script = `import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  vus: 1,
  iterations: ${K6_REQUESTS_PER_ROUTE},
  discardResponseBodies: true,
  maxDuration: '45s',
  thresholds: ${JSON.stringify(routeThresholdLines)},
};

const ORIGIN = ${JSON.stringify(origin)};
const ROUTES = ${JSON.stringify(routeTargets.map(r => r.path))};

http.setResponseCallback(http.expectedStatuses({min: 200, max: 299}));
export default function () {
  for (const route of ROUTES) {
    http.get(ORIGIN + route, {tags: {route}, timeout: '1s', redirects: 0});
    sleep(0.1);
  }
}
`;
  writeFileSync(scriptPath, script, 'utf8');

  const exit = await toolExit('k6', ['run', '--no-usage-report', `--summary-export=${summaryPath}`, scriptPath],
    {cwd: k6Dir, timeout: 60_000});

  // 99 indica limite violado. Só aceite as séries completas da rota.
  let summary;
  if (exit === 0 || exit === 99) {
    try { summary = readJsonLimited(summaryPath, 8 * 1024 * 1024); } catch { /* sem prova numérica */ }
  }
  if (!summary) return {
    summary: normalizeCoverageRow({tool: 'k6', version, status: 'failed',
      detail: `k6 sem relatório válido (exit=${exit ?? 'indisponível'})`}),
    extraCoverage: routeTargets.map(route => normalizeCoverageRow({tool: `k6:rota:${route.path}`, version, status: 'failed',
      detail: `rota=${route.path}; nenhum relatório válido do k6`})),
    findings, routeMetrics,
  };
  const completed = routeTargets.filter(route => {
    const metric = summary.metrics?.[`http_reqs{route:${route.path}}`];
    return (metric?.values ?? metric)?.count === K6_REQUESTS_PER_ROUTE;
  });
  const evaluated = evaluateK6Summary(summary, exit, completed, thresholds);
  for (const route of routeTargets) {
    const metric = evaluated.routeMetrics.find(item => item.route === route.path);
    const measured = metric && Number.isFinite(metric.p95) && Number.isFinite(metric.failRate);
    const missingSource = measured && !metric.source && (metric.p95 > thresholds.k6P95Ms || metric.failRate > thresholds.k6FailRate);
    extraCoverage.push(normalizeCoverageRow({
      tool: `k6:rota:${route.path}`,
      version, status: measured ? 'ok' : 'failed', files: measured ? [route.file] : [],
      detail: measured ? `arquivo=${route.file}; rota=${route.path}; requisições=${K6_REQUESTS_PER_ROUTE}; p95=${metric.p95.toFixed(1)}ms; falhas=${(metric.failRate * 100).toFixed(2)}%${missingSource ? '; limite excedido sem origem localizável' : ''}`
        : `rota=${route.path}; série ou contagem de requisições da rota incompleta`,
    }));
    if (measured) routeMetrics.push(metric);
  }
  findings.push(...evaluated.findings);

  return {
    summary: normalizeCoverageRow({
      tool: 'k6',
      version,
      status: routeMetrics.length ? 'ok' : 'failed',
      detail: `${routeMetrics.length} rota(s) testada(s) com limites (p95<${thresholds.k6P95Ms}ms, falhas<${(thresholds.k6FailRate * 100).toFixed(1)}%); ${findings.length} achado(s)`,
    }),
    extraCoverage,
    findings,
    routeMetrics,
  };
}

async function runCpuFunctions(root, config, thresholds, version) {
  const extraCoverage = [];
  const findings = [];
  let measured = 0;
  for (const {file, functionName} of config?.cpuFunctions ?? []) {
    const result = await collectCpuMetrics({snapshotRoot: root, file, functionName, thresholdMs: thresholds.cpuSelfMs});
    const tool = 'node-cpu-prof:arquivo';
    if (result.status !== 'measured') {
      extraCoverage.push(normalizeCoverageRow({tool, version, status: 'skipped',
        detail: `${file} (${functionName}): ${result.detail}`}));
      continue;
    }
    measured++;
    const evidence = `arquivo=${file}:${result.line}; função=${functionName}; tempo próprio amostral=${result.selfMs.toFixed(1)}ms; amostras próprias=${result.selfSamples}/${result.sampleCount}; limiar=${result.thresholdMs}ms`;
    extraCoverage.push(normalizeCoverageRow({tool, version, status: 'ok', files: [file],
      detail: `${evidence}; recorte: uma chamada isolada sem argumentos`}));
    if (result.hotspot) findings.push(normalizeFinding({
      tool: 'node-cpu-prof', rule: 'CPU-PROF-HOTSPOT', file, line: result.line,
      severity: result.selfMs >= result.thresholdMs * 2 ? 'alta' : 'media',
      message: 'Função ultrapassou o limite de tempo próprio no perfil amostral do V8.', evidence,
    }));
  }
  if (config?.cpuOmissions) {
    extraCoverage.push(normalizeCoverageRow({tool: 'node-cpu-prof:selecao', version, status: 'skipped',
      detail: `${config.cpuOmissions} seleção(ões) de CPU inválida(s), legada(s) ou acima do limite`}));
  }
  return {extraCoverage, findings, summary: normalizeCoverageRow({tool: 'node-cpu-prof', version,
    status: measured ? 'ok' : 'skipped',
    detail: measured ? `${measured} função(ões) em recorte autônomo sem argumentos; demais caminhos não cobertos`
      : 'Nenhum recorte de função medido; informe cpuFunctions com arquivo e função autônoma no snapshot'})};
}

function declaredBudget(root, config, measurement) {
  const file = config?.baselineFile ?? 'desempenho.baseline.json';
  if (!config?.baselineFile && !fileExists(root, file)) return;
  let reference;
  try { reference = readJsonLimited(join(root, file), 2 * 1024 * 1024); } catch { /* orçamento inválido */ }
  const current = config?.server && measurement.httpMode === 'static'
    ? {...measurement, lighthouse: [], k6Routes: []} : measurement;
  return compareDeclaredBudget(current, reference, file);
}

export async function collectPerformance(root = REPO_ROOT, mode = process.env.PERF_HTTP_MODE) {
  const coverage = [];
  const findings = [];
  const measurement = {httpMode: 'static', versions: {'lighthouse-ci': 'desconhecida', k6: 'desconhecida',
    pg_stat_statements: 'desconhecida'}, lighthouse: [], k6Routes: [], sqlQueries: []};
  function record(result) {
    coverage.push(result.summary, ...result.extraCoverage);
    if (result.summary.status === 'ok') findings.push(...result.findings);
  }
  try {
    const config = loadConfig(root);
    const thresholds = config?.thresholds ?? DEFAULT_THRESHOLDS;
    coverage.push(...declaredRouteOmissions(config));
    const pgBinDir = findPostgresBinDir();
    const versions = getToolVersions(pgBinDir);
    const http = await openHttp(root, config, mode);
    measurement.httpMode = http.mode;
    measurement.versions = {'lighthouse-ci': versions.lhci, k6: versions.k6, pg_stat_statements: versions.pg};
    coverage.push(...http.coverage);
    try {
      for (const route of http.targets.filter(route => !route.page)) {
        coverage.push(routeCoverage(route.path, 'fora da seleção de páginas do Lighthouse CI'));
      }
      const lighthouse = await runLighthouseCi({origin: http.origin, routes: http.targets.filter(route => route.page),
        chromePath: findChrome(), thresholds, version: versions.lhci});
      record(lighthouse);
      measurement.lighthouse = lighthouse.measuredMetrics;
      const k6 = await runK6LoadTest({origin: http.origin, routeTargets: http.targets, thresholds, version: versions.k6});
      record(k6);
      measurement.k6Routes = k6.routeMetrics;
    } finally {
      await http.close?.();
    }

    record(await runCpuFunctions(root, config, thresholds, versions.node));
    const postgres = await runPostgresMetrics({workRoot: root, sqlInfo: discoverSqlFiles(root, config),
      pgBinDir, thresholds, version: versions.pg});
    record(postgres);
    measurement.sqlQueries = postgres.summary.status === 'ok' ? postgres.analyzedQueries : [];
    const budget = declaredBudget(root, config, measurement);
    if (budget) {
      coverage.push(budget.coverage);
      findings.push(...budget.findings);
    }
  } catch {
    coverage.push(normalizeCoverageRow({tool: 'coletor', version: '5', status: 'failed', detail: 'Coleta interrompida antes de concluir todas as etapas'}));
  }
  return {...validateModuleOutput({coverage, findings}), measurement: validatePerformanceMeasurement(measurement)};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await collectPerformance())}\n`);
}
