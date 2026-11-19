/** Funções puras de validação, avaliação de limites e normalização de saída do módulo 7 (desempenho). */

export const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);
export const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);

export const DEFAULT_THRESHOLDS = {
  performanceScore: 0.7,
  lcpMs: 2500,
  cls: 0.1,
  tbtMs: 200,
  k6P95Ms: 200,
  k6FailRate: 0.01,
  cpuSelfMs: 80,
  cpuTotalPct: 25,
  sqlMeanMs: 50,
  sqlMaxMs: 120,
  sqlSeqScanCost: 100,
  regressionPct: 25,
};

function cleanText(value, fallback, max = 500) {
  const raw = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return (raw.length > 0 ? raw : fallback).slice(0, max);
}

/**
 * Normaliza caminho relativo do repositório, rejeitando escapes, paths absolutos ou nulos.
 */
export function normalizeRepoRelativePath(rawPath, prefixes = ['/repo/', '/tmp/work-repo/']) {
  if (typeof rawPath !== 'string') return null;
  let value = rawPath.trim();
  if (value.length === 0 || value.includes('\0') || value.includes('\\')) return null;
  if (value.startsWith('file://')) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
    } catch {
      return null;
    }
  }
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }
  value = value.replace(/^\.\//, '');
  if (value.startsWith('/')) return null;
  const segments = value.split('/');
  if (segments.some(seg => seg === '' || seg === '.' || seg === '..')) return null;
  if (value.length > 400) return null;
  return value;
}

export function normalizePositiveLine(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return 1;
  return Math.trunc(num);
}

export function normalizeFinding(input) {
  const file = normalizeRepoRelativePath(input?.file) ?? 'desempenho.config.json';
  const severity = VALID_SEVERITIES.has(input?.severity) ? input.severity : 'media';
  return {
    tool: cleanText(input?.tool, 'desempenho', 80),
    rule: cleanText(input?.rule, 'PERF-FINDING', 120),
    file,
    line: normalizePositiveLine(input?.line),
    severity,
    message: cleanText(input?.message, 'Problema de desempenho detectado', 400),
    evidence: cleanText(input?.evidence, 'sem evidência adicional', 800),
  };
}

export function normalizeCoverageRow(input) {
  const status = VALID_STATUSES.has(input?.status) ? input.status : 'failed';
  return {
    tool: cleanText(input?.tool, 'desconhecida', 120),
    version: cleanText(input?.version, 'desconhecida', 80),
    status,
    detail: cleanText(input?.detail, status === 'failed' ? 'falha na execução' : 'sem detalhes', 500),
  };
}

export function validateModuleOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Saída do módulo deve ser um objeto JSON');
  }
  if (!Array.isArray(output.coverage) || !Array.isArray(output.findings)) {
    throw new Error('Saída deve conter arrays coverage e findings');
  }
  const coverage = output.coverage.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Item de coverage inválido');
    if (!VALID_STATUSES.has(row.status)) throw new Error(`Status inválido em coverage: ${String(row.status)}`);
    return normalizeCoverageRow(row);
  });
  const findings = output.findings.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Item de finding inválido');
    const rel = normalizeRepoRelativePath(item.file);
    if (!rel) throw new Error(`Caminho relativo inválido em finding: ${String(item.file)}`);
    if (!Number.isInteger(item.line) || item.line < 1) throw new Error(`Linha inválida em finding: ${String(item.line)}`);
    if (!VALID_SEVERITIES.has(item.severity)) throw new Error(`Gravidade inválida em finding: ${String(item.severity)}`);
    return normalizeFinding({...item, file: rel});
  });
  return {coverage, findings};
}

function finiteNumber(value, fallback, min = 0, max = 10_000_000) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) return fallback;
  return num;
}

