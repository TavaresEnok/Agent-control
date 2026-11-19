import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileFunction, createContext} from 'node:vm';
import {executionAllowed, runBoundedNode} from './execute-tests.mjs';

const runner = fileURLToPath(import.meta.url);
export const propertyTool = 'fast-check';
export const propertyLimits = {int32: [-2147483648, 2147483647], defaultSeed: 20261119, defaultRuns: 32,
  maxRuns: 128, maxParameters: 4, maxPlanBytes: 16 * 1024};
const maxProperties = 8;

export function measureProperty(fc, {integers, seed, numRuns}, predicate, path) {
  let calls = 0;
  let falsified = false;
  const arbitrary = integers.map(bounds => fc.integer(bounds));
  const property = fc.property(...arbitrary, (...args) => {
    calls++;
    // O fast-check distingue retorno falso de erro. Só o primeiro é falsificação aqui.
    const value = predicate(...args);
    if (typeof value !== 'boolean') throw new Error('QA_FASTCHECK_PREDICATE_INVALID');
    falsified = !value;
    return value;
  });
  const result = fc.check(property, {seed, numRuns, path, randomType: 'xorshift128plus', endOnFailure: true});
  if (result.interrupted || result.seed !== seed || result.numSkips !== 0 || result.numShrinks !== 0 ||
      result.numRuns !== calls || calls < 1 || calls > numRuns ||
      (!result.failed && path === undefined && calls !== numRuns) || result.failed !== falsified ||
      (result.failed && (!result.counterexample || !/^\d+$/.test(result.counterexamplePath)))) {
    throw new Error('QA_FASTCHECK_RESULT_UNMEASURED');
  }
  return {version: fc.__version, calls, counterexample: result.counterexample, path: result.counterexamplePath};
}

const comparisons = new Map([
  ['strictEqual', Object.is], ['===', (left, right) => left === right], ['!==', (left, right) => left !== right],
  ['<', (left, right) => left < right], ['<=', (left, right) => left <= right],
  ['>', (left, right) => left > right], ['>=', (left, right) => left >= right],
]);

function compilePredicate({source, operands, operator, params, target, typescript}) {
  // Apenas os trechos já validados pela análise de sintaxe entram no processo de medição.
  const parsingContext = createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}});
  const fn = `(${source}\n)`;
  const code = typescript ? stripTypeScriptTypes(fn) : fn;
  const exported = compileFunction(`'use strict'; return ${code}`, [], {parsingContext})();
  const pair = compileFunction(`'use strict'; return [(${operands[0]}\n), (${operands[1]}\n)]`,
    [target.local, ...params], {parsingContext});
  const compare = comparisons.get(operator);
  return (...args) => compare(...pair(exported, ...args));
}

