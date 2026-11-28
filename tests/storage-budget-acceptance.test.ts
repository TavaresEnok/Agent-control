import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {assertDiskSpaceForLaunch, readSpaceVerdict, SPACE_RECORD_FILE} from '../src/personal-disk.ts';
import {runSpaceCommand, type DockerRun, type SpaceReport} from '../src/personal-space.ts';

/** Daemon with only the AC's base images: two module images sharing a 300 MB base. */
const docker: DockerRun = async args => {
  const layer = (n: number) => 'sha256:' + String(n).padStart(64, '0');
  const images: Record<string, {tag: string; layers: [string, number][]}> = {
    ['sha256:' + '1'.repeat(64)]: {tag: 'ac-module-qa:x', layers: [[layer(1), 300e6], [layer(2), 50e6]]},
    ['sha256:' + '2'.repeat(64)]: {tag: 'ac-module-banco:x', layers: [[layer(1), 300e6], [layer(3), 20e6]]},
  };
  if (args[0] === 'image' && args[1] === 'ls') return {ok: true, stdout: Object.keys(images).join('\n')};
  if (args[0] === 'image' && args[1] === 'inspect') return {ok: true, stdout: JSON.stringify(args.slice(2).map(id => ({Id: id, RepoTags: [images[id]!.tag], RepoDigests: [],
    Size: images[id]!.layers.reduce((sum, [, n]) => sum + n, 0), Config: {Labels: null}, RootFS: {Layers: images[id]!.layers.map(([l]) => l)}})))};
  if (args[0] === 'history') return {ok: true, stdout: [...images[args.at(-1)!]!.layers].reverse().map(([, n]) => JSON.stringify({Size: String(n), CreatedBy: 'COPY a /a'})).join('\n')};
  if (args[0] === 'system') return {ok: true, stdout: JSON.stringify({Containers: [{Names: 'ac-personal-pg', Labels: '', Size: '0B', Mounts: 'pg'}],
    Volumes: [{Name: 'pg', Labels: 'com.docker.volume.anonymous=', Size: '100MB'}]})};
  return {ok: false, stdout: ''};
};

test('aceitação: instalação sintética sem projetos fica dentro do orçamento e o comando relata as categorias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-budget-'));
  try {
    const data = join(root, 'data'), product = join(root, 'produto'), repo = join(root, 'projeto');
    await mkdir(join(product, '.git'), {recursive: true});
    await mkdir(repo, {recursive: true});
    await mkdir(join(data, 'verify-db'), {recursive: true, mode: 0o700});
    await writeFile(join(data, 'verify-db', 'grype.db'), Buffer.alloc(2 * 1024 * 1024, 1));
    await mkdir(join(root, 'tmp', 'ac-rodada'), {recursive: true});
    await mkdir(join(root, 'backups', 'inst', '20261128'), {recursive: true});
    await mkdir(join(root, 'home', '.claude-trabalhadores', 'enok'), {recursive: true});
    const file = join(data, 'installation.json');
    await writeFile(file, JSON.stringify({schemaVersion: 1, mode: 'administration-only', activation: 'personal',
      databaseUrl: 'postgresql://ac@127.0.0.1:1/ac', dataDirectory: data, http: {listen: '127.0.0.1', port: 18080, publicOrigin: 'http://127.0.0.1:18080'},
      storage: {budgetGB: 20, productRepo: product}, project: {id: randomUUID(), label: 'Sintético', repo, owner: 'operador'}}), {mode: 0o600});
    const printed: string[] = [];
    const deps = {docker, jobProjects: async () => new Map<string, string>(), tmpRoot: join(root, 'tmp'), backupRoot: join(root, 'backups'),
      home: join(root, 'home'), print: (line: string) => printed.push(line)};
    assert.equal(await runSpaceCommand([file, '--por-projeto'], deps), 0);
    const text = printed.join('\n');
    for (const label of ['Repositório do produto', 'Worktrees', 'Dados da instalação', 'Temporários /tmp/ac-*', 'Backups', 'Logins dos trabalhadores',
      'Imagens Docker do AC (união das camadas)', 'Volumes Docker do AC', 'Projetos', 'Sintético']) assert.ok(text.includes(label), label);
    assert.match(text, /dentro do orçamento/);
    const saved = JSON.parse(await readFile(join(data, SPACE_RECORD_FILE), 'utf8')) as SpaceReport;
    assert.equal((await stat(join(data, SPACE_RECORD_FILE))).mode & 0o777, 0o600);
    assert.equal(saved.state, 'ok');
    assert.ok(saved.acBytes <= saved.budgetGB * 1e9);
    // A base compartilhada conta uma vez: 300 + 50 + 20 MB, não 670.
    assert.equal(saved.categories.find(item => item.key === 'imagens')!.bytes, 370e6);
    assert.equal(saved.categories.find(item => item.key === 'volumes')!.bytes, 100e6);
    assert.equal(saved.projects[0]!.bytes, 0);
    assert.equal((await readSpaceVerdict(data)).state, 'ok');
    await assertDiskSpaceForLaunch([data], async () => 50);
    printed.length = 0;
    assert.equal(await runSpaceCommand([file, '--json'], deps), 0);
    assert.equal(JSON.parse(printed.join('\n')).schemaVersion, 1);
    await assert.rejects(runSpaceCommand([file, '--desconhecida'], deps), /Uso: npm run personal:espaco/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
