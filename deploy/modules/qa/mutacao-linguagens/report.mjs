import {createHash} from 'node:crypto';
import {limits} from './measurement.mjs';

const maxPropertyFindings = 50;
const reasons = {
  'baseline-failed': 'suíte de referência reprovada',
  'go-build-failed': 'compilação Go reprovada',
  'go-local-replace': 'replace local fora do escopo offline',
  'go-package-selection': 'falha na seleção dos pacotes Go',
  'go-test-execution': 'falha na execução de go test',
  'invalid-snapshot': 'snapshot inválido para o executor',
  'isolated-container-required': 'execução dinâmica reservada ao contêiner isolado',
  'no-candidates': 'nenhum candidato aritmético enumerado',
  'no-passing-tests': 'nenhum teste de referência aprovado',
  'no-properties': 'nenhuma propriedade Hypothesis coletada',
  'no-property-examples': 'nenhuma propriedade executada com desfecho e exemplos',
  'offline-dependency': 'dependência indisponível no ambiente offline',
  'process-output-limit': 'limite de saída do subprocesso atingido',
  'process-timeout': 'subprocesso excedeu o tempo limite',
  'python-test-execution': 'falha na execução do pytest',
  'test-limit': 'limite de casos ou chamadas atingido',
  'test-set-changed': 'conjunto ou elegibilidade dos testes mudou após a mutação',
  'time-budget': 'orçamento de medição esgotado',
  'tool-execution': 'falha ao executar a ferramenta ou validar seu relatório',
  'tool-unavailable': 'ferramenta ou versão fixada indisponível',
};
const operationalReasons = new Set([
  'go-build-failed', 'go-package-selection', 'go-test-execution', 'invalid-snapshot',
  'process-output-limit', 'process-timeout', 'python-test-execution', 'tool-execution',
]);

function reasonText(code) {
  return Object.hasOwn(reasons, code) ? reasons[code] : 'motivo indisponível';
}

function trialFailedOperationally(mutant) {
  return mutant.reason !== 'go-build-failed' && operationalReasons.has(mutant.reason);
}

function coverageStatus(report) {
  if (['measured', 'partial'].includes(report.status)) return 'ok';
  const operationalFailure = operationalReasons.has(report.reason ?? report.baseline?.reason) ||
    (report.baseline?.status === 'passed' && report.mutants.some(trialFailedOperationally));
  return operationalFailure ? 'failed' : 'skipped';
}

function scopeText(report, status) {
  if (report.status === 'measured') return 'medição concluída';
  if (report.status === 'partial') return 'medição parcial';
  if (report.status === 'unavailable') return 'indisponível';
  return status === 'failed' ? 'falha operacional' : 'sem medição';
}

function testIdentity(test, pathLabel) {
  if (test.file) return `${pathLabel(test.file)}:${test.line} (caso ${test.id.slice(0, 16)})`;
  // Go subtest names may contain project values. Emit a stable identifier instead.
  return 'caso ' + createHash('sha256').update(JSON.stringify([test.package, test.name])).digest('hex').slice(0, 16);
}

export function publishMutation(report, row, pathLabel) {
  const {tool, version, seed, baseline, omittedTests = 0} = report;
  const status = coverageStatus(report);
  const scope = scopeText(report, status);
  const coverage = (name, state, detail) => row(name, version, state, detail);
  if (!baseline) {
    const reason = report.selection ? report.reason : reasonText(report.reason);
    return {coverageRow: coverage(tool, status, `${scope}: ${reason}`)};
  }

  const {candidates, killed, survived, notRun, unselected, omittedSources, truncated} = report;
  const counts = `${candidates} candidatos enumerados, ${killed} mortos, ${survived} sobreviventes, ${notRun} sem classificação`;
  const exclusions = `${unselected} fora da amostra, ${omittedSources} fontes e ${omittedTests} arquivos de teste omitidos`;
  const reference = baseline.status === 'passed' ? `referência aprovada (${baseline.passed} testes)`
    : baseline.status === 'failed' ? `${reasonText(baseline.reason)} (${baseline.failed} testes falhos)`
      : `referência sem medição: ${reasonText(baseline.reason)}`;
  const coverageRow = coverage(tool, status, [
    scope, counts, exclusions, truncated && 'enumeração truncada', reference, `semente ${seed}`,
  ].filter(Boolean).join('. '));

  const extraRows = [];
  const findings = [];
  for (const [index, mutant] of report.mutants.slice(0, limits.mutants).entries()) {
    const {file, line, column, before, after} = mutant;
    const key = `qa-mutante:${tool}:${index + 1}`;
    const patch = `${pathLabel(file)}:${line}:${column} operador ${before} → ${after}`;
    if (mutant.status === 'not-run') {
      const failed = baseline.status === 'passed' && trialFailedOperationally(mutant);
      extraRows.push(coverage(key, failed ? 'failed' : 'skipped',
        `${failed ? 'falha operacional' : 'sem medição'}. ${patch}. ${reasonText(mutant.reason)}`));
    } else if (mutant.status === 'killed') {
      extraRows.push(coverage(key, 'ok',
        `morto. ${patch}. Teste ${testIdentity(mutant.killedBy, pathLabel)} reprovou após a mutação`));
    } else {
      const evidence = `${patch}. A mesma suíte permaneceu aprovada após a mutação. Semente ${seed}`;
      extraRows.push(coverage(key, 'ok', `sobrevivente. ${evidence}`));
      findings.push({tool, rule: 'QA-MUTANTE-SOBREVIVENTE', file, line, severity: 'alta',
        message: `Mutante de ${tool} sobreviveu à suíte executada`, evidence});
    }
  }
  return {coverageRow, extraRows, findings};
}

export function publishProperties(report, row, pathLabel) {
  const {tool, version, seed, omittedTests = 0, properties = []} = report;
  const status = coverageStatus(report);
  const scope = scopeText(report, status);
  const checked = properties.filter(test => test.examples > 0 && ['passed', 'failed'].includes(test.status));
  const falsified = checked.filter(test => test.status === 'failed');
  const examples = checked.reduce((total, test) => total + test.examples, 0);
  const omittedFindings = Math.max(0, falsified.length - maxPropertyFindings);
  const reason = report.selection ? report.reason : (report.reason ? reasonText(report.reason) : '');
  const detail = [
    scope,
    `${checked.length}/${properties.length} propriedades medidas (${checked.length - falsified.length} aprovadas, ${falsified.length} falsificadas)`,
    `${examples} chamadas nas propriedades medidas, ${omittedTests} arquivos de teste omitidos`,
    omittedFindings && `${omittedFindings} achados fora do limite de publicação`,
    reason,
    `semente ${seed}`,
  ].filter(Boolean).join('. ');
  return {
    coverageRow: row(tool, version, status, detail),
    extraRows: report.status === 'partial' && operationalReasons.has(report.reason)
      ? [row(`${tool}-execucao`, version, 'failed', `falha operacional. ${reason}`)] : [],
    findings: falsified.slice(0, maxPropertyFindings).map(test => ({
      tool, rule: 'QA-PROPRIEDADE-FALSIFICADA', file: test.file, line: test.line, severity: 'alta',
      message: 'Propriedade Hypothesis falsificada',
      evidence: `Teste ${testIdentity(test, pathLabel)} reprovou após ${test.examples} chamadas à propriedade. Semente ${seed}`,
    })),
  };
}
