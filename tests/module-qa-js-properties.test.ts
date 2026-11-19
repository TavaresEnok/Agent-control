import assert from 'node:assert/strict';
import {existsSync, rmSync} from 'node:fs';
import {test} from 'node:test';
import {
  arithmetic, arithmeticTestFile, propertyTest, stageJsPropertiesFixture, unitExample,
} from './fixtures/module-qa-js-properties.ts';

const {analyzeSourceFile, analyzeTestFile, collectQaModule, loadQaSyntax} = await import(
  new URL('../deploy/modules/qa/collect.mjs', import.meta.url).href
);
const {measureProperty} = await import(new URL('../deploy/modules/qa/js-properties.mjs', import.meta.url).href);
const qaTools = new URL('../deploy/modules/qa/node_modules/', import.meta.url);
const realTools = {skip: !['@babel/parser', '@babel/traverse', 'fast-check'].every(name =>
  existsSync(new URL(`${name}/package.json`, qaTools))) && 'instale as dependências fixadas de deploy/modules/qa'};
const fc = realTools.skip ? undefined : await import(new URL('fast-check/lib/fast-check.js', qaTools).href);
const syntax = realTools.skip ? undefined : await loadQaSyntax();

test('fast-check real conta chamadas, encerra na falsificação e reproduz pelo caminho', realTools, () => {
  const plan = {integers: [{min: -10, max: 10}, {min: -10, max: 10}], seed: 42, numRuns: 32};
  const add = (a: number, b: number) => a + b;
  const defectiveAdd = (a: number, b: number) => b === 3 ? a - b : a + b;
  let invocations = 0;
  const approved = measureProperty(fc, plan, (a: number, b: number) => {
    invocations++;
    return Object.is(add(a, b), b + a);
  });
  assert.deepEqual(approved, {version: '4.10.3', calls: 32, counterexample: null, path: null});
  assert.equal(invocations, 32);

  const property = (a: number, b: number) => Object.is(defectiveAdd(a, b), a + b);
  const falsified = measureProperty(fc, plan, property);
  assert.deepEqual(falsified, {version: '4.10.3', calls: 27, counterexample: [-6, 3], path: '26'});
  assert.deepEqual(measureProperty(fc, plan, property), falsified);
  assert.deepEqual(measureProperty(fc, plan, property, falsified.path), {...falsified, calls: 1});
  assert.equal(measureProperty(fc, {...plan, numRuns: 26}, property).counterexample, null);
  assert.throws(() => measureProperty(fc, plan, () => { throw new TypeError('falha sintética'); }), /UNMEASURED/);
});

test('a declaração liga a comparação, o teste e a exportação local com aliases', realTools, () => {
  const result = analyzeTestFile(arithmeticTestFile, propertyTest, syntax);
  assert.equal(result.jsPropertyDeclarations, 1);
  assert.equal(result.assertionFreeTests.length, 0);
  assert.deepEqual(result.jsProperties, [{
    integers: [{min: -10, max: 10}, {min: -10, max: 10}], seed: 42, numRuns: 32,
    operands: ['add(a, b)', 'a + b'], operator: 'strictEqual', params: ['a', 'b'],
    target: {source: 'arithmetic.ts', name: 'sum', local: 'add', arity: 2, receiver: undefined, optional: false},
    file: arithmeticTestFile, testLine: 6, line: 7, column: 3,
  }]);
  const importedMethods = propertyTest.replace("import fc from 'fast-check';", "import {assert as check, property as law, integer as int} from 'fast-check';")
    .replace('fc.assert(fc.property(', 'check(law(').replaceAll('fc.integer', 'int')
    .replace('assert.strictEqual(add(a, b), a + b)', 'add(a, b) === add(b, a)')
    .replace(', {seed: 42, numRuns: 32}', '');
  const [commutativity] = analyzeTestFile(arithmeticTestFile, importedMethods, syntax).jsProperties;
  assert.equal(commutativity.operator, '===');
  assert.deepEqual(commutativity.operands, ['add(a, b)', 'add(b, a)']);
  assert.equal(commutativity.seed, 20261119);
  assert.equal(commutativity.numRuns, 32);

  const [sum] = analyzeSourceFile('arithmetic.ts', arithmetic, syntax).functions;
  assert.deepEqual(sum.propertyTarget, {arity: 2, code: arithmetic.trim().slice('export '.length)});
  const arrow = '(left: number, right: number) => left + right';
  const [arrowSum] = analyzeSourceFile('arithmetic.ts', `const add = ${arrow}; export {add as sum};`, syntax).functions;
  assert.deepEqual(arrowSum.propertyTarget, {arity: 2, code: arrow});
  assert.deepEqual(arrowSum.exportNames, ['sum']);
  const [withState] = analyzeSourceFile('arithmetic.ts', `const offset = 1;\n${arithmetic.replace('left + right', 'left + right + offset')}`, syntax).functions;
  assert.equal(withState.propertyTarget, undefined);
});

