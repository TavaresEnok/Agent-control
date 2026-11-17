import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Capacity} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {beginPersonalVerification, readVerificationProgress} from '../src/verify-command.ts';
import {VERIFY_RUNTIME_BIN} from '../src/verify-image.ts';
import {listSecurityReports} from '../src/verify-report.ts';
import type {VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const HOMOLOGATION_NOTE = 'Homologação declarada e não varrida: a imagem não tem ZAP, Nuclei nem Schemathesis.';

function benchWorker(): VerifyWorker {
  return {
    async run(call) {
      const task = call.task;
      if (task.startsWith('Pedido de mapa.')) {
        return JSON.stringify({
          kind: 'mapa',
          routes: [{method: 'GET', path: '/admin', file: 'src/app.ts', line: 2}],
          surfaces: ['http'],
        });
      }
      if (task.startsWith('Pedido de exame.')) {
        const lines = task.split('\n');
        const at = lines.findIndex(line => line === 'Arquivos:');
        const files: string[] = [];
        for (const line of lines.slice(at + 1)) {
          if (!line.startsWith('- ')) break;
          files.push(line.slice(2));
        }
        const items = (task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        return JSON.stringify({
          kind: 'exame',
          filesRead: files.length ? files : ['src/app.ts'],
          checklist: items.length ? items : ['ASVS-5-V1'],
          findings: [{
            title: 'Rota sem checagem de acesso',
            severity: 'alta',
            file: 'src/app.ts',
            line: 2,
            scenario: 'A rota responde sem dono.',
            suggestion: 'Checar o acesso antes de responder.',
            cwe: 'CWE-862',
            reference: 'ASVS-5.0-V4',
            snippet: "app.get('/admin', () => 'painel')",
          }],
        });
      }
      if (task.startsWith('Pedido de confirmação.')) {
        return JSON.stringify({
          kind: 'confirmacao',
          status: 'confirmado',
          reason: 'A rota responde sem checar o dono.',
          proof: 'src/app.ts registra GET /admin sem checagem.',
        });
      }
      throw new Error('task desconhecida');
    },
  };
}

test('URL de fora é recusada antes de gravar andamento ou rodar ferramentas', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-url-'));
  let called = false;
  try {
    await assert.rejects(() => beginPersonalVerification({
      projectId: randomUUID(),
      url: 'http://example.com',
      dataDirectory,
      repoPath: dataDirectory,
      runTools: async () => { called = true; },
    }), (error: unknown) => {
      assert.equal(error instanceof Refusal, true);
      assert.equal((error as Refusal).code, 'VERIFY_EXTERNAL_TARGET');
      return true;
    });
    assert.equal(called, false);
    assert.equal((await readdir(dataDirectory)).includes('verificacoes'), false);
    assert.deepEqual(await readVerificationProgress(dataDirectory, randomUUID()), []);
  } finally {
    await rm(dataDirectory, {recursive: true, force: true});
  }
});

test('o exame grava andamento, espera as ferramentas e conta chamadas', {timeout: 180_000}, async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  // isolatedDatabase labels are at most 16 characters; the suffix keeps this run distinct.
  const database = await isolatedDatabase(url, 'verify_command_r2'.slice(0, 16));
  const db = new Ledger(database.url);
  const capacity = new Capacity(db);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-repo-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-bases-'));
  const image = `sha256:${'ab'.repeat(32)}`;
  let releaseTools = () => {};
  let observed: Promise<void> | undefined;
  try {
    await db.migrate();
    const principal = 'verify-owner';
    const project = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Verificação']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 2});
    const providers = ['claude', 'grok'] as const;
    const accounts = providers.map(() => randomUUID());
    const specialistProfiles = providers.map(() => randomUUID());
    const reviewerProfiles = providers.map(() => randomUUID());
    const adapters = providers.map(provider => createSyntheticProviderAdapter({
      id: 'fixture-' + provider,
      provider,
      version: 'verify-v1',
      runner: async input => ({protocol: 'ac-synthetic-quota-v1', provider, accountId: input.accountId, status: 'available', remainingPercent: 75, resetAt: null}),
    }));
    const collectors = new ProviderCollectors(db, adapters);
    for (let i = 0; i < providers.length; i++) {
      await capacity.registerModel(principal, {provider: providers[i], model: 'fixture-model', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verify-command'});
      await capacity.addAccount(principal, project, {id: accounts[i], provider: providers[i], label: 'Synthetic ' + providers[i], resourceIdentity: 'verify-' + accounts[i], mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-command', maxConcurrent: 2});
      await capacity.addProfile(principal, project, {id: specialistProfiles[i], accountId: accounts[i], model: 'fixture-model', effort: 'medium', role: 'specialist'});
      await capacity.addProfile(principal, project, {id: reviewerProfiles[i], accountId: accounts[i], model: 'fixture-model', effort: 'medium', role: 'reviewer'});
      await collectors.bind(principal, project, {accountId: accounts[i], adapterId: adapters[i].manifest.id, expectedRevision: 0, minimumIntervalSeconds: 1});
    }
    const revision = await capacity.publish(principal, project, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 1,
      roles: {specialist: {regular: specialistProfiles, emergency: []}, reviewer: {regular: reviewerProfiles, emergency: []}},
    });
    const context = await db.createContext(principal, project, randomUUID());
    await capacity.assignPolicy(principal, context, revision);
    await mkdir(join(repo, 'src'), {recursive: true});
    await writeFile(join(repo, 'src', 'app.ts'), "export function register(app: {get(path: string, handler: () => string): void}) {\n  app.get('/admin', () => 'painel');\n}\n");
    const gitEnv = {...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.com'};
    await exec('git', ['init'], {cwd: repo, env: gitEnv});
    await exec('git', ['add', 'src/app.ts'], {cwd: repo, env: gitEnv});
    await exec('git', ['-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'rota sem checagem'], {cwd: repo, env: gitEnv});
    const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo})).stdout.trim();
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");
    for (const accountId of accounts) await collectors.collect(principal, project, accountId, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'verify-command', 60);
    const gate = new Promise<void>(resolve => { releaseTools = () => resolve(); });
    let toolsStarted = false;
    let spec: {image: string; repository: string; databases: string; output: string} | undefined;
    const modelCalls = {count: 0};
    let networkCalled = false;
    const begun = await beginPersonalVerification({
      projectId: project,
      url: 'http://127.0.0.1:9/app',
      dataDirectory,
      repoPath: repo,
      commit,
      ledger: db,
      principal,
      authority,
      policyRevision: 1,
      worker: benchWorker(),
      databasesDirectory: databases,
      image,
      modelCalls,
      networkRunner: async () => {
        networkCalled = true;
        return {code: 0, stdout: 'true'};
      },
      runTools: async received => {
        spec = received;
        toolsStarted = true;
        await gate;
      },
      observe: job => { observed = job; },
    });
    assert.equal(begun.status, 'running');
    assert.equal(begun.phase, 'ferramentas');
    assert.equal(toolsStarted, true);
    assert.equal(spec?.image, image);
    assert.equal(spec?.repository, repo);
    assert.equal(spec?.databases, databases);
    assert.equal(spec?.output.startsWith(dataDirectory), true);
    const running = await readVerificationProgress(dataDirectory, project);
    assert.equal(running.length, 1);
    assert.equal(running[0]?.id, begun.id);
    assert.equal(running[0]?.status, 'running');
    assert.equal(running[0]?.phase, 'ferramentas');
    assert.equal(running[0]?.note, HOMOLOGATION_NOTE);
    assert.equal(networkCalled, false);
    const progressFile = join(dataDirectory, 'verificacoes', project, 'andamento', `${begun.id}.json`);
    assert.equal((await stat(progressFile)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dataDirectory, 'verificacoes'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dataDirectory, 'verificacoes', project, 'andamento'))).mode & 0o777, 0o700);
    assert.equal((await stat(spec?.output ?? '')).mode & 0o777, 0o700);
    releaseTools();
    await observed;
    assert.ok(modelCalls.count >= 1);
    const finished = await readVerificationProgress(dataDirectory, project);
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.id, begun.id);
    assert.equal(finished[0]?.status, 'done');
    assert.equal(finished[0]?.phase, 'done');
    assert.equal(finished[0]?.note, HOMOLOGATION_NOTE);
    assert.ok((finished[0]?.modelCalls ?? 0) >= 1);
    assert.equal(typeof finished[0]?.durationMs, 'number');
    const reports = await listSecurityReports(dataDirectory, project);
    assert.equal(reports.some(item => item.id === begun.id && item.note.includes(HOMOLOGATION_NOTE)), true);
    assert.equal(networkCalled, false);
  } finally {
    releaseTools();
    if (observed) await observed.catch(() => undefined);
    await db.close();
    await database.close();
    await rm(repo, {recursive: true, force: true});
    await rm(dataDirectory, {recursive: true, force: true});
    await rm(databases, {recursive: true, force: true});
  }
});

