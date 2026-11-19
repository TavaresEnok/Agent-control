import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {moduleCollectorArguments, parseModuleCollectorOutput, readPinnedModuleImage, validateModuleCollectorObject} from '../src/verification-modules.ts';
import {arithmetic, arithmeticTestFile, defectiveArithmetic, stageJsPropertiesFixture} from './fixtures/module-qa-js-properties.ts';

test('a imagem de QA mede propriedades locais e reproduz a falsificação aritmética offline', {
  skip: process.env.AC_MODULE_LAB !== '1', timeout: 360_000,
}, async () => {
  const image = await readPinnedModuleImage('qa');
  async function collect(source: string, withProperty: boolean) {
    const repository = stageJsPropertiesFixture(source, withProperty);
    try {
      const [runtime, run, ...args] = moduleCollectorArguments({image, repository});
      const {stdout} = await promisify(execFile)(runtime!, [run!, '--pull=never', ...args], {
        encoding: 'buffer', timeout: 80_000, maxBuffer: 8 * 1024 * 1024,
      });
      const report = parseModuleCollectorOutput(stdout, {module: 'qa'});
      const summary = report.coverage.find(row => row.tool === 'fast-check');
      assert.ok(summary);
      assert.deepEqual(report.coverage.filter(row => row.status === 'failed'), []);
      const properties = report.coverage.filter(row => row.tool.startsWith('qa-propriedade:fast-check:'));
      const findings = report.findings.filter(finding => finding.tool === 'fast-check');
      return {summary, properties, findings, coverage: report.coverage};
    } finally {
      await rm(repository, {recursive: true, force: true});
    }
  }

  const control = await collect(arithmetic, true);
  assert.equal(control.summary.version, '4.10.3');
  assert.equal(control.summary.status, 'ok');
  assert.match(control.summary.detail, /1\/1 propriedades medidas \(1 aprovadas, 0 falsificadas\).*32 chamadas/);
  assert.equal(control.properties.length, 1);
  assert.match(control.properties[0]!.detail, /aprovada em 32 chamadas, semente 42, limite 32.*teste tests\/arithmetic\.test\.mjs:6, propriedade 7:3, função sum em arithmetic\.ts:1/);
  assert.deepEqual(control.findings, []);

  const defect = await collect(defectiveArithmetic, true);
  assert.equal(defect.summary.status, 'ok');
  assert.match(defect.summary.detail, /1\/1 propriedades medidas \(0 aprovadas, 1 falsificadas\).*27 chamadas/);
  assert.equal(defect.findings.length, 1);
  assert.equal(defect.findings[0]!.file, arithmeticTestFile);
  assert.equal(defect.findings[0]!.line, 7);
  assert.equal(defect.findings[0]!.rule, 'QA-FASTCHECK-PROPRIEDADE-VIOLADA');
  assert.match(defect.findings[0]!.evidence, /falsificada em 27 chamadas, semente 42, limite 32, caminho 26, contraexemplo \[-6,3\].*função sum em arithmetic\.ts:1/);
  const repeated = await collect(defectiveArithmetic, true);
  assert.deepEqual(repeated.properties, defect.properties);
  assert.deepEqual(repeated.findings, defect.findings);

  const example = await collect(arithmetic, false);
  assert.equal(example.summary.status, 'skipped');
  assert.match(example.summary.detail, /0\/0 declarações medidas/);
  assert.deepEqual(example.properties, []);
  assert.deepEqual(example.findings, []);
  assert.equal(example.coverage.find(row => row.tool === 'node-test-v8')?.status, 'ok');
});

test('somente a combinação pública de módulo, ferramenta e regra conserva seu identificador longo', () => {
  const rule = 'QA-FASTCHECK-PROPRIEDADE-VIOLADA';
  const result = (module: 'qa' | 'banco', tool: string, identifier: string) => validateModuleCollectorObject({
    coverage: [{tool, version: '1', status: 'ok', detail: 'Fixture local.'}],
    findings: [{tool, rule: identifier, file: 'src/demo.ts', line: 1, severity: 'media', message: 'Fixture local.', evidence: 'Linha 1.'}],
  }, module).findings[0]!.rule;
  assert.equal(result('qa', 'fast-check', rule), rule);
  for (const altered of [result('banco', 'fast-check', rule), result('qa', 'outro', rule), result('qa', 'fast-check', rule + '-PRIVADO')]) {
    assert.equal(altered, '[removido: alta entropia]');
  }
});
