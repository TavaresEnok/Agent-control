import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, sep} from 'node:path';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {designBenchWorker} from '../src/design-bench.ts';
import {type DesignCaptureDriver} from '../src/design-capture.ts';
import {stageDesignCapturesForJob, writeDesignExamCaptures} from '../src/design-capture-stage.ts';
import {runDesignModule, type DesignModuleInput} from '../src/design-module.ts';

const CAPTURE_DIR = 'AC_DESIGN_CAPTURE_DIR';
const CAPTURE_RUN = 'AC_DESIGN_CAPTURE_RUN';

let gate: Promise<void> = Promise.resolve();

function alone(name: string, body: () => Promise<void>): void {
  test(name, async () => {
    const wait = gate;
    let release: () => void = () => {};
    gate = new Promise(resolve => { release = resolve; });
    await wait;
    try {
      await body();
    } finally {
      release();
    }
  });
}

function pngName(bytes: Buffer): string {
  return `${createHash('sha256').update(bytes).digest('hex')}.png`;
}

const driver: DesignCaptureDriver = {
  async setViewport() {},
  async emulateMedia() {},
  async goto() {},
  async screenshot() { return Buffer.from('png-da-tela'); },
  async content() { return '<p>ok</p>'; },
};

function examInput(
  data: string,
  repo: string,
  runId: string,
  worker: DesignModuleInput['worker'],
): DesignModuleInput {
  return {
    activation: 'personal',
    projectId: randomUUID(),
    repo,
    targetUrl: 'http://127.0.0.1:4173',
    dataDirectory: data,
    intentId: randomUUID(),
    runId,
    createdAt: new Date('2026-11-17T03:04:05.000Z'),
    commit: 'abc123',
    files: [{path: 'src/Tela.tsx', text: 'export const tela = <main>Oi</main>;\n'}],
    worker,
    reserve: async role => ({
      provider: role === 'reviewer' ? 'grok' : 'claude',
      model: role,
      accountId: randomUUID(),
      profileId: randomUUID(),
      grantId: randomUUID(),
    }),
    release: async () => {},
    driver,
  };
}

function workerSeeing(onCapture: (task: string) => Promise<void>): DesignModuleInput['worker'] {
  const bench = designBenchWorker();
  return {
    async run(call) {
      if (call.task.includes('Capturas:')) {
        await onCapture(call.task);
        if (call.role === 'reviewer') {
          return JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'a imagem não sustenta o ponto', proof: 'png aberto'});
        }
        return JSON.stringify({
          kind: 'exame',
          filesRead: ['src/Tela.tsx'],
          checklist: ['DESIGN-NIELSEN-H1-ESTADO'],
          findings: [{
            title: 'Captura vista',
            severity: 'baixa',
            file: 'src/Tela.tsx',
            line: 1,
            scenario: 'A imagem foi aberta no caminho citado.',
            suggestion: 'Manter o texto legível.',
            cwe: null,
            reference: 'DESIGN-VISUAL',
            snippet: 'png',
          }],
        });
      }
      return bench.run(call);
    },
  };
}

function restoreEnv(dir: string | undefined, run: string | undefined): void {
  if (dir === undefined) delete process.env[CAPTURE_DIR];
  else process.env[CAPTURE_DIR] = dir;
  if (run === undefined) delete process.env[CAPTURE_RUN];
  else process.env[CAPTURE_RUN] = run;
}