test('o prazo do exame é seis horas', async () => {
  const mod = await import('../src/verify-command.ts');
  assert.equal(mod.EXAM_TIME_LIMIT_MS, 21_600_000);
});

test('prazo esgotado não chama ferramentas nem o worker', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'verify_exam_time');
  const db = new Ledger(database.url);
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-time-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-time-db-'));
  const projectId = randomUUID();
  let toolsCalled = false;
  let workerCalled = false;
  let observed: Promise<void> | undefined;
  try {
    await db.migrate();
    const begun = await beginPersonalVerification({
      projectId,
      dataDirectory,
      repoPath: dataDirectory,
      commit: 'a'.repeat(40),
      ledger: db,
      principal: 'verify-owner',
      authority: {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1},
      policyRevision: 1,
      worker: {async run() { workerCalled = true; return ''; }},
      databasesDirectory: databases,
      image: `sha256:${'ab'.repeat(32)}`,
      timeLimitMs: -1,
      runTools: async () => { toolsCalled = true; },
      observe: job => { observed = job; },
    });
    assert.equal(begun.status, 'running');
    assert.ok(observed);
    await assert.rejects(observed, (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message, 'VERIFY_EXAM_TIMEOUT');
      return true;
    });
    assert.equal(toolsCalled, false);
    assert.equal(workerCalled, false);
    const finished = await readVerificationProgress(dataDirectory, projectId);
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.id, begun.id);
    assert.equal(finished[0]?.status, 'failed');
    assert.equal(finished[0]?.phase, 'failed');
  } finally {
    if (observed) await observed.catch(() => undefined);
    await db.close();
    await database.close();
    await rm(dataDirectory, {recursive: true, force: true});
    await rm(databases, {recursive: true, force: true});
  }
});

