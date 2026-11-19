import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
// @ts-expect-error The collector modules are native JavaScript.
import {collectLanguageMutation, collectPythonProperties} from '../deploy/modules/qa/mutacao-linguagens/index.mjs';
// @ts-expect-error The collector modules are native JavaScript.
import * as measurement from '../deploy/modules/qa/mutacao-linguagens/measurement.mjs';

const {
  classifyTrial, decodeGoSuite, decodePlan, decodePythonSuite, goListFormat, measurePlan, patchSource,
  seed, summarizeProperties,
} = measurement;
const fixture = fileURLToPath(new URL('./fixtures/module-qa-mutacao-linguagens/', import.meta.url));
const pythonRunner = fileURLToPath(new URL('../deploy/modules/qa/mutacao-linguagens/python-runner.py', import.meta.url));

type Edit = {id: string; file: string; line: number; column: number; before: string; after: string};
type FixtureResult = {status: string; mutants: (Edit & {status: string; reason?: string})[]};

const report = (value: unknown) => ({code: 0, output: JSON.stringify(value), diagnostics: ''});
const edits = (values: Omit<Edit, 'id'>[]) => report({edits: values, omitted: [], truncated: false});
const passed = {tests: [{id: 'test', status: 'passed'}]};
const failed = {tests: [{id: 'test', status: 'failed', name: 'TestTotal'}]};

test('API pública exige o isolamento do coletor antes de iniciar subprocessos', async () => {
  const context = {repoDir: '/repo', workspace: '/tmp/invalid/project', workRoot: '/tmp/invalid'};
  for (const result of [
    await collectLanguageMutation('go', context, ['go.mod', 'a.go', 'a_test.go'], false),
    await collectLanguageMutation('python', context, ['test_arithmetic.py'], false),
    await collectPythonProperties(context, ['test_arithmetic.py'], false),
  ]) {
    assert.equal(result.status, 'not-run');
    assert.equal(result.reason, 'isolated-container-required');
  }
  const incomplete = await collectLanguageMutation('python', context, ['test_arithmetic.py'], true);
  assert.match(incomplete.reason, /escopo parcial/);
});

test('confirma arquivo, linha física e coluna Unicode antes de aplicar o operador', () => {
  const file = 'arithmetic.py';
  const source = 'result = variável + operand\r\n';
  const edit = {file, line: 1, column: 19, before: '+', after: '-'};
  const plan = decodePlan(edits([edit, edit]), [file], () => source);
  assert.equal(plan.edits.length, 1);
  assert.equal(patchSource(source, plan.edits[0]), 'result = variável - operand\r\n');
  assert.throws(() => decodePlan(edits([{...edit, column: 18}]), [file], () => source), /origin/);
  assert.throws(() => decodePlan(edits([{...edit, file: '../arithmetic.py'}]), [file], () => source), /invalid-edit/);
  assert.throws(() => patchSource('result = variável * operand\r\n', edit), /origin/);
});

test('amostra e baseline reproduzíveis, com limite e contagem de não executados', async () => {
  const file = 'arithmetic.py';
  const source = 'x + 1\n'.repeat(11);
  const list = Array.from({length: 11}, (_, index) =>
    ({file, line: index + 1, column: 3, before: '+', after: '-'}));
  const plan = decodePlan(edits(list), [file], () => source);
  const reverse = decodePlan(edits([...list].reverse()), [file], () => source);
  let baselineCalls = 0;
  const run = async (edit?: Edit) => {
    if (!edit) {
      baselineCalls++;
      return passed;
    }
    return edit.line % 2 ? failed : passed;
  };
  const result = await measurePlan(plan, run);
  assert.deepEqual(await measurePlan(reverse, run), result);
  assert.equal(baselineCalls, 2);
  assert.equal(result.status, 'partial');
  assert.equal(result.baseline.status, 'passed');
  assert.equal(result.candidates, 11);
  assert.equal(result.mutants.length, 8);
  assert.equal(result.notRun, 3);
  assert.equal(result.killed + result.survived, 8);
});

