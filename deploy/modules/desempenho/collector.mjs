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
import {startStaticServer} from './static-server.mjs';
import {
  analyzeCpuProfile,
  DEFAULT_THRESHOLDS,
  evaluateBaselineRegression,
  evaluateK6Summary,
  evaluateLighthouseLhr,
  evaluatePgStatStatements,
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

function copyRepoSafe(srcDir, dstDir, state = {files: 0}) {
  mkdirSync(dstDir, {recursive: true});
  let entries;
  try {
    entries = readdirSync(srcDir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    if (state.files >= MAX_COPY_FILES) break;
    if (entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    const info = lstatSync(srcPath);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      copyRepoSafe(srcPath, dstPath, state);
    } else if (info.isFile() && info.size <= MAX_COPY_BYTES) {
      copyFileSync(srcPath, dstPath);
      state.files += 1;
    }
  }
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

function splitSqlStatements(sqlText, file) {
  const statements = [];
  const lines = sqlText.split(/\r?\n/);
  let current = [];
  let startLine = 1;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const rawLine = lines[idx];
    const trimmed = rawLine.trim();
    if (current.length === 0 && (trimmed === '' || trimmed.startsWith('--'))) {
      continue;
    }
    if (current.length === 0) startLine = idx + 1;
    current.push(rawLine);
    if (trimmed.endsWith(';')) {
      const joined = current.join('\n').trim();
      if (joined.length > 1) {
        statements.push({file, line: startLine, sql: joined.replace(/;\s*$/, '')});
      }
      current = [];
    }
  }
  if (current.length > 0) {
    const joined = current.join('\n').trim();
    if (joined.length > 0) {
      statements.push({file, line: startLine, sql: joined});
    }
  }
  return statements;
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
  const urls = routes.map(r => new URL(r.path, origin).href);
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
  spawnSync('lhci', ['assert', `--config=${configPath}`], {
    cwd: lhciDir,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  for (const fileName of lhrFiles) {
    const lhr = JSON.parse(readFileSync(join(outDataDir, fileName), 'utf8'));
    const reqPathname = (() => {
      try {
        return new URL(lhr.requestedUrl ?? lhr.finalDisplayedUrl ?? origin).pathname;
      } catch {
        return '/';
      }
    })();
    const routeInfo = routes.find(r => r.path === reqPathname) ?? routes[0];
    const evaluated = evaluateLighthouseLhr(lhr, routeInfo, thresholds);
    measuredMetrics.push(evaluated.metrics);
    findings.push(...evaluated.findings);

    const m = evaluated.metrics;
    extraCoverage.push(normalizeCoverageRow({
      tool: `lighthouse-ci:rota:${m.route}`,
      version,
      status: 'ok',
      detail: `arquivo=${m.file}; score=${m.score !== null ? (m.score * 100).toFixed(0) : 'n/a'}/100; LCP=${m.lcp !== null ? Math.round(m.lcp) : 'n/a'}ms; CLS=${m.cls !== null ? m.cls.toFixed(3) : 'n/a'}; TBT=${m.tbt !== null ? Math.round(m.tbt) : 'n/a'}ms`,
    }));
  }

  return {
    summary: normalizeCoverageRow({
      tool: 'lighthouse-ci',
      version,
      status: 'ok',
      detail: `${measuredMetrics.length} tela(s) medida(s) (LCP, CLS, TBT, desempenho); ${findings.length} achado(s)`,
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
  routeThresholdLines.http_req_failed = [`rate<${thresholds.k6FailRate}`];
  routeThresholdLines.http_req_duration = [`p(95)<${thresholds.k6P95Ms}`];
  for (const r of routeTargets) {
    routeThresholdLines[`http_req_duration{route:${r.path}}`] = [`p(95)<${thresholds.k6P95Ms}`];
    routeThresholdLines[`http_req_failed{route:${r.path}}`] = [`rate<${thresholds.k6FailRate}`];
  }

  const script = `import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 2,
  iterations: ${Math.max(12, routeTargets.length * 6)},
  thresholds: ${JSON.stringify(routeThresholdLines)},
};

const ORIGIN = ${JSON.stringify(origin)};
const ROUTES = ${JSON.stringify(routeTargets.map(r => r.path))};

export default function () {
  for (const route of ROUTES) {
    const res = http.get(ORIGIN + route, { tags: { route } });
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
      status: 'ok',
      detail: `arquivo=${rm.file}; p95=${rm.p95 !== null ? rm.p95.toFixed(1) : 'n/a'}ms; avg=${rm.avg !== null ? rm.avg.toFixed(1) : 'n/a'}ms; max=${rm.max !== null ? rm.max.toFixed(1) : 'n/a'}ms; falhas=${(rm.failRate * 100).toFixed(2)}%`,
    }));
  }

  return {
    summary: normalizeCoverageRow({
      tool: 'k6',
      version,
      status: 'ok',
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

async function runPgStatStatements({workRoot, sqlInfo, pgBinDir, thresholds, version}) {
  const extraCoverage = [];
  const findings = [];
  const analyzedQueries = [];

  const hasLiveSql = sqlInfo.migrations.length > 0 || sqlInfo.queries.length > 0;
  if (!hasLiveSql && !sqlInfo.snapshotFile) {
    return {
      summary: normalizeCoverageRow({
        tool: 'pg_stat_statements',
        version,
        status: 'skipped',
        detail: 'Nenhuma migração SQL, consulta ou snapshot pg_stat_statements encontrado no repositório',
      }),
      extraCoverage,
      findings,
      analyzedQueries,
    };
  }

  const sqlSources = [];
  const rowsToEvaluate = [];
  const explainPlans = [];

  if (sqlInfo.snapshotFile) {
    try {
      const snap = readJsonLimited(join(workRoot, sqlInfo.snapshotFile), 5 * 1024 * 1024);
      const list = Array.isArray(snap) ? snap : (Array.isArray(snap.rows) ? snap.rows : []);
      for (const item of list) rowsToEvaluate.push(item);
      extraCoverage.push(normalizeCoverageRow({
        tool: `pg_stat_statements:snapshot:${sqlInfo.snapshotFile}`,
        version,
        status: 'ok',
        detail: `${list.length} registro(s) carregado(s) do snapshot`,
      }));
    } catch (error) {
      return {
        summary: normalizeCoverageRow({
          tool: 'pg_stat_statements',
          version,
          status: 'failed',
          detail: `Falha ao ler snapshot ${sqlInfo.snapshotFile}: ${error instanceof Error ? error.message : 'erro'}`,
        }),
        extraCoverage,
        findings,
        analyzedQueries,
      };
    }
  }

  let migrationsApplied = 0;
  let migrationsFailed = 0;
  let queriesExecuted = 0;

  if (hasLiveSql) {
    if (!pgBinDir) {
      return {
        summary: normalizeCoverageRow({
          tool: 'pg_stat_statements',
          version,
          status: 'failed',
          detail: 'Binários PostgreSQL não encontrados em /usr/lib/postgresql/*/bin',
        }),
        extraCoverage,
        findings,
        analyzedQueries,
      };
    }

    const pgData = '/tmp/pgdata';
    const pgSock = '/tmp/pgsock';
    mkdirSync(pgSock, {recursive: true});
    const pgPort = await allocatePort();

    const initRes = spawnSync(
      join(pgBinDir, 'initdb'),
      ['-D', pgData, '-U', 'postgres', '--encoding=UTF8', '--locale=C.UTF-8', '--auth=trust', '--nosync'],
      {encoding: 'utf8', timeout: 30_000},
    );
    if (initRes.status !== 0) {
      return {
        summary: normalizeCoverageRow({
          tool: 'pg_stat_statements',
          version,
          status: 'failed',
          detail: `initdb falhou: ${(initRes.stderr || initRes.stdout || '').trim().slice(0, 260)}`,
        }),
        extraCoverage,
        findings,
        analyzedQueries,
      };
    }

    const confAppend = [
      "listen_addresses = '127.0.0.1'",
      `port = ${pgPort}`,
      `unix_socket_directories = '${pgSock}'`,
      "shared_preload_libraries = 'pg_stat_statements'",
      "pg_stat_statements.track = 'all'",
      'track_io_timing = on',
      'shared_buffers = 16MB',
      'dynamic_shared_memory_type = mmap',
      'max_connections = 20',
      'fsync = off',
    ].join('\n');
    writeFileSync(join(pgData, 'postgresql.conf'), `${readFileSync(join(pgData, 'postgresql.conf'), 'utf8')}\n${confAppend}\n`);

    const startRes = spawnSync(
      join(pgBinDir, 'pg_ctl'),
      ['-D', pgData, '-l', '/tmp/pg.log', 'start', '-w'],
      {encoding: 'utf8', timeout: 30_000},
    );
    if (startRes.status !== 0) {
      const logTail = existsSync('/tmp/pg.log') ? readFileSync('/tmp/pg.log', 'utf8').slice(-300) : '';
      return {
        summary: normalizeCoverageRow({
          tool: 'pg_stat_statements',
          version,
          status: 'failed',
          detail: `pg_ctl start falhou: ${(startRes.stderr || logTail).trim().slice(0, 260)}`,
        }),
        extraCoverage,
        findings,
        analyzedQueries,
      };
    }

    const pgMod = await import('pg');
    const Client = pgMod.default?.Client ?? pgMod.Client;
    const client = new Client({host: '127.0.0.1', port: pgPort, user: 'postgres', database: 'postgres'});
    try {
      await client.connect();
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');

      for (const migRel of sqlInfo.migrations) {
        const sqlText = readFileSync(join(workRoot, migRel), 'utf8');
        try {
          await client.query(sqlText);
          migrationsApplied += 1;
          extraCoverage.push(normalizeCoverageRow({
            tool: `pg_stat_statements:migracao:${migRel}`,
            version,
            status: 'ok',
            detail: 'migração aplicada com sucesso no PostgreSQL isolado',
          }));
        } catch (err) {
          migrationsFailed += 1;
          extraCoverage.push(normalizeCoverageRow({
            tool: `pg_stat_statements:migracao:${migRel}`,
            version,
            status: 'skipped',
            detail: `migração não aplicada: ${err instanceof Error ? err.message.slice(0, 180) : 'erro'}`,
          }));
        }
      }

      const parsedStatements = [];
      for (const qRel of sqlInfo.queries) {
        const sqlText = readFileSync(join(workRoot, qRel), 'utf8');
        const statements = splitSqlStatements(sqlText, qRel);
        for (const stmt of statements) {
          sqlSources.push(stmt);
          parsedStatements.push(stmt);
          const upper = stmt.sql.trim().toUpperCase();
          if (upper.startsWith('SELECT') || upper.startsWith('WITH')) {
            try {
              const expRes = await client.query(`EXPLAIN (FORMAT JSON) ${stmt.sql}`);
              const plan = expRes.rows?.[0]?.['QUERY PLAN']?.[0];
              if (plan) explainPlans.push({file: stmt.file, line: stmt.line, plan});
            } catch {
              /* erro de execução será tratado abaixo */
            }
          }
        }
      }

      await client.query('SELECT pg_stat_statements_reset()');

      for (const stmt of parsedStatements) {
        const upper = stmt.sql.trim().toUpperCase();
        const isSelect = upper.startsWith('SELECT') || upper.startsWith('WITH');
        try {
          for (let i = 0; i < 5; i += 1) {
            if (isSelect) {
              await client.query(stmt.sql);
            } else {
              await client.query('BEGIN');
              await client.query(stmt.sql);
              await client.query('ROLLBACK');
            }
          }
          queriesExecuted += 1;
        } catch (err) {
          extraCoverage.push(normalizeCoverageRow({
            tool: `pg_stat_statements:consulta:${stmt.file}:${stmt.line}`,
            version,
            status: 'skipped',
            detail: `erro ao executar consulta: ${err instanceof Error ? err.message.slice(0, 180) : 'erro'}`,
          }));
        }
      }

      const statsRes = await client.query(`
        SELECT query, calls, total_exec_time, mean_exec_time, max_exec_time, rows,
               shared_blks_hit, shared_blks_read, temp_blks_written
        FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY mean_exec_time DESC
        LIMIT 100
      `);
      for (const row of statsRes.rows) {
        rowsToEvaluate.push(row);
      }
    } finally {
      await client.end().catch(() => undefined);
      spawnSync(join(pgBinDir, 'pg_ctl'), ['-D', pgData, 'stop', '-m', 'fast'], {encoding: 'utf8', timeout: 10_000});
    }
  }

  const evaluated = evaluatePgStatStatements(rowsToEvaluate, explainPlans, sqlSources, thresholds);
  findings.push(...evaluated.findings);
  analyzedQueries.push(...evaluated.analyzedQueries);

  for (const aq of evaluated.analyzedQueries) {
    extraCoverage.push(normalizeCoverageRow({
      tool: `pg_stat_statements:consulta:${aq.file}:${aq.line}`,
      version,
      status: 'ok',
      detail: `calls=${aq.calls}; mean=${aq.meanMs.toFixed(2)}ms; max=${aq.maxMs.toFixed(2)}ms; total=${aq.totalMs.toFixed(2)}ms`,
    }));
  }

  return {
    summary: normalizeCoverageRow({
      tool: 'pg_stat_statements',
      version,
      status: 'ok',
      detail: `${migrationsApplied} migração(ões) aplicada(s) (${migrationsFailed} pulada(s)); ${queriesExecuted} consulta(s) executada(s); ${evaluated.analyzedQueries.length} estatística(s) analisada(s); ${findings.length} achado(s)`,
    }),
    extraCoverage,
    findings,
    analyzedQueries,
  };
}

async function main() {
  if (!existsSync(REPO_ROOT)) {
    throw new Error('Diretório /repo ausente');
  }
  copyRepoSafe(REPO_ROOT, WORK_ROOT);

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
  let serverStartFailure = null;

  const cpuProfDir = '/tmp/cpuprof';
  mkdirSync(cpuProfDir, {recursive: true});

  try {
    if (config?.server) {
      const port = await allocatePort();
      const entryAbs = join(WORK_ROOT, config.server.entry);
      if (!existsSync(entryAbs)) {
        serverStartFailure = `Entrypoint de servidor ausente: ${config.server.entry}`;
      } else {
        const serverArgs = config.server.cpuProfile
          ? ['--cpu-prof', `--cpu-prof-dir=${cpuProfDir}`, '--cpu-prof-interval=1000', entryAbs]
          : [entryAbs];
        serverChild = spawn(process.execPath, serverArgs, {
          cwd: WORK_ROOT,
          env: {
            PATH: process.env.PATH,
            HOME: '/tmp',
            TMPDIR: '/tmp',
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            [config.server.portEnv]: String(port),
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let serverStderr = '';
        serverChild.stderr?.on('data', chunk => {
          if (serverStderr.length < 1000) serverStderr += String(chunk);
        });
        const candidateOrigin = `http://127.0.0.1:${port}`;
        const ready = await waitForHttpReady(`${candidateOrigin}${config.server.readyPath}`, 10_000);
        if (!ready) {
          serverStartFailure = `Servidor ${config.server.entry} não respondeu em ${config.server.readyPath}: ${serverStderr.trim().slice(0, 200)}`;
          await stopChildGracefully(serverChild);
          serverChild = null;
        } else {
          origin = candidateOrigin;
          const declaredRoutes = config.routes.length > 0
            ? config.routes
            : config.server.routes.map(p => ({path: p, file: config.server.entry}));
          httpRouteTargets = declaredRoutes.map(r => ({
            path: r.path,
            file: r.file ?? config.server.entry,
            line: 1,
          }));
          // Para Lighthouse CI, prioriza rotas HTML declaradas ou '/'
          const htmlCandidates = declaredRoutes.filter(r => !r.path.startsWith('/api/'));
          webRoutes = htmlCandidates.length > 0 ? htmlCandidates : [{path: '/', file: config.server.entry}];
        }
      }
    } else if (process.env.PERF_TARGET_URL) {
      const parsedUrl = new URL(process.env.PERF_TARGET_URL);
      origin = parsedUrl.origin;
      const declared = config?.routes?.length ? config.routes : [{path: parsedUrl.pathname || '/', file: 'desempenho.config.json'}];
      webRoutes = declared;
      httpRouteTargets = declared.map(r => ({path: r.path, file: r.file ?? 'desempenho.config.json', line: 1}));
    } else {
      const staticWeb = discoverStaticWeb(WORK_ROOT, config);
      if (staticWeb) {
        staticServer = await startStaticServer(staticWeb.rootDir);
        origin = staticServer.origin;
        webRoutes = config?.routes?.length
          ? config.routes.map(r => ({path: r.path, file: r.file ?? staticWeb.routes[0]?.file ?? 'index.html'}))
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

    const k6Result = runK6LoadTest({
      origin,
      routeTargets: httpRouteTargets,
      thresholds,
      version: versions.k6,
    });

    // Encerra o servidor antes de analisar o .cpuprofile para garantir flush completo do V8.
    if (serverChild) {
      await stopChildGracefully(serverChild);
      serverChild = null;
    }
    if (staticServer) {
      await staticServer.close();
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
    } else {
      cpuResult = runCpuProfiling({
        cpuProfDir,
        workRoot: WORK_ROOT,
        config,
        thresholds,
        version: versions.node,
      });
    }

    const sqlInfo = discoverSqlFiles(WORK_ROOT, config);
    const pgResult = await runPgStatStatements({
      workRoot: WORK_ROOT,
      sqlInfo,
      pgBinDir,
      thresholds,
      version: versions.pg,
    });

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
    if (baselinePath && existsSync(baselinePath)) {
      const baseline = readJsonLimited(baselinePath, 2 * 1024 * 1024);
      const regressions = evaluateBaselineRegression(
        {
          lighthouse: lhResult.measuredMetrics,
          k6Routes: k6Result.routeMetrics,
          sqlQueries: pgResult.analyzedQueries,
        },
        baseline,
        thresholds,
      );
      allFindings.push(...regressions);
      extraBaselineCoverage.push(normalizeCoverageRow({
        tool: `baseline:${normalizeRepoRelativePath(baselinePath) ?? 'desempenho.baseline.json'}`,
        version: '1.0',
        status: 'ok',
        detail: `comparação com baseline executada; ${regressions.length} regressão(ões) detectada(s)`,
      }));
    }

    const coverage = [
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
    if (staticServer) await staticServer.close().catch(() => undefined);
  }
}

main().catch(error => {
  process.stderr.write(`PERF_COLLECTOR_FATAL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
