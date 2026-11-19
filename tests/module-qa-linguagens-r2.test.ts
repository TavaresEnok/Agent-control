import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test, type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';

const {
  collectLanguageSuite, decodeGoPass, decodePythonPass, loadLanguageSnapshot, measureLanguageSuite,
  prepareGoTestBudget, readGoCaseLocations, runLanguageProcess, selectLanguageSuite,
} = await import(new URL('../deploy/modules/qa/language-tests.mjs', import.meta.url).href);

function fixture(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'qa-linguagens-r2-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  putFiles(root, files);
  return root;
}

function putFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, content);
  }
}

test('cada área de trabalho restaura os mesmos fontes e dados Git', t => {
  const repo = fixture(t, {
    'arithmetic.py': 'TOTAL = 20\n',
    'test_arithmetic.py': 'from arithmetic import TOTAL\n',
    'testdata/total.txt': '20\n',
    'testdata/.empty': '',
    '.env': 'placeholder',
  });
  const parent = fixture(t, {});
  const snapshot = loadLanguageSnapshot(repo);
  assert.deepEqual(new Set(snapshot.files), new Set([
    'arithmetic.py', 'test_arithmetic.py', 'testdata/total.txt', 'testdata/.empty',
  ]));

  for (let pass = 1; pass <= 3; pass++) {
    const cwd = join(parent, String(pass));
    snapshot.copyTo(cwd);
    assert.equal(readFileSync(join(cwd, 'arithmetic.py'), 'utf8'), 'TOTAL = 20\n');
    assert.equal(readFileSync(join(cwd, 'testdata/total.txt'), 'utf8'), '20\n');
    writeFileSync(join(cwd, 'arithmetic.py'), 'TOTAL = 30\n');
    rmSync(join(cwd, 'testdata/total.txt'));
  }
  assert.equal(readFileSync(join(repo, 'testdata/total.txt'), 'utf8'), '20\n');

  writeFileSync(join(repo, 'testdata/unsized.txt'), Buffer.alloc(1024 * 1024 + 1));
  assert.match(loadLanguageSnapshot(repo).reason, /escopo parcial/);
});

test('a chamada atual do coletor ainda respeita o bloqueio de execução no host', async t => {
  const repoDir = fixture(t, {'go.mod': 'module example.invalid/qa\n', 'total_test.go': 'package total\n'});
  const context = {repoDir, workRoot: repoDir, workspace: repoDir};
  const result = await collectLanguageSuite('go', context, ['go.mod', 'total_test.go'], false);
  assert.equal(result.coverageRow.status, 'skipped');
  assert.match(result.coverageRow.detail, /contêiner isolado/);
});

for (const outcome of ['prazo', 'saída']) {
  test(`o supervisor encerra a espera por ${outcome} sem evento close`, async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref() { this.released = true; },
      released: false,
    });
    const result = runLanguageProcess('fixture', [], tmpdir(), {
      timeoutMs: 30, maxBytes: 6, spawnChild: () => child,
    });
    if (outcome === 'prazo') child.emit('exit', 0, null);
    else {
      child.stdout.write('123');
      child.stderr.write('4567');
    }
    await assert.rejects(result, outcome === 'prazo' ? /QA_TEST_TIMEOUT/ : /QA_TEST_OUTPUT_LIMIT/);
    assert.ok(child.stdout.destroyed && child.stderr.destroyed && child.released);
  });
}

const pythonRunner = fileURLToPath(new URL('../deploy/modules/qa/python-test-runner.py', import.meta.url));
const pythonCoverage = process.env.QA_R2_TEST_COVERAGE ?? '/opt/qa-coverage';
const python = process.env.QA_R2_TEST_PYTHON ?? '/usr/bin/python3';

