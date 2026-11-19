import {DEFAULT_THRESHOLDS, describeK6Source, k6Source, normalizeCoverageRow, normalizeFinding,
  normalizeRepoRelativePath, safeRoutePath} from './lib.mjs';

const series = [
  {key: 'k6Routes', metric: 'p95', label: 'p95', tool: 'k6', rule: 'ROTA', minimum: 10, http: true,
    same: (a, b) => a.route === b.route,
    location: a => a.source, subject: a => `Rota ${a.route}`,
    source: a => describeK6Source(a.source, a.file)},
  {key: 'lighthouse', metric: 'lcp', label: 'LCP', tool: 'lighthouse-ci', rule: 'LCP', minimum: 100, http: true,
    same: (a, b) => a.route === b.route && a.formFactor === b.formFactor,
    location: a => ({file: a.file, line: 1}), subject: a => `Tela ${a.route} (${a.formFactor})`},
  {key: 'sqlQueries', metric: 'meanMs', label: 'tempo médio SQL', tool: 'pg_stat_statements', rule: 'SQL', minimum: 5,
    same: (a, b) => a.file === b.file && a.line === b.line,
    location: a => ({file: a.file, line: a.line}), subject: a => `Consulta ${a.file}:${a.line}`},
];

export function validatePerformanceMeasurement(raw) {
  if (!raw || !['static', 'isolated'].includes(raw.httpMode)) throw new Error('modo da medição de desempenho inválido');
  const measurement = {httpMode: raw.httpMode, versions: {}};
  for (const {key, metric, tool, http} of series) {
    const version = raw.versions?.[tool];
    if (typeof version !== 'string' || !version.length || version.length > 80 ||
        !Array.isArray(raw[key]) || raw[key].length > (http ? 8 : 100)) throw new Error('série de desempenho inválida');
    measurement.versions[tool] = version;
    measurement[key] = raw[key].map(item => {
      const file = normalizeRepoRelativePath(item?.file, []);
      if (!file || !Number.isFinite(item[metric]) || item[metric] < 0) throw new Error('métrica de desempenho inválida');
      const metricValue = {[metric]: item[metric], file};
      if (http) {
        const route = safeRoutePath(item.route);
        if (!route) throw new Error('rota medida inválida');
        if (key === 'k6Routes') return {...metricValue, route, source: k6Source(item.source)};
        if (!['desktop', 'mobile'].includes(item.formFactor)) throw new Error('formato da tela inválido');
        return {...metricValue, route, formFactor: item.formFactor};
      }
      if (!Number.isSafeInteger(item.line) || item.line < 1 ||
          typeof item.statementHash !== 'string' || !/^[a-f0-9]{16}$/.test(item.statementHash)) {
        throw new Error('origem da medição SQL inválida');
      }
      return {...metricValue, line: item.line, statementHash: item.statementHash};
    });
  }
  return measurement;
}

function compare(current, reference, {examId, file}) {
  let compared = 0;
  let exceeded = 0;
  const findings = [];
  const historical = examId !== undefined;
  const percent = DEFAULT_THRESHOLDS.regressionPct;
  for (const entry of series) {
    const {key, metric, label, tool, http} = entry;
    if (!Array.isArray(reference[key])) continue;
    if (historical && (current.versions[tool] !== reference.versions[tool] ||
        current.versions[tool].includes('desconhecida') || (http && current.httpMode !== reference.httpMode))) continue;
    for (const observed of current[key]) {
      const candidates = reference[key].filter(prior => prior && entry.same(observed, prior) &&
        Number.isFinite(prior[metric]) && prior[metric] >= 0 &&
        (!historical || (prior[metric] > 0 && observed.file === prior.file &&
          (http || observed.statementHash === prior.statementHash))));
      if (candidates.length !== 1) continue;
      compared++;
      const before = candidates[0][metric];
      const after = observed[metric];
      if (after <= before || (historical && (after <= before * (1 + percent / 100) || after - before <= entry.minimum))) continue;
      exceeded++;
      const location = entry.location(observed);
      if (!location) continue;
      const message = historical
        ? `${entry.subject(observed)} apresentou regressão medida de ${label} frente ao exame anterior independente.`
        : `${entry.subject(observed)} excedeu o orçamento de ${label} declarado pelo projeto.`;
      const evidence = historical ? `exame anterior=${examId}; anterior=${before.toFixed(2)}ms`
        : `orçamento declarado em ${file}; limite=${before.toFixed(2)}ms`;
      findings.push(normalizeFinding({tool, rule: `DESEMPENHO-${historical ? 'REGRESSAO' : 'ORCAMENTO'}-${entry.rule}`, ...location,
        severity: (historical ? after >= before * (1 + 2 * percent / 100) : after >= before * 2) ? 'alta' : 'media',
        message, evidence: `${label}; ${evidence}; atual=${after.toFixed(2)}ms${entry.source ? '; ' + entry.source(observed) : ''}`}));
    }
  }
  return {compared, exceeded, findings};
}

export function compareDeclaredBudget(current, reference, file) {
  const tool = 'orcamento-declarado';
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
    return {findings: [], coverage: normalizeCoverageRow({tool, version: '1', status: 'failed',
      detail: `Orçamento declarado indisponível ou inválido em ${file}`})};
  }
  const result = compare(current, reference, {file});
  return {findings: result.findings, coverage: normalizeCoverageRow({tool, version: '1',
    status: result.compared ? 'ok' : 'skipped',
    detail: `${file}; ${result.compared} par(es) comparável(is), ${result.exceeded} acima do orçamento declarado, ${result.findings.length} achado(s) localizado(s)`})};
}

/** prior provém de armazenamento do exame sob controle do host. Nunca leia esse argumento do snapshot. */
export function compareIndependentMeasurement(current, prior, imageDigest) {
  const tool = 'medicao-anterior-independente';
  const row = (status, detail, findings = []) => ({findings, coverage: normalizeCoverageRow({tool, version: '1', status, detail})});
  if (prior === undefined) return row('skipped', 'Medição anterior independente não fornecida pela base');
  if (typeof prior?.examId !== 'string' || !/^[a-zA-Z0-9][-_.a-zA-Z0-9]{0,99}$/.test(prior.examId)) {
    return row('failed', 'Origem da medição anterior inválida');
  }
  const previousDigest = prior.measurement?.imageDigest;
  if (typeof previousDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(previousDigest)) {
    return row('failed', 'Digest da medição anterior inválido');
  }
  if (previousDigest !== imageDigest) return row('skipped', 'Imagem da medição anterior diferente da imagem atual');
  let reference;
  try { reference = validatePerformanceMeasurement(prior.measurement); }
  catch { return row('failed', 'Séries da medição anterior inválidas'); }
  const result = compare(current, reference, {examId: prior.examId});
  return row(result.compared ? 'ok' : 'skipped',
    `exame anterior=${prior.examId}; ${result.compared} par(es) comparável(is), ${result.exceeded} piora(s) acima do limiar, ${result.findings.length} achado(s) localizado(s)`,
    result.findings);
}