async function runProperty(context, payload, property) {
  const scratch = mkdtempSync(join(context.workRoot, 'js-property-'));
  try {
    const planFile = join(scratch, 'plan.json');
    writeFileSync(planFile, payload, {mode: 0o600});
    const {code, output} = await runBoundedNode(['--permission', `--allow-fs-read=${dirname(runner)}`,
      '--allow-fs-read=/proc/self/mountinfo', '--allow-fs-read=/sys/class/net', `--allow-fs-read=${planFile}`,
      runner, context.repoDir, planFile], scratch, {timeoutMs: 1500, maxBytes: 16 * 1024});
    if (code !== 0) throw new Error('QA_FASTCHECK_EXECUTION_FAILED');
    const report = JSON.parse(output);
    const {version, calls, counterexample, path} = report;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      !Number.isSafeInteger(calls) || calls < 1 || calls > property.numRuns ||
      (counterexample === null ? path !== null || calls !== property.numRuns
        : typeof path !== 'string' || !/^\d+$/.test(path) || Number(path) !== calls - 1 || !Array.isArray(counterexample) ||
          counterexample.length !== property.integers.length || counterexample.some((value, index) =>
            !Number.isSafeInteger(value) || value < property.integers[index].min || value > property.integers[index].max))) {
      throw new Error('QA_FASTCHECK_REPORT_INVALID');
    }
    return report;
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

export async function collectJsProperties({context, sourceAnalyses, testAnalyses, incomplete, parserError, failTool,
  row, key, path, unmeasured}) {
  if (failTool === propertyTool) throw new Error('QA_FASTCHECK_FORCED_FAILURE');
  const declared = testAnalyses.reduce((sum, test) => sum + test.jsPropertyDeclarations, 0);
  const skip = reason => ({coverageRow: row(propertyTool, unmeasured, 'skipped', `0/${declared} declarações medidas; ${reason}`)});
  if (parserError) return skip('análise da sintaxe indisponível');
  if (incomplete) return skip('snapshot parcial por limites de cópia ou arquivos indisponíveis');
  if (declared === 0) return skip('nenhuma propriedade funcional declarada encontrada');

  const sources = new Map(sourceAnalyses.map(source => [source.file, source.functions]));
  const selected = [];
  let eligible = 0;
  for (const property of testAnalyses.flatMap(test => test.jsProperties)) {
    const {target} = property;
    const matches = sources.get(target.source)?.filter(fn => fn.exportNames.includes(target.name)) ?? [];
    const [fn] = matches;
    if (matches.length !== 1 || fn.propertyTarget?.arity !== target.arity) continue;
    const payload = JSON.stringify({...property, source: fn.propertyTarget.code, typescript: /\.(?:[cm]?ts|tsx)$/.test(target.source)});
    if (Buffer.byteLength(payload) > propertyLimits.maxPlanBytes) continue;
    eligible++;
    if (selected.length < maxProperties) selected.push({property, payload, functionLine: fn.startLine});
  }
  const unsupported = `${declared - eligible} sem forma elegível ou função local pura demonstrável`;
  if (!eligible) return skip(unsupported);
  if (!executionAllowed(context.repoDir)) return skip(`${eligible} elegíveis, execução reservada ao contêiner isolado; ${unsupported}`);

  const extraRows = [];
  const findings = [];
  let measured = 0;
  let cases = 0;
  let errors = 0;
  let version = unmeasured;
  for (const {property, payload, functionLine} of selected) {
    const {target, file, line, column, testLine, seed, numRuns} = property;
    const label = key('qa-propriedade:fast-check', file, `:${line}:${column}`);
    const link = `teste ${path(file)}:${testLine}, propriedade ${line}:${column}, função ${target.name.slice(0, 48)} em ${path(target.source)}:${functionLine}`;
    try {
      const result = await runProperty(context, payload, property);
      const falsified = result.counterexample !== null;
      measured++;
      cases += result.calls;
      version = result.version;
      const evidence = `${falsified ? 'falsificada' : 'aprovada'} em ${result.calls} chamadas, semente ${seed}, limite ${numRuns}` +
        (falsified ? `, caminho ${result.path}, contraexemplo ${JSON.stringify(result.counterexample)}` : '');
      extraRows.push(row(label, version, 'ok', `${evidence}. ${link}`));
      if (falsified) findings.push({tool: propertyTool, rule: 'QA-FASTCHECK-PROPRIEDADE-VIOLADA', file, line,
        severity: 'alta', message: 'Comparação da propriedade funcional declarada falsificada', evidence: `${evidence}. ${link}`});
    } catch {
      errors++;
      extraRows.push(row(label, unmeasured, 'failed', `execução sem resultado aferível. ${link}`));
    }
  }
  const limited = eligible - selected.length;
  return {coverageRow: row(propertyTool, version, measured ? 'ok' : 'failed',
    `medição ${measured === declared ? 'concluída' : 'parcial'}; ${measured}/${declared} propriedades medidas (${measured - findings.length} aprovadas, ${findings.length} falsificadas); ${cases} chamadas; ${errors} erros de execução; ${limited} fora do limite; ${unsupported}; comparações isoladas`),
  extraRows, findings};
}

async function main(repoDir, planFile) {
  if (!executionAllowed(repoDir)) throw new Error('QA_CONTAINER_REQUIRED');
  const fc = await import('fast-check');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  process.stdout.write(JSON.stringify(measureProperty(fc, plan, compilePredicate(plan))));
}

if (process.argv[1] === runner) {
  main(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
}