export function validateThresholds(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    performanceScore: finiteNumber(src.performanceScore, DEFAULT_THRESHOLDS.performanceScore, 0, 1),
    lcpMs: finiteNumber(src.lcpMs, DEFAULT_THRESHOLDS.lcpMs, 1),
    cls: finiteNumber(src.cls, DEFAULT_THRESHOLDS.cls, 0, 10),
    tbtMs: finiteNumber(src.tbtMs, DEFAULT_THRESHOLDS.tbtMs, 1),
    k6P95Ms: finiteNumber(src.k6P95Ms, DEFAULT_THRESHOLDS.k6P95Ms, 1),
    k6FailRate: finiteNumber(src.k6FailRate, DEFAULT_THRESHOLDS.k6FailRate, 0, 1),
    cpuSelfMs: finiteNumber(src.cpuSelfMs, DEFAULT_THRESHOLDS.cpuSelfMs, 1),
    cpuTotalPct: finiteNumber(src.cpuTotalPct, DEFAULT_THRESHOLDS.cpuTotalPct, 1, 100),
    sqlMeanMs: finiteNumber(src.sqlMeanMs, DEFAULT_THRESHOLDS.sqlMeanMs, 0.1),
    sqlMaxMs: finiteNumber(src.sqlMaxMs, DEFAULT_THRESHOLDS.sqlMaxMs, 0.1),
    sqlSeqScanCost: finiteNumber(src.sqlSeqScanCost, DEFAULT_THRESHOLDS.sqlSeqScanCost, 1),
    regressionPct: finiteNumber(src.regressionPct, DEFAULT_THRESHOLDS.regressionPct, 1, 1000),
  };
}

function safeRoutePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('#') || /[{},]/.test(trimmed) || trimmed.length > 200 || trimmed.includes('..') || trimmed.includes('\\') || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Configuração de desempenho deve ser um objeto JSON');
  }
  const out = {
    staticDir: undefined,
    routes: [],
    server: undefined,
    cpuWorkloads: [],
    migrationsDir: undefined,
    migrations: [],
    sqlDir: undefined,
    sqlQueries: [],
    pgStatStatementsFile: undefined,
    baselineFile: undefined,
    thresholds: validateThresholds(raw.thresholds),
  };

  if (raw.staticDir !== undefined) {
    const rel = normalizeRepoRelativePath(raw.staticDir);
    if (!rel) throw new Error('staticDir inválido');
    out.staticDir = rel;
  }
  if (Array.isArray(raw.routes)) {
    for (const entry of raw.routes.slice(0, 40)) {
      if (typeof entry === 'string') {
        const route = safeRoutePath(entry);
        if (route) out.routes.push({path: route, file: undefined});
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const route = safeRoutePath(entry.path);
        const file = entry.file !== undefined ? normalizeRepoRelativePath(entry.file) : undefined;
        if (route) out.routes.push({path: route, file: file ?? undefined});
      }
    }
  }
  if (raw.server !== undefined) {
    if (!raw.server || typeof raw.server !== 'object' || Array.isArray(raw.server)) {
      throw new Error('server inválido na configuração');
    }
    const entry = normalizeRepoRelativePath(raw.server.entry);
    if (!entry) throw new Error('server.entry inválido');
    const routes = Array.isArray(raw.server.routes)
      ? raw.server.routes.map(safeRoutePath).filter(Boolean).slice(0, 40)
      : ['/'];
    const readyPath = safeRoutePath(raw.server.readyPath ?? '/') ?? '/';
    const portEnv = typeof raw.server.portEnv === 'string' && /^[A-Z_][A-Z0-9_]{0,40}$/.test(raw.server.portEnv)
      ? raw.server.portEnv
      : 'PORT';
    out.server = {
      entry,
      routes: routes.length > 0 ? routes : ['/'],
      readyPath,
      portEnv,
      cpuProfile: raw.server.cpuProfile !== false,
    };
  }
  if (Array.isArray(raw.cpuWorkloads)) {
    for (const item of raw.cpuWorkloads.slice(0, 20)) {
      const file = typeof item === 'string'
        ? normalizeRepoRelativePath(item)
        : (item && typeof item === 'object' ? normalizeRepoRelativePath(item.file) : null);
      if (!file) continue;
      const args = Array.isArray(item?.args)
        ? item.args.filter(a => typeof a === 'string' && !a.includes('..') && !a.includes('\0') && a.length <= 120).slice(0, 10)
        : [];
      out.cpuWorkloads.push({file, args});
    }
  }
  if (raw.migrationsDir !== undefined) {
    const rel = normalizeRepoRelativePath(raw.migrationsDir);
    if (!rel) throw new Error('migrationsDir inválido');
    out.migrationsDir = rel;
  }
  if (Array.isArray(raw.migrations)) {
    for (const m of raw.migrations.slice(0, 100)) {
      const rel = normalizeRepoRelativePath(m);
      if (rel) out.migrations.push(rel);
    }
  }
  if (raw.sqlDir !== undefined) {
    const rel = normalizeRepoRelativePath(raw.sqlDir);
    if (!rel) throw new Error('sqlDir inválido');
    out.sqlDir = rel;
  }
  if (Array.isArray(raw.sqlQueries)) {
    for (const q of raw.sqlQueries.slice(0, 100)) {
      const rel = typeof q === 'string'
        ? normalizeRepoRelativePath(q)
        : (q && typeof q === 'object' ? normalizeRepoRelativePath(q.file) : null);
      if (rel) out.sqlQueries.push(rel);
    }
  }
  if (raw.pgStatStatementsFile !== undefined) {
    const rel = normalizeRepoRelativePath(raw.pgStatStatementsFile);
    if (!rel) throw new Error('pgStatStatementsFile inválido');
    out.pgStatStatementsFile = rel;
  }
  if (raw.baselineFile !== undefined) {
    const rel = normalizeRepoRelativePath(raw.baselineFile);
    if (!rel) throw new Error('baselineFile inválido');
    out.baselineFile = rel;
  }
  return out;
}

