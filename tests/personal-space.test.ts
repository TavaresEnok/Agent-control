import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {link, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {assertDiskSpaceForLaunch, readSpaceVerdict, SPACE_RECORD_FILE, SPACE_RECORD_MAX_AGE_MS} from '../src/personal-disk.ts';
import {spaceNotice} from '../src/personal-health.ts';
import {alignLayers, GB, layerUnion, measureDocker, measureSpace, spaceState, writeSpaceRecord, type DockerRun, type SpaceReport} from '../src/personal-space.ts';

const L = (n: number) => 'sha256:' + String(n).padStart(64, '0');

/** Fake daemon: images by id with layers and history sizes, plus `docker system df -v`. */
function fakeDocker(images: {id: string; tags?: string[]; labels?: Record<string, string>; layers: [string, number][]}[], df: object): DockerRun {
  return async args => {
    if (args[0] === 'image' && args[1] === 'ls') return {ok: true, stdout: images.map(image => image.id).join('\n') + '\n'};
    if (args[0] === 'image' && args[1] === 'inspect') return {ok: true, stdout: JSON.stringify(args.slice(2).map(id => {
      const image = images.find(item => item.id === id)!;
      return {Id: image.id, RepoTags: image.tags ?? [], RepoDigests: [], Size: image.layers.reduce((sum, [, n]) => sum + n, 0),
        Config: {Labels: image.labels ?? null}, RootFS: {Layers: image.layers.map(([layer]) => layer)}};
    }))};
    if (args[0] === 'history') {
      const image = images.find(item => item.id === args.at(-1))!;
      return {ok: true, stdout: [...image.layers].reverse().map(([, n]) => JSON.stringify({Size: String(n), CreatedBy: 'COPY x /x # buildkit'})).join('\n')};
    }
    if (args[0] === 'system') return {ok: true, stdout: JSON.stringify(df)};
    return {ok: false, stdout: ''};
  };
}

test('camadas compartilhadas entre imagens do AC contam uma vez e a base do AC não volta no projeto', () => {
  const result = layerUnion([
    {id: 'a', owner: 'ac', layers: [{id: L(1), bytes: 100}, {id: L(2), bytes: 10}]},
    {id: 'b', owner: 'ac', layers: [{id: L(1), bytes: 100}, {id: L(3), bytes: 20}]},
    {id: 'c', owner: 'p1', layers: [{id: L(1), bytes: 100}, {id: L(4), bytes: 5}]},
    {id: 'd', owner: 'p1', layers: [{id: L(4), bytes: 5}, {id: L(5), bytes: 1}]},
  ]);
  assert.equal(result.ac, 130);
  assert.deepEqual([...result.projects], [['p1', 6]]);
});

test('o histórico do buildkit alinha com as camadas mesmo com RUN e WORKDIR de tamanho zero', () => {
  const empty = 'sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef';
  const history = [{size: 70, createdBy: '# debian.sh'}, {size: 0, createdBy: 'ENV A=1'}, {size: 0, createdBy: 'RUN /bin/sh -c mkdir -p /x # buildkit'},
    {size: 0, createdBy: 'WORKDIR /x'}, {size: 0, createdBy: 'ENTRYPOINT ["node"]'}];
  assert.deepEqual(alignLayers([L(1), L(2), empty], history), [{id: L(1), bytes: 70}, {id: L(2), bytes: 0}]);
  assert.deepEqual(alignLayers([L(1)], [{size: 70, createdBy: 'COPY a /a'}]), [{id: L(1), bytes: 70}]);
  assert.equal(alignLayers([L(1), L(2), L(3)], [{size: 70, createdBy: 'COPY a /a'}]), undefined);
});

test('Docker: imagens do AC pela união, projeto pelo rótulo, e volume anônimo de terceiros fica fora', async () => {
  const project = randomUUID();
  const docker = fakeDocker([
    {id: 'sha256:' + 'a'.repeat(64), tags: ['ac-module-qa:x'], layers: [[L(1), 1000], [L(2), 100]]},
    {id: 'sha256:' + 'b'.repeat(64), tags: ['ac-native-execution:personal'], layers: [[L(1), 1000], [L(3), 200]]},
    // Sem nome do AC, mas fixada (nativeBootstrap ou digest.txt): é do AC.
    {id: 'sha256:' + 'c'.repeat(64), tags: [], layers: [[L(1), 1000], [L(6), 7]]},
    {id: 'sha256:' + 'd'.repeat(64), tags: ['nexo-ui:1'], labels: {'com.agent-control.project': project}, layers: [[L(1), 1000], [L(4), 50]]},
    {id: 'sha256:' + 'e'.repeat(64), tags: ['painel_provedores-api:latest'], layers: [[L(5), 9999]]},
  ], {
    Containers: [{Names: 'ac-personal-pg', Labels: '', Size: '1kB', Mounts: 'pgvol'}, {Names: 'painel_redis', Labels: '', Size: '5MB', Mounts: 'redisvol'}],
    Volumes: [{Name: 'pgvol', Labels: 'com.docker.volume.anonymous=', Size: '2MB'}, {Name: 'redisvol', Labels: 'com.docker.volume.anonymous=', Size: '3GB'},
      {Name: 'ac-test-db-journal', Labels: '', Size: '1MB'}, {Name: 'orfao', Labels: 'com.docker.volume.anonymous=', Size: '4GB'},
      {Name: 'nexo-dados', Labels: 'com.agent-control.project=' + project, Size: '6MB'}],
  });
  const problems: string[] = [];
  const space = await measureDocker(docker, new Set(['sha256:' + 'c'.repeat(64)]), new Set([project]), problems);
  assert.deepEqual(problems, []);
  assert.equal(space.images, 1307);
  assert.equal(space.containers, 1000);
  assert.equal(space.volumes, 3e6);
  assert.deepEqual(space.projects.get(project), {images: 50, volumes: 6e6});
  const down: DockerRun = async () => ({ok: false, stdout: ''});
  const noted: string[] = [];
  assert.equal((await measureDocker(down, new Set(), new Set(), noted)).images, 0);
  assert.match(noted[0]!, /Docker indisponível/);
});

test('o que é do projeto sai do total do AC e arquivo com hardlink conta uma vez', async () => {
  const root = await mkdtemp(join(tmpdir(), 'personal-space-'));
  try {
    const data = join(root, 'data'), repo = join(root, 'repo'), product = join(root, 'produto');
    const id = randomUUID(), job = randomUUID(), retired = randomUUID();
    await mkdir(join(product, '.git'), {recursive: true});
    await mkdir(repo, {recursive: true});
    for (const dir of [join(data, 'qa-cache', id), join(data, 'verificacoes', id), join(data, 'native', 'execution-host', job), join(data, 'native', 'execution-host', retired), join(data, 'verify-db')])
      await mkdir(dir, {recursive: true});
    const mb = Buffer.alloc(1024 * 1024, 1);
    await writeFile(join(data, 'qa-cache', id, 'cache.bin'), mb);
    await writeFile(join(data, 'native', 'execution-host', job, 'captura.png'), mb);
    // Pasta de job de projeto que não está mais na instalação: é resto do AC, conta no AC.
    await writeFile(join(data, 'native', 'execution-host', retired, 'captura.png'), mb);
    await writeFile(join(data, 'verify-db', 'grype.db'), mb);
    await link(join(data, 'verify-db', 'grype.db'), join(data, 'verify-db', 'mesmo.db'));
    const report = await measureSpace({dataDirectory: data, storage: {productRepo: product, budgetGB: 1},
      project: {id, label: 'Projeto', repo}}, {
      docker: async () => ({ok: false, stdout: ''}), jobProjects: async () => new Map([[job, id], [retired, randomUUID()]]),
      tmpRoot: join(root, 'tmp'), backupRoot: join(root, 'backups'), home: join(root, 'home'),
    });
    const dados = report.categories.find(item => item.key === 'dados')!;
    const project = report.projects[0]!;
    assert.deepEqual(project.parts.map(part => part.key).sort(), ['jobs', 'qa-cache', 'verificacoes']);
    assert.ok(project.bytes >= 2 * 1024 * 1024 && project.bytes < 3 * 1024 * 1024, String(project.bytes));
    // verify-db (1 MB com o hardlink) e o job do projeto retirado (1 MB); nada do projeto.
    assert.ok(dados.bytes >= 2 * 1024 * 1024 && dados.bytes < 2.5 * 1024 * 1024, String(dados.bytes));
    assert.equal(report.acBytes, report.categories.reduce((sum, item) => sum + item.bytes, 0));
    assert.equal(report.state, 'ok');
    assert.ok(report.problems.some(problem => /Docker indisponível/.test(problem)));
  } finally { await rm(root, {recursive: true, force: true}); }
});

function record(acBytes: number, measuredAt: Date, budgetGB = 20): SpaceReport {
  return {schemaVersion: 1, measuredAt: measuredAt.toISOString(), budgetGB, alertRatio: 0.9, acBytes, state: spaceState(acBytes, budgetGB, 0.9), categories: [], projects: [], problems: []};
}

test('acima do orçamento recusa novos exames e trabalhadores, e o limite de disco continua valendo', async () => {
  const data = await mkdtemp(join(tmpdir(), 'personal-space-gate-'));
  try {
    assert.equal(spaceState(17.9 * GB, 20, 0.9), 'ok');
    assert.equal(spaceState(18 * GB, 20, 0.9), 'alerta');
    assert.equal(spaceState(20 * GB, 20, 0.9), 'acima');
    await writeSpaceRecord(data, record(25 * GB, new Date()));
    await assert.rejects(assertDiskSpaceForLaunch([data, '/'], async () => 50), (error: {code?: string; detail?: string}) =>
      error.code === 'PERSONAL_SPACE_BUDGET_EXCEEDED' && /retencao-automatica/.test(error.detail ?? '') && /25,0 GB/.test(error.detail ?? ''));
    // O disco cheio fala primeiro, com o código de sempre.
    await assert.rejects(assertDiskSpaceForLaunch([data], async () => 95), {code: 'PERSONAL_DISK_FULL'});
    const verdict = await readSpaceVerdict(data);
    assert.equal(verdict.state, 'acima');
    assert.match(spaceNotice(verdict)!.text, /bloqueados/);
    // Só o primeiro volume (os dados) é lido: um arquivo plantado no repositório de um projeto não bloqueia.
    const other = await mkdtemp(join(tmpdir(), 'personal-space-repo-'));
    try {
      await writeSpaceRecord(other, record(99 * GB, new Date()));
      await writeSpaceRecord(data, record(5 * GB, new Date()));
      await assertDiskSpaceForLaunch([data, other], async () => 50);
    } finally { await rm(other, {recursive: true, force: true}); }
    await writeSpaceRecord(data, record(19 * GB, new Date()));
    await assertDiskSpaceForLaunch([data], async () => 50);
    assert.match(spaceNotice(await readSpaceVerdict(data))!.text, /19,0 GB de 20,0 GB/);
  } finally { await rm(data, {recursive: true, force: true}); }
});

test('medição vencida, ausente, do futuro ou ilegível não bloqueia, só avisa', async () => {
  const data = await mkdtemp(join(tmpdir(), 'personal-space-stale-'));
  try {
    assert.equal((await readSpaceVerdict(data)).state, 'ausente');
    await assertDiskSpaceForLaunch([data], async () => 50);
    assert.match(spaceNotice({state: 'ausente'})!.text, /personal:espaco/);
    await writeSpaceRecord(data, record(99 * GB, new Date(Date.now() - SPACE_RECORD_MAX_AGE_MS - 1000)));
    assert.equal((await readSpaceVerdict(data)).state, 'vencida');
    await assertDiskSpaceForLaunch([data], async () => 50);
    await writeSpaceRecord(data, record(99 * GB, new Date(Date.now() + 60 * 60 * 1000)));
    assert.equal((await readSpaceVerdict(data)).state, 'vencida');
    await assertDiskSpaceForLaunch([data], async () => 50);
    await writeFile(join(data, SPACE_RECORD_FILE), '{quebrado');
    assert.equal((await readSpaceVerdict(data)).state, 'ilegivel');
    await assertDiskSpaceForLaunch([data], async () => 50);
    assert.equal(spaceNotice({state: 'ok', acBytes: 1, budgetGB: 20, measuredAt: new Date().toISOString()}), null);
  } finally { await rm(data, {recursive: true, force: true}); }
});
