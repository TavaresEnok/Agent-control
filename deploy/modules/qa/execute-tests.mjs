import {spawn} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const runner = fileURLToPath(new URL('./node-test-runner.mjs', import.meta.url));
const testTimeoutMs = 8_000;
const maxOutputBytes = 2 * 1024 * 1024;
const maxMutants = 8;

export const suiteTool = 'node-test-v8';
export const mutationTool = 'stryker-mutator';
export const runtimeInstalled = runner === '/opt/qa-tools/node-test-runner.mjs';

export function executionAllowed(repoDir) {
  if (!runtimeInstalled || process.env.QA_HOST_TEST_MODE === '1' ||
      process.getuid?.() !== 65532 || !['/repo', '/repository'].includes(repoDir)) return false;
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(line => line.split(' '));
  const readonly = path => mounts.some(fields => fields[4] === path && fields[5]?.split(',').includes('ro'));
  const scratch = mounts.some(fields => fields[4] === '/tmp' && fields[5]?.split(',').includes('rw') &&
    fields[fields.indexOf('-') + 1] === 'tmpfs');
  return readonly('/') && readonly(repoDir) && scratch &&
    readdirSync('/sys/class/net').every(name => name === 'lo');
}

export function selectNodeSuite({manifest, testFiles, readTest, incomplete, nestedManifest}) {
  if (incomplete) return {reason: 'snapshot parcial por limites de cópia ou arquivos indisponíveis'};
  if (nestedManifest) return {reason: 'manifesto de subprojeto encontrado; execução dinâmica cobre somente projetos simples'};
  if (manifest?.scripts?.test !== undefined && String(manifest.scripts.test).trim() !== 'node --test') {
    return {reason: 'script de teste incompatível com a execução offline de node --test sem opções'};
  }
  if (testFiles.some(file => file.endsWith('.tsx'))) return {reason: 'testes TSX exigem transformação fora do executor node:test'};
  const files = testFiles.filter(file => /(?:^|\/)(?:test\.(?:[cm]?js|[cm]?ts)|[^/]+[.-](?:test|spec)\.(?:[cm]?js|[cm]?ts))$/.test(file) ||
    /(?:^|\/)test\/.+\.[cm]?[jt]s$/.test(file));
  if (files.length === 0) return {reason: 'nenhum arquivo de teste compatível com node:test'};
  if (manifest?.scripts?.test === undefined && !files.some(file => /['"]node:test['"]/.test(readTest(file)))) {
    return {reason: 'projeto sem runner node:test identificado'};
  }
  if (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(key => Object.keys(manifest?.[key] ?? {}).length)) {
    return {reason: 'projeto declara dependências externas indisponíveis no executor offline'};
  }
  return {files};
}

export function runBoundedNode(args, cwd, {timeoutMs = testTimeoutMs, maxBytes = maxOutputBytes} = {}) {
  return runBoundedProcess(process.execPath, args, cwd, {timeoutMs, maxBytes}).then(({code, output}) => ({code, output}));
}

export function runBoundedProcess(binary, args, cwd, {
  timeoutMs = testTimeoutMs, maxBytes = maxOutputBytes, env = {}, stopOnStdout,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: {PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: '/tmp', LANG: 'C.UTF-8', TZ: 'UTC', ...env},
    });
    let size = 0;
    let problem;
    const output = [];
    const diagnostics = [];
    const stop = reason => {
      problem ??= reason;
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') problem = 'QA_TEST_PROCESS_KILL';
      }
    };
    const timer = setTimeout(() => stop('QA_TEST_TIMEOUT'), timeoutMs);
    child.stdout.on('data', chunk => {
      if (problem) return;
      size += chunk.length;
      if (size > maxBytes) stop('QA_TEST_OUTPUT_LIMIT');
      else {
        output.push(chunk);
        const reason = stopOnStdout?.(chunk);
        if (reason) stop(reason);
      }
    });
    child.stderr.on('data', chunk => {
      if (problem) return;
      size += chunk.length;
      if (size > maxBytes) stop('QA_TEST_OUTPUT_LIMIT');
      else diagnostics.push(chunk);
    });
    child.once('error', error => stop(`QA_TEST_SPAWN_${error.code ?? 'ERROR'}`));
    child.once('exit', () => {
      // Encerra também descendentes que tenham ficado com pipes abertos.
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') problem ??= 'QA_TEST_PROCESS_KILL';
        }
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (problem) reject(new Error(problem));
      else if (signal || (code !== 0 && code !== 1)) reject(new Error(`QA_TEST_PROCESS_EXIT ${signal ?? code}`));
      else resolve({code, output: Buffer.concat(output).toString('utf8'), diagnostics: Buffer.concat(diagnostics).toString('utf8')});
    });
  });
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const testStatuses = new Set(['passed', 'failed', 'skipped', 'todo', 'error']);
const assertionStatuses = new Set(['executed', 'unobserved', 'unsupported']);

