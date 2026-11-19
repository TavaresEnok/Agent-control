import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {appendFileSync, chmodSync, cpSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const qaModuleDir = fileURLToPath(new URL('../deploy/modules/qa/', import.meta.url));
const fixtureDir = fileURLToPath(new URL('./fixtures/module-qa/', import.meta.url));
const cleanFixtureDir = fileURLToPath(new URL('./fixtures/module-qa/clean/', import.meta.url));
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
  findings: {tool: string; rule: string; file: string; line: number; evidence: string}[];
};

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

test('imagem pelo digest mede cobertura V8 e prova mutantes mortos e sobreviventes por execução', {skip: !labEnabled}, () => {
  const pin = readQaDigestPin(readFileSync(join(qaModuleDir, 'digest.txt'), 'utf8'));
  const defective = collect(pin, fixtureDir);
  assert.equal(row(defective, 'node-test-v8').status, 'ok');
  assert.equal(row(defective, 'stryker-mutator').status, 'ok');
  for (let pass = 1; pass <= 3; pass++) {
    assert.match(row(defective, `qa-passada:${pass}`).detail, /passou.*4 aprovados, 0 reprovados, 1 pulados/);
  }
  assert.match(row(defective, 'qa-arquivo:src/defective-pricing.ts').detail, /V8 em três passadas: ramos [1-9]\/\d+/);
  assert.match(row(defective, 'qa-requisito:REQ-01').detail, /calcularDescontoFidelidade.*tests\/clean-pricing\.test\.ts:5.*passed,passed,passed/);

  const rules = new Set(defective.findings.map(f => f.rule));
  for (const rule of [
    'QA-COBERTURA-FUNCAO-SEM-TESTE', 'QA-STRYKER-MUTANTE-SOBREVIVENTE', 'QA-REQUISITO-SEM-PROVA',
    'QA-FASTCHECK-PROPRIEDADE-VIOLADA', 'QA-TESTE-PULADO', 'QA-TESTE-SEM-ASSERCAO',
    'QA-AXE-IMAGE-ALT', 'QA-AXE-BUTTON-NAME', 'QA-CONTRATO-ROTA-SEM-OPENAPI',
  ]) assert.ok(rules.has(rule), rule);

  const mutantRows = defective.coverage.filter(c => c.tool.startsWith('qa-mutante:'));
  assert.ok(mutantRows.some(c => /morto .*src\/clean-pricing\.ts:2 .*node:test reprovou .*ERR_ASSERTION/.test(c.detail)));
  assert.ok(defective.findings.some(f => f.rule === 'QA-STRYKER-MUTANTE-SOBREVIVENTE' &&
    f.file === 'src/defective-pricing.ts' && f.line === 2 && f.evidence.includes('valor > 100') && f.evidence.includes('node:test aprovou')));
  assert.equal(defective.findings.some(f => f.file.includes('clean-')), false);

  const clean = collect(pin, cleanFixtureDir);
  assert.equal(row(clean, 'node-test-v8').status, 'ok');
  assert.match(row(clean, 'stryker-mutator').detail, /4 mortos, 0 sobreviventes/);
  assert.deepEqual(clean.findings, []);
});

test('imagem pelo digest registra teste realmente reprovado nas três passadas', {skip: !labEnabled}, () => {
  const pin = readQaDigestPin(readFileSync(join(qaModuleDir, 'digest.txt'), 'utf8'));
  const repo = mkdtempSync(join(tmpdir(), 'qa-failure-fixture-'));
  try {
    cpSync(cleanFixtureDir, repo, {recursive: true});
    chmodSync(repo, 0o755);
    appendFileSync(join(repo, 'tests/clean-pricing.test.ts'), `
test('prova sintética de desconto incorreto', () => {
  const valores = [100, 101];
  const descontos = valores.map(calcularDescontoFidelidade);
  assert.deepEqual(descontos, [100, 101]);
});
`);
    const output = collect(pin, repo);
    for (let pass = 1; pass <= 3; pass++) assert.match(row(output, `qa-passada:${pass}`).detail, /falhou.*1 reprovados/);
    assert.equal(row(output, 'stryker-mutator').status, 'skipped');
    assert.ok(output.findings.some(f => f.rule === 'QA-TESTE-FALHOU' && f.file === 'tests/clean-pricing.test.ts' &&
      f.evidence.includes('failed, failed, failed') && f.evidence.includes('ERR_ASSERTION')));
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});