/** Avalia um LHR do Lighthouse CI e retorna métricas e achados normalizados. */
export function evaluateLighthouseLhr(lhr, routeInfo, thresholds) {
  const file = normalizeRepoRelativePath(routeInfo?.file) ?? 'index.html';
  const route = routeInfo?.path ?? '/';
  const formFactor = lhr?.configSettings?.formFactor ?? 'desktop';
  const score = typeof lhr?.categories?.performance?.score === 'number' ? lhr.categories.performance.score : null;
  const lcp = typeof lhr?.audits?.['largest-contentful-paint']?.numericValue === 'number'
    ? lhr.audits['largest-contentful-paint'].numericValue
    : null;
  const cls = typeof lhr?.audits?.['cumulative-layout-shift']?.numericValue === 'number'
    ? lhr.audits['cumulative-layout-shift'].numericValue
    : null;
  const tbt = typeof lhr?.audits?.['total-blocking-time']?.numericValue === 'number'
    ? lhr.audits['total-blocking-time'].numericValue
    : null;
  const fcp = typeof lhr?.audits?.['first-contentful-paint']?.numericValue === 'number'
    ? lhr.audits['first-contentful-paint'].numericValue
    : null;

  const findings = [];
  if (score !== null && score < thresholds.performanceScore) {
    findings.push(normalizeFinding({
      tool: 'lighthouse-ci',
      rule: 'LH-PERFORMANCE-SCORE',
      file,
      line: 1,
      severity: score < 0.5 ? 'alta' : 'media',
      message: `Nota de desempenho Lighthouse baixa na rota ${route} (${formFactor}): ${(score * 100).toFixed(0)}/100 (mínimo ${(thresholds.performanceScore * 100).toFixed(0)}/100)`,
      evidence: `rota=${route} formFactor=${formFactor} score=${score.toFixed(2)} LCP=${lcp !== null ? Math.round(lcp) : 'n/a'}ms CLS=${cls !== null ? cls.toFixed(3) : 'n/a'} TBT=${tbt !== null ? Math.round(tbt) : 'n/a'}ms`,
    }));
  }
  if (lcp !== null && lcp > thresholds.lcpMs) {
    findings.push(normalizeFinding({
      tool: 'lighthouse-ci',
      rule: 'LH-LCP-SLOW',
      file,
      line: 1,
      severity: lcp > 4000 ? 'alta' : 'media',
      message: `LCP lento na rota ${route} (${formFactor}): ${Math.round(lcp)}ms (limite ${thresholds.lcpMs}ms)`,
      evidence: `rota=${route} formFactor=${formFactor} largest-contentful-paint=${Math.round(lcp)}ms`,
    }));
  }
  if (cls !== null && cls > thresholds.cls) {
    findings.push(normalizeFinding({
      tool: 'lighthouse-ci',
      rule: 'LH-CLS-SHIFT',
      file,
      line: 1,
      severity: cls > 0.25 ? 'alta' : 'media',
      message: `CLS elevado na rota ${route} (${formFactor}): ${cls.toFixed(3)} (limite ${thresholds.cls})`,
      evidence: `rota=${route} formFactor=${formFactor} cumulative-layout-shift=${cls.toFixed(3)}`,
    }));
  }
  if (tbt !== null && tbt > thresholds.tbtMs) {
    findings.push(normalizeFinding({
      tool: 'lighthouse-ci',
      rule: 'LH-TBT-BLOCKING',
      file,
      line: 1,
      severity: tbt > 600 ? 'alta' : 'media',
      message: `Total Blocking Time elevado na rota ${route} (${formFactor}): ${Math.round(tbt)}ms (limite ${thresholds.tbtMs}ms)`,
      evidence: `rota=${route} formFactor=${formFactor} total-blocking-time=${Math.round(tbt)}ms`,
    }));
  }

  return {
    metrics: {route, formFactor, file, score, lcp, cls, tbt, fcp},
    findings,
  };
}