alone('copia png de capturas para planning e work e ignora o resto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-stage-'));
  const planning = join(root, 'job', 'planning');
  const work = join(root, 'job', 'work');
  const run = randomUUID();
  const bytes = Buffer.from('png-da-tela');
  const name = pngName(bytes);
  try {
    await mkdir(join(root, '.design-captures', run), {recursive: true});
    await mkdir(planning, {recursive: true});
    await mkdir(work, {recursive: true});
    await writeFile(join(root, '.design-captures', run, name), bytes, {mode: 0o600});
    await writeFile(join(root, '.design-captures', run, 'nota.txt'), 'nao');
    await symlink('/etc/hostname', join(root, '.design-captures', run, `${'ab'.repeat(32)}.png`));
    const copied = await stageDesignCapturesForJob(root, [planning, work]);
    assert.equal(copied, 0);
    assert.equal(existsSync(join(planning, 'capturas')), false);
    assert.equal(existsSync(join(work, 'capturas')), false);
    assert.equal(existsSync(join(planning, 'capturas', name)), false);
    assert.equal(existsSync(join(work, 'capturas', name)), false);
    assert.equal(await stageDesignCapturesForJob(join(root, 'job'), [planning]), 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

alone('com as variáveis de ambiente copia o run mesmo sem .design-captures no repositório', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-stage-env-'));
  const repo = join(root, 'repo');
  const dest = join(root, 'planning');
  const run = randomUUID();
  const bytes = Buffer.from('png-privado');
  const name = pngName(bytes);
  const parent = join(root, 'data', 'design-captures');
  const previousDir = process.env[CAPTURE_DIR];
  const previousRun = process.env[CAPTURE_RUN];
  try {
    await mkdir(join(parent, run), {recursive: true});
    await mkdir(repo);
    await mkdir(dest);
    await writeFile(join(parent, run, name), bytes, {mode: 0o600});
    await writeFile(join(repo, 'README'), 'sem capturas');
    process.env[CAPTURE_DIR] = parent;
    process.env[CAPTURE_RUN] = run;
    const copied = await stageDesignCapturesForJob(repo, [dest]);
    assert.equal(existsSync(join(repo, '.design-captures')), false);
    assert.equal(copied, 1);
    assert.equal(await readFile(join(dest, 'capturas', name), 'utf8'), 'png-privado');
    const decoyRun = randomUUID();
    const decoy = Buffer.from('png-decoy-env');
    const decoyName = pngName(decoy);
    const otherDest = join(root, 'work');
    await mkdir(join(repo, '.design-captures', decoyRun), {recursive: true});
    await mkdir(otherDest);
    await writeFile(join(repo, '.design-captures', decoyRun, decoyName), decoy, {mode: 0o600});
    delete process.env[CAPTURE_RUN];
    assert.equal(await stageDesignCapturesForJob(repo, [otherDest]), 0);
    assert.equal(existsSync(join(otherDest, 'capturas', decoyName)), false);
  } finally {
    restoreEnv(previousDir, previousRun);
    await rm(root, {recursive: true, force: true});
  }
});

alone('não copia png privado cujo nome não é o sha256 dos bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-stage-hash-'));
  const repo = join(root, 'repo');
  const dest = join(root, 'planning');
  const run = randomUUID();
  const good = Buffer.from('png-integro');
  const bad = Buffer.from('png-mentira');
  const goodName = pngName(good);
  const badName = pngName(Buffer.from('nome-falso'));
  const parent = join(root, 'data', 'design-captures');
  const previousDir = process.env[CAPTURE_DIR];
  const previousRun = process.env[CAPTURE_RUN];
  try {
    await mkdir(join(parent, run), {recursive: true});
    await mkdir(repo);
    await mkdir(dest);
    await writeFile(join(parent, run, goodName), good, {mode: 0o600});
    await writeFile(join(parent, run, badName), bad, {mode: 0o600});
    process.env[CAPTURE_DIR] = parent;
    process.env[CAPTURE_RUN] = run;
    const copied = await stageDesignCapturesForJob(repo, [dest]);
    assert.equal(copied, 1);
    const copiedBytes = await readFile(join(dest, 'capturas', goodName));
    assert.equal(pngName(copiedBytes), goodName);
    assert.equal(existsSync(join(dest, 'capturas', badName)), false);
  } finally {
    restoreEnv(previousDir, previousRun);
    await rm(root, {recursive: true, force: true});
  }
});

alone('não copia um segundo run que esteja no mesmo diretório', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-stage-one-'));
  const repo = join(root, 'repo');
  const dest = join(root, 'planning');
  const run = randomUUID();
  const other = randomUUID();
  const bytes = Buffer.from('png-atual');
  const otherBytes = Buffer.from('png-outro');
  const decoyBytes = Buffer.from('png-decoy');
  const name = pngName(bytes);
  const otherName = pngName(otherBytes);
  const decoyName = pngName(decoyBytes);
  const parent = join(root, 'data', 'design-captures');
  const previousDir = process.env[CAPTURE_DIR];
  const previousRun = process.env[CAPTURE_RUN];
  try {
    const decoyRun = randomUUID();
    await mkdir(join(parent, run), {recursive: true});
    await mkdir(join(parent, other), {recursive: true});
    await mkdir(join(repo, '.design-captures', decoyRun), {recursive: true});
    await mkdir(dest);
    await writeFile(join(parent, run, name), bytes, {mode: 0o600});
    await writeFile(join(parent, other, otherName), otherBytes, {mode: 0o600});
    await writeFile(join(repo, '.design-captures', decoyRun, decoyName), decoyBytes, {mode: 0o600});
    process.env[CAPTURE_DIR] = parent;
    process.env[CAPTURE_RUN] = run;
    const copied = await stageDesignCapturesForJob(repo, [dest]);
    assert.equal(copied, 1);
    assert.equal(await readFile(join(dest, 'capturas', name), 'utf8'), 'png-atual');
    assert.equal(existsSync(join(dest, 'capturas', otherName)), false);
    assert.equal(existsSync(join(dest, 'capturas', decoyName)), false);
  } finally {
    restoreEnv(previousDir, previousRun);
    await rm(root, {recursive: true, force: true});
  }
});