test('o runner Python atribui importação reprovada ao caso e distingue descoberta externa e pytest', {
  skip: !existsSync(python) || !existsSync(join(pythonCoverage, 'coverage/__init__.py')),
}, async t => {
  const root = fixture(t, {
    'arithmetic.py': 'def gross(net):\n    return net * 2\n',
    'testdata/gross.txt': '40\n',
    'test_arithmetic.py': `from pathlib import Path
import unittest
from arithmetic import gross

class GrossTests(unittest.TestCase):
    def test_control(self):
        expected = int(Path("testdata/gross.txt").read_text())
        self.assertEqual(gross(20), expected)
    def test_import(self):
        from recipe_component_missing import calculate
`,
    'test_external.py': 'import declared_external_fixture\n',
    'test_local.py': 'import local_package.missing\n',
    'local_package/__init__.py': '',
    'test_style.py': 'def testControl():\n    assert 2 + 2 == 4\n',
    'test_style_class.py': 'class TestArithmetic:\n    def test_control(self):\n        assert 2 + 2 == 4\n',
    'test_style_missing.py': 'import pytest\n',
  });
  const profile = join(root, 'coverage.json');
  const plan = join(root, 'plan.json');
  async function execute(files: string[]) {
    const selection = selectLanguageSuite('python', ['arithmetic.py', ...files], false);
    writeFileSync(plan, JSON.stringify({...selection, maxTests: 200, maxProfileBytes: 1024 * 1024}));
    const command = 'import runpy, sys; sys.path.append(sys.argv.pop(1)); runpy.run_path(sys.argv.pop(1), run_name="__main__")';
    const result = await runLanguageProcess(python, ['-I', '-S', '-B', '-c', command, pythonCoverage, pythonRunner, plan, profile], root);
    return decodePythonPass(result, selection);
  }

  const measured = await execute(['test_arithmetic.py', 'test_external.py', 'test_local.py']);
  assert.equal(measured.unavailable, 1);
  assert.equal(measured.errors, 1);
  assert.equal(measured.unsupported, 0);
  assert.deepEqual(measured.tests.map(({name, status}: {name: string; status: string}) => [name, status]), [
    ['GrossTests.test_control', 'passed'], ['GrossTests.test_import', 'failed'],
  ]);
  assert.deepEqual(measured.coverage, {files: 1, statements: [2, 2], branches: [0, 0]});

  const pytestFiles = ['test_style.py', 'test_style_class.py', 'test_style_missing.py'];
  const pytest = await execute(pytestFiles);
  assert.equal(pytest.unsupported, 3);
  assert.equal(pytest.unavailable, 0);
  assert.deepEqual(pytest.tests, []);
  assert.equal(pytest.coverage, null);
  const suite = await measureLanguageSuite('python', selectLanguageSuite('python', pytestFiles, false), async () => pytest);
  assert.equal(suite.coverageRow.status, 'skipped');
  assert.match(suite.coverageRow.detail, /formato pytest não suportado/);
  assert.match(suite.extraRows[0].detail, /3 arquivos com formato pytest não suportado/);

  const mixedFiles = ['test_arithmetic.py', 'test_style.py'];
  const mixed = await execute(mixedFiles);
  const mixedSuite = await measureLanguageSuite('python',
    selectLanguageSuite('python', ['arithmetic.py', ...mixedFiles], false), async () => mixed);
  assert.equal(mixedSuite.coverageRow.status, 'ok');
  assert.match(mixedSuite.coverageRow.detail, /formato pytest não suportado/);
  assert.match(mixedSuite.extraRows[3].detail, /escopo parcial/);
});

const moduleName = 'example.invalid/qa/total';