function readK6Values(metricEntry) {
  if (!metricEntry || typeof metricEntry !== 'object') return null;
  if (metricEntry.values && typeof metricEntry.values === 'object') return metricEntry.values;
  return metricEntry;
}

/** Avalia o --summary-export JSON do k6, incluindo métricas por tag de rota. */
export function evaluateK6Summary(summary, exitCode, routeTargets, thresholds) {
  const metrics = summary?.metrics && typeof summary.metrics === 'object' ? summary.metrics : {};
  const findings = [];
  const routeMetrics = [];

  for (const target of routeTargets) {
    const route = target.path;
    const file = normalizeRepoRelativePath(target.file) ?? 'server.mjs';
    const line = normalizePositiveLine(target.line ?? 1);
    const taggedKey = Object.keys(metrics).find(k => k === `http_req_duration{route:${route}}`);
    const durationValues = readK6Values(taggedKey ? metrics[taggedKey] : null);
    const p95 = typeof durationValues?.['p(95)'] === 'number' ? durationValues['p(95)'] : null;
    const avg = typeof durationValues?.avg === 'number' ? durationValues.avg : null;
    const max = typeof durationValues?.max === 'number' ? durationValues.max : null;

    const failKey = Object.keys(metrics).find(k => k === `http_req_failed{route:${route}}`);
    const failValues = readK6Values(failKey ? metrics[failKey] : null);
    const failRate = typeof failValues?.rate === 'number'
      ? failValues.rate
      : (typeof failValues?.value === 'number' ? failValues.value : null);

    routeMetrics.push({route, file, line, p95, avg, max, failRate});

    if (p95 !== null && p95 > thresholds.k6P95Ms) {
      findings.push(normalizeFinding({
        tool: 'k6',
        rule: 'K6-THRESHOLD-LATENCY-P95',
        file,
        line,
        severity: p95 > thresholds.k6P95Ms * 2 ? 'alta' : 'media',
        message: `Rota ${route} violou limite de latência k6: p95=${p95.toFixed(1)}ms (limite ${thresholds.k6P95Ms}ms)`,
        evidence: `rota=${route} p95=${p95.toFixed(1)}ms avg=${avg !== null ? avg.toFixed(1) : 'n/a'}ms max=${max !== null ? max.toFixed(1) : 'n/a'}ms exit=${exitCode}`,
      }));
    }
    if (failRate !== null && failRate > thresholds.k6FailRate) {
      findings.push(normalizeFinding({
        tool: 'k6',
        rule: 'K6-THRESHOLD-ERROR-RATE',
        file,
        line,
        severity: 'alta',
        message: `Rota ${route} violou limite de erro HTTP no k6: taxa=${(failRate * 100).toFixed(2)}% (limite ${(thresholds.k6FailRate * 100).toFixed(2)}%)`,
        evidence: `rota=${route} http_req_failed=${failRate.toFixed(4)} exit=${exitCode}`,
      }));
    }
  }

  return {routeMetrics, findings};
}

