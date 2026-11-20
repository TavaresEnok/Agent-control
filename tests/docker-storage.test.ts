import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {dockerStorageResolver, probeLocalDockerStorage} from '../src/docker-storage.ts';

async function withDaemon(reply: (url: string) => {status: number; body: string}, run: (socket: string, requests: string[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'ac-docker-storage-'));
  const socket = join(directory, 'docker.sock'), requests: string[] = [];
  const server: Server = createServer((req, res) => { requests.push(`${req.method} ${req.url}`); const {status, body} = reply(req.url ?? ''); res.writeHead(status).end(body); });
  await new Promise<void>(ok => server.listen(socket, ok));
  try { await run(socket, requests); } finally { await new Promise<void>(ok => server.close(() => ok())); await rm(directory, {recursive: true, force: true}); }
}

test('o daemon local diz onde guarda o armazenamento, por uma leitura fixa e somente de consulta', async () => {
  await withDaemon(() => ({status: 200, body: JSON.stringify({DockerRootDir: '/mnt/docker-dados/', Containers: 3})}), async (socket, requests) => {
    assert.equal(await probeLocalDockerStorage({socketPath: socket, configFile: '/ausente.json'}), '/mnt/docker-dados');
    assert.deepEqual(requests, ['GET /info']);
  });
});

test('sem socket local não há armazenamento local; com socket mas sem resposta valem o data-root e o padrão', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ac-docker-storage-'));
  try {
    assert.equal(await probeLocalDockerStorage({socketPath: join(directory, 'nenhum.sock'), configFile: join(directory, 'daemon.json')}), undefined);
    await writeFile(join(directory, 'arquivo'), 'não é socket');
    assert.equal(await probeLocalDockerStorage({socketPath: join(directory, 'arquivo')}), undefined);
    await withDaemon(() => ({status: 500, body: 'erro'}), async socket => {
      const configFile = join(directory, 'daemon.json');
      assert.equal(await probeLocalDockerStorage({socketPath: socket, configFile, defaultRoot: '/padrao/docker'}), '/padrao/docker');
      await writeFile(configFile, JSON.stringify({'data-root': '/mnt/outro-docker'}));
      assert.equal(await probeLocalDockerStorage({socketPath: socket, configFile, defaultRoot: '/padrao/docker'}), '/mnt/outro-docker');
      await writeFile(configFile, JSON.stringify({'data-root': 'relativo'}));
      assert.equal(await probeLocalDockerStorage({socketPath: socket, configFile, defaultRoot: '/padrao/docker'}), '/padrao/docker');
    });
    await withDaemon(() => ({status: 200, body: JSON.stringify({DockerRootDir: 'relativo'})}), async socket => {
      assert.equal(await probeLocalDockerStorage({socketPath: socket, configFile: join(directory, 'nenhum.json'), defaultRoot: '/padrao/docker'}), '/padrao/docker');
    });
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('a resposta fica guardada: muitas reservas fazem uma consulta, a falha mantém a última boa e o negativo é refeito mais cedo', async () => {
  let clock = 0, calls = 0, answer: string | undefined | Error = '/mnt/docker';
  const resolver = dockerStorageResolver(async () => { calls += 1; if (answer instanceof Error) throw answer; return answer; }, {now: () => clock, foundTtlMs: 1000, missingTtlMs: 100});
  assert.deepEqual(await Promise.all(Array.from({length: 20}, () => resolver.resolve())), Array(20).fill('/mnt/docker'));
  assert.equal(calls, 1, 'chamadas simultâneas dividem uma consulta');
  for (let i = 0; i < 50; i++) await resolver.resolve();
  assert.equal(calls, 1, 'dentro do prazo não consulta de novo');
  clock = 1000; answer = new Error('daemon fora');
  assert.equal(await resolver.resolve(), '/mnt/docker', 'falha mantém o último valor bom');
  assert.equal(calls, 2);
  clock = 1050; await resolver.resolve(); assert.equal(calls, 2, 'a falha também fica em espera curta');
  clock = 1200; answer = undefined;
  assert.equal(await resolver.resolve(), undefined, 'daemon removido: sem armazenamento local');
  clock = 1250; answer = '/mnt/novo'; assert.equal(await resolver.resolve(), undefined); assert.equal(calls, 3, "negativo guardado por prazo curto");
  clock = 1400; assert.equal(await resolver.resolve(), '/mnt/novo', 'o negativo é refeito depois do prazo curto');

  clock = 0; calls = 0; answer = new Error('nunca respondeu');
  const never = dockerStorageResolver(async () => { calls += 1; throw answer; }, {now: () => clock, missingTtlMs: 100});
  assert.equal(await never.resolve(), undefined); await never.resolve(); assert.equal(calls, 1);
});
