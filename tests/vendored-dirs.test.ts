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

test('pacote fora do módulo do cabeçalho, ou antes de qualquer cabeçalho, devolve vendor ao exame', async () => {
  for (const modules of [
    MODULES.replace('github.com/lib/pq/oid', 'internal/auth'),
    `example.com/app/internal/auth\n${MODULES}`,
  ]) {
    const root = await goRepo({modules});
    try {
      const vendored: VendoredFiles[] = [];
      await listExamFiles(root, vendored);
      assert.equal(vendored.length, 0);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

test('num pacote listado só saem fontes Go, C e assembly e avisos de licença', async () => {
  const root = await goRepo();
  try {
    const pq = join(root, 'backend', 'vendor', 'github.com', 'lib', 'pq');
    await writeFile(join(pq, 'handler.ts'), 'export {};\n');
    await writeFile(join(pq, 'build.sh'), 'echo\n');
    await writeFile(join(pq, 'LICENSE'), 'MIT\n');
    await writeFile(join(pq, 'asm_amd64.s'), '// asm\n');
    await writeFile(join(pq, 'LICENSE.ts'), 'export {};\n');
    await writeFile(join(pq, 'NOTICE.js'), 'module.exports = 1;\n');
    await writeFile(join(pq, 'LICENSE.md'), '# MIT\n');
    const vendored: VendoredFiles[] = [];
    const files = await listExamFiles(root, vendored);
    assert.ok(files.includes('backend/vendor/github.com/lib/pq/handler.ts'));
    assert.ok(files.includes('backend/vendor/github.com/lib/pq/build.sh'));
    assert.ok(files.includes('backend/vendor/github.com/lib/pq/LICENSE.ts'), 'nome de licença com extensão de código vai ao exame');
    assert.ok(files.includes('backend/vendor/github.com/lib/pq/NOTICE.js'));
    const out = vendored[0]?.files ?? [];
    assert.ok(out.includes('backend/vendor/github.com/lib/pq/LICENSE'));
    assert.ok(out.includes('backend/vendor/github.com/lib/pq/asm_amd64.s'));
    assert.ok(out.includes('backend/vendor/github.com/lib/pq/LICENSE.md'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('módulos 2 a 9: a pasta aparece com o motivo e a contagem, e a nota diz o que não é coberto', async () => {
  const root = await goRepo();
  try {
    for (const aggregate of [false, true]) {
      const map = await mapModuleSnapshot(root, undefined, {aggregateOmissions: aggregate});
      assert.equal(map.vendored?.length, 1);
      assert.equal(map.vendored?.[0]?.dir, 'backend/vendor');
      assert.equal(map.vendored?.[0]?.files, 4);
      assert.match(map.vendored?.[0]?.digest ?? '', /^[0-9a-f]{64}$/);
      assert.equal(map.files.some(row => row.file === 'backend/vendor/github.com/lib/pq/conn.go'), false);
      assert.ok(map.files.some(row => row.file === 'backend/vendor/github.com/lib/pq/extra/porta.go' && row.code !== null));
      assert.ok(map.files.some(row => row.file === 'backend/internal/app.go' && row.code !== null));
    }
    const first = (await mapModuleSnapshot(root)).vendored?.[0]?.digest;
    await writeFile(join(root, 'backend', 'vendor', 'github.com', 'lib', 'pq', 'conn.go'), 'package pq\n// porta\n');
    assert.notEqual((await mapModuleSnapshot(root)).vendored?.[0]?.digest, first, 'a impressão digital muda com o código copiado');
    const note = vendoredNote([{dir: 'backend/vendor', files: 4, digest: 'a'.repeat(64)}]);
    assert.match(note, /backend\/vendor \(4 arquivos, sha256 a{64}\)/);
    assert.match(note, /não prova que o código seja de terceiros/);
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

test('a impressão digital é a mesma no módulo 1 e nos módulos 2 a 9', async () => {
  const {vendoredDigest} = await import('../src/vendored-dirs.ts');
  const root = await goRepo();
  try {
    const vendored: VendoredFiles[] = [];
    await listExamFiles(root, vendored);
    const entry = vendored[0]!;
    const fromVerify = await vendoredDigest(join(root, entry.dir), entry.files.map(file => file.slice(entry.dir.length + 1)));
    const map = await mapModuleSnapshot(root);
    assert.equal(map.vendored?.[0]?.digest, fromVerify);
    assert.deepEqual([...(map.vendored?.[0]?.paths ?? [])].sort(), [...entry.files].sort());
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
