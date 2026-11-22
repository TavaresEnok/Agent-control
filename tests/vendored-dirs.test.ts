import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {listExamFiles, type VendoredFiles} from '../src/verify-slices.ts';
import {goVendorPackages, vendoredNote} from '../src/vendored-dirs.ts';

const GO_MOD = 'module example.com/app\n\ngo 1.27\n\nrequire (\n\tgithub.com/lib/pq v1.10.9\n\tgolang.org/x/text v0.20.0 // indirect\n)\n';
const MODULES = '# github.com/lib/pq v1.10.9\n## explicit; go 1.13\ngithub.com/lib/pq\ngithub.com/lib/pq/oid\n# golang.org/x/text v0.20.0\n## explicit; go 1.18\ngolang.org/x/text/unicode/norm\n';

async function goRepo(over: {goMod?: string | null; modules?: string} = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ac-vendor-'));
  const backend = join(root, 'backend');
  await mkdir(join(backend, 'vendor', 'github.com', 'lib', 'pq', 'oid'), {recursive: true});
  await mkdir(join(backend, 'vendor', 'golang.org', 'x', 'text', 'unicode', 'norm'), {recursive: true});
  await mkdir(join(backend, 'vendor', 'github.com', 'lib', 'pq', 'extra'), {recursive: true});
  await mkdir(join(backend, 'internal'), {recursive: true});
  if (over.goMod !== null) await writeFile(join(backend, 'go.mod'), over.goMod ?? GO_MOD);
  await writeFile(join(backend, 'vendor', 'modules.txt'), over.modules ?? MODULES);
  await writeFile(join(backend, 'vendor', 'github.com', 'lib', 'pq', 'conn.go'), 'package pq\n');
  await writeFile(join(backend, 'vendor', 'github.com', 'lib', 'pq', 'oid', 'types.go'), 'package oid\n');
  await writeFile(join(backend, 'vendor', 'golang.org', 'x', 'text', 'unicode', 'norm', 'norm.go'), 'package norm\n');
  // Fora dos pacotes listados: vai ao exame, mesmo dentro de vendor.
  await writeFile(join(backend, 'vendor', 'github.com', 'lib', 'pq', 'extra', 'porta.go'), 'package extra\n');
  await writeFile(join(backend, 'internal', 'app.go'), 'package internal\n');
  return root;
}

test('módulo 1: só os pacotes listados e conferidos com o go.mod saem; o resto de vendor é examinado', async () => {
  const root = await goRepo();
  try {
    const vendored: VendoredFiles[] = [];
    const files = await listExamFiles(root, vendored);
    assert.deepEqual(files, ['backend/go.mod', 'backend/internal/app.go', 'backend/vendor/github.com/lib/pq/extra/porta.go']);
    assert.equal(vendored.length, 1);
    assert.equal(vendored[0]?.dir, 'backend/vendor');
    assert.deepEqual(vendored[0]?.files.sort(), [
      'backend/vendor/github.com/lib/pq/conn.go',
      'backend/vendor/github.com/lib/pq/oid/types.go',
      'backend/vendor/golang.org/x/text/unicode/norm/norm.go',
      'backend/vendor/modules.txt',
    ]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('sem go.mod, com versão divergente, substituição local ou modules.txt por link, vendor é examinado inteiro', async () => {
  const cases: {goMod?: string | null; modules?: string}[] = [
    {goMod: null},
    {goMod: GO_MOD.replace('v1.10.9', 'v1.10.8')},
    {modules: MODULES.replace('# github.com/lib/pq v1.10.9', '# github.com/lib/pq v1.10.9 => ./pq-local')},
    {modules: '## explicit\nsrc/auth\n'},
  ];
  for (const over of cases) {
    const root = await goRepo(over);
    try {
      const vendored: VendoredFiles[] = [];
      const files = await listExamFiles(root, vendored);
      assert.equal(vendored.length, 0, JSON.stringify(over));
      assert.ok(files.includes('backend/vendor/github.com/lib/pq/conn.go'));
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
  const linked = await goRepo();
  try {
    await rm(join(linked, 'backend', 'vendor', 'modules.txt'));
    await writeFile(join(linked, 'modules-real.txt'), MODULES);
    await symlink(join(linked, 'modules-real.txt'), join(linked, 'backend', 'vendor', 'modules.txt'));
    assert.equal(await goVendorPackages(join(linked, 'backend', 'vendor'), 'vendor'), undefined);
  } finally {
    await rm(linked, {recursive: true, force: true});
  }
});

test('um autoload.php ou bundle/ falso não esconde nada', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-vendor-falso-'));
  try {
    await mkdir(join(root, 'src', 'vendor', 'bundle'), {recursive: true});
    await writeFile(join(root, 'src', 'vendor', 'autoload.php'), '');
    await writeFile(join(root, 'src', 'vendor', 'auth.ts'), 'export const ok = true;\n');
    const vendored: VendoredFiles[] = [];
    const files = await listExamFiles(root, vendored);
    assert.ok(files.includes('src/vendor/auth.ts'));
    assert.equal(vendored.length, 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('módulos 2 a 9: a pasta aparece com o motivo e a contagem, e a nota diz o que não é coberto', async () => {
  const root = await goRepo();
  try {
    for (const aggregate of [false, true]) {
      const map = await mapModuleSnapshot(root, undefined, {aggregateOmissions: aggregate});
      assert.deepEqual(map.vendored, [{dir: 'backend/vendor', files: 4}]);
      assert.equal(map.files.some(row => row.file === 'backend/vendor/github.com/lib/pq/conn.go'), false);
      assert.ok(map.files.some(row => row.file === 'backend/vendor/github.com/lib/pq/extra/porta.go' && row.code !== null));
      assert.ok(map.files.some(row => row.file === 'backend/internal/app.go' && row.code !== null));
    }
    const note = vendoredNote([{dir: 'backend/vendor', files: 4}]);
    assert.match(note, /backend\/vendor \(4 arquivos\)/);
    assert.match(note, /não detectam uma alteração local/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('um achado de ferramenta dentro de vendor continua legível na confirmação', async () => {
  const {readRepoText} = await import('../src/verify-runtime.ts');
  const root = await goRepo();
  try {
    const vendored: VendoredFiles[] = [];
    const files = await listExamFiles(root, vendored);
    const allowed = new Set([...files, ...vendored.flatMap(entry => entry.files)]);
    const read = await readRepoText(root, 'backend/vendor/github.com/lib/pq/conn.go', 1, allowed);
    assert.equal(read.missing, false);
    assert.match(read.text, /package pq/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
