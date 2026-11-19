import {readFileSync, lstatSync} from 'node:fs';
import {join} from 'node:path';

/** Validação, avaliação de limites e normalização de saída do módulo 7. */

export const MAX_DECLARED_ROUTES = 40;
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
  sqlMeanMs: 50,
  sqlMaxMs: 120,
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
    ...(status === 'ok' && Array.isArray(input?.files)
      ? {files: [...new Set(input.files.map(file => normalizeRepoRelativePath(file, [])).filter(Boolean))]}
      : {}),
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
    cpuSelfMs: finiteNumber(src.cpuSelfMs, DEFAULT_THRESHOLDS.cpuSelfMs, 1, 500),
    sqlMeanMs: finiteNumber(src.sqlMeanMs, DEFAULT_THRESHOLDS.sqlMeanMs, 0.1),
    sqlMaxMs: finiteNumber(src.sqlMaxMs, DEFAULT_THRESHOLDS.sqlMaxMs, 0.1),
    regressionPct: finiteNumber(src.regressionPct, DEFAULT_THRESHOLDS.regressionPct, 1, 1000),
  };
}

export function readJsonLimited(filePath, maxBytes) {
  const info = lstatSync(filePath);
  if (!info.isFile() || info.size > maxBytes) throw new Error('arquivo JSON inválido ou grande demais');
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function loadConfig(root) {
  try {
    return validateConfig(readJsonLimited(join(root, 'desempenho.config.json'), 256 * 1024));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function safeRoutePath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('#') || /[{},]/.test(trimmed) || trimmed.length > 200 || trimmed.includes('..') || trimmed.includes('\\') || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  const base = 'http://127.0.0.1';
  const url = new URL(trimmed, base);
  if (url.origin !== base || url.href !== base + trimmed || /%(?:00|2f|5c)/i.test(url.pathname)) return null;
  return trimmed;
}

export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Configuração de desempenho deve ser um objeto JSON');
  }
  const out = {
    staticDir: undefined,
    routes: [],
    routeOmissions: 0,
    routesBeyondLimit: [],
    server: undefined,
    cpuFunctions: [],
    cpuOmissions: 0,
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
    for (const entry of raw.routes.slice(0, MAX_DECLARED_ROUTES)) {
      if (typeof entry === 'string') {
        const route = safeRoutePath(entry);
        if (route) out.routes.push({path: route, file: undefined});
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const route = safeRoutePath(entry.path);
        const file = entry.file !== undefined ? normalizeRepoRelativePath(entry.file) : undefined;
        if (route) out.routes.push({path: route, file: file ?? undefined,
          ...(typeof entry.page === 'boolean' ? {page: entry.page} : {})});
      }
    }
    out.routeOmissions = Math.min(raw.routes.length, MAX_DECLARED_ROUTES) - out.routes.length;
    const seen = new Set(out.routes.map(route => route.path));
    for (const entry of raw.routes.slice(MAX_DECLARED_ROUTES)) {
      const path = safeRoutePath(typeof entry === 'string' ? entry : entry?.path);
      if (!path) out.routeOmissions++;
      else if (!seen.has(path)) {
        seen.add(path);
        out.routesBeyondLimit.push(path);
      }
    }
  }
  if (raw.server !== undefined) {
    if (!raw.server || typeof raw.server !== 'object' || Array.isArray(raw.server)) {
      throw new Error('server inválido na configuração');
    }
    const entry = normalizeRepoRelativePath(raw.server.entry);
    if (!entry) throw new Error('server.entry inválido');
    const readyPath = safeRoutePath(raw.server.readyPath ?? '/') ?? '/';
    const portEnv = typeof raw.server.portEnv === 'string' && /^[A-Z_][A-Z0-9_]{0,40}$/.test(raw.server.portEnv)
      ? raw.server.portEnv
      : 'PORT';
    out.server = {entry, readyPath, portEnv};
  }
  if (Array.isArray(raw.cpuFunctions)) {
    out.cpuOmissions += Math.max(0, raw.cpuFunctions.length - 20);
    for (const item of raw.cpuFunctions.slice(0, 20)) {
      const file = normalizeRepoRelativePath(item?.file, []);
      const functionName = item?.functionName;
      if (!file || typeof functionName !== 'string' || !/^[A-Za-z_$][\w$]{0,79}$/.test(functionName)) {
        out.cpuOmissions++;
        continue;
      }
      if (!out.cpuFunctions.some(candidate => candidate.file === file && candidate.functionName === functionName)) {
        out.cpuFunctions.push({file, functionName});
      }
    }
  } else if (raw.cpuFunctions !== undefined) {
    out.cpuOmissions++;
  }
  if (raw.server?.cpuProfile === true || raw.cpuWorkloads?.length) out.cpuOmissions++;
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
    const file = normalizeRepoRelativePath(target.file);
    const source = k6Source(target.source);
    const durationValues = readK6Values(metrics[`http_req_duration{route:${route}}`]);
    const p95 = Number.isFinite(durationValues?.['p(95)']) && durationValues['p(95)'] >= 0 ? durationValues['p(95)'] : null;
    const avg = typeof durationValues?.avg === 'number' ? durationValues.avg : null;
    const max = typeof durationValues?.max === 'number' ? durationValues.max : null;

    const failValues = readK6Values(metrics[`http_req_failed{route:${route}}`]);
    const rate = failValues?.rate ?? failValues?.value;
    const failRate = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : null;

    routeMetrics.push({route, file, source, p95, avg, max, failRate});
    if (p95 === null || failRate === null || !source) continue;
    const origin = describeK6Source(source, file);

    if (p95 > thresholds.k6P95Ms) {
      findings.push(normalizeFinding({
        tool: 'k6',
        rule: 'K6-THRESHOLD-LATENCY-P95',
        file: source.file,
        line: source.line,
        severity: p95 > thresholds.k6P95Ms * 2 ? 'alta' : 'media',
        message: `Rota ${route} violou limite de latência k6: p95=${p95.toFixed(1)}ms (limite ${thresholds.k6P95Ms}ms)`,
        evidence: `${origin}; rota=${route} p95=${p95.toFixed(1)}ms avg=${avg !== null ? avg.toFixed(1) : 'n/a'}ms max=${max !== null ? max.toFixed(1) : 'n/a'}ms exit=${exitCode}`,
      }));
    }
    if (failRate > thresholds.k6FailRate) {
      findings.push(normalizeFinding({
        tool: 'k6',
        rule: 'K6-THRESHOLD-ERROR-RATE',
        file: source.file,
        line: source.line,
        severity: 'alta',
        message: `Rota ${route} violou limite de erro HTTP no k6: taxa=${(failRate * 100).toFixed(2)}% (limite ${(thresholds.k6FailRate * 100).toFixed(2)}%)`,
        evidence: `${origin}; rota=${route} http_req_failed=${failRate.toFixed(4)} exit=${exitCode}`,
      }));
    }
  }

  return {routeMetrics, findings};
}

export function k6Source(source) {
  const file = normalizeRepoRelativePath(source?.file, []);
  if (!file || !Number.isSafeInteger(source.line) || source.line < 1 ||
      !['declaration', 'document'].includes(source.kind)) return null;
  return {file, line: source.line, kind: source.kind};
}

export function describeK6Source(source, file) {
  if (source.kind === 'declaration') {
    return `declaração da rota em ${source.file}:${source.line}; arquivo associado=${file}; métrica da resposta HTTP`;
  }
  return `documento servido=${source.file}:${source.line} (primeiro conteúdo); métrica da resposta HTTP`;
}