test('baseline ausente, vermelha ou sem dependência bloqueia todos os mutantes', async () => {
  const file = 'arithmetic.py';
  const plan = decodePlan(edits([{file, line: 1, column: 3, before: '+', after: '-'}]), [file], () => 'x + 1');
  for (const [suite, status, reason] of [
    [failed, 'not-run', 'baseline-failed'],
    [{tests: [{id: 'test', status: 'skipped'}]}, 'not-run', 'no-passing-tests'],
    [{reason: 'offline-dependency'}, 'unavailable', 'offline-dependency'],
  ] as const) {
    const result = await measurePlan(plan, async (edit?: Edit) => {
      assert.equal(edit, undefined);
      return suite;
    });
    assert.equal(result.status, status);
    assert.equal(result.notRun, 1);
    assert.equal(result.score, null);
    assert.equal(result.mutants[0].reason, reason);
  }
  assert.deepEqual(classifyTrial(passed, {tests: [{id: 'other', status: 'failed'}]}),
    {status: 'not-run', reason: 'test-set-changed'});
});

test('relatório Go distingue falha de caso, falha de build e dependência offline', () => {
  const pkg = 'qa.local/arithmetic';
  const testPackages = new Set([pkg]);
  const event = (Action: string, Test?: string) => ({Action, Package: pkg, Test});
  const run = (code: number, events: object[], diagnostics = '') => decodeGoSuite(
    {code, output: events.map(value => JSON.stringify(value)).join('\n'), diagnostics}, testPackages,
  );
  const start = [event('start'), event('run', 'TestTotal')];
  const baseline = run(0, [...start, event('pass', 'TestTotal'), event('pass')]);
  assert.equal(classifyTrial(baseline, run(1, [...start, event('fail', 'TestTotal'), event('fail')])).status, 'killed');
  assert.equal(run(1, [event('build-fail'), event('fail')]).reason, 'go-test-execution');
  assert.equal(run(1, []).reason, 'go-test-execution');
  assert.equal(run(0, [...start, event('pass')]).reason, 'go-test-execution');
  assert.equal(run(1, [], 'module lookup disabled by GOPROXY=off').reason, 'offline-dependency');
});

test('propriedades sem exemplos e interrupções ficam sem medição', () => {
  const file = 'test_arithmetic.py';
  const tests = [{file, id: 'a'.repeat(64), line: 10, property: true, examples: 0, status: 'skipped'}];
  const decode = (value: object) => decodePythonSuite(report({exitCode: 0, tests, limited: false,
    unavailable: false, ...value}), [file], true);
  assert.equal(summarizeProperties(decode({})).status, 'not-run');
  assert.equal(summarizeProperties(decode({tests: [], exitCode: 5})).reason, 'no-properties');
  assert.equal(summarizeProperties(decode({unavailable: true})).status, 'unavailable');
  assert.equal(summarizeProperties(decode({limited: true})).reason, 'test-limit');
  const measured = summarizeProperties(decode({exitCode: 1, tests: [{...tests[0], status: 'failed', examples: 4}]}));
  assert.equal(measured.status, 'measured');
  assert.equal(measured.outcome, 'failed');
});

function invoke(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(binary, args, {cwd, env, encoding: 'utf8', timeout: 35_000, maxBuffer: 1024 * 1024});
  assert.ifError(result.error);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  return {code: result.status, output: result.stdout, diagnostics: result.stderr};
}

