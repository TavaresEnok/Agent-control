import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {listExamFiles} from '../src/verify-slices.ts';
import {VENDORED_REASON} from '../src/vendored-dirs.ts';

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ac-vendor-'));
  await mkdir(join(root, 'backend', 'vendor', 'github.com', 'lib'), {recursive: true});
  await writeFile(join(root, 'backend', 'vendor', 'modules.txt'), '# github.com/lib v1.0.0\n');
  await writeFile(join(root, 'backend', 'vendor', 'github.com', 'lib', 'lib.go'), 'package lib\n');
  await mkdir(join(root, 'backend', 'internal'), {recursive: true});
  await writeFile(join(root, 'backend', 'internal', 'app.go'), 'package internal\n');
  // Uma pasta vendor sem assinatura de dependências é código do projeto.
  await mkdir(join(root, 'web', 'src', 'vendor'), {recursive: true});
  await writeFile(join(root, 'web', 'src', 'vendor', 'proprio.ts'), 'export const x = 1;\n');
  return root;
}

test('o módulo 1 não manda dependências vendorizadas ao modelo e registra a pasta', async () => {
  const root = await repo();
  try {
    const vendored: string[] = [];
    const files = await listExamFiles(root, vendored);
    assert.deepEqual(files, ['backend/internal/app.go', 'web/src/vendor/proprio.ts']);
    assert.deepEqual(vendored, ['backend/vendor']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('os módulos 2 a 9 marcam a pasta vendorizada com o motivo, sem examiná-la', async () => {
  const root = await repo();
  try {
    const map = await mapModuleSnapshot(root);
    const vendor = map.files.find(row => row.file === 'backend/vendor');
    assert.equal(vendor?.code, null);
    assert.equal(vendor?.reason, VENDORED_REASON);
    assert.equal(map.files.some(row => row.file.startsWith('backend/vendor/')), false);
    assert.ok(map.files.some(row => row.file === 'web/src/vendor/proprio.ts' && row.code !== null));
    assert.ok(map.files.some(row => row.file === 'backend/internal/app.go' && row.code !== null));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