test('exemplos, skips, geradores e configurações fora do contrato ficam sem propriedade elegível', realTools, () => {
  const unsupported = [
    propertyTest.replace("test('soma", "test.skip('soma"),
    propertyTest.replace("test('soma", "test.only('soma"),
    propertyTest.replace('{seed: 42, numRuns: 32}', '{seed: 42, numRuns: 129}'),
    propertyTest.replace('{seed: 42, numRuns: 32}', "{seed: 42, numRuns: 32, path: '0'}"),
    propertyTest.replace('min: -10, max: 10', 'min: 2, max: 2'),
    propertyTest.replace('min: -10, max: 10', 'min: -10, max: upperBound'),
    propertyTest.replace('fc.property', 'fc.asyncProperty'),
    propertyTest.replace('assert.strictEqual(add(a, b), a + b)', 'true'),
    propertyTest.replace('add(a, b)', 'add(2, 2)'),
    propertyTest.replace('add(a, b)', 'add(...[a, b])'),
    propertyTest.replace('a + b)),', 'unknown(a, b))),'),
    propertyTest.replace('  fc.assert', '  if (false) fc.assert'),
    propertyTest.replace('fc.assert', 'fc.check'),
  ];
  for (const source of unsupported) {
    const result = analyzeTestFile(arithmeticTestFile, source, syntax);
    assert.equal(result.jsPropertyDeclarations, 1, source);
    assert.deepEqual(result.jsProperties, [], source);
  }
  const example = analyzeTestFile(arithmeticTestFile, unitExample, syntax);
  assert.equal(example.jsPropertyDeclarations, 0);
  assert.deepEqual(example.jsProperties, []);
  const shadowed = analyzeTestFile(arithmeticTestFile, propertyTest.replace('  fc.assert', '  const fc = {};\n  fc.assert'), syntax);
  assert.equal(shadowed.jsPropertyDeclarations, 0);
});

test('coletor distingue ausência, fonte impura e propriedade elegível fora do contêiner', realTools, async () => {
  const impure = `const offset = 1;\n${arithmetic.replace('left + right', 'left + right + offset')}`;
  for (const {source, declared, detail} of [
    {source: arithmetic, declared: false, detail: /0\/0.*nenhuma propriedade/},
    {source: impure, declared: true, detail: /0\/1.*1 sem forma elegível ou função local pura/},
    {source: arithmetic, declared: true, detail: /0\/1.*1 elegíveis, execução reservada ao contêiner isolado/},
  ]) {
    const repoDir = stageJsPropertiesFixture(source, declared);
    try {
      const output = await collectQaModule({repoDir});
      const row = output.coverage.find((item: {tool: string}) => item.tool === 'fast-check');
      assert.equal(row?.status, 'skipped');
      assert.equal(row.version, 'não aferida');
      assert.match(row.detail, detail);
      assert.equal(output.coverage.some((item: {tool: string}) => item.tool.startsWith('qa-propriedade:fast-check')), false);
      assert.equal(output.findings.some((item: {tool: string}) => item.tool === 'fast-check'), false);
    } finally {
      rmSync(repoDir, {recursive: true, force: true});
    }
  }
});