/** Analisa um arquivo .cpuprofile V8 e identifica funções quentes no código do repositório. */
export function analyzeCpuProfile(profileJson, workRoot, thresholds) {
  if (!profileJson || typeof profileJson !== 'object' || !Array.isArray(profileJson.nodes)) {
    throw new Error('Perfil .cpuprofile inválido');
  }
  const nodeMap = new Map();
  for (const node of profileJson.nodes) {
    if (node && typeof node.id === 'number') nodeMap.set(node.id, node);
  }
  const selfUsByNode = new Map();
  const samples = Array.isArray(profileJson.samples) ? profileJson.samples : [];
  const deltas = Array.isArray(profileJson.timeDeltas) ? profileJson.timeDeltas : [];

  if (samples.length > 0 && samples.length === deltas.length) {
    for (let i = 0; i < samples.length; i += 1) {
      const id = samples[i];
      const delta = typeof deltas[i] === 'number' && deltas[i] > 0 ? deltas[i] : 0;
      selfUsByNode.set(id, (selfUsByNode.get(id) ?? 0) + delta);
    }
  } else {
    for (const node of profileJson.nodes) {
      const hits = typeof node.hitCount === 'number' && node.hitCount > 0 ? node.hitCount : 0;
      if (hits > 0) selfUsByNode.set(node.id, hits * 1000);
    }
  }

  const totalDurationMs = typeof profileJson.startTime === 'number' && typeof profileJson.endTime === 'number' && profileJson.endTime >= profileJson.startTime
    ? (profileJson.endTime - profileJson.startTime) / 1000
    : Array.from(selfUsByNode.values()).reduce((a, b) => a + b, 0) / 1000;

  const prefixes = [
    workRoot.endsWith('/') ? workRoot : `${workRoot}/`,
    '/repo/',
    '/tmp/work-repo/',
  ];
  const byFrame = new Map();
  let userActiveUs = 0;

  for (const [nodeId, us] of selfUsByNode.entries()) {
    const node = nodeMap.get(nodeId);
    const frame = node?.callFrame;
    if (!frame || typeof frame.url !== 'string') continue;
    if (frame.url.startsWith('node:') || frame.url.includes('/opt/desempenho-tools/') || frame.url === '') continue;
    const rel = normalizeRepoRelativePath(frame.url, prefixes);
    if (!rel) continue;
    userActiveUs += us;
    const fnName = cleanText(frame.functionName, '(anonymous)', 120);
    const line = normalizePositiveLine((typeof frame.lineNumber === 'number' ? frame.lineNumber : 0) + 1);
    const key = `${rel}:${line}:${fnName}`;
    const prev = byFrame.get(key) ?? {file: rel, line, functionName: fnName, selfUs: 0};
    prev.selfUs += us;
    byFrame.set(key, prev);
  }

  const hotspots = Array.from(byFrame.values())
    .map(item => {
      const selfMs = item.selfUs / 1000;
      const pct = userActiveUs > 0 ? (item.selfUs / userActiveUs) * 100 : 0;
      return {...item, selfMs, pct};
    })
    .sort((a, b) => b.selfMs - a.selfMs);

  const findings = [];
  for (const spot of hotspots) {
    if (spot.selfMs >= thresholds.cpuSelfMs && (spot.pct >= thresholds.cpuTotalPct || spot.selfMs >= thresholds.cpuSelfMs * 2)) {
      findings.push(normalizeFinding({
        tool: 'node-cpu-prof',
        rule: 'CPU-PROF-HOTSPOT',
        file: spot.file,
        line: spot.line,
        severity: spot.selfMs >= thresholds.cpuSelfMs * 2.5 ? 'alta' : 'media',
        message: `Ponto quente de CPU em '${spot.functionName}': ${spot.selfMs.toFixed(1)}ms (${spot.pct.toFixed(1)}% do tempo de CPU no código do projeto)`,
        evidence: `arquivo=${spot.file}:${spot.line} funcao=${spot.functionName} selfMs=${spot.selfMs.toFixed(1)}ms pct=${spot.pct.toFixed(1)}% duracaoTotal=${totalDurationMs.toFixed(1)}ms`,
      }));
    }
  }

  return {
    totalDurationMs,
    userActiveMs: userActiveUs / 1000,
    sampleCount: samples.length,
    hotspots,
    findings,
  };
}

