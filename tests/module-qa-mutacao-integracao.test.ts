import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
// @ts-expect-error The collector modules are native JavaScript.
import {publishMutation, publishProperties} from '../deploy/modules/qa/mutacao-linguagens/report.mjs';
// @ts-expect-error The collector modules are native JavaScript.
import {verifyQaLockfiles} from '../deploy/modules/qa/verify-lock.mjs';

type Row = {tool: string; version: string; status: string; detail: string};
type Finding = {tool: string; rule: string; file: string; line: number; evidence: string};
type Output = {coverage: Row[]; findings: Finding[]};
const row = (tool: string, version: string, status: string, detail: string): Row => ({tool, version, status, detail});
const pathLabel = (file: string) => file;
const moduleDir = fileURLToPath(new URL('../deploy/modules/qa/', import.meta.url));
const languageFixture = fileURLToPath(new URL('./fixtures/module-qa-mutacao-linguagens/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(moduleDir, 'qa-tools.lock.json'), 'utf8'));

test('entrypoint publica ferramentas novas e preserva linhas das suítes no modo sintético', () => {
  const collect = (failTool?: string): Output => {
    const execution = spawnSync('/bin/sh', [join(moduleDir, 'entrypoint.sh')], {
      env: {PATH: process.env.PATH, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: languageFixture, QA_FAIL_TOOL: failTool},
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(execution.status, 0, execution.error?.message ?? execution.stderr);
    assert.equal(execution.stdout.trimEnd().split('\n').length, 1);
    return JSON.parse(execution.stdout);
  };
  const healthy = collect();
  const fault = collect('hypothesis');
  const results = new Map(healthy.coverage.map(item => [item.tool, item]));
  const {python, go} = manifest.languageMeasurements;
  for (const [tool, version] of [['mutmut', python.versions.mutmut], ['go-mutesting', go.version],
    ['hypothesis', python.versions.hypothesis]] as [string, string][]) {
    assert.equal(results.get(tool)?.status, 'skipped');
    assert.equal(results.get(tool)?.version, version);
    assert.match(results.get(tool)?.detail ?? '', /contêiner isolado/);
  }
  for (const tool of ['python-unittest-coverage', 'go-test-cover', 'qa-navegador']) {
    assert.equal(results.get(tool)?.status, 'skipped');
    assert.deepEqual(fault.coverage.find(item => item.tool === tool), results.get(tool));
  }
  assert.deepEqual(fault.coverage.filter(item => item.status === 'failed').map(item => item.tool), ['hypothesis']);
  assert.deepEqual(healthy.findings, []);
  assert.deepEqual(fault.findings, []);
});

test('publica mutações medidas e separa compilação do mutante, referência reprovada e falha operacional', () => {
  const edit = {file: 'go/arithmetic.go', line: 3, column: 6, before: '+', after: '-'};
  const report = {
    tool: 'go-mutesting', version: '1.0.0', seed: 42, status: 'partial', omittedTests: 0,
    baseline: {status: 'passed', passed: 1}, candidates: 4, killed: 1, survived: 1, notRun: 2,
    unselected: 0, omittedSources: 0, truncated: false,
    mutants: [
      {...edit, status: 'killed', killedBy: {package: 'qa.local/arithmetic', name: 'TestExample/dados-sinteticos'}},
      {...edit, line: 4, status: 'survived'},
      {...edit, line: 5, status: 'not-run', reason: 'go-build-failed'},
      {...edit, line: 6, status: 'not-run', reason: 'process-timeout'},
    ],
  };
  const measured = publishMutation(report, row, pathLabel);
  assert.equal(measured.coverageRow.status, 'ok');
  assert.match(measured.coverageRow.detail, /medição parcial.*4 candidatos enumerados, 1 mortos, 1 sobreviventes, 2 sem classificação/);
  assert.deepEqual(measured.extraRows.map((item: Row) => item.status), ['ok', 'ok', 'skipped', 'failed']);
  assert.match(measured.extraRows[0].detail, /go\/arithmetic\.go:3:6 operador \+ → -.*caso [a-f0-9]{16}.*reprovou/);
  assert.doesNotMatch(JSON.stringify(measured), /dados-sinteticos|qa\.local/);
  assert.equal(measured.findings.length, 1);
  assert.equal(measured.findings[0].file, 'go/arithmetic.go');
  assert.equal(measured.findings[0].line, 4);
  assert.match(measured.findings[0].evidence, /go\/arithmetic\.go:4:6 operador \+ → -/);

  const referenceFailure = publishMutation({
    ...report, status: 'not-run', killed: 0, survived: 0, notRun: 4,
    baseline: {status: 'failed', failed: 1, reason: 'baseline-failed'},
    mutants: report.mutants.map(mutant => ({...mutant, status: 'not-run', reason: 'baseline-failed'})),
  }, row, pathLabel);
  assert.match(referenceFailure.coverageRow.detail, /sem medição.*suíte de referência reprovada/);
  assert.equal(referenceFailure.coverageRow.status, 'skipped');
  assert.deepEqual(referenceFailure.findings, []);
  assert.ok(referenceFailure.extraRows.every((item: Row) => item.status === 'skipped'));

  const interrupted = publishMutation({
    ...report, status: 'not-run', killed: 0, survived: 0, notRun: 4,
    mutants: report.mutants.map(mutant => ({...mutant, status: 'not-run', reason: 'process-timeout'})),
  }, row, pathLabel);
  assert.equal(interrupted.coverageRow.status, 'failed');
  assert.match(interrupted.coverageRow.detail, /falha operacional/);
  assert.deepEqual(interrupted.findings, []);
});

test('propriedades publicam evidência limitada e preservam falsificação durante falha operacional', () => {
  const property = {file: 'test_arithmetic.py', line: 10, examples: 4, status: 'failed', id: 'a'.repeat(64)};
  const report = {
    tool: 'hypothesis', version: '1.0.0', seed: 42, status: 'partial', reason: 'python-test-execution',
    properties: [
      ...Array.from({length: 55}, (_, index) => ({...property, line: 10 + index, diagnostics: 'dados sintéticos'})),
      {...property, status: 'error'},
      {...property, status: 'passed', examples: 10},
    ],
  };
  const output = publishProperties(report, row, pathLabel);
  assert.equal(output.coverageRow.status, 'ok');
  assert.match(output.coverageRow.detail, /medição parcial.*56\/57 propriedades medidas \(1 aprovadas, 55 falsificadas\)/);
  assert.match(output.coverageRow.detail, /230 chamadas.*5 achados fora do limite/);
  assert.equal(output.extraRows[0].status, 'failed');
  assert.match(output.extraRows[0].detail, /falha operacional/);
  assert.equal(output.findings.length, 50);
  assert.equal(output.findings[0].rule, 'QA-PROPRIEDADE-FALSIFICADA');
  assert.match(output.findings[0].evidence, /test_arithmetic\.py:10.*reprovou por asserção após 4 chamadas.*42/);
  assert.doesNotMatch(JSON.stringify(output), /dados sintéticos/);
  const terminal = publishProperties({...report, status: 'not-run', properties: []}, row, pathLabel);
  assert.equal(terminal.coverageRow.status, 'failed');
  assert.deepEqual(terminal.findings, []);
});

test('lock novo verifica integridade Python e Go e o Dockerfile usa os três estágios', () => {
  const temp = mkdtempSync(join(tmpdir(), 'qa-language-lock-'));
  try {
    const pythonLock = 'mutacao-linguagens/requirements.lock';
    const goMod = 'mutacao-linguagens/go-mutesting/go.mod';
    const goSum = 'mutacao-linguagens/go-mutesting/go.sum';
    mkdirSync(join(temp, 'mutacao-linguagens/go-mutesting'), {recursive: true});
    for (const file of ['package.json', 'package-lock.json', 'qa-tools.lock.json', pythonLock, goMod, goSum]) {
      cpSync(join(moduleDir, file), join(temp, file));
    }
    assert.equal(verifyQaLockfiles(temp).ok, true);
    for (const file of [pythonLock, goMod, goSum]) {
      appendFileSync(join(temp, file), '\n');
      assert.throws(() => verifyQaLockfiles(temp), /QA_LANGUAGE_MEASUREMENT_LOCK_MISMATCH/);
      cpSync(join(moduleDir, file), join(temp, file));
    }
    const dockerfile = readFileSync(join(moduleDir, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /AS qa-python[\s\S]+install\.sh python \/opt\/qa-mutation-python\n\nFROM .* AS qa-go/);
    assert.match(dockerfile, /AS qa-go[\s\S]+install\.sh go \/opt\/go-mutesting-plan\n[\s\S]+FROM .*playwright:/);
    assert.match(dockerfile, /COPY --from=qa-python .*\/mutacao-linguagens\/python-deps/);
    assert.match(dockerfile, /COPY --from=qa-go .*\/mutacao-linguagens\/go-mutesting-plan/);
    assert.match(dockerfile, /verify-lock\.mjs --language-tools-installed\n\nUSER 65532:65532/);
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }
});
