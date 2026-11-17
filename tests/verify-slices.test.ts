import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadSecurityChecklist} from '../src/verify-checklist.ts';
import type {ChecklistItem} from '../src/verify-types.ts';
import {listExamFiles, sliceExamFiles} from '../src/verify-slices.ts';

function idsFor(kinds: readonly ChecklistItem['appliesTo'][]): string[] {
  const wanted = new Set(kinds);
  return loadSecurityChecklist().filter(item => wanted.has(item.appliesTo)).map(item => item.id);
}

test('repo temporário ignora symlink de fora e não deixa arquivo sem fatia', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'verify-slices-'));
  const root = join(parent, 'repo');
  try {
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(join(root, 'src', 'app.ts'), 'export const n = 1;\n');
    await writeFile(join(root, 'package.json'), '{}\n');
    await writeFile(join(root, 'README.md'), 'nota\n');
    await writeFile(join(parent, 'fora.txt'), 'segredo\n');
    await symlink(join('..', 'fora.txt'), join(root, 'vazou'));
    await symlink(parent, join(root, 'saida'));
    for (const dir of ['.git', 'node_modules', 'dist', '.ai', 'verificacoes']) {
      await mkdir(join(root, 'nested', dir), {recursive: true});
      await writeFile(join(root, 'nested', dir, 'oculto.txt'), 'nao\n');
    }
    const files = await listExamFiles(root);
    assert.deepEqual(files, ['README.md', 'package.json', 'src/app.ts']);
    const slices = sliceExamFiles(files, loadSecurityChecklist());
    const assigned = slices.flatMap(slice => slice.files);
    assert.deepEqual(assigned, files);
    assert.equal(new Set(assigned).size, files.length);
    for (const file of files) {
      const owners = slices.filter(slice => slice.files.includes(file));
      assert.equal(owners.length, 1, file);
      assert.ok(owners[0].checklist.length >= 1);
      assert.ok(owners[0].files.length <= 15);
    }
  } finally {
    await rm(parent, {recursive: true, force: true});
  }
});

test('fatia de no máximo 15 e checklist conforme o tipo do arquivo', () => {
  const checklist = loadSecurityChecklist();
  assert.deepEqual(sliceExamFiles([], checklist), []);
  const many = Array.from({length: 16}, (_, index) => `doc/n${String(index).padStart(2, '0')}.md`);
  const slices = sliceExamFiles(many, checklist);
  assert.deepEqual(slices.map(slice => slice.id), ['fatia-1', 'fatia-2']);
  assert.equal(slices[0].files.length, 15);
  assert.deepEqual(slices[1].files, ['doc/n15.md']);
  assert.deepEqual(slices.flatMap(slice => slice.files), many);
  for (const slice of slices) assert.deepEqual(slice.checklist, idsFor(['any']));

  const cases: [string, ChecklistItem['appliesTo'][]][] = [
    ['src/app.ts', ['code', 'any']],
    ['src/app.js', ['code', 'any']],
    ['src/app.py', ['code', 'any']],
    ['src/page.tsx', ['code', 'any']],
    ['src/clock.ts', ['code', 'any']],
    ['src/api.ts', ['code', 'route', 'any']],
    ['src/api/pedidos.ts', ['code', 'route', 'any']],
    ['src/server.js', ['code', 'route', 'any']],
    ['pkg/routes/item.py', ['code', 'route', 'any']],
    ['README.md', ['any']],
    ['Dockerfile', ['dockerfile', 'any']],
    ['image/Dockerfile', ['dockerfile', 'any']],
    ['image/Dockerfile.extra', ['dockerfile', 'any']],
    ['package.json', ['dependency', 'any']],
    ['package-lock.json', ['dependency', 'any']],
    ['yarn.lock', ['dependency', 'any']],
    ['pnpm-lock.yaml', ['dependency', 'any']],
    ['deploy/compose.yml', ['config', 'any']],
    ['deploy/compose.lab.yaml', ['config', 'any']],
    ['.env', ['secret', 'any']],
    ['keys/id_rsa', ['secret', 'any']],
  ];
  for (const [file, kinds] of cases) {
    const [slice] = sliceExamFiles([file], checklist);
    assert.equal(slice.id, 'fatia-1');
    assert.deepEqual(slice.files, [file]);
    assert.deepEqual(slice.checklist, idsFor(kinds), file);
    assert.ok(slice.checklist.length >= 1, file);
  }

  const mixed = sliceExamFiles(['README.md', 'src/app.ts', 'Dockerfile'], checklist);
  assert.equal(mixed.length, 1);
  assert.deepEqual(mixed[0].files, ['README.md', 'src/app.ts', 'Dockerfile']);
  assert.deepEqual(mixed[0].checklist, idsFor(['code', 'dockerfile', 'any']));
});
