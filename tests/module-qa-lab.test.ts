import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {appendFileSync, chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const qaModuleDir = fileURLToPath(new URL('../deploy/modules/qa/', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/module-qa/', import.meta.url));
const cleanFixtureDir = fileURLToPath(new URL('./fixtures/module-qa-clean/', import.meta.url));
const labEnabled = process.env.AC_MODULE_LAB === '1';

function readQaDigestPin(raw: string): string {
  const trimmed = raw.trim();
  if (/^sha256:[a-f0-9]{64}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^[A-Za-z0-9./:@_-]+@sha256:[a-f0-9]{64}$/.test(trimmed) && !trimmed.includes(':latest@')) {
    return trimmed;
  }
  throw new Error(`QA_IMAGE_DIGEST_INVALID: ${trimmed}`);
}

function runQaContainerByDigest(imagePin: string, repoPath: string) {
  const runtimeBin = process.env.AC_CONTAINER_RUNTIME_BIN ?? ['doc', 'ker'].join('');
  const args = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '128',
    '--memory',
    '536870912',
    '--memory-swap',
    '536870912',
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m',
    '--mount',
    `type=bind,src=${repoPath},dst=/repo,readonly`,
    imagePin,
  ];
  return spawnSync(runtimeBin, args, {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

test('digest pin valida formato sha256 imutavel e recusa tags soltas', () => {
  const validSha = `sha256:${'a'.repeat(64)}`;
  assert.equal(readQaDigestPin(`${validSha}\n`), validSha);
  assert.throws(() => readQaDigestPin('ac-module-qa:latest'), /QA_IMAGE_DIGEST_INVALID/);
  assert.throws(() => readQaDigestPin(''), /QA_IMAGE_DIGEST_INVALID/);
});

type Output = {
  coverage: {tool: string; status: string; detail: string}[];
  findings: {tool: string; rule: string; file: string; line: number; message: string; evidence: string}[];
};

const {classifyMutant, decodeNodeReport} = await import(
  new URL('../deploy/modules/qa/execute-tests.mjs', import.meta.url).href
);

function hasExpectedKilledMutant(output: Output): boolean {
  return output.coverage.some(c => c.tool.startsWith('qa-mutante:') && c.status === 'ok' &&
    /\bmorto\b.*src\/clean-pricing\.ts:2\b.*EqualityOperator.*valor > 100.*node:test reprovou tests\/clean-pricing\.test\.ts:5 'REQ-01: calcula desconto de fidelidade incluindo a fronteira exata de 100'.*após o patch/.test(c.detail));
}

test('prova do mutante exige patch e teste reprovado identificados, sem depender do código interno', () => {
  const detail = "morto / src/clean-pricing.ts:2 EqualityOperator → valor > 100 / node:test reprovou tests/clean-pricing.test.ts:5 'REQ-01: calcula desconto de fidelidade incluindo a fronteira exata de 100' (falha do teste) após o patch";
  const report: Output = {coverage: [{tool: 'qa-mutante:1', status: 'ok', detail}], findings: []};
  assert.equal(hasExpectedKilledMutant(report), true);
  for (const altered of [detail.replace('morto', 'sobrevivente'), detail.replace('valor > 100', 'valor < 100'),
    detail.replace('tests/clean-pricing.test.ts:5', 'tests/clean-pricing.test.ts:6'),
    detail.replace('node:test reprovou', 'node:test aprovou')]) {
    assert.equal(hasExpectedKilledMutant({...report, coverage: [{...report.coverage[0]!, detail: altered}]}), false);
  }
  assert.equal(hasExpectedKilledMutant({...report, coverage: [{...report.coverage[0]!, status: 'failed'}]}), false);
});

test('erros do executor e ausência de teste não classificam mutante como morto', () => {
  const file = 'tests/sintetico.test.ts';
  const testResult = {file, line: 5, column: 1, name: 'prova sintética', status: 'passed'};
  const baseline = {summary: true, tests: [testResult]};
  const decode = (report: object, code: number) => decodeNodeReport({code, output: JSON.stringify(report)}, [file], false);
  const failed = {summary: false, tests: [{...testResult, status: 'failed'}]};
  assert.equal(classifyMutant(baseline, decode(failed, 1)).status, 'morto');
  assert.equal(classifyMutant(baseline, decode(baseline, 0)).status, 'sobrevivente');
  for (const error of ['testTimeoutFailure', 'testCodeFailure', 'ERR_MODULE_NOT_FOUND', 'ERR_ACCESS_DENIED']) {
    const status = error.startsWith('ERR_') ? 'failed' : 'error';
    assert.throws(() => decode({summary: false, tests: [{...testResult, status, error}]}, 1), /QA_NODE_TEST_EXECUTION_FAILED/);
  }
  assert.throws(() => decode({summary: false, tests: []}, 1), /QA_NODE_TEST_EXECUTION_FAILED/);
  assert.throws(() => classifyMutant(baseline, {summary: true, tests: []}), /QA_MUTANT_TEST_SET_CHANGED/);
  assert.throws(() => decode(failed, 0), /QA_NODE_TEST_EXECUTION_FAILED/);
});

function collect(pin: string, directory: string): Output {
  const run = runQaContainerByDigest(pin, directory);
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const report = JSON.parse(lines[0]!) as Output;
  assert.deepEqual(report.coverage.filter(row => row.status === 'failed'), []);
  return report;
}

const row = (out: Output, tool: string) => {
  const result = out.coverage.find(row => row.tool === tool);
  assert.ok(result, tool);
  return result;
};

const passRows = (out: Output) => out.coverage.filter(row => row.tool === 'node-test-v8-execucao');

test('imagem pelo digest mede cobertura V8 e prova mutantes mortos e sobreviventes por execução', {skip: !labEnabled}, () => {
  const pin = readQaDigestPin(readFileSync(join(qaModuleDir, 'digest.txt'), 'utf8'));
  const defective = collect(pin, fixtureDir);
  assert.equal(row(defective, 'node-test-v8').status, 'ok');
  assert.equal(row(defective, 'stryker-mutator').status, 'ok');
  const passes = passRows(defective);
  assert.equal(passes.length, 3);
  for (let pass = 1; pass <= 3; pass++) {
    assert.match(passes[pass - 1]!.detail, new RegExp(`^execução ${pass}: node:test resultado aprovado; 8 aprovados, 0 reprovados, 1 pulados`));
  }
  assert.match(row(defective, 'qa-arquivo:src/defective-pricing.ts').detail, /V8 em três passadas: ramos [1-9]\/\d+/);
  assert.match(row(defective, 'qa-requisito:REQ-01').detail, /calcularDescontoFidelidade.*tests\/clean-pricing\.test\.ts:5.*passed,passed,passed/);

  const rules = new Set(defective.findings.map(f => f.rule));
  for (const rule of [
    'QA-COBERTURA-FUNCAO-SEM-TESTE', 'QA-STRYKER-MUTANTE-SOBREVIVENTE', 'QA-REQUISITO-SEM-PROVA',
    'QA-TESTE-PULADO', 'QA-TESTE-SEM-ASSERCAO',
    'QA-AXE-IMAGE-ALT', 'QA-AXE-BUTTON-NAME', 'QA-CONTRATO-ROTA-SEM-OPENAPI',
  ]) assert.ok(rules.has(rule), rule);

  assert.match(row(defective, 'qa-propriedades-funcionais').detail, /4 de 4 casos.*0 com reprovação/);
  assert.equal(row(defective, 'qa-fuzz').status, 'skipped');
  assert.ok(hasExpectedKilledMutant(defective));
  assert.ok(defective.findings.some(f => f.rule === 'QA-STRYKER-MUTANTE-SOBREVIVENTE' &&
    f.file === 'src/defective-pricing.ts' && f.line === 2 && f.evidence.includes('valor > 100') && f.evidence.includes('node:test aprovou')));
  assert.equal(defective.findings.some(f => f.file.includes('clean-')), false);

  const clean = collect(pin, cleanFixtureDir);
  assert.equal(row(clean, 'node-test-v8').status, 'ok');
  assert.match(row(clean, 'qa-propriedades-funcionais').detail, /4 de 4 casos.*0 com reprovação/);
  assert.match(row(clean, 'stryker-mutator').detail, /4 mortos, 0 sobreviventes/);
  assert.deepEqual(clean.findings, []);
});

test('imagem pelo digest registra teste realmente reprovado nas três passadas', {skip: !labEnabled}, () => {
  const pin = readQaDigestPin(readFileSync(join(qaModuleDir, 'digest.txt'), 'utf8'));
  const repo = mkdtempSync(join(tmpdir(), 'qa-failure-fixture-'));
  try {
    cpSync(cleanFixtureDir, repo, {recursive: true});
    chmodSync(repo, 0o755);
    const testFile = join(repo, 'tests/clean-pricing.test.ts');
    const failureLine = readFileSync(testFile, 'utf8').split('\n').length + 1;
    appendFileSync(testFile, `
test('prova sintética de desconto incorreto', () => {
  const valores = [100, 101];
  const descontos = valores.map(calcularDescontoFidelidade);
  assert.deepEqual(descontos, [100, 101]);
});
`);
    const output = collect(pin, repo);
    const passes = passRows(output);
    assert.equal(passes.length, 3);
    for (let pass = 1; pass <= 3; pass++) assert.match(passes[pass - 1]!.detail, new RegExp(`^execução ${pass}: node:test resultado reprovado;.*1 reprovados`));
    assert.equal(row(output, 'stryker-mutator').status, 'skipped');
    assert.ok(output.findings.some(f => f.rule === 'QA-TESTE-FALHOU' && f.file === 'tests/clean-pricing.test.ts' &&
      f.line === failureLine && f.message.includes('prova sintética de desconto incorreto') &&
      f.evidence.includes('failed, failed, failed')));
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});

test('JSON do coletor vincula a função realmente executada e respeita a resolução ESM', {skip: !labEnabled}, () => {
  const pin = readQaDigestPin(readFileSync(join(qaModuleDir, 'digest.txt'), 'utf8'));
  const repo = mkdtempSync(join(tmpdir(), 'qa-link-fixture-'));
  try {
    cpSync(cleanFixtureDir, repo, {recursive: true});
    chmodSync(repo, 0o755);
    writeFileSync(join(repo, 'src', 'pedido novo.mjs'), 'let total = 0; export function validar(x) { return x + ++total; }');
    writeFileSync(join(repo, 'src', 'pedido%20novo.mjs'), 'export function identidadeLiteral(x) { return x + 1; }');
    writeFileSync(join(repo, 'src', 'operacoes.mjs'), 'export function somar(x) { return x + 1; }\nexport function subtrair(x) { return x - 1; }\nexport async function buscar() { return 42; }');
    writeFileSync(join(repo, 'tests', 'vinculos.test.mjs'), [
      "import {test} from 'node:test'; import assert from 'node:assert/strict';",
      "import {validar} from '../src/pedido%20novo.mjs';",
      "import {identidadeLiteral} from '../src/pedido%2520novo.mjs';",
      "import {somar, subtrair, buscar} from '../src/operacoes.mjs';",
      "test('QA-VALIDADOR: contador', () => assert.equal(validar(0), 1));",
      "test('REQ-31 operação não exercida', () => { if (false) assert.equal(subtrair(1), 0); assert.equal(1 + 1, 2); });",
      "test('importa o nome com percentual', () => assert.equal(identidadeLiteral(1), 2));",
      "test('função assíncrona', async () => assert.equal(await buscar(), 42));",
      "test('operação exercida', () => assert.equal(somar(1), 2));",
    ].join('\n'));
    appendFileSync(join(repo, 'requisitos.md'), '\nREQ-31: `subtrair`\nREQ-32: `somar`\nREQ-33: `buscar`\nREQ-34: `identidadeLiteral`\nREQ-35: `somar` e `subtrair`\n');
    const report = collect(pin, repo);
    assert.equal(row(report, 'node-test-v8').status, 'ok');
    assert.match(row(report, 'qa-propriedades-funcionais').detail, /4 de 5 casos/);
    assert.match(row(report, 'qa-requisito:REQ-32').detail, /somar/);
    const unproved = report.findings.filter(f => f.rule === 'QA-REQUISITO-SEM-PROVA');
    assert.ok(unproved.some(f => f.message.includes('REQ-31')));
    for (const id of ['REQ-32', 'REQ-33', 'REQ-34']) assert.ok(!unproved.some(f => f.message.includes(id)), id);
    assert.ok(unproved.some(f => f.message.includes('REQ-35')));
  } finally { rmSync(repo, {recursive:true, force:true}); }
});