alone('ignora symlink que escapa do diretório de capturas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-stage-link-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  const outside = join(root, 'outside');
  const dest = join(root, 'planning');
  const run = randomUUID();
  const bytes = Buffer.from('png-fora');
  const decoyBytes = Buffer.from('png-decoy-link');
  const name = pngName(bytes);
  const decoyName = pngName(decoyBytes);
  const parent = join(data, 'design-captures');
  const previousDir = process.env[CAPTURE_DIR];
  const previousRun = process.env[CAPTURE_RUN];
  try {
    const decoyRun = randomUUID();
    await mkdir(join(outside, 'secret'), {recursive: true});
    await mkdir(join(repo, '.design-captures', decoyRun), {recursive: true});
    await mkdir(data);
    await mkdir(dest);
    await writeFile(join(outside, 'secret', name), bytes, {mode: 0o600});
    await writeFile(join(outside, 'marker'), 'vivo');
    await writeFile(join(repo, '.design-captures', decoyRun, decoyName), decoyBytes, {mode: 0o600});
    await mkdir(parent);
    await symlink(join(outside, 'secret'), join(parent, run));
    process.env[CAPTURE_DIR] = parent;
    process.env[CAPTURE_RUN] = run;
    const copied = await stageDesignCapturesForJob(repo, [dest]);
    assert.equal(copied, 0);
    assert.equal(existsSync(join(dest, 'capturas', name)), false);
    assert.equal(existsSync(join(dest, 'capturas', decoyName)), false);
    assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'vivo');

    const realRun = randomUUID();
    const kept = Buffer.from('png-dentro');
    const keptName = pngName(kept);
    const linkName = `${'cd'.repeat(32)}.png`;
    await mkdir(join(parent, realRun));
    await writeFile(join(parent, realRun, keptName), kept, {mode: 0o600});
    await symlink(join(outside, 'secret', name), join(parent, realRun, linkName));
    process.env[CAPTURE_RUN] = realRun;
    const inner = await stageDesignCapturesForJob(repo, [dest]);
    assert.equal(inner, 1);
    assert.equal(await readFile(join(dest, 'capturas', keptName), 'utf8'), 'png-dentro');
    assert.equal(existsSync(join(dest, 'capturas', linkName)), false);
    assert.equal(existsSync(join(dest, 'capturas', decoyName)), false);

    const linkedData = join(root, 'data-link');
    await symlink(outside, linkedData);
    await assert.rejects(
      () => runDesignModule(examInput(linkedData, repo, randomUUID(), workerSeeing(async () => {}))),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PATH_FORBIDDEN',
    );
    assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'vivo');
    assert.equal((await readdir(outside)).includes('design-captures'), false);

    const planted = join(root, 'data-planted');
    await mkdir(planted);
    await symlink(outside, join(planted, 'design-captures'));
    await assert.rejects(
      () => runDesignModule(examInput(planted, repo, randomUUID(), workerSeeing(async () => {}))),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PATH_FORBIDDEN',
    );
    assert.deepEqual((await readdir(outside)).sort(), ['marker', 'secret']);
  } finally {
    restoreEnv(previousDir, previousRun);
    await rm(root, {recursive: true, force: true});
  }
});