/** Normaliza texto SQL para correspondência aproximada entre arquivo .sql e pg_stat_statements. */
export function normalizeSqlFingerprint(sql) {
  return String(sql ?? '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function findSqlLocation(queryText, sqlSources) {
  const normQuery = normalizeSqlFingerprint(queryText);
  const matches = sqlSources.filter(src => normalizeSqlFingerprint(src.sql) === normQuery);
  return matches.length === 1 ? {file: matches[0].file, line: matches[0].line} : null;
}

function hasHighCostSeqScan(planNode, minCost) {
  if (!planNode || typeof planNode !== 'object') return null;
  if (planNode['Node Type'] === 'Seq Scan') {
    const totalCost = Number(planNode['Total Cost'] ?? 0);
    const actualRows = Number(planNode['Actual Rows'] ?? planNode['Plan Rows'] ?? 0);
    if (totalCost >= minCost || actualRows >= 5000) {
      return {
        relation: cleanText(planNode['Relation Name'], 'tabela', 80),
        totalCost,
        rows: actualRows,
      };
    }
  }
  if (Array.isArray(planNode.Plans)) {
    for (const child of planNode.Plans) {
      const hit = hasHighCostSeqScan(child, minCost);
      if (hit) return hit;
    }
  }
  return null;
}

/** Avalia linhas de pg_stat_statements e planos EXPLAIN (FORMAT JSON). */
export function evaluatePgStatStatements(rows, explainPlans, sqlSources, thresholds) {
  const findings = [];
  const analyzedQueries = [];

  for (const row of rows) {
    const query = String(row?.query ?? '');
    const lower = query.toLowerCase();
    if (!query || lower.includes('pg_stat_statements') || lower.startsWith('explain') || lower.startsWith('create extension') || lower.startsWith('begin') || lower.startsWith('commit') || lower.startsWith('set ')) {
      continue;
    }
    const calls = Number(row?.calls ?? 0);
    const meanMs = Number(row?.mean_exec_time ?? 0);
    const maxMs = Number(row?.max_exec_time ?? 0);
    const totalMs = Number(row?.total_exec_time ?? 0);
    const loc = row?.file ? {file: row.file, line: row.line ?? 1} : findSqlLocation(query, sqlSources);
    if (!loc) continue;
    const file = normalizeRepoRelativePath(loc.file);
    if (!file) continue;
    const line = normalizePositiveLine(loc.line);

    analyzedQueries.push({file, line, calls, meanMs, maxMs, totalMs, query: cleanText(query, '', 160)});

    if (meanMs > thresholds.sqlMeanMs || maxMs > thresholds.sqlMaxMs) {
      findings.push(normalizeFinding({
        tool: 'pg_stat_statements',
        rule: meanMs > thresholds.sqlMeanMs ? 'PG-QUERY-SLOW-MEAN' : 'PG-QUERY-SLOW-MAX',
        file,
        line,
        severity: meanMs > thresholds.sqlMeanMs * 2 || maxMs > thresholds.sqlMaxMs * 2 ? 'alta' : 'media',
        message: `Consulta SQL lenta em pg_stat_statements: mean=${meanMs.toFixed(2)}ms, max=${maxMs.toFixed(2)}ms (${calls} chamadas)`,
        evidence: `arquivo=${file}:${line} calls=${calls} mean_exec_time=${meanMs.toFixed(2)}ms max_exec_time=${maxMs.toFixed(2)}ms query="${cleanText(query, '', 160)}"`,
      }));
    }
  }

  for (const planEntry of explainPlans) {
    const hit = hasHighCostSeqScan(planEntry?.plan?.Plan, thresholds.sqlSeqScanCost);
    if (!hit) continue;
    const file = normalizeRepoRelativePath(planEntry.file) ?? 'queries.sql';
    const line = normalizePositiveLine(planEntry.line);
    findings.push(normalizeFinding({
      tool: 'pg_stat_statements',
      rule: 'PG-SEQ-SCAN-COST',
      file,
      line,
      severity: 'media',
      message: `Seq Scan de alto custo na tabela '${hit.relation}' (custo=${hit.totalCost.toFixed(1)}, linhas=${hit.rows})`,
      evidence: `arquivo=${file}:${line} relation=${hit.relation} total_cost=${hit.totalCost.toFixed(1)} rows=${hit.rows}`,
    }));
  }

  return {analyzedQueries, findings};
}

/** Compara métricas atuais contra baseline anterior para detectar piora (regressão). */
export function evaluateBaselineRegression(current, baseline, thresholds) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return [];
  const findings = [];
  const limitFactor = 1 + thresholds.regressionPct / 100;

  if (Array.isArray(baseline.k6Routes) && Array.isArray(current.k6Routes)) {
    for (const cur of current.k6Routes) {
      const prev = baseline.k6Routes.find(item => item?.route === cur.route);
      if (prev && typeof prev.p95 === 'number' && prev.p95 > 0 && typeof cur.p95 === 'number') {
        if (cur.p95 > prev.p95 * limitFactor && cur.p95 - prev.p95 > 10) {
          const pct = ((cur.p95 - prev.p95) / prev.p95) * 100;
          findings.push(normalizeFinding({
            tool: 'k6',
            rule: 'DESEMPENHO-REGRESSAO-ROTA',
            file: cur.file,
            line: cur.line,
            severity: pct >= thresholds.regressionPct * 2 ? 'alta' : 'media',
            message: `Rota ${cur.route} piorou ${pct.toFixed(1)}% em relação ao baseline (p95: ${prev.p95.toFixed(1)}ms -> ${cur.p95.toFixed(1)}ms)`,
            evidence: `rota=${cur.route} baseline_p95=${prev.p95.toFixed(1)}ms atual_p95=${cur.p95.toFixed(1)}ms delta=+${pct.toFixed(1)}%`,
          }));
        }
      }
    }
  }

  if (Array.isArray(baseline.lighthouse) && Array.isArray(current.lighthouse)) {
    for (const cur of current.lighthouse) {
      const prev = baseline.lighthouse.find(item => item?.route === cur.route && item?.formFactor === cur.formFactor);
      if (prev && typeof prev.lcp === 'number' && prev.lcp > 0 && typeof cur.lcp === 'number') {
        if (cur.lcp > prev.lcp * limitFactor && cur.lcp - prev.lcp > 100) {
          const pct = ((cur.lcp - prev.lcp) / prev.lcp) * 100;
          findings.push(normalizeFinding({
            tool: 'lighthouse-ci',
            rule: 'DESEMPENHO-REGRESSAO-LCP',
            file: cur.file,
            line: 1,
            severity: pct >= thresholds.regressionPct * 2 ? 'alta' : 'media',
            message: `Tela ${cur.route} (${cur.formFactor}) piorou LCP em ${pct.toFixed(1)}% (${Math.round(prev.lcp)}ms -> ${Math.round(cur.lcp)}ms)`,
            evidence: `rota=${cur.route} baseline_lcp=${Math.round(prev.lcp)}ms atual_lcp=${Math.round(cur.lcp)}ms delta=+${pct.toFixed(1)}%`,
          }));
        }
      }
    }
  }

  if (Array.isArray(baseline.sqlQueries) && Array.isArray(current.sqlQueries)) {
    for (const cur of current.sqlQueries) {
      const prev = baseline.sqlQueries.find(item => item?.file === cur.file && item?.line === cur.line);
      if (prev && typeof prev.meanMs === 'number' && prev.meanMs > 0 && typeof cur.meanMs === 'number') {
        if (cur.meanMs > prev.meanMs * limitFactor && cur.meanMs - prev.meanMs > 5) {
          const pct = ((cur.meanMs - prev.meanMs) / prev.meanMs) * 100;
          findings.push(normalizeFinding({
            tool: 'pg_stat_statements',
            rule: 'DESEMPENHO-REGRESSAO-SQL',
            file: cur.file,
            line: cur.line,
            severity: pct >= thresholds.regressionPct * 2 ? 'alta' : 'media',
            message: `Consulta SQL em ${cur.file}:${cur.line} piorou ${pct.toFixed(1)}% (${prev.meanMs.toFixed(2)}ms -> ${cur.meanMs.toFixed(2)}ms)`,
            evidence: `arquivo=${cur.file}:${cur.line} baseline_mean=${prev.meanMs.toFixed(2)}ms atual_mean=${cur.meanMs.toFixed(2)}ms delta=+${pct.toFixed(1)}%`,
          }));
        }
      }
    }
  }

  return findings;
}