export function decodeNodeReport({code, output}, files, measure) {
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    throw new Error('QA_NODE_TEST_REPORT_INVALID');
  }
  if (typeof report?.summary !== 'boolean' || !Array.isArray(report.tests) ||
      report.tests.some(t => !files.includes(t.file) || typeof t.name !== 'string' ||
        !testStatuses.has(t.status) || !isCount(t.line) || !isCount(t.column) ||
        (t.features !== undefined && (!Array.isArray(t.features) || t.features.some(value => typeof value !== 'string'))) ||
        (t.assertionStatus !== undefined && !assertionStatuses.has(t.assertionStatus)))) {
    throw new Error('QA_NODE_TEST_REPORT_INVALID');
  }
  const infrastructure = report.tests.find(t => t.status === 'error' ||
    ['ERR_ACCESS_DENIED', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'].includes(t.error));
  const failed = report.tests.some(t => t.status === 'failed');
  if (infrastructure || report.summary === failed || code !== Number(failed)) {
    const context = infrastructure ? ` em ${infrastructure.file}:${infrastructure.line}` : '';
    throw new Error(`QA_NODE_TEST_EXECUTION_FAILED${context}`);
  }
  if (measure && (!Array.isArray(report.coverage) ||
    report.coverage.some(c => typeof c.file !== 'string' ||
      !isCount(c.coveredBranchCount) || !isCount(c.totalBranchCount) || c.coveredBranchCount > c.totalBranchCount ||
      !isCount(c.coveredFunctionCount) || !isCount(c.totalFunctionCount) || c.coveredFunctionCount > c.totalFunctionCount ||
      !Array.isArray(c.functions) || c.functions.some(f => typeof f.name !== 'string' || !isCount(f.line) || !isCount(f.count))))) {
    throw new Error('QA_V8_COVERAGE_INVALID');
  }
  return report;
}

export async function executeNodeSuite({repoDir, workRoot, workspace, files, mutation}) {
  if (!executionAllowed(repoDir)) throw new Error('QA_CONTAINER_REQUIRED');
  const scratch = mkdtempSync(join(workRoot, 'run-'));
  try {
    cpSync(workspace, scratch, {recursive: true});
    if (mutation) writeFileSync(join(scratch, mutation.file), mutation.content);
    const result = await runBoundedNode([runner, repoDir, ...files], scratch);
    return decodeNodeReport(result, files, true);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

export function testIdentity(test) {
  return JSON.stringify([test.file, test.line, test.column, test.name]);
}

export function comparePasses(passes) {
  const results = new Map();
  for (const [index, pass] of passes.entries()) {
    const repeats = new Map();
    for (const result of pass.tests) {
      const identity = testIdentity(result);
      const occurrence = (repeats.get(identity) ?? 0) + 1;
      repeats.set(identity, occurrence);
      const key = `${identity}:${occurrence}`;
      if (!results.has(key)) results.set(key, {...result, statuses: passes.map(() => 'absent'),
        featurePasses: passes.map(() => []), assertionStatuses: passes.map(() => 'unsupported')});
      const test = results.get(key);
      test.statuses[index] = result.status;
      test.assertionStatuses[index] = result.assertionStatus ?? 'unsupported';
      test.featurePasses[index] = result.features ?? [];
    }
  }
  return [...results.values()];
}

export function classifyMutant(baseline, mutated) {
  if (!baseline.summary || !baseline.tests.some(test => test.status === 'passed') ||
      baseline.tests.some(test => test.status === 'failed' || test.status === 'error')) {
    throw new Error('QA_MUTANT_BASELINE_INELIGIBLE');
  }
  const comparison = comparePasses([baseline, mutated]);
  if (comparison.some(t => t.statuses[0] === 'passed' ? !['passed', 'failed'].includes(t.statuses[1])
    : t.statuses[0] !== t.statuses[1])) throw new Error('QA_MUTANT_TEST_SET_CHANGED');
  const killedBy = comparison.find(t => t.statuses[1] === 'failed');
  return {status: killedBy ? 'morto' : 'sobrevivente', killedBy};
}

function replaceRange(content, location, replacement) {
  const lines = content.split('\n');
  const offset = ({line, column}) => {
    if (!isCount(line) || !isCount(column) || lines[line] === undefined || column > lines[line].length) {
      throw new Error('QA_STRYKER_INVALID_LOCATION');
    }
    return lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0) + column;
  };
  const start = offset(location.start);
  const end = offset(location.end);
  if (start >= end) throw new Error('QA_STRYKER_INVALID_LOCATION');
  return content.slice(0, start) + '(' + replacement + ')' + content.slice(end);
}

export async function planMutations(Instrumenter, files, readSource) {
  const logger = {debug() {}, info() {}, warn() {}, error() {}, trace() {}, isDebugEnabled: () => false, isTraceEnabled: () => false};
  const instrumenter = new Instrumenter(logger);
  const selected = [];
  let total = 0;
  for (const file of files) {
    const content = readSource(file);
    const {mutants} = await instrumenter.instrument([{name: file, content, mutate: true}], {
      plugins: null, excludedMutations: [], ignorers: [],
    });
    for (const mutant of mutants) {
      if (mutant.status === 'Ignored' || mutant.mutatorName !== 'EqualityOperator') continue;
      total++;
      if (selected.length >= maxMutants) continue;
      selected.push({
        file, line: mutant.location.start.line + 1, replacement: mutant.replacement,
        content: replaceRange(content, mutant.location, mutant.replacement),
      });
    }
  }
  return {selected, total};
}