alone('recusa runId que não é uuid', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-stage-id-'));
  try {
    await assert.rejects(
      () => writeDesignExamCaptures(data, '../fora', [{
        route: '/',
        viewport: 375,
        theme: 'claro',
        state: 'padrao',
        bytes: Buffer.from('png'),
      }]),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PATH_FORBIDDEN',
    );
    assert.equal(existsSync(join(data, 'design-captures')), false);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

alone('grava as capturas no diretório de dados e não no repositório', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-stage-data-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  const dest = join(root, 'planning');
  const runId = randomUUID();
  const bytes = Buffer.from('png-da-tela');
  const name = pngName(bytes);
  let seen = 0;
  try {
    await mkdir(repo);
    await mkdir(data);
    await mkdir(dest);
    await runDesignModule(examInput(data, repo, runId, workerSeeing(async task => {
      const path = task.match(/arquivo=(\S+)/)?.[1] ?? '';
      assert.equal(path, join(data, 'design-captures', runId, name));
      assert.equal(path.startsWith(repo + sep), false);
      assert.equal(existsSync(join(repo, '.design-captures')), false);
      const file = await lstat(path);
      assert.equal(file.isSymbolicLink(), false);
      assert.equal(file.isFile(), true);
      assert.equal(file.mode & 0o777, 0o600);
      const runDir = await lstat(join(data, 'design-captures', runId));
      assert.equal(runDir.isSymbolicLink(), false);
      assert.equal(runDir.isDirectory(), true);
      assert.equal(runDir.mode & 0o777, 0o700);
      const parent = await lstat(join(data, 'design-captures'));
      assert.equal(parent.isSymbolicLink(), false);
      assert.equal(parent.isDirectory(), true);
      assert.equal(parent.mode & 0o777, 0o700);
      const copied = await stageDesignCapturesForJob(repo, [dest]);
      assert.equal(copied, 1);
      assert.equal(await readFile(join(dest, 'capturas', name), 'utf8'), 'png-da-tela');
      seen += 1;
    })));
    assert.ok(seen >= 1);
    assert.equal(process.env[CAPTURE_DIR], undefined);
    assert.equal(process.env[CAPTURE_RUN], undefined);
    assert.equal(existsSync(join(data, 'design-captures', runId)), false);
    assert.equal(existsSync(join(repo, '.design-captures')), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

alone('o exame seguinte apaga o run deixado por um kill e preserva o resto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'design-stage-kill-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  const runId = randomUUID();
  const killed = randomUUID();
  const escape = randomUUID();
  const fileId = randomUUID();
  const parent = join(data, 'design-captures');
  const outside = join(root, 'outside');
  let seen = 0;
  try {
    await mkdir(repo);
    await mkdir(join(parent, killed), {recursive: true});
    await mkdir(join(parent, runId));
    await mkdir(join(parent, 'nao-uuid'));
    await mkdir(outside);
    await writeFile(join(parent, killed, 'old.png'), 'velho');
    await writeFile(join(parent, 'nota.txt'), 'fica');
    await writeFile(join(parent, 'nao-uuid', 'x.txt'), 'x');
    await writeFile(join(parent, fileId), 'arquivo');
    await writeFile(join(parent, runId, 'sentinel.txt'), 'vivo');
    await writeFile(join(outside, 'marker'), 'vivo');
    await symlink(outside, join(parent, escape));
    await runDesignModule(examInput(data, repo, runId, workerSeeing(async () => {
      assert.equal(existsSync(join(parent, killed)), false);
      assert.equal(await readFile(join(parent, 'nota.txt'), 'utf8'), 'fica');
      assert.equal(await readFile(join(parent, 'nao-uuid', 'x.txt'), 'utf8'), 'x');
      assert.equal(await readFile(join(parent, fileId), 'utf8'), 'arquivo');
      assert.equal(await readFile(join(parent, runId, 'sentinel.txt'), 'utf8'), 'vivo');
      assert.equal(existsSync(join(parent, runId, pngName(Buffer.from('png-da-tela')))), true);
      assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'vivo');
      const link = await lstat(join(parent, escape));
      assert.equal(link.isSymbolicLink(), true);
      assert.equal(existsSync(join(repo, '.design-captures')), false);
      seen += 1;
    })));
    assert.ok(seen >= 1);
    assert.equal(existsSync(join(parent, killed)), false);
    assert.equal(existsSync(join(parent, runId)), false);
    assert.equal(await readFile(join(parent, 'nota.txt'), 'utf8'), 'fica');
    assert.equal(await readFile(join(parent, 'nao-uuid', 'x.txt'), 'utf8'), 'x');
    assert.equal(await readFile(join(parent, fileId), 'utf8'), 'arquivo');
    assert.equal(await readFile(join(outside, 'marker'), 'utf8'), 'vivo');
    assert.equal((await lstat(join(parent, escape))).isSymbolicLink(), true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
