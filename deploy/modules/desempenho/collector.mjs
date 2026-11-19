/**
 * Coletor real do módulo 7 (desempenho).
 * Executa dentro do contêiner isolado (--network none por padrão, --read-only, UID 65532).
 * Emite um único JSON UTF-8 em stdout: { coverage: [...], findings: [...] }.
 */
import {spawn, spawnSync} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {createServer} from 'node:net';
import {basename, dirname, extname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  analyzeCpuProfile,
  DEFAULT_THRESHOLDS,
  evaluateBaselineRegression,
  evaluateK6Summary,
  evaluateLighthouseLhr,
  normalizeCoverageRow,
  normalizeRepoRelativePath,
  validateConfig,
  validateModuleOutput,
} from './lib.mjs';

const REPO_ROOT = '/repo';
const WORK_ROOT = '/tmp/work-repo';
const MAX_COPY_FILES = 2500;
const MAX_COPY_BYTES = 10 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.nuxt', 'coverage', '.lighthouseci']);

function copyRepoSafe(srcDir, dstDir, state = {files: 0, omissions: []}) {
  mkdirSync(dstDir, {recursive: true});
  let entries;
  try {
    entries = readdirSync(srcDir, {withFileTypes: true});
  } catch {
    state.omissions.push(`diretório ilegível: ${relative(REPO_ROOT, srcDir) || '.'}`);
    return state;
  }
  for (const entry of entries) {
    if (state.files >= MAX_COPY_FILES) { state.omissions.push('limite de 2500 arquivos'); break; }
    if (entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    let info;
    try { info = lstatSync(srcPath); } catch { state.omissions.push(`entrada ilegível: ${relative(REPO_ROOT, srcPath)}`); continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      copyRepoSafe(srcPath, dstPath, state);
    } else if (info.isFile() && info.size <= MAX_COPY_BYTES) {
      try { copyFileSync(srcPath, dstPath); state.files += 1; } catch { state.omissions.push(`arquivo ilegível: ${relative(REPO_ROOT, srcPath)}`); }
    } else if (info.isFile()) { state.omissions.push(`arquivo maior que 10 MiB: ${relative(REPO_ROOT, srcPath)}`); }
  }
  return state;
}

function readJsonLimited(filePath, maxBytes = 512 * 1024) {
  const info = lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) {
    throw new Error(`Arquivo JSON inválido ou grande demais: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
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
    if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const full = join(rootDir, rel);
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
  const base = '/usr/lib/postgresql';
  try {
    const versions = readdirSync(base, {withFileTypes: true})
      .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
      .map(d => Number(d.name))
      .sort((a, b) => b - a);
    for (const ver of versions) {
      const bin = join(base, String(ver), 'bin');
      if (existsSync(join(bin, 'initdb')) && existsSync(join(bin, 'pg_ctl')) && existsSync(join(bin, 'postgres'))) {
        return bin;
      }
    }
  } catch {
    /* ausente */
  }
  return null;
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

async function allocatePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const srv = createServer();
    srv.once('error', rejectPromise);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(err => (err ? rejectPromise(err) : resolvePromise(port)));
    });
  });
}

async function waitForHttpReady(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {signal: AbortSignal.timeout(1500)});
      if (res.status < 500) return true;
    } catch {
      /* aguarda subir */
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

async function stopChildGracefully(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveStop => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolveStop();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolveStop();
    }
  });
}


function discoverStaticWeb(workRoot, config) {
  if (config?.staticDir) {
    const dir = join(workRoot, config.staticDir);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      const htmls = listFilesByExt(dir, ['.html', '.htm']);
      if (htmls.length > 0) {
        const routes = htmls.map(h => ({
          path: h === 'index.html' ? '/' : `/${h}`,
          file: `${config.staticDir}/${h}`,
        }));
        return {rootDir: dir, routes};
      }
    }
  }

  for (const candidate of ['public', 'dist', 'build', 'deploy/pwa']) {
    const dir = join(workRoot, candidate);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      const htmls = listFilesByExt(dir, ['.html', '.htm']);
      if (htmls.length > 0) {
        const routes = htmls.map(h => ({
          path: h === 'index.html' ? '/' : `/${h}`,
          file: `${candidate}/${h}`,
        }));
        return {rootDir: dir, routes};
      }
    }
  }

  if (existsSync(join(workRoot, 'index.html'))) {
    const htmls = readdirSync(workRoot).filter(f => f.endsWith('.html') || f.endsWith('.htm'));
    return {
      rootDir: workRoot,
      routes: htmls.map(h => ({path: h === 'index.html' ? '/' : `/${h}`, file: h})),
    };
  }
  return null;
}

function discoverSqlFiles(workRoot, config) {
  const migrations = [];
  if (config?.migrations?.length) {
    for (const m of config.migrations) {
      if (existsSync(join(workRoot, m))) migrations.push(m);
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
      if (existsSync(join(workRoot, q))) queries.push(q);
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
      extraCoverage,
      findings,
      measuredMetrics,
    };
  }

  const lhciDir = '/tmp/lhci';
  mkdirSync(lhciDir, {recursive: true});
  const urls = routes.map(r => { const url = new URL(r.path, origin); if (url.origin !== origin) throw new Error('origem de rota inválida'); return url.href; });
  const configPath = join(lhciDir, 'lighthouserc.json');
  const rc = {
    ci: {
      collect: {
        url: urls,
        numberOfRuns: 1,
        settings: {
          chromeFlags: '--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu',
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

  const collectRes = spawnSync('lhci', ['collect', `--config=${configPath}`], {
    cwd: lhciDir,
    env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
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

  if (collectRes.status !== 0 || lhrFiles.length === 0) {
    const errText = (collectRes.stderr || collectRes.stdout || `exit=${collectRes.status}`).trim();
    return {
      summary: normalizeCoverageRow({
        tool: 'lighthouse-ci',
        version,
        status: 'failed',
        detail: `lhci collect falhou: ${errText.slice(0, 300)}`,
      }),
      extraCoverage,
      findings,
      measuredMetrics,
    };
  }

  // Também executa `lhci assert` para validar as asserções nativas do Lighthouse CI
  const assertRes = spawnSync('lhci', ['assert', `--config=${configPath}`], {
    cwd: lhciDir,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  for (const fileName of lhrFiles) {
    let lhr, requested;
    try {
      lhr = readJsonLimited(join(outDataDir, fileName), 16 * 1024 * 1024);
      requested = new URL(lhr.requestedUrl);
    } catch { continue; }
    const routeInfo = routes.find(r => requested.href === new URL(r.path, origin).href);
    if (!routeInfo || requested.origin !== origin || measuredMetrics.some(m => m.route === routeInfo.path)) continue;
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
      status: m ? 'ok' : 'failed', detail: m ? `arquivo=${m.file}; score=${m.score}; LCP=${m.lcp}ms; CLS=${m.cls}; TBT=${m.tbt}ms` : 'LHR correspondente com métricas completas ausente'}));
  }

  return {
    summary: normalizeCoverageRow({
      tool: 'lighthouse-ci',
      version,
      status: measuredMetrics.length === routes.length && assertRes.status === 0 ? 'ok' : 'failed',
      detail: `assert exit=${assertRes.status}; ${measuredMetrics.length} tela(s) medida(s) (LCP, CLS, TBT, desempenho); ${findings.length} achado(s)`,
    }),
    extraCoverage,
    findings,
    measuredMetrics,
  };
}

function runK6LoadTest({origin, routeTargets, thresholds, version}) {
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

  const k6Dir = '/tmp/k6';
  mkdirSync(k6Dir, {recursive: true});
  const scriptPath = join(k6Dir, 'script.js');
  const summaryPath = join(k6Dir, 'summary.json');

  const routeThresholdLines = {};
  routeThresholdLines.http_req_failed = [`rate<=${thresholds.k6FailRate}`];
  routeThresholdLines.http_req_duration = [`p(95)<=${thresholds.k6P95Ms}`];
  for (const r of routeTargets) {
    routeThresholdLines[`http_req_duration{route:${r.path}}`] = [`p(95)<=${thresholds.k6P95Ms}`];
    routeThresholdLines[`http_req_failed{route:${r.path}}`] = [`rate<=${thresholds.k6FailRate}`];
  }

  const script = `import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 2,
  iterations: 2,
  maxDuration: '45s',
  thresholds: ${JSON.stringify(routeThresholdLines)},
};

const ORIGIN = ${JSON.stringify(origin)};
const ROUTES = ${JSON.stringify(routeTargets.map(r => r.path))};

export default function () {
  for (const route of ROUTES) {
    const res = http.get(ORIGIN + route, { tags: { route }, timeout: '1s', redirects: 0 });
    check(res, { 'status < 500': (r) => r.status < 500 });
  }
}
`;
  writeFileSync(scriptPath, script, 'utf8');

  const res = spawnSync(
    'k6',
    ['run', '--no-usage-report', `--summary-export=${summaryPath}`, scriptPath],
    {
      cwd: k6Dir,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  // k6 sai 0 quando passa todos os limites, e 99 quando um limite (threshold) é violado.
  if ((res.status !== 0 && res.status !== 99) || !existsSync(summaryPath)) {
    const errText = (res.stderr || res.stdout || `exit=${res.status}`).trim();
    return {
      summary: normalizeCoverageRow({
        tool: 'k6',
        version,
        status: 'failed',
        detail: `k6 falhou (exit=${res.status}): ${errText.slice(0, 300)}`,
      }),
      extraCoverage,
      findings,
      routeMetrics,
    };
  }

  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const evaluated = evaluateK6Summary(summary, res.status, routeTargets, thresholds);
  findings.push(...evaluated.findings);
  routeMetrics.push(...evaluated.routeMetrics);

  for (const rm of evaluated.routeMetrics) {
    extraCoverage.push(normalizeCoverageRow({
      tool: `k6:rota:${rm.route}`,
      version,
      status: rm.p95 !== null && rm.failRate !== null ? 'ok' : 'failed',
      detail: `arquivo=${rm.file}; p95=${rm.p95 !== null ? rm.p95.toFixed(1) : 'n/a'}ms; avg=${rm.avg !== null ? rm.avg.toFixed(1) : 'n/a'}ms; max=${rm.max !== null ? rm.max.toFixed(1) : 'n/a'}ms; falhas=${rm.failRate === null ? 'n/a' : (rm.failRate * 100).toFixed(2) + '%'}`,
    }));
  }

  return {
    summary: normalizeCoverageRow({
      tool: 'k6',
      version,
      status: routeMetrics.every(r => r.p95 !== null && r.failRate !== null) ? 'ok' : 'failed',
      detail: `${routeMetrics.length} rota(s) testada(s) com limites (p95<${thresholds.k6P95Ms}ms, falhas<${(thresholds.k6FailRate * 100).toFixed(1)}%); ${findings.length} achado(s)`,
    }),
    extraCoverage,
    findings,
    routeMetrics,
  };
}

function runCpuProfiling({cpuProfDir, workRoot, config, thresholds, version}) {
  const extraCoverage = [];
  const findings = [];

  const workloads = [...(config?.cpuWorkloads ?? [])];
  if (workloads.length === 0) {
    for (const dir of ['perf', 'benchmarks']) {
      const full = join(workRoot, dir);
      if (existsSync(full) && statSync(full).isDirectory()) {
        for (const f of listFilesByExt(full, ['.mjs', '.js'])) {
          workloads.push({file: `${dir}/${f}`, args: []});
        }
      }
    }
  }

  let workloadFailures = 0;
  for (const workload of workloads) {
    const abs = join(workRoot, workload.file);
    if (!existsSync(abs)) {
      workloadFailures += 1;
      extraCoverage.push(normalizeCoverageRow({
        tool: `node-cpu-prof:arquivo:${workload.file}`,
        version,
        status: 'failed',
        detail: `Workload ausente: ${workload.file}`,
      }));
      continue;
    }
    const runRes = spawnSync(
      process.execPath,
      ['--cpu-prof', `--cpu-prof-dir=${cpuProfDir}`, '--cpu-prof-interval=1000', abs, ...(workload.args ?? [])],
      {
        cwd: workRoot,
        env: {PATH: process.env.PATH, HOME: '/tmp', TMPDIR: '/tmp', NODE_ENV: 'test'},
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (runRes.status !== 0) {
      workloadFailures += 1;
      extraCoverage.push(normalizeCoverageRow({
        tool: `node-cpu-prof:arquivo:${workload.file}`,
        version,
        status: 'failed',
        detail: `Execução do workload falhou (exit=${runRes.status}): ${(runRes.stderr || '').trim().slice(0, 200)}`,
      }));
    }
  }

  let profileFiles = [];
  try {
    profileFiles = readdirSync(cpuProfDir).filter(f => f.endsWith('.cpuprofile')).sort();
  } catch {
    profileFiles = [];
  }

  if (profileFiles.length === 0 && workloadFailures === 0) {
    return {
      summary: normalizeCoverageRow({
        tool: 'node-cpu-prof',
        version,
        status: 'skipped',
        detail: 'Nenhum servidor Node.js ou workload configurado (desempenho.config.json ou perf/*.mjs) para perfilar com --cpu-prof',
      }),
      extraCoverage,
      findings,
    };
  }

  if (profileFiles.length === 0 && workloadFailures > 0) {
    return {
      summary: normalizeCoverageRow({
        tool: 'node-cpu-prof',
        version,
        status: 'failed',
        detail: `${workloadFailures} workload(s) falharam sem gerar .cpuprofile`,
      }),
      extraCoverage,
      findings,
    };
  }

  const seenFiles = new Set();
  for (const profFile of profileFiles) {
    const profJson = JSON.parse(readFileSync(join(cpuProfDir, profFile), 'utf8'));
    const analysis = analyzeCpuProfile(profJson, workRoot, thresholds);
    findings.push(...analysis.findings);

    const topSpot = analysis.hotspots[0];
    const filesInProf = [...new Set(analysis.hotspots.map(h => h.file))];
    if (filesInProf.length === 0) {
      extraCoverage.push(normalizeCoverageRow({
        tool: `node-cpu-prof:perfil:${profFile}`,
        version,
        status: 'ok',
        detail: `duração=${analysis.totalDurationMs.toFixed(1)}ms; amostras=${analysis.sampleCount}; sem hotspots no código do projeto`,
      }));
    } else {
      for (const fileRel of filesInProf) {
        if (seenFiles.has(fileRel)) continue;
        seenFiles.add(fileRel);
        const spot = analysis.hotspots.find(h => h.file === fileRel) ?? topSpot;
        extraCoverage.push(normalizeCoverageRow({
          tool: `node-cpu-prof:arquivo:${fileRel}`,
          version,
          status: 'ok',
          detail: `duração=${analysis.totalDurationMs.toFixed(1)}ms; amostras=${analysis.sampleCount}; principal=${spot.functionName}@L${spot.line} (${spot.selfMs.toFixed(1)}ms / ${spot.pct.toFixed(1)}%)`,
        }));
      }
    }
  }

  return {
    summary: normalizeCoverageRow({
      tool: 'node-cpu-prof',
      version,
      status: workloadFailures > 0 ? 'failed' : 'ok',
      detail: `${profileFiles.length} perfil(is) .cpuprofile analisado(s); ${findings.length} hotspot(s) acima do limite (${thresholds.cpuSelfMs}ms)`,
    }),
    extraCoverage,
    findings,
  };
}

async function runPgStatStatements({workRoot, sqlInfo, version}) {
  const extraCoverage = [];
  if (sqlInfo.snapshotFile) {
    try {
      const snapshot = readJsonLimited(join(workRoot, sqlInfo.snapshotFile), 5 * 1024 * 1024);
      const rows = Array.isArray(snapshot) ? snapshot : snapshot?.rows;
      if (!Array.isArray(rows)) throw new Error('snapshot deve conter array de registros');
      extraCoverage.push(normalizeCoverageRow({tool: `pg_stat_statements:snapshot:${sqlInfo.snapshotFile}`, version, status: 'skipped', detail: `${rows.length} registro(s) externos, sem proveniência de medição local`}));
    } catch (error) {
      extraCoverage.push(normalizeCoverageRow({tool: `pg_stat_statements:snapshot:${sqlInfo.snapshotFile}`, version, status: 'failed', detail: `Snapshot inválido: ${error instanceof Error ? error.message : String(error)}`}));
    }
  }
  const hasSql = sqlInfo.migrations.length || sqlInfo.queries.length;
  return {
    summary: normalizeCoverageRow({tool: 'pg_stat_statements', version, status: extraCoverage.some(row => row.status === 'failed') ? 'failed' : 'skipped',
      detail: hasSql ? 'SQL não executado: PostgreSQL compartilha UID e privilégios com o coletor; isolamento de evidências indisponível' : 'Nenhuma medição SQL local disponível'}),
    extraCoverage, findings: [], analyzedQueries: [],
  };
}

const retained = {coverage: [], findings: []};
async function main() {
  if (!existsSync(REPO_ROOT)) {
    throw new Error('Diretório /repo ausente');
  }
  const copyState = copyRepoSafe(REPO_ROOT, WORK_ROOT);

  let config = null;
  const configPath = join(WORK_ROOT, 'desempenho.config.json');
  if (existsSync(configPath)) {
    config = validateConfig(readJsonLimited(configPath, 256 * 1024));
  }
  const thresholds = config?.thresholds ?? DEFAULT_THRESHOLDS;

  const pgBinDir = findPostgresBinDir();
  const chromePath = findChrome();
  const versions = getToolVersions(pgBinDir);

  let serverChild = null;
  let staticServer = null;
  let origin = null;
  let webRoutes = [];
  let httpRouteTargets = [];
  const unmappedRoutes = [];
  let serverStartFailure = null;

  const cpuProfDir = '/tmp/cpuprof';
  mkdirSync(cpuProfDir, {recursive: true});

  try {
    if (config?.server) {
      serverStartFailure = 'Servidor do repositório não executado: UID compartilhado permite alterar evidências';
    } else if (process.env.PERF_TARGET_URL) {
      serverStartFailure = 'Alvo externo não permitido nesta coleta local';
    } else {
      const staticWeb = discoverStaticWeb(WORK_ROOT, config);
      if (staticWeb) {
        staticServer = spawn(process.execPath, [fileURLToPath(new URL('./static-server.mjs', import.meta.url)), staticWeb.rootDir], {stdio: ['ignore', 'pipe', 'ignore']});
        origin = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('servidor estático não iniciou')), 5000);
          staticServer.stdout.once('data', data => { clearTimeout(timer); resolve(String(data).trim()); });
          staticServer.once('exit', () => { clearTimeout(timer); reject(new Error('servidor estático terminou')); });
        });
        webRoutes = config?.routes?.length
          ? config.routes.map(r => ({path: r.path, file: r.file ?? staticWeb.routes.find(candidate => candidate.path === new URL(r.path, origin).pathname)?.file})).filter(r => { if (!r.file) { unmappedRoutes.push(r.path); return false; } return true; })
          : staticWeb.routes;
        httpRouteTargets = webRoutes.map(r => ({path: r.path, file: r.file ?? 'index.html', line: 1}));
      }
    }

    const lhResult = await runLighthouseCi({
      origin,
      routes: webRoutes,
      chromePath,
      thresholds,
      version: versions.lhci,
    });

    retained.coverage.push(lhResult.summary, ...lhResult.extraCoverage);
    retained.findings.push(...lhResult.findings);
    const k6Result = runK6LoadTest({
      origin,
      routeTargets: httpRouteTargets,
      thresholds,
      version: versions.k6,
    });

    retained.coverage.push(k6Result.summary, ...k6Result.extraCoverage);
    retained.findings.push(...k6Result.findings);

    // Encerra o servidor antes de analisar o .cpuprofile para garantir flush completo do V8.
    if (serverChild) {
      await stopChildGracefully(serverChild);
      serverChild = null;
    }
    if (staticServer) {
      await stopChildGracefully(staticServer);
      staticServer = null;
    }

    let cpuResult;
    if (serverStartFailure) {
      cpuResult = {
        summary: normalizeCoverageRow({
          tool: 'node-cpu-prof',
          version: versions.node,
          status: 'failed',
          detail: serverStartFailure,
        }),
        extraCoverage: [],
        findings: [],
      };
    } else if (config?.cpuWorkloads?.length || existsSync(join(WORK_ROOT, 'perf')) || existsSync(join(WORK_ROOT, 'benchmarks'))) {
      cpuResult = {summary: normalizeCoverageRow({tool: 'node-cpu-prof', version: versions.node, status: 'skipped', detail: 'Workloads não executados: UID compartilhado permite alterar evidências'}), extraCoverage: [], findings: []};
    } else {
      cpuResult = runCpuProfiling({
        cpuProfDir,
        workRoot: WORK_ROOT,
        config,
        thresholds,
        version: versions.node,
      });
    }

    retained.coverage.push(cpuResult.summary, ...cpuResult.extraCoverage);
    retained.findings.push(...cpuResult.findings);
    const sqlInfo = discoverSqlFiles(WORK_ROOT, config);
    const pgResult = await runPgStatStatements({
      workRoot: WORK_ROOT,
      sqlInfo,
      pgBinDir,
      thresholds,
      version: versions.pg,
    });

    retained.coverage.push(pgResult.summary, ...pgResult.extraCoverage);
    retained.findings.push(...pgResult.findings);
    const allFindings = [
      ...lhResult.findings,
      ...k6Result.findings,
      ...cpuResult.findings,
      ...pgResult.findings,
    ];

    const baselinePath = config?.baselineFile
      ? join(WORK_ROOT, config.baselineFile)
      : (existsSync(join(WORK_ROOT, 'desempenho.baseline.json')) ? join(WORK_ROOT, 'desempenho.baseline.json') : null);
    const extraBaselineCoverage = [];
    if (baselinePath) {
      const baselineName = config?.baselineFile ?? 'desempenho.baseline.json';
      try {
        const baseline = readJsonLimited(baselinePath, 2 * 1024 * 1024);
        if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('baseline inválido');
        const current = {lighthouse: lhResult.measuredMetrics, k6Routes: k6Result.routeMetrics, sqlQueries: pgResult.analyzedQueries};
        const pairs = (current.k6Routes || []).filter(c => Number.isFinite(c.p95) && baseline.k6Routes?.some(b => b.route === c.route && Number.isFinite(b.p95) && b.p95 > 0)).length
          + (current.lighthouse || []).filter(c => Number.isFinite(c.lcp) && baseline.lighthouse?.some(b => b.route === c.route && b.formFactor === c.formFactor && Number.isFinite(b.lcp) && b.lcp > 0)).length
          + (current.sqlQueries || []).filter(c => Number.isFinite(c.meanMs) && baseline.sqlQueries?.some(b => b.file === c.file && b.line === c.line && Number.isFinite(b.meanMs) && b.meanMs > 0)).length;
        const regressions = evaluateBaselineRegression(current, baseline, thresholds);
        allFindings.push(...regressions);
        extraBaselineCoverage.push(normalizeCoverageRow({tool: `baseline:${baselineName}`, version: '1.0', status: pairs ? 'ok' : 'skipped', detail: `${pairs} par(es) comparáveis; ${regressions.length} regressão(ões); comparação limitada aos pares presentes e valores anteriores positivos`}));
      } catch (error) {
        extraBaselineCoverage.push(normalizeCoverageRow({tool: `baseline:${baselineName}`, version: '1.0', status: 'failed', detail: `Baseline indisponível ou inválido: ${error instanceof Error ? error.message : String(error)}`}));
      }
    }

    const coverage = [
      normalizeCoverageRow({tool: 'copia-repositorio', version: '1', status: copyState.omissions.length ? 'failed' : 'ok', detail: `${copyState.files} arquivo(s); limites: 2500 arquivos, 10 MiB por arquivo; exclusões: .git, dependências, builds e symlinks; ${copyState.omissions.slice(0, 4).join('; ') || 'sem omissões adicionais'}`}),
      ...unmappedRoutes.map(route => normalizeCoverageRow({tool: `rota:${route}`, version: '1', status: 'skipped', detail: 'Arquivo da rota não identificado; informe routes[].file'})),
      lhResult.summary,
      ...lhResult.extraCoverage,
      k6Result.summary,
      ...k6Result.extraCoverage,
      cpuResult.summary,
      ...cpuResult.extraCoverage,
      pgResult.summary,
      ...pgResult.extraCoverage,
      ...extraBaselineCoverage,
    ];

    const validated = validateModuleOutput({coverage, findings: allFindings});
    process.stdout.write(`${JSON.stringify(validated)}\n`);
  } finally {
    if (serverChild) await stopChildGracefully(serverChild);
    if (staticServer) await stopChildGracefully(staticServer);
  }
}

main().catch(error => {
  retained.coverage.push(normalizeCoverageRow({tool: 'coletor', version: '1', status: 'failed', detail: error instanceof Error ? error.message : String(error)}));
  process.stdout.write(`${JSON.stringify(validateModuleOutput(retained))}\n`);
});
