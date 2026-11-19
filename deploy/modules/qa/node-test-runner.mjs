// Processo de ferramentas da imagem. O node:test executa cada arquivo em um filho.
import {run} from 'node:test';
import {isAbsolute, join, relative} from 'node:path';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {instrumentTestAssertions, loadQaSyntax, qaAssertionMethods} from './collect.mjs';
import {executionAllowed, testIdentity} from './execute-tests.mjs';

async function prepareAssertions(cwd, files) {
  const instrumented = new Map();
  const syntax = await loadQaSyntax().catch(() => undefined);
  if (!syntax) return instrumented;
  for (const file of files) {
    const path = join(cwd, file);
    const content = readFileSync(path, 'utf8');
    let prepared;
    try {
      prepared = instrumentTestAssertions(file, content, syntax);
    } catch {
      continue;
    }
    if (!prepared.proofs.length) continue;
    writeFileSync(path, prepared.content);
    instrumented.set(file, prepared);
  }
  return instrumented;
}

export async function runNodeTests(cwd, files) {
  const coverageProbe = join(cwd, '.qa-v8-probe.mjs');
  const execArgv = ['--permission', `--allow-fs-read=${cwd}`];
  if (process.allowedNodeEnvironmentFlags.has('--allow-env')) {
    execArgv.push('--allow-env=NODE_TEST_CONTEXT', '--allow-env=NODE_TEST_WORKER_ID', '--allow-env=NODE_V8_COVERAGE');
  }
  // Referências e mutantes usam a mesma configuração e medem o preload de cobertura.
  const temp = join(cwd, '.qa-coverage');
  mkdirSync(temp);
  process.env.TMPDIR = temp;
  writeFileSync(coverageProbe, `
import assert from 'node:assert';
import strict from 'node:assert/strict';
function qaCoverageProbe(value) { return value ? 1 : 0; }
qaCoverageProbe(true);
const assertionFunctions = new Map(${JSON.stringify(qaAssertionMethods)}.map(method => {
  const originals = new Set([assert[method], strict[method]]);
  if (method === 'ok') { originals.add(assert); originals.add(strict); }
  return [method, originals.has.bind(originals)];
}));
const acceptedMethod = assertionFunctions.get.bind(assertionFunctions);
const apply = Reflect.apply;
export function captureAssertion(fn, receiver, method, probe) {
  return (...args) => {
    if (typeof fn === 'function' && acceptedMethod(method)?.(fn)) probe();
    return apply(fn, receiver, args);
  };
}
`);
  const instrumented = await prepareAssertions(cwd, files);
  const probes = new Map([...instrumented.values()].flatMap(({proofs}) => proofs.map(site =>
    [testIdentity({...site, name: site.title.slice(0, 200)}), site.probes])));
  execArgv.push('--allow-inspector', `--allow-fs-write=${temp}`, '--import', coverageProbe);
  const events = run({
    cwd,
    files: files.map(file => join(cwd, file)),
    coverage: true,
    coverageExcludeGlobs: [],
    concurrency: 1,
    isolation: 'process',
    execArgv,
  });

  const tests = [];
  let summary;
  let measured;
  let logBytes = 0;
  for await (const {type, data} of events) {
    if (type === 'test:stdout' || type === 'test:stderr') {
      logBytes += Buffer.byteLength(data.message);
      if (logBytes > 1024 * 1024) throw new Error('QA_TEST_LOG_LIMIT');
    }
    if (type === 'test:summary' && data.file === undefined) summary = data.success;
    if (type === 'test:coverage' && data.nesting === 0) {
      const probe = data.summary.files.find(file => file.path === coverageProbe);
      if (!probe?.functions.some(fn => fn.name === 'qaCoverageProbe' && fn.count > 0)) {
        throw new Error('QA_V8_WORKER_COVERAGE_MISSING');
      }
      measured = data.summary.files.filter(({path}) => path !== coverageProbe && !relative(cwd, path).startsWith('../'))
        .map(({path, coveredBranchCount, totalBranchCount, coveredFunctionCount, totalFunctionCount, functions}) => ({
          file: relative(cwd, path), coveredBranchCount, totalBranchCount, coveredFunctionCount, totalFunctionCount,
          functions: functions.map(({name, line, count}) => ({name, line, count})),
        }));
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    const file = isAbsolute(data.file ?? '') ? relative(cwd, data.file) : data.file;
    const error = data.details?.error;
    // Suites e arquivos sintéticos só são relevantes quando apontam uma falha de infraestrutura.
    if (error?.failureType === 'subtestsFailed') continue;
    if (data.details?.type === 'suite' && type === 'test:pass' && data.skip === undefined && data.todo === undefined) continue;
    if (!file || (data.name === data.file && type === 'test:pass')) continue;

    const status = data.skip !== undefined ? 'skipped'
      : data.todo !== undefined ? 'todo'
        : type === 'test:pass' ? 'passed'
          : error?.failureType === 'testCodeFailure' && error.exitCode === undefined ? 'failed' : 'error';
    const line = data.line ?? 1;
    const column = instrumented.get(file)?.originalColumn(line, data.column ?? 1) ?? data.column ?? 1;
    tests.push({
      file, name: data.name.slice(0, 200), line, column,
      status, error: error?.cause?.code ?? error?.failureType,
    });
    if (tests.length > 1000) throw new Error('QA_TEST_EVENT_LIMIT');
  }

  if (typeof summary !== 'boolean' || !Array.isArray(measured)) {
    throw new Error('QA_NODE_TEST_REPORT_INCOMPLETE');
  }
  const counts = new Map(measured.map(file => [file.file, new Map(file.functions.map(fn => [fn.name, fn.count]))]));
  for (const test of tests) {
    const names = probes.get(testIdentity(test));
    const functions = counts.get(test.file);
    test.assertionStatus = names && functions
      ? names.some(probe => functions.get(probe.name) > 0) ? 'executed' : 'unobserved'
      : 'unsupported';
    test.features = [...new Set((names ?? []).filter(probe => functions?.get(probe.name) > 0).flatMap(probe => probe.features))];
  }
  return {summary, tests, coverage: measured.filter(file => !files.includes(file.file))};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repoDir, ...files] = process.argv.slice(2);
  if (!executionAllowed(repoDir)) throw new Error('QA_CONTAINER_REQUIRED');
  const report = await runNodeTests(process.cwd(), files);
  process.stdout.write(JSON.stringify(report));
  process.exitCode = Number(!report.summary);
}
