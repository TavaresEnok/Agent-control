import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {measurePhase} from './k6.mjs';
import {limits, phases, requestsPerPhase} from './limits.mjs';
import {defaultBinDir, probeTools} from './processes.mjs';
import {startLatencyProxy} from './proxy.mjs';
import {readLoadPlan, startStaticFixture} from './snapshot.mjs';

export const localLoadTool = 'qa-carga';
const unmeasured = 'não aferida';
const labels = ['controle', 'degradada', 'recuperação'];

function evaluate([control, degraded, recovery]) {
  if ([control, degraded, recovery].some(series => !series || series.reason)) return 'prova incompleta';
  if (control.p95 > limits.controlP95Ms) return `controle acima de ${limits.controlP95Ms} ms`;
  if (degraded.p95 - control.p95 < limits.minimumDeltaMs) return 'degradação insuficiente';
  if (recovery.p95 > control.p95 + limits.recoveryMarginMs ||
      degraded.p95 - recovery.p95 < limits.minimumDeltaMs) return 'recuperação insuficiente';
  return null;
}

function describeSeries(series, label) {
  if (series?.p95 === undefined) return `${label} sem medida (${series?.reason ?? 'etapa não executada'})`;
  return `${label} p95=${series.p95.toFixed(1)} ms, ${series.count} GET, ${(series.failRate * 100).toFixed(1)}% falhas` +
    (series.reason ? `, ${series.served} servidos` : '');
}

// binDir é um parâmetro do executor confiável, usado pelos testes com ferramentas próprias.
export async function runLocalLoadQa({
  workspace, workRoot, copiedFiles, enabled, row, key, binDir = defaultBinDir,
}) {
  let version = unmeasured;
  const summary = (status, detail, extraRows = [], files = []) => ({
    coverageRow: {...row(localLoadTool, version, status, detail), ...(files.length ? {files} : {})},
    extraRows,
    findings: [],
  });
  const routeRow = (route, status, detail, measured = false) => ({
    ...row(key(localLoadTool, route.path), version, status, `${route.path} ${detail}`),
    ...(measured ? {files: [route.file]} : {}),
  });
  const plan = readLoadPlan(workspace, copiedFiles);
  if (plan.reason) return summary(plan.status, plan.reason);
  const {routes} = plan;
  if (routes.some(route => route.reason)) {
    const status = routes.some(route => route.status === 'failed') ? 'failed' : 'skipped';
    return summary(status, 'insumo declarado indisponível', routes.map(route =>
      routeRow(route, route.status ?? 'skipped', route.reason ?? 'ensaio suspenso por insumo indisponível')));
  }
  if (enabled !== true) {
    const detail = 'execução reservada à homologação local isolada';
    return summary('skipped', detail, routes.map(route => routeRow(route, 'skipped', detail)));
  }

  const results = new Map();
  const signal = AbortSignal.timeout(limits.totalMs);
  let cwd;
  let fixture;
  let proxy;
  let stage = 'preparação local';
  let interrupted;
  try {
    cwd = mkdtempSync(join(workRoot, 'qa-carga-'));
    stage = 'sonda das ferramentas';
    const tools = await probeTools(binDir, cwd, signal);
    if (tools.reason) return summary(tools.status, tools.reason, routes.map(route =>
      routeRow(route, tools.status, tools.reason)));
    version = tools.version;
    stage = 'início da fixture';
    fixture = await startStaticFixture(routes);
    stage = 'início do Toxiproxy';
    proxy = await startLatencyProxy(tools.proxy, cwd, fixture.port, signal);
    for (const [i, phase] of phases.entries()) {
      if (i === 1) {
        stage = 'aplicação de latência no Toxiproxy';
        await proxy.addLatency();
      } else if (i === 2) {
        stage = 'remoção de latência no Toxiproxy';
        await proxy.removeLatency();
      }
      stage = `medição ${labels[i]}`;
      try {
        const sample = await measurePhase({binary: tools.k6, cwd, phase, proxy, fixture, routes});
        results.set(phase, sample);
      } catch {
        results.set(phase, new Map(routes.map(route => [route.path, {reason: 'k6 sem relatório válido'}])));
        if (proxy.signal.aborted) throw new Error('QA_CARGA_EXECUTION_ABORTED');
      }
    }
  } catch {
    interrupted = `falha na etapa de ${stage}`;
  } finally {
    try {
      await proxy?.close();
    } finally {
      try {
        await fixture?.close();
      } finally {
        if (cwd) rmSync(cwd, {recursive: true, force: true});
      }
    }
  }

  const files = new Set();
  let proven = 0;
  const extraRows = routes.map(route => {
    const series = phases.map(phase => results.get(phase)?.get(route.path));
    const issue = evaluate(series);
    const accepted = !issue && !interrupted;
    const measured = series.some(item => item?.p95 !== undefined && item.served > 0);
    if (measured) files.add(route.file);
    if (accepted) proven++;
    const details = series.map((sample, i) => describeSeries(sample, labels[i])).join(' / ');
    const outcome = accepted ? 'recuperação comprovada' : interrupted ?? issue;
    return routeRow(route, accepted ? 'ok' : 'failed', `${outcome}. ${details}`, measured);
  });
  const cap = `limites de ${limits.vus} VUs, ${requestsPerPhase} GET por rota e fase, ${limits.bodyBytes / 1024} KiB por corpo, ${limits.phaseMs / 1000} s por fase e ${limits.totalMs / 1000} s no total`;
  const detail = `${proven}/${routes.length} rotas com controle, degradação e recuperação comprovados. Latência de ${limits.latencyMs} ms configurada. ${cap}`;
  return summary(proven === routes.length ? 'ok' : 'failed',
    interrupted ? `${interrupted}. ${detail}` : detail, extraRows, [...files]);
}
