import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test, type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';

const {
  collectLanguageSuite, decodeGoPass, decodePythonPass, executeLanguagePass, loadLanguageSnapshot, measureLanguageSuite,
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
    '.git/HEAD': 'metadado sintético',
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

test('insumos protegidos na árvore tornam o snapshot parcial e impedem materialização', t => {
  for (const protectedFile of [
    'tests/fixtures/auth.json', 'testdata/build/quantity.txt', '.env.test', 'testdata/signing.PEM', '.docker/config.json',
    '.envrc', 'fixtures/SERVICE-ACCOUNT.json', 'config/service-account-build.json',
  ]) {
    const repo = fixture(t, {
      'test_arithmetic.py': 'import unittest\n',
      'go.mod': 'module example.invalid/qa\n',
      'total_test.go': 'package total\n',
      [protectedFile]: 'placeholder sintético',
    });
    assert.deepEqual(loadLanguageSnapshot(repo), {
      reason: 'escopo parcial por insumos omitidos pela proteção do snapshot',
    });
  }
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
    'test_pytest_helper.py': `import unittest
from pytest import raises
class UnitWithHelper(unittest.TestCase):
    def test_value(self):
        with raises(ValueError):
            int("fixture")
`,
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

  const helperFiles = ['test_pytest_helper.py'];
  const missingHelper = await execute(helperFiles);
  assert.equal(missingHelper.unavailable, 1);
  assert.equal(missingHelper.unsupported, 0);
  assert.equal(missingHelper.errors, 0);
  assert.deepEqual(missingHelper.tests, []);
  const helperSuite = await measureLanguageSuite('python', selectLanguageSuite('python', helperFiles, false), async () => missingHelper);
  assert.equal(helperSuite.coverageRow.status, 'skipped');
  assert.match(helperSuite.coverageRow.detail, /dependência indisponível/);
  assert.doesNotMatch(helperSuite.coverageRow.detail, /formato pytest/);

  const pytestFiles = ['test_style.py', 'test_style_class.py'];
  const pytest = await execute(pytestFiles);
  assert.equal(pytest.unsupported, 2);
  assert.equal(pytest.unavailable, 0);
  assert.deepEqual(pytest.tests, []);
  assert.equal(pytest.coverage, null);
  const suite = await measureLanguageSuite('python', selectLanguageSuite('python', pytestFiles, false), async () => pytest);
  assert.equal(suite.coverageRow.status, 'skipped');
  assert.match(suite.coverageRow.detail, /formato pytest não suportado/);
  assert.match(suite.extraRows[0].detail, /2 arquivos com formato pytest não suportado/);

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
  const locations = new Map(['TestΣ_1', 'TestΣ_1/A::10/mínimo#01', 'TestΣ_1/B+10'].map(name =>
    [`${moduleName}\0${name}`, {file: 'two_test.go', line: 7}]));
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

test('Go mantém resultados do pacote e a cobertura quando falta a origem do caso', async () => {
  const selection = selectLanguageSuite('go', ['go.mod', 'total.go', 'one_test.go'], false);
  const profile = `mode: set\n${moduleName}/total.go:1.1,2.1 2 1\n`;
  const decode = (code: number, events: {Action: string; Test?: string}[], locations = new Map()) => decodeGoPass({
    code, output: events.map(event => JSON.stringify({Package: moduleName, ...event})).join('\n'), diagnostics: '',
  }, profile, selection, moduleName, locations);
  const failed = decode(1, [{Action: 'fail', Test: 'TestBusiness'}, {Action: 'fail'}]);
  assert.equal(failed.tests[0].file, null);
  assert.equal(failed.tests[0].line, null);
  assert.deepEqual(failed.coverage, {files: 1, statements: [2, 2]});
  const complete = await measureLanguageSuite('go', selection, async () => failed);
  assert.equal(complete.coverageRow.status, 'ok');
  assert.match(complete.coverageRow.detail, /1 caso com falha ou oscilação/);
  assert.deepEqual(complete.findings, []);
  assert.match(complete.extraRows[4].detail,
    /pacote Go "example\.invalid\/qa\/total"; 1 caso com falha ou oscilação sem arquivo identificado; reprovações por execução \(1: 1, 2: 1, 3: 1\)/);

  const approved = decode(0, [{Action: 'pass', Test: 'TestBusiness'}, {Action: 'pass'}]);
  const interrupted = decode(1, [
    {Action: 'fail', Test: 'TestPartial'}, {Action: 'run', Test: 'TestInterrupted'}, {Action: 'fail'},
  ]);
  const passes = [failed, approved, interrupted];
  const partial = await measureLanguageSuite('go', selection, async () => passes.shift());
  assert.equal(partial.coverageRow.status, 'failed');
  assert.match(partial.coverageRow.detail, /erro na execução; 2 casos com falha ou oscilação/);
  assert.deepEqual(partial.findings, []);
  assert.equal(partial.extraRows[3].status, 'skipped');
  assert.match(partial.extraRows[3].detail, /escopo parcial.*3: statements 2\/2/);
  assert.equal(partial.extraRows[4].tool, complete.extraRows[4].tool);
  assert.match(partial.extraRows[4].detail, /2 casos.*reprovações por execução \(1: 1, 2: 0, 3: 1 \(parcial\)\)/);

  const located = decode(0, [{Action: 'pass', Test: 'TestBusiness'}, {Action: 'pass'}],
    new Map([[`${moduleName}\0TestBusiness`, {file: 'one_test.go', line: 7}]]));
  const mixed = [located, failed, located];
  const inconsistent = await measureLanguageSuite('go', selection, async () => mixed.shift());
  assert.match(inconsistent.coverageRow.detail, /1 caso com falha ou oscilação; atribuição parcial/);
  assert.deepEqual(inconsistent.findings, []);
  assert.match(inconsistent.extraRows[4].detail, /1 caso.*reprovações por execução \(1: 0, 2: 1, 3: 0\)/);
});

const go = process.env.QA_R2_TEST_GO ?? '/usr/local/go/bin/go';
const incompatibleGo = process.env.QA_R3_TEST_GO_INCOMPATIBLE ?? '/usr/lib/go-1.22/bin/go';
const lock = JSON.parse(readFileSync(new URL('../deploy/modules/qa/qa-tools.lock.json', import.meta.url), 'utf8'));
const expectedGoVersion = `go${lock.languageRuntimes.go.version}`;

async function readGoVersion(t: TestContext, binary: string) {
  const cwd = fixture(t, {});
  const result = await runLanguageProcess(binary, ['env', 'GOVERSION'], cwd, {
    timeoutMs: 10_000, env: {HOME: cwd, GOENV: 'off', GOTOOLCHAIN: 'local'},
  });
  assert.equal(result.code, 0, result.diagnostics);
  return result.output.trim();
}

async function assertRejectedGoVersion(binary: string) {
  const snapshot = {copyTo() { assert.fail('a versão incompatível deve parar antes da cópia'); }};
  const selection = selectLanguageSuite('go', ['go.mod', 'total_test.go'], false);
  const pass = await executeLanguagePass('go', snapshot, selection, binary);
  assert.deepEqual(pass, {tests: [], unavailable: 1, errors: 0, coverage: null, fixtureSkips: 0,
    reason: 'versão Go fixada indisponível'});
}

test('o adaptador exige a versão Go fixada por inteiro', async t => {
  const root = fixture(t, {
    'go': `#!/bin/sh\nprintf '%s\\n' '${expectedGoVersion}0'\n`,
  });
  const binary = join(root, 'go');
  chmodSync(binary, 0o700);
  assert.equal(await readGoVersion(t, binary), `${expectedGoVersion}0`);
  await assertRejectedGoVersion(binary);
});

test('o adaptador exige que a consulta de GOVERSION termine com sucesso', async t => {
  const root = fixture(t, {
    'go': `#!/bin/sh\nprintf '%s\\n' '${expectedGoVersion}'\nexit 1\n`,
  });
  const binary = join(root, 'go');
  chmodSync(binary, 0o700);
  await assertRejectedGoVersion(binary);
});

test('o adaptador recusa um executável Go real de versão incompatível', {
  skip: !existsSync(incompatibleGo),
}, async t => {
  const version = await readGoVersion(t, incompatibleGo);
  assert.match(version, /^go[1-9]\d*\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)|(?:beta|rc)[1-9]\d*)?$/);
  assert.notEqual(version, expectedGoVersion);
  await assertRejectedGoVersion(incompatibleGo);
});

test('o Go fixado mede por pacote um subteste sem recibo de arquivo de teste', {
  skip: !existsSync(go), timeout: 45_000,
}, async t => {
  assert.equal(await readGoVersion(t, go), expectedGoVersion);
  const repo = fixture(t, {
    'go.mod': `module ${moduleName}\n\ngo 1.27\n`,
    'quantity.go': `package total
import "testing"
func checkQuantity(t *testing.T) { t.Error("quantidade diferente") }
`,
    'quantity_test.go': `package total
import "testing"
func TestQuantity(t *testing.T) { t.Run("valor", checkQuantity) }
`,
  });
  const snapshot = loadLanguageSnapshot(repo);
  const selection = selectLanguageSuite('go', snapshot.files, false);
  const pass = await executeLanguagePass('go', snapshot, selection, go);
  assert.equal(pass.errors, 0);
  assert.equal(pass.unavailable, 0);
  assert.deepEqual(pass.tests.map(({file, line, name, status}: {file: string | null; line: number | null; name: string; status: string}) =>
    [file, line, name, status]), [
    [null, null, `${moduleName}.TestQuantity/valor`, 'failed'],
    ['quantity_test.go', 3, `${moduleName}.TestQuantity`, 'failed'],
  ]);
  assert.deepEqual(pass.coverage, {files: 1, statements: [1, 1]});
  const suite = await measureLanguageSuite('go', selection, async () => pass);
  assert.equal(suite.findings.length, 1);
  assert.match(suite.findings[0].message, /Teste '.*\.TestQuantity' falhou/);
  assert.match(suite.extraRows[4].detail, /1 caso com falha ou oscilação sem arquivo identificado.*\(1: 1, 2: 1, 3: 1\)/);
});

test('Go fixado usa o dado de embed, atribui arquivos e nega a entrada ao 201º caso', {
  skip: !existsSync(go), timeout: 100_000,
}, async t => {
  assert.equal(await readGoVersion(t, go), expectedGoVersion);
  const scratch = fixture(t, {});
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
func TestWrongQuantity(t *testing.T) {
    if Quantity() != "21\\n" { t.Fatal("quantidade diferente") }
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
  const snapshot = loadLanguageSnapshot(original);
  const cwd = join(scratch, 'project');
  snapshot.copyTo(cwd);
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

  const failed = await execute('failed', '^TestWrongQuantity$');
  assert.equal(failed.result.code, 1, failed.result.diagnostics || failed.result.output);
  const noLocation = decodeGoPass(failed.result, null, selection, moduleName);
  assert.equal(noLocation.errors, 0);
  assert.equal(noLocation.tests[0].file, null);
  assert.equal(noLocation.tests[0].package, moduleName);
  assert.equal(noLocation.tests[0].status, 'failed');

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