const python = process.env.QA_MUTATION_SYNTHETIC_PYTHON;
const pythonDeps = process.env.QA_MUTATION_SYNTHETIC_PYTHON_DEPS;
test('mutmut, pytest e Hypothesis reais em cópia temporária da fixture', {skip: !python || !pythonDeps}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-synthetic-python-'));
  try {
    const project = join(root, 'project');
    const tools = join(root, 'tools');
    mkdirSync(tools);
    cpSync(fixture, project, {recursive: true});
    cpSync(pythonRunner, join(tools, 'python-runner.py'));
    cpSync(pythonDeps!, join(tools, 'python-deps'), {recursive: true});
    const run = (...args: string[]) => invoke(python!, ['-P', '-s', '-S', '-B', join(tools, 'python-runner.py'),
      ...args], project, {HOME: root, TMPDIR: root, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONHASHSEED: String(seed)});
    const file = 'arithmetic.py';
    const path = join(project, file);
    const source = readFileSync(path, 'utf8');
    const files = ['test_arithmetic.py'];
    const plan = decodePlan(run('plan', file), [file], () => source);
    assert.deepEqual(plan.edits.map((edit: Edit) => [edit.line, edit.before, edit.after]), [[3, '+', '-'], [7, '*', '/']]);
    const result: FixtureResult = await measurePlan(plan, async (edit?: Edit) => {
      writeFileSync(path, edit ? patchSource(source, edit) : source);
      return decodePythonSuite(run('suite', String(seed), ...files), files);
    });
    assert.equal(result.status, 'measured');
    assert.deepEqual(result.mutants.sort((a, b) => a.line - b.line).map(mutant => mutant.status), ['killed', 'survived']);
    const properties = () => summarizeProperties(decodePythonSuite(run('properties', String(seed), ...files), files, true));
    writeFileSync(path, source);
    const healthy = properties();
    assert.equal(healthy.status, 'measured');
    assert.equal(healthy.outcome, 'passed');
    assert.deepEqual(healthy.properties.map((entry: {line: number; examples: number}) => [entry.line, entry.examples]),
      [[10, 32], [16, 32]]);
    assert.deepEqual(healthy, properties());
    writeFileSync(path, patchSource(source, plan.edits[0]));
    assert.equal(properties().outcome, 'failed');
    const ordinary = 'test_ordinary.py';
    writeFileSync(join(project, ordinary), 'def test_hypothesis_name_only():\n    assert False\n');
    const withoutProperties = decodePythonSuite(run('properties', String(seed), ordinary), [ordinary], true);
    assert.equal(summarizeProperties(withoutProperties).reason, 'no-properties');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

const go = process.env.QA_MUTATION_SYNTHETIC_GO;
const planner = process.env.QA_MUTATION_SYNTHETIC_GO_PLANNER;
test('go-mutesting e go test reais em cópia temporária da fixture', {skip: !go || !planner}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-synthetic-go-'));
  try {
    const project = join(root, 'project');
    const cache = join(root, 'cache');
    mkdirSync(cache);
    cpSync(join(fixture, 'go'), project, {recursive: true});
    const env = {PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, GOCACHE: cache, GOENV: 'off', GOWORK: 'off',
      GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOTELEMETRY: 'off', GOVCS: '*:off', CGO_ENABLED: '0', GOMAXPROCS: '2'};
    const file = 'arithmetic.go';
    const path = join(project, file);
    const source = readFileSync(path, 'utf8');
    assert.equal(invoke(go!, ['list', '-mod=readonly', '-f', goListFormat, './...'], project, env).output.trim(),
      'S\t' + path + '\nP\tqa.local/arithmetic');
    const plan = decodePlan(invoke(planner!, [file], project, env), [file], () => source);
    assert.deepEqual(plan.edits.map((edit: Edit) => [edit.line, edit.before, edit.after]),
      [[3, '+', '-'], [4, '*', '/'], [5, '*', '/']]);
    const result: FixtureResult = await measurePlan(plan, async (edit?: Edit) => {
      writeFileSync(path, edit ? patchSource(source, edit) : source);
      const tests = invoke(go!, ['test', '-json', '-mod=readonly', '-count=1', '-p=2', '-parallel=1', '-vet=off',
        '-timeout=8s', '-run', '^(Test|Example)', '-shuffle=' + seed, './...'], project, env);
      return decodeGoSuite(tests, new Set(['qa.local/arithmetic']));
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.mutants.sort((a, b) => a.line - b.line).map(mutant => mutant.status),
      ['killed', 'survived', 'not-run']);
    assert.equal(result.mutants.find(mutant => mutant.line === 5)?.reason, 'go-test-execution');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
