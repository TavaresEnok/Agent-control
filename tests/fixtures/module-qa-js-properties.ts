import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export const arithmetic = `export function sum(left: number, right: number): number {
  return left + right;
}
`;

export const defectiveArithmetic = arithmetic.replace('return left + right;', 'return right === 3 ? left - right : left + right;');

export const propertyTest = `import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {sum as add} from '../arithmetic.ts';

test('soma corresponde ao operador aritmético', () => {
  fc.assert(fc.property(fc.integer({min: -10, max: 10}), fc.integer({min: -10, max: 10}),
    (a, b) => assert.strictEqual(add(a, b), a + b)), {seed: 42, numRuns: 32});
});
`;

export const unitExample = `import assert from 'node:assert/strict';
import test from 'node:test';
import {sum as add} from '../arithmetic.ts';

test('exemplo de soma', () => assert.strictEqual(add(2, 2), 4));
`;

export const arithmeticTestFile = 'tests/arithmetic.test.mjs';

export function stageJsPropertiesFixture(source: string, withProperty: boolean): string {
  const repository = mkdtempSync(join(tmpdir(), 'qa-js-properties-'));
  try {
    chmodSync(repository, 0o755);
    mkdirSync(join(repository, 'tests'));
    chmodSync(join(repository, 'tests'), 0o755);
    const manifest = {type: 'module', scripts: {test: 'node --test'},
      ...(withProperty ? {devDependencies: {'fast-check': '4.10.3'}} : {})};
    for (const [file, contents] of Object.entries({'package.json': JSON.stringify(manifest),
      'arithmetic.ts': source, [arithmeticTestFile]: withProperty ? propertyTest : unitExample})) {
      const destination = join(repository, file);
      writeFileSync(destination, contents);
      chmodSync(destination, 0o644);
    }
    return repository;
  } catch (error) {
    rmSync(repository, {recursive: true, force: true});
    throw error;
  }
}