test('Go identifica a oscilação de subtestes mesmo com o pai sempre reprovado', async () => {
  const selection = selectLanguageSuite('go', ['go.mod', 'one_test.go', 'two_test.go'], false);
  const locations = new Map([[`${moduleName}\0TestΣ_1`, {file: 'two_test.go', line: 7}]]);
  let pass = 0;
  const result = await measureLanguageSuite('go', selection, async () => {
    const events = [
      {Action: pass % 2 ? 'pass' : 'fail', Package: moduleName, Test: 'TestΣ_1/A::10/mínimo#01'},
      {Action: pass++ % 2 ? 'fail' : 'pass', Package: moduleName, Test: 'TestΣ_1/B+10'},
      {Action: 'fail', Package: moduleName, Test: 'TestΣ_1'},
      {Action: 'fail', Package: moduleName},
    ];
    return decodeGoPass({code: 1, output: events.map(event => JSON.stringify(event)).join('\n'), diagnostics: ''},
      null, selection, moduleName, locations);
  });
  const oscillating = result.findings.filter(({rule}: {rule: string}) => rule === 'QA-TESTE-OSCILANTE');
  assert.equal(oscillating.length, 2);
  assert.ok(oscillating.every(({file, line}: {file: string; line: number}) => file === 'two_test.go' && line === 7));
  assert.match(oscillating[0].message, /A::10\/mínimo#01/);
  assert.match(oscillating[1].message, /B\+10/);
});

const go = process.env.QA_R2_TEST_GO ?? '/usr/local/go/bin/go';

test('Go 1.27.4 usa o dado de embed, atribui arquivos e nega a entrada ao 201º caso', {
  skip: !existsSync(go), timeout: 100_000,
}, async t => {
  const original = fixture(t, {
    'go.mod': `module ${moduleName}\n\ngo 1.27\n`,
    'total.go': `package total
import _ "embed"
//go:embed testdata/quantity.txt
var quantity string
func Quantity() string { return quantity }
`,
    'testdata/quantity.txt': '20\n',
    'one_test.go': `package total
import ("fmt"; "testing")
func TestΣ(t *testing.T) {
    t.Run("desconto/10%#1", func(t *testing.T) {
        if Quantity() != "20\\n" { t.Fatalf("quantidade: %q", Quantity()) }
    })
}
func ExampleQuantity() {
    fmt.Print(Quantity())
    // Output: 20
}
`,
    'two_test.go': `package total
import ("os"; "testing")
func TestCap(t *testing.T) {
    for range 199 {
        t.Run("valor", func(t *testing.T) {
            f, err := os.OpenFile("business.txt", os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
            if err != nil { t.Fatal(err) }
            if _, err := f.WriteString("20\\n"); err != nil { t.Fatal(err) }
            if err := f.Close(); err != nil { t.Fatal(err) }
        })
    }
}
`,
    'other/total_test.go': `package other
import ("os"; "testing")
func TestAnotherPackage(t *testing.T) {
    if err := os.WriteFile("business.txt", []byte("20\\n"), 0600); err != nil { t.Fatal(err) }
}
`,
  });
  const scratch = fixture(t, {});
  const snapshot = loadLanguageSnapshot(original);
  const cwd = join(scratch, 'project');
  snapshot.copyTo(cwd);
  const version = await runLanguageProcess(go, ['version'], cwd, {env: {GOTOOLCHAIN: 'local'}});
  assert.match(version.output, /go1\.27\.4\b/);
  const selection = selectLanguageSuite('go', snapshot.files, false);
  const cache = join(scratch, 'go-cache');

  async function execute(name: string, filter: string) {
    const attempt = join(scratch, name);
    mkdirSync(attempt);
    const {overlayFile, cases} = prepareGoTestBudget(attempt, dirname(dirname(go)));
    const profile = join(attempt, 'coverage.out');
    const result = await runLanguageProcess(go, [
      'test', '-json', '-mod=readonly', '-count=1', '-p=2', '-parallel=1', '-vet=off', '-timeout=8s', '-run', filter,
      `-overlay=${overlayFile}`, '-covermode=set', `-coverprofile=${profile}`, './...',
    ], cwd, {timeoutMs: 35_000, env: {
      HOME: attempt, TMPDIR: attempt, GOCACHE: cache, GOPATH: join(attempt, 'go'), GOENV: 'off', GOTOOLCHAIN: 'local',
      GOWORK: 'off', GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off', CGO_ENABLED: '0', GOMAXPROCS: '2', QA_GO_CASE_DIR: cases,
    }});
    return {cases, result, profile};
  }

  const normal = await execute('normal', '^(TestΣ|ExampleQuantity)$');
  assert.equal(normal.result.code, 0, normal.result.diagnostics || normal.result.output);
  const locations = readGoCaseLocations(normal.cases, cwd, selection, moduleName);
  const report = decodeGoPass(normal.result, readFileSync(normal.profile, 'utf8'), selection, moduleName, locations);
  assert.deepEqual(report.tests.map(({file, name, line}: {file: string; name: string; line: number}) => [file, name, line]), [
    ['one_test.go', `${moduleName}.TestΣ/desconto/10%#1`, 4], ['one_test.go', `${moduleName}.TestΣ`, 3],
    ['one_test.go', `${moduleName}.ExampleQuantity`, 8],
  ]);
  assert.equal(report.unattributed, 0);
  assert.deepEqual(report.coverage, {files: 1, statements: [1, 1]});

  const full = await execute('full', '^TestCap$');
  assert.equal(full.result.code, 0, full.result.diagnostics || full.result.output);
  assert.equal(readFileSync(join(cwd, 'business.txt'), 'utf8').trimEnd().split('\n').length, 199);
  rmSync(join(cwd, 'business.txt'));

  const over = await execute('over', '^(TestCap|TestAnotherPackage)$');
  assert.equal(over.result.code, 1, over.result.diagnostics || over.result.output);
  assert.throws(() => readGoCaseLocations(over.cases, cwd, selection, moduleName), /QA_LANGUAGE_TEST_LIMIT/);
  const otherRan = existsSync(join(cwd, 'other/business.txt'));
  const ran = readFileSync(join(cwd, 'business.txt'), 'utf8').trimEnd().split('\n').length;
  assert.equal(1 + ran + Number(otherRan), 200);
});