test('contêiner alvo entra na rede interna e o laço não varre', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-net-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-netdb-'));
  const projectId = randomUUID();
  const calls: string[][] = [];
  let releaseTools = () => {};
  let stop = false;
  const gate = new Promise<void>(resolve => { releaseTools = resolve; });
  let observed: Promise<void> | undefined;
  try {
    const begun = await beginPersonalVerification({
      projectId,
      url: 'http://verify-alvo:9/app',
      dataDirectory,
      repoPath: dataDirectory,
      commit: 'ab'.repeat(20),
      ledger: {} as Ledger,
      principal: 'verify-owner',
      authority: {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1},
      policyRevision: 1,
      worker: {async run() { throw new Error('worker'); }},
      databasesDirectory: databases,
      image: `sha256:${'cd'.repeat(32)}`,
      networkRunner: async args => {
        calls.push([...args]);
        return {code: 0, stdout: args.includes('inspect') ? 'true' : ''};
      },
      runTools: async () => {
        await gate;
        if (stop) throw new Error('fim do teste');
      },
      observe: job => { observed = job; },
    });
    const network = `verify-homologation-${begun.id.replaceAll('-', '').slice(0, 8)}`;
    assert.match(network, /^verify-homologation-[a-f0-9]{8}$/);
    assert.deepEqual(calls, [
      [VERIFY_RUNTIME_BIN, 'network', 'create', '--internal', network],
      [VERIFY_RUNTIME_BIN, 'network', 'inspect', network, '--format', '{{.Internal}}'],
      [VERIFY_RUNTIME_BIN, 'network', 'connect', network, 'verify-alvo'],
    ]);
    const running = await readVerificationProgress(dataDirectory, projectId);
    assert.equal(running.length, 1);
    assert.equal(running[0]?.status, 'running');
    assert.equal(running[0]?.note, HOMOLOGATION_NOTE);
  } finally {
    if (observed) {
      stop = true;
      releaseTools();
      await observed.catch(() => undefined);
    }
    await rm(dataDirectory, {recursive: true, force: true});
    await rm(databases, {recursive: true, force: true});
  }
});
