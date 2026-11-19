import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
// @ts-expect-error The collector modules are native JavaScript.
import {collectLanguageMutation, collectPythonProperties, goScope, runGoSuite, verifyPinnedTool} from '../deploy/modules/qa/mutacao-linguagens/index.mjs';
// @ts-expect-error The collector modules are native JavaScript.
import {runBoundedProcess} from '../deploy/modules/qa/execute-tests.mjs';
// @ts-expect-error The collector modules are native JavaScript.
import * as measurement from '../deploy/modules/qa/mutacao-linguagens/measurement.mjs';

const {
  classifyTrial, decodeGoSuite, decodePlan, decodePythonSuite, limits, measurePlan, patchSource,
  seed, stopGoAtTestLimit, summarizeProperties,
} = measurement;
const fixture = fileURLToPath(new URL('./fixtures/module-qa-mutacao-linguagens/', import.meta.url));
const pythonRunner = fileURLToPath(new URL('../deploy/modules/qa/mutacao-linguagens/python-runner.py', import.meta.url));
const pythonUnitRunner = fileURLToPath(new URL('../deploy/modules/qa/python-test-runner.py', import.meta.url));

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
  const logged = {...event('output', 'TestTotal'), Output: 'panic: mensagem esperada\nfatal error: exemplo\n'};
  const summary = {...event('output'), Output: 'FAIL\n', OutputType: 'frame'};
  const baseline = run(0, [...start, logged, event('pass', 'TestTotal'), event('pass')]);
  assert.equal(baseline.tests[0].status, 'passed');
  const failure = [...start, logged, event('fail', 'TestTotal')];
  assert.equal(classifyTrial(baseline, run(1, [...failure, summary, event('fail')])).status, 'killed');
  assert.equal(run(1, [...failure, {...summary, OutputType: undefined}, event('fail')]).reason, 'go-test-execution');
  const buildFailure = [event('build-fail'), event('fail')];
  const compilerDiagnostic = {Action: 'build-output', Output: './arithmetic.go:3:14: invalid operation: division by zero\n'};
  const busyCompiler = 'go: fork/exec /go/pkg/tool/compile: resource temporarily unavailable\n';
  assert.equal(run(1, [compilerDiagnostic, ...buildFailure]).reason, 'go-build-failed');
  assert.equal(run(1, buildFailure).reason, 'go-build-execution');
  assert.equal(run(1, [compilerDiagnostic, ...buildFailure], busyCompiler).reason, 'go-build-execution');
  assert.equal(run(1, [{Action: 'build-output', Output: busyCompiler}, ...buildFailure]).reason, 'go-build-execution');
  assert.equal(run(1, []).reason, 'go-test-execution');
  assert.equal(run(0, [...start, event('pass')]).reason, 'go-test-execution');
  assert.equal(run(1, [], 'module lookup disabled by GOPROXY=off').reason, 'offline-dependency');
});

test('limite Go acompanha eventos run entre blocos de saída', () => {
  const monitor = stopGoAtTestLimit();
  const line = (event: object) => Buffer.from(JSON.stringify(event) + '\n');
  const event = line({Action: 'run', Test: 'TestOperação'});
  const log = line({Action: 'output', Output: event.toString()});
  assert.equal(monitor(Buffer.concat([...Array(limits.tests).fill(event), log])), undefined);
  assert.equal(monitor(event.subarray(0, event.indexOf(0xc3) + 1)), undefined);
  assert.equal(monitor(event.subarray(event.indexOf(0xc3) + 1)), 'QA_TEST_GO_CASE_LIMIT');
});

test('sondagem sem versão verificável indica ferramenta indisponível', async () => {
  const matches = (value: unknown) => value === '1.0.0';
  const unavailable = {status: 'unavailable', message: 'tool-unavailable'};
  await verifyPinnedTool(async () => report('1.0.0'), matches);
  for (const result of [report('2.0.0'), {code: 0, output: 'invalid'}, {code: 1, output: ''}]) {
    await assert.rejects(verifyPinnedTool(async () => result, matches), unavailable);
  }
  await assert.rejects(verifyPinnedTool(async () => { throw new Error('QA_TEST_SPAWN_ENOEXEC'); }, matches), unavailable);
  await assert.rejects(verifyPinnedTool(async () => { throw new Error('QA_TEST_TIMEOUT'); }, matches), /QA_TEST_TIMEOUT/);
});

