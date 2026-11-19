// Processo de ferramentas da imagem. O node:test executa cada arquivo em um filho.
import {run} from 'node:test';
import {isAbsolute, join, relative} from 'node:path';
import {mkdirSync, writeFileSync} from 'node:fs';
import {executionAllowed} from './execute-tests.mjs';

const [repoDir, mode, ...files] = process.argv.slice(2);
if (!executionAllowed(repoDir)) throw new Error('QA_CONTAINER_REQUIRED');
const cwd = process.cwd();
const coverage = mode === 'coverage';
const coverageProbe = join(cwd, '.qa-v8-probe.mjs');
const execArgv = ['--permission', `--allow-fs-read=${cwd}`];
if (process.allowedNodeEnvironmentFlags.has('--allow-env')) {
  execArgv.push('--allow-env=NODE_TEST_CONTEXT', '--allow-env=NODE_TEST_WORKER_ID', '--allow-env=NODE_V8_COVERAGE');
}
if (coverage) {
  // O gravador de cobertura V8 do filho precisa escrever na árvore temporária do runner.
  const temp = join(cwd, '.qa-coverage');
  mkdirSync(temp);
  process.env.TMPDIR = temp;
  // O preload prova que a cobertura veio dos filhos, mesmo quando a suíte não importa fontes.
  writeFileSync(coverageProbe, 'function qaCoverageProbe(value) { return value ? 1 : 0; }\nqaCoverageProbe(true);\n');
  execArgv.push('--allow-inspector', `--allow-fs-write=${temp}`, '--import', coverageProbe);
}
const events = run({
  cwd,
  files: files.map(file => join(cwd, file)),
  coverage,
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
  tests.push({
    file, name: data.name.slice(0, 200), line: data.line ?? 1, column: data.column ?? 1,
    status, error: error?.cause?.code ?? error?.failureType,
  });
  if (tests.length > 1000) throw new Error('QA_TEST_EVENT_LIMIT');
}

if (typeof summary !== 'boolean' || (coverage && !Array.isArray(measured))) {
  throw new Error('QA_NODE_TEST_REPORT_INCOMPLETE');
}
process.stdout.write(JSON.stringify({summary, tests, coverage: measured}));
process.exitCode = Number(!summary);
