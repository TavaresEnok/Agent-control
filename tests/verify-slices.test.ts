import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {loadSecurityChecklist} from '../src/verify-checklist.ts';
import type {ChecklistItem} from '../src/verify-types.ts';
import {auxiliaryKind, listExamFiles, sliceExamFiles} from '../src/verify-slices.ts';

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

test('módulo 1: classes que saem do modelo são testes, documentação e gerados; o resto é produção', () => {
  const head = (text: string) => Buffer.from(text);
  for (const file of ['backend/internal/store/store_test.go', 'web/src/app.test.tsx', 'web/src/app.spec.ts', 'tools/test_parse.py',
    'pkg/parse_test.py', 'src/__tests__/util.ts', 'backend/testdata/case.json', 'e2e/login.ts', 'tests/app.ts', 'test/setup.ts',
    'spec/api.ts']) assert.equal(auxiliaryKind(file), 'testes', file);
  for (const file of ['README.md', 'docs/guia.mdx', 'docs/manual.rst', 'NOTAS.txt']) assert.equal(auxiliaryKind(file), 'documentacao', file);
  for (const file of ['web/package-lock.json', 'yarn.lock', 'backend/go.sum', 'backend/api/openapi.json', 'api/swagger.yaml']) assert.equal(auxiliaryKind(file), 'gerados', file);
  assert.equal(auxiliaryKind('backend/internal/dbgen/users.sql.go', head('// Code generated by sqlc. DO NOT EDIT.\n// versions:\npackage dbgen\n')), 'gerados');
  assert.equal(auxiliaryKind('backend/internal/dbgen/crlf.sql.go', head('// Code generated by sqlc. DO NOT EDIT.\r\npackage dbgen\r\n')), 'gerados');
  assert.equal(auxiliaryKind('web/src/api/schema.ts', head('/**\n * This file was auto-generated by openapi-typescript.\n */\n')), 'gerados');
  // Production stays: lists the build reads, a mention of generation in code, a marker below the first lines.
  for (const file of ['requirements.txt', 'requirements-dev.txt', 'CMakeLists.txt', 'package.json', 'src/testing.ts', 'src/contest/api.ts',
    // A route or package named test or spec below the root is production code.
    'app/api/test/route.ts', 'src/spec/handlers.ts', 'web/src/test/render.tsx', 'web/e2e/login.ts']) {
    assert.equal(auxiliaryKind(file, head('export {};\n')), null, file);
  }
  assert.equal(auxiliaryKind('src/id.ts', head('export const id = 1; // the id is auto-generated by the database\n')), null);
  assert.equal(auxiliaryKind('src/late.ts', head('a\nb\nc\nd\ne\n// Code generated by x. DO NOT EDIT.\n')), null);
  // Go's marker is one exact line; a loose mention in a block comment or without the final period is not it.
  for (const text of ['/* Code generated by x. DO NOT EDIT. */\n', '// Code generated by x. DO NOT EDIT\n', '//Code generated by x. DO NOT EDIT.\n',
    '// handler: Code generated by x. DO NOT EDIT.\n']) assert.equal(auxiliaryKind('src/h.go', head(text)), null, text);
});

test('módulo 1: com a lista de classes, listExamFiles separa os auxiliares e mantém binários à parte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verify-aux-'));
  try {
    await mkdir(join(root, 'src'), {recursive: true});
    await writeFile(join(root, 'src', 'app.ts'), 'export const n = 1;\n');
    await writeFile(join(root, 'src', 'app.test.ts'), 'export {};\n');
    await writeFile(join(root, 'README.md'), 'nota\n');
    await writeFile(join(root, 'src', 'gen.go'), '// Code generated by protoc-gen-go. DO NOT EDIT.\npackage src\n');
    await writeFile(join(root, 'logo.md'), Buffer.from([0x23, 0, 1]));
    const auxiliary = {testes: [] as string[], documentacao: [] as string[], gerados: [] as string[]};
    const binaries: string[] = [];
    assert.deepEqual(await listExamFiles(root, [], binaries, auxiliary), ['src/app.ts']);
    assert.deepEqual(auxiliary, {testes: ['src/app.test.ts'], documentacao: ['README.md'], gerados: ['src/gen.go']});
    assert.deepEqual(binaries, ['logo.md']);
    assert.deepEqual(await listExamFiles(root), ['README.md', 'logo.md', 'src/app.test.ts', 'src/app.ts', 'src/gen.go']);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