test('propriedades já concluídas sobrevivem à interrupção e casos pendentes ficam sem medição', () => {
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

  const completed = [{...tests[0], status: 'failed', examples: 4}, {...tests[0], id: 'b'.repeat(64), status: 'pending', examples: 3}];
  const interrupted = summarizeProperties(decode({exitCode: 2, tests: completed}));
  assert.deepEqual(interrupted, {status: 'partial', outcome: 'failed', reason: 'python-test-execution', properties: completed});
  assert.equal(summarizeProperties(decode({exitCode: 2, tests: completed.slice(1)})).status, 'not-run');
  assert.deepEqual(decodePythonSuite(report({exitCode: 2, tests: completed, limited: false,
    unavailable: false}), [file]), {reason: 'python-test-execution'});
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
    const tools = join(root, 'tools', 'mutacao-linguagens');
    mkdirSync(tools, {recursive: true});
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

    const runtimeFile = 'runtime_math.py';
    const runtimeTest = 'test_runtime_math.py';
    const runtimeSource = 'def total(value):\n    return value * 0\n';
    writeFileSync(join(project, runtimeFile), runtimeSource);
    writeFileSync(join(project, runtimeTest), 'from runtime_math import total\ndef test_total():\n    assert total(3) == 0\n');
    const runtimePlan = decodePlan(run('plan', runtimeFile), [runtimeFile], () => runtimeSource);
    const runtimeMutation = await measurePlan(runtimePlan, async (edit?: Edit) => {
      writeFileSync(join(project, runtimeFile), edit ? patchSource(runtimeSource, edit) : runtimeSource);
      const result = run('suite', String(seed), runtimeTest);
      if (edit) assert.match(result.diagnostics, /1 failed/);
      return decodePythonSuite(result, [runtimeTest]);
    });
    assert.equal(runtimeMutation.status, 'measured');
    assert.equal(runtimeMutation.mutants[0].status, 'killed');
    assert.equal(runtimeMutation.mutants[0].killedBy.file, runtimeTest);

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

    writeFileSync(join(root, 'conftest.py'), 'raise AssertionError("fixture fora do snapshot")\n');
    writeFileSync(join(project, 'conftest.py'), [
      'import pytest', '@pytest.fixture(scope="session")', 'def offset():', '    return 4',
      '@pytest.fixture', 'def broken_setup():', '    raise RuntimeError("erro de setup sintetico")', '',
    ].join('\n'));
    const local = 'test_local_fixture.py';
    writeFileSync(join(project, local), [
      'from hypothesis import given, strategies as st', '@given(st.integers())',
      'def test_local(offset, value):', '    assert (value + offset) - offset == value', '',
    ].join('\n'));
    const localFixture = summarizeProperties(decodePythonSuite(run('properties', String(seed), local), [local], true));
    assert.equal(localFixture.status, 'measured');
    assert.equal(localFixture.outcome, 'passed');
    assert.equal(localFixture.properties[0].examples, 32);

    const partialFile = 'test_partial.py';
    writeFileSync(join(project, partialFile), [
      'from hypothesis import given, strategies as st', 'import os',
      '@given(st.just(2))', 'def test_bad_property(value):',
      "    os.write(1, b'log sintetico do teste\\n')", '    assert value == 0',
      '@given(st.just(3))', 'def test_runtime_error(value):', '    raise RuntimeError("erro sintetico")', '',
      '@given(st.just(3))', 'def test_fixture_error(broken_setup, value):', '    assert value == 3', '',
    ].join('\n'));
    const partialRun = run('properties', String(seed), partialFile);
    assert.match(partialRun.diagnostics, /log sintetico/);
    const partial = summarizeProperties(decodePythonSuite(partialRun, [partialFile], true));
    assert.equal(partial.status, 'partial');
    assert.equal(partial.outcome, 'failed');
    assert.equal(partial.reason, 'python-test-execution');
    assert.deepEqual(partial.properties.map((property: {status: string}) => property.status), ['failed', 'failed', 'error']);

    const interruptedFile = 'test_interrupted_properties.py';
    writeFileSync(join(project, interruptedFile), [
      'from hypothesis import given, strategies as st',
      '@given(st.just(3))', 'def test_falsified(value):', '    assert value == 4', '',
      '@given(st.just(3))', 'def test_interrupt(value):', '    raise KeyboardInterrupt("interrupção sintética")', '',
    ].join('\n'));
    const interruptedRun = run('properties', String(seed), interruptedFile);
    assert.equal(JSON.parse(interruptedRun.output).exitCode, 2);
    const interrupted = summarizeProperties(decodePythonSuite(interruptedRun, [interruptedFile], true));
    assert.equal(interrupted.status, 'partial');
    assert.equal(interrupted.reason, 'python-test-execution');
    assert.equal(interrupted.properties[0].status, 'failed');
    assert.ok(interrupted.properties[0].examples > 0);
    assert.equal(interrupted.properties[1].status, 'pending');

    // Mirror the runner layout in the image and give unittest only its coverage import path.
    const coveragePath = join(root, 'coverage-runtime');
    mkdirSync(coveragePath);
    cpSync(join(pythonDeps!, 'coverage'), join(coveragePath, 'coverage'), {recursive: true});
    const unitRunner = join(root, 'tools', 'python-test-runner.py');
    cpSync(pythonUnitRunner, unitRunner);
    const unitPlan = join(root, 'plan.json');
    const optionalTest = 'test_optional_hypothesis.py';
    writeFileSync(join(project, optionalTest), [
      'import unittest', 'try:', '    import hypothesis', 'except ModuleNotFoundError:', '    hypothesis = None',
      'class OptionalDependency(unittest.TestCase):', '    @unittest.skipIf(hypothesis is None, "optional")',
      '    def test_presence(self):', '        self.assertIsNotNone(hypothesis)', '',
    ].join('\n'));
    writeFileSync(unitPlan, JSON.stringify({
      files: [...files, 'test_unit.py', optionalTest], sourceFiles: [file], maxTests: 200, maxProfileBytes: 1024 * 1024,
    }));
    writeFileSync(path, source);
    const unitRun = invoke(python!, ['-P', '-s', '-S', '-B', unitRunner, unitPlan, join(root, 'coverage.json')],
      project, {HOME: root, TMPDIR: root, PYTHONPATH: coveragePath});
    const unitResult = JSON.parse(unitRun.output);
    assert.equal(unitResult.unavailable, 1);
    assert.equal(unitResult.errors, 0);
    assert.deepEqual(unitResult.tests, [
      {file: 'test_unit.py', name: 'ArithmeticTest.test_total', status: 'passed'},
      {file: optionalTest, name: 'OptionalDependency.test_presence', status: 'skipped'},
    ]);
    assert.equal(unitResult.coverage.files, 1);
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
    const file = 'arithmetic.go';
    const path = join(project, file);
    const source = readFileSync(path, 'utf8');
    const selection = {moduleDir: '.', sourceFiles: [file]};
    const run = (_binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number,
      stopOnStdout?: (chunk: Buffer) => string | undefined) =>
      runBoundedProcess(go!, args, cwd, {env, timeoutMs, maxBytes: limits.outputBytes, stopOnStdout});
    const discover = () => goScope(run, project, root, cache, selection);
    const readonly = await discover();
    assert.equal(readonly.mode, '-mod=readonly');
    assert.deepEqual(readonly.sources, [file]);

    const vendor = join(project, 'vendor');
    const dependency = join(vendor, 'qa.local/offset');
    mkdirSync(dependency, {recursive: true});
    writeFileSync(join(project, 'go.mod'), 'module qa.local/arithmetic\n\ngo 1.27\n\nrequire qa.local/offset v1.0.0\n');
    writeFileSync(join(vendor, 'modules.txt'), '# qa.local/offset v1.0.0\n## explicit; go 1.27\nqa.local/offset\n');
    writeFileSync(join(dependency, 'offset.go'), 'package offset\nconst Value = 2\n');
    const testPath = join(project, 'arithmetic_test.go');
    writeFileSync(testPath, [
      'package arithmetic', 'import ("fmt"; "testing"; "qa.local/offset")', 'func TestTotal(t *testing.T) {',
      '    fmt.Println("panic: log esperado")',
      '    if Total(4, offset.Value) != 6 { t.Error("incorrect addition") }', '}', '',
    ].join('\n'));
    const scope = await discover();
    assert.deepEqual(scope, {...readonly, mode: '-mod=vendor'});
    const runSuite = () => runGoSuite(run, project, root, cache, selection, scope);
    const plan = decodePlan(invoke(planner!, [file], project, {}), [file], () => source);
    assert.deepEqual(plan.edits.map((edit: Edit) => [edit.line, edit.before, edit.after]),
      [[3, '+', '-'], [4, '*', '/'], [5, '*', '/']]);
    const result: FixtureResult = await measurePlan(plan, async (edit?: Edit) => {
      writeFileSync(path, edit ? patchSource(source, edit) : source);
      return runSuite();
    });
    assert.equal(result.status, 'partial');
    assert.deepEqual(result.mutants.sort((a, b) => a.line - b.line).map(mutant => mutant.status),
      ['killed', 'survived', 'not-run']);
    assert.equal(result.mutants.find(mutant => mutant.line === 5)?.reason, 'go-build-failed');

    writeFileSync(path, source);
    writeFileSync(testPath, 'package arithmetic\nimport "testing"\nfunc TestAbort(t *testing.T) { panic("erro sintético") }\n');
    assert.deepEqual(await runSuite(), {reason: 'go-test-execution'});

    writeFileSync(testPath, [
      'package arithmetic', 'import ("fmt"; "os"; "testing"; "time")',
      'func TestBudget(t *testing.T) {',
      `    for i := 0; i < ${limits.tests}; i++ { t.Run(fmt.Sprint(i), func(t *testing.T) {}) }`,
      '    time.Sleep(time.Second)', '    if err := os.WriteFile("after-budget", []byte("done"), 0600); err != nil { t.Fatal(err) }',
      '}', '',
    ].join('\n'));
    assert.deepEqual(await runSuite(), {reason: 'test-limit'});
    await delay(1_100);
    assert.equal(existsSync(join(project, 'after-budget')), false);

    writeFileSync(testPath, 'package arithmetic\nimport ("testing"; _ "qa.local/offset")\nfunc TestOffline(t *testing.T) {}\n');
    rmSync(dependency, {recursive: true});
    assert.deepEqual(await runSuite(), {reason: 'offline-dependency'});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
