// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {promisify} from 'node:util';
import {Capacity} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {beginPersonalVerification, defaultRunTools, evaluationSlots, NETWORK_COMMAND_TIMEOUT_MS, prepareExamSnapshot, readVerificationProgress, runBoundedCommand, type VerifyJobOutcome} from '../src/verify-command.ts';
import {VERIFY_RUNTIME_BIN} from '../src/verify-image.ts';
import {listSecurityReports} from '../src/verify-report.ts';
import type {VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const HOMOLOGATION_NOTE = 'Homologação declarada e não varrida: a imagem não tem ZAP, Nuclei nem Schemathesis.';
const PINNED_IMAGE = `sha256:${'ab'.repeat(32)}`;

async function allowHomologation(root: string, containers: readonly string[]): Promise<string> {
  const repo = join(root, 'repo');
  const data = join(root, 'private');
  await mkdir(repo, {recursive: true});
  await mkdir(data, {recursive: true});
  const file = join(root, 'installation.json');
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    mode: 'administration-only',
    databaseUrl: 'postgres://127.0.0.1/ac-verify',
    dataDirectory: data,
    project: {id: randomUUID(), label: 'Alvo', repo, owner: 'owner'},
    http: {listen: '127.0.0.1', port: 18405, publicOrigin: 'http://127.0.0.1:18405'},
    verifyHomologationContainers: containers,
  }), {mode: 0o600});
  await chmod(file, 0o600);
  return file;
}

/** A real commit in `dir`. The exam makes one git-archive snapshot when it begins, so a fake repository no longer reaches the tools. */
async function commitDirectory(dir: string): Promise<string> {
  const env = {...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.com'};
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  await exec('git', ['init', '-q'], {cwd: dir, env});
  await exec('git', ['add', 'seed.txt'], {cwd: dir, env});
  await exec('git', ['commit', '-q', '-m', 'seed'], {cwd: dir, env});
  return (await exec('git', ['rev-parse', 'HEAD'], {cwd: dir})).stdout.trim();
}

function blockedInput(dataDirectory: string, databases: string, extra: Record<string, unknown> = {}) {
  return {
    projectId: randomUUID(),
    dataDirectory,
    repoPath: dataDirectory,
    commit: 'ab'.repeat(20),
    ledger: {} as Ledger,
    principal: 'verify-owner',
    authority: {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1},
    policyRevision: 1,
    worker: {async run() { return ''; }},
    databasesDirectory: databases,
    image: PINNED_IMAGE,
    ...extra,
  };
}

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
    await capacity.registerModel(principal, {provider: 'claude', model: 'fixture-model', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verify-command'});
    const labels = ['claude-a', 'claude-b'] as const;
    const accounts = labels.map(() => randomUUID());
    const specialistProfiles = labels.map(() => randomUUID());
    const reviewerProfiles = labels.map(() => randomUUID());
    const adapters = labels.map(label => createSyntheticProviderAdapter({
      id: 'fixture-' + label,
      provider: 'claude',
      version: 'verify-v1',
      runner: async input => ({protocol: 'ac-synthetic-quota-v1', provider: 'claude', accountId: input.accountId, status: 'available', remainingPercent: 75, resetAt: null}),
    }));
    const collectors = new ProviderCollectors(db, adapters);
    for (let i = 0; i < labels.length; i++) {
      await capacity.addAccount(principal, project, {id: accounts[i], provider: 'claude', label: 'Synthetic ' + labels[i], resourceIdentity: 'verify-' + accounts[i], mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-command', maxConcurrent: 2});
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
    // A contagem da fase de exame fica gravada: arquivos julgados nunca passam do total.
    assert.equal(typeof finished[0]?.total, 'number');
    assert.ok((finished[0]?.total ?? 0) >= 1);
    assert.ok((finished[0]?.judged ?? -1) >= 0 && (finished[0]?.judged ?? 0) <= (finished[0]?.total ?? 0));
    const reports = await listSecurityReports(dataDirectory, project);
    assert.equal(reports.some(item => item.id === begun.id && item.note.includes(HOMOLOGATION_NOTE)), true);
    assert.equal(networkCalled, false);

    // An examiner that never answers a valid exam leaves the file without judgment: the report is saved, the progress is not 'done'.
    const unjudged: VerifyWorker = {async run(call) {
      return call.task.startsWith('Pedido de exame.') ? 'isto não é JSON' : benchWorker().run(call);
    }};
    let second: Promise<void> | undefined;
    let ended: VerifyJobOutcome | undefined;
    const again = await beginPersonalVerification({projectId: project, url: 'http://127.0.0.1:9/app', dataDirectory, repoPath: repo, commit,
      ledger: db, principal, authority, policyRevision: 1, worker: unjudged, databasesDirectory: databases, image, modelCalls: {count: 0},
      networkRunner: async () => ({code: 0, stdout: 'true'}), runTools: async () => {}, observe: job => { second = job; },
      onOutcome: outcome => { ended = outcome; }});
    await second;
    assert.deepEqual(ended, {status: 'incomplete', pending: 1, total: 1, partial: false});
    const incomplete = (await readVerificationProgress(dataDirectory, project)).find(row => row.id === again.id);
    assert.equal(incomplete?.status, 'incomplete');
    assert.equal(incomplete?.phase, 'done');
    assert.equal(incomplete?.pending, 1);
    assert.equal(incomplete?.total, 1);
    assert.match(incomplete?.note ?? '', /^Exame incompleto: 1 de 1 arquivos sem julgamento do examinador\./);
    const run = (await db.pool.query('SELECT status FROM ac_verify_runs WHERE id=$1', [again.id])).rows[0];
    assert.equal(run?.status, 'done', 'o relatório gravado continua utilizável');
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

test('o módulo 1 roda tantas fatias de uma vez quantas são as vagas de avaliação da instalação', async () => {
  const ledgerWith = (query: unknown) => ({pool: {query}}) as unknown as Ledger;
  assert.equal(await evaluationSlots(ledgerWith(async (sql: string) => {
    assert.match(sql, /SELECT evaluation_limit FROM ac_capacity_config WHERE id=1/);
    return {rows: [{evaluation_limit: 3}]};
  })), 3);
  // Without a readable configuration the slices run one at a time.
  assert.equal(await evaluationSlots(ledgerWith(async () => ({rows: []}))), 1);
  assert.equal(await evaluationSlots(ledgerWith(async () => ({rows: [{evaluation_limit: 0}]}))), 1);
  assert.equal(await evaluationSlots(ledgerWith(async () => { throw new Error('sem tabela'); })), 1);
  assert.equal(await evaluationSlots({} as unknown as Ledger), 1);
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
    const seed = await commitDirectory(dataDirectory);
    const begun = await beginPersonalVerification({
      projectId,
      dataDirectory,
      repoPath: dataDirectory,
      commit: seed,
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

test('snapshot que falha não deixa andamento "running" nem bloqueia o exame seguinte', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'verify_snap_fail');
  const db = new Ledger(database.url);
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-snapfail-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-snapfail-db-'));
  const projectId = randomUUID();
  let toolsCalled = false;
  try {
    await db.migrate();
    await commitDirectory(dataDirectory);
    const attempt = () => beginPersonalVerification({
      projectId,
      dataDirectory,
      repoPath: dataDirectory,
      commit: 'e'.repeat(40), // valid shape, absent from the repository: git archive fails
      ledger: db,
      principal: 'verify-owner',
      authority: {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1},
      policyRevision: 1,
      worker: {async run() { return ''; }},
      databasesDirectory: databases,
      image: PINNED_IMAGE,
      runTools: async () => { toolsCalled = true; },
    });
    for (let round = 0; round < 2; round++) {
      await assert.rejects(attempt, (error: unknown) => {
        assert.equal(error instanceof Refusal && error.code === 'VERIFY_ALREADY_RUNNING', false, 'a falha do snapshot não pode virar VERIFY_ALREADY_RUNNING');
        return true;
      });
      assert.deepEqual(await readVerificationProgress(dataDirectory, projectId), []);
      const leftovers = await readdir(join(dataDirectory, 'verificacoes', projectId, 'andamento'));
      assert.deepEqual(leftovers, []);
    }
    assert.equal(toolsCalled, false);
  } finally {
    await db.close();
    await database.close();
    await rm(dataDirectory, {recursive: true, force: true});
    await rm(databases, {recursive: true, force: true});
  }
});

test('contêiner alvo entra na rede interna e o laço não varre', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-net-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-netdb-'));
  const installRoot = await mkdtemp(join(tmpdir(), 'ac-verify-allow-'));
  const projectId = randomUUID();
  const calls: string[][] = [];
  let releaseTools = () => {};
  let stop = false;
  const gate = new Promise<void>(resolve => { releaseTools = resolve; });
  let observed: Promise<void> | undefined;
  let network = '';
  try {
    const installationPath = await allowHomologation(installRoot, ['verify-alvo']);
    const seed = await commitDirectory(dataDirectory);
    const begun = await beginPersonalVerification({
      projectId,
      url: 'http://verify-alvo:9/app',
      dataDirectory,
      repoPath: dataDirectory,
      commit: seed,
      ledger: {} as Ledger,
      principal: 'verify-owner',
      authority: {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1},
      policyRevision: 1,
      worker: {async run() { throw new Error('worker'); }},
      databasesDirectory: databases,
      image: `sha256:${'cd'.repeat(32)}`,
      installationPath,
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
    network = `verify-homologation-${begun.id.replaceAll('-', '').slice(0, 8)}`;
    assert.match(network, /^verify-homologation-[a-f0-9]{8}$/);
    assert.deepEqual(calls, [
      // The homologation network carries the installation, project and kind ownership labels.
      [VERIFY_RUNTIME_BIN, 'network', 'create', '--internal',
        '--label', `com.agent-control.installation=${basename(dataDirectory)}`, '--label', `com.agent-control.project=${projectId}`,
        '--label', 'com.agent-control.kind=verify-dynamic-network', network],
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
      assert.deepEqual(calls.slice(-2), [
        [VERIFY_RUNTIME_BIN, 'network', 'disconnect', network, 'verify-alvo'],
        [VERIFY_RUNTIME_BIN, 'network', 'rm', network],
      ]);
      await assert.rejects(stat(join(dataDirectory, 'verificacoes', projectId, 'andamento', '.running')));
    }
    await rm(dataDirectory, {recursive: true, force: true});
    await rm(databases, {recursive: true, force: true});
    await rm(installRoot, {recursive: true, force: true});
  }
});

test('execução running no ledger ou no andamento responde 409 e não chama ferramentas', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-busy-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-busy-db-'));
  const projectId = randomUUID();
  let tools = 0;
  const runningLedger = {
    pool: {query: async (sql: string) => {
      assert.match(sql, /ac_verify_runs/);
      // Um módulo 2 a 10 rodando não bloqueia a segurança: só uma rodada de segurança conta.
      assert.match(sql, /module = 'verify'/);
      return {rows: [{present: 1}], rowCount: 1};
    }},
  } as unknown as Ledger;
  try {
    await assert.rejects(() => beginPersonalVerification({
      ...blockedInput(dataDirectory, databases, {projectId, ledger: runningLedger}),
      runTools: async () => { tools += 1; },
    }), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_ALREADY_RUNNING' && error.status === 409);
    assert.equal(tools, 0);
    const progressDir = join(dataDirectory, 'verificacoes', projectId, 'andamento');
    await mkdir(progressDir, {recursive: true});
    await writeFile(join(progressDir, 'running.json'), JSON.stringify({
      id: randomUUID(), status: 'running', phase: 'ferramentas', startedAt: '2026-11-17T00:00:00.000Z',
    }));
    await assert.rejects(() => beginPersonalVerification({
      ...blockedInput(dataDirectory, databases, {projectId}),
      runTools: async () => { tools += 1; },
    }), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_ALREADY_RUNNING' && error.status === 409);
    assert.equal(tools, 0);
    await rm(join(progressDir, 'running.json'));
    await writeFile(join(progressDir, '.running'), 'other-run', {flag: 'wx'});
    await assert.rejects(() => beginPersonalVerification({
      ...blockedInput(dataDirectory, databases, {projectId}),
      runTools: async () => { tools += 1; },
    }), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_ALREADY_RUNNING' && error.status === 409);
    assert.equal(tools, 0);
    assert.equal(await readFile(join(progressDir, '.running'), 'utf8'), 'other-run');
  } finally {
    await rm(dataDirectory, {recursive: true, force: true});
    await rm(databases, {recursive: true, force: true});
  }
});

test('andamentos running de rodadas terminais não bloqueiam a próxima verificação', async () => {
  const root = await mkdtemp(join(tmpdir(),'ac-verify-terminal-progress-'));
  const projectId = randomUUID();
  const failed = randomUUID();
  const done = randomUUID();
  const directory = join(root,'verificacoes',projectId,'andamento');
  const marker = join(directory,'.running');
  let observed: Promise<void>|undefined;
  try {
    const commit = await commitDirectory(root);
    await mkdir(directory,{recursive:true});
    for (const id of [failed,done]) {
      await writeFile(join(directory,id+'.json'),JSON.stringify({id,status:'running',phase:'ferramentas',startedAt:new Date().toISOString()}));
    }
    await writeFile(marker,failed);
    const ledger = {pool:{query:async(sql:string,params:unknown[])=>{
      if (sql.includes("status = 'running'")) return {rows:[],rowCount:0};
      assert.match(sql,/status IN \('failed','done'\)/);
      assert.equal(params[0],projectId);
      assert.deepEqual(new Set(params[1] as string[]),new Set([failed,done]));
      return {rows:[{id:failed},{id:done}],rowCount:2};
    }}} as unknown as Ledger;
    const begun = await beginPersonalVerification({
      ...blockedInput(root,root,{projectId,commit,ledger}),
      runTools:async()=>{throw Error('fim da coleta de teste');},
      observe:job=>{observed=job;},
    });
    assert.notEqual(begun.id,failed);
    assert.notEqual(begun.id,done);
    for (const id of [failed,done]) await assert.rejects(stat(join(directory,id+'.json')),{code:'ENOENT'});
    await assert.rejects(observed!,/fim da coleta de teste/);
    await assert.rejects(stat(marker),{code:'ENOENT'});
  } finally {
    await observed?.catch(()=>undefined);
    await rm(root,{recursive:true,force:true});
  }
});

test('contêiner fora da lista não cria rede; na lista, o rm acontece se as ferramentas lançam', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-forbid-'));
  const databases = await mkdtemp(join(tmpdir(), 'ac-verify-forbid-db-'));
  const installRoot = await mkdtemp(join(tmpdir(), 'ac-verify-forbid-inst-'));
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    return {code: 0, stdout: args.includes('inspect') ? 'true' : ''};
  };
  let tools = 0;
  let observed: Promise<void> | undefined;
  try {
    const seed = await commitDirectory(dataDirectory);
    await assert.rejects(() => beginPersonalVerification({
      ...blockedInput(dataDirectory, databases, {
        url: 'http://verify-alvo:9/app',
        networkRunner: run,
      }),
      runTools: async () => { tools += 1; },
    }), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_TARGET_FORBIDDEN' && error.status === 403);
    assert.equal(calls.length, 0);
    assert.equal(tools, 0);
    const installationPath = await allowHomologation(installRoot, ['outro-alvo']);
    await assert.rejects(() => beginPersonalVerification({
      ...blockedInput(dataDirectory, databases, {
        url: 'http://verify-alvo:9/app',
        installationPath,
        networkRunner: run,
      }),
      runTools: async () => { tools += 1; },
    }), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_TARGET_FORBIDDEN' && error.status === 403);
    assert.equal(calls.length, 0);
    const allowed = await allowHomologation(installRoot, ['verify-alvo']);
    await beginPersonalVerification({
      ...blockedInput(dataDirectory, databases, {
        url: 'http://verify-alvo:9/app',
        installationPath: allowed,
        networkRunner: run,
        commit: seed,
      }),
      runTools: async () => { tools += 1; throw new Error('ferramentas'); },
      observe: job => { observed = job; },
    });
    assert.equal(tools, 1);
    assert.ok(observed);
    await assert.rejects(observed);
    assert.equal(calls.some(args => args[2] === 'rm' && args[3]?.startsWith('verify-homologation-')), true);
    assert.equal(calls.some(args => args[2] === 'disconnect'), true);
  } finally {
    if (observed) await observed.catch(() => undefined);
    await rm(dataDirectory, {recursive: true, force: true});
    await rm(databases, {recursive: true, force: true});
    await rm(installRoot, {recursive: true, force: true});
  }
});

test('comando de rede não fica pendurado além do prazo', async () => {
  assert.equal(NETWORK_COMMAND_TIMEOUT_MS, 30_000);
  const started = Date.now();
  const result = await runBoundedCommand(['/bin/sleep', '30'], 300);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 5_000);
});

test('o archive do commit não inclui arquivo uncommitted e não é o repo vivo', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-archive-'));
  const gitEnv = {...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.com'};
  let snapshot = '';
  try {
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, 'src', 'kept.txt'), 'committed\n');
    await exec('git', ['init'], {cwd: repo, env: gitEnv});
    await exec('git', ['add', 'src/kept.txt'], {cwd: repo, env: gitEnv});
    await exec('git', ['-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'base'], {cwd: repo, env: gitEnv});
    const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo})).stdout.trim();
    await writeFile(join(repo, 'src', 'kept.txt'), 'dirty\n');
    await writeFile(join(repo, 'src', 'later.txt'), 'uncommitted\n');
    snapshot = await prepareExamSnapshot(repo, commit);
    assert.notEqual(snapshot, repo);
    assert.equal((await stat(snapshot)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(snapshot, 'src', 'kept.txt'), 'utf8'), 'committed\n');
    await assert.rejects(stat(join(snapshot, 'src', 'later.txt')));
    const output = await mkdtemp(join(tmpdir(), 'ac-verify-archive-out-'));
    const databases = await mkdtemp(join(tmpdir(), 'ac-verify-archive-db-'));
    let mounted = '';
    try {
      await defaultRunTools({image: PINNED_IMAGE, repository: repo, databases, output, commit}, 5_000, async args => {
        const mount = args.find(item => item.startsWith('type=bind,src=') && item.includes(',dst=/repository,readonly'))!;
        const path = mount.slice('type=bind,src='.length).split(',')[0]!;
        assert.equal((await stat(path)).mode & 0o777, 0o700);
        mounted = path;
      });
      assert.notEqual(mounted, '');
      await assert.rejects(stat(mounted), {code: 'ENOENT'});
      await defaultRunTools({
        image: PINNED_IMAGE,
        repository: repo,
        databases,
        output,
        commit,
        staticPersonalExam: true,
      }, 5_000, async args => {
        const mount = args.find(item => item.startsWith('type=bind,src=') && item.includes(',dst=/repository,readonly'));
        mounted = mount?.slice('type=bind,src='.length).split(',')[0] ?? '';
        assert.notEqual(mounted, repo);
        assert.equal((await stat(join(mounted, '..'))).mode & 0o777, 0o700);
        assert.equal((await stat(mounted)).mode & 0o777, 0o755);
        assert.equal((await stat(join(mounted, 'src'))).mode & 0o005, 0o005);
        assert.equal((await stat(join(mounted, 'src/kept.txt'))).mode & 0o004, 0o004);
        assert.equal(await readFile(join(mounted, 'src', 'kept.txt'), 'utf8'), 'committed\n');
        await assert.rejects(stat(join(mounted, 'src', 'later.txt')));
        throw new Error('ferramentas falharam');
      });
      assert.fail('deveria lançar');
    } catch (error) {
      assert.equal(error instanceof Error && error.message === 'ferramentas falharam', true);
      assert.notEqual(mounted, '');
      await assert.rejects(stat(mounted), {code: 'ENOENT'});
      await assert.rejects(stat(join(mounted, '..')), {code: 'ENOENT'});
    } finally {
      await rm(output, {recursive: true, force: true});
      await rm(databases, {recursive: true, force: true});
    }
  } finally {
    if (snapshot) await rm(snapshot, {recursive: true, force: true});
    await rm(repo, {recursive: true, force: true});
  }
});

test('o carimbo da base é reivindicado no início e solto se o exame falha', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-stamp-'));
  const databases = join(dataDirectory, 'verify-db', '20261117-030405');
  const projectId = randomUUID();
  let observed: Promise<void> | undefined;
  let sawStamp = false;
  let claimName = '';
  let toolsDir = '';
  try {
    await mkdir(databases, {recursive: true, mode: 0o700});
    // A published stamp always has its manifest; the exam confirms it after claiming.
    await writeFile(join(databases, 'manifest.json'), '{}\n');
    const seed = await commitDirectory(dataDirectory);
    const started = await beginPersonalVerification({
      ...blockedInput(dataDirectory, databases, {projectId, commit: seed}),
      runTools: async () => {
        const dir = join(dataDirectory, 'verify-db', 'in-use');
        const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
        assert.equal(names.length, 1);
        claimName = names[0] ?? '';
        const held = JSON.parse(await readFile(join(dir, claimName), 'utf8')) as {stamp: string; pid: number; claimedAt: string};
        sawStamp = held.stamp === databases && held.pid === process.pid && Number.isNaN(Date.parse(held.claimedAt)) === false;
        assert.equal((await stat(join(dir, claimName))).mode & 0o777, 0o600);
        toolsDir = join(dataDirectory, 'verificacoes', projectId, 'ferramentas');
        assert.equal((await readdir(toolsDir)).length, 1);
        throw new Error('ferramentas falharam');
      },
      observe: job => { observed = job; },
    });
    assert.ok(observed);
    await assert.rejects(observed, (error: unknown) => error instanceof Error && error.message === 'ferramentas falharam');
    assert.equal(sawStamp, true);
    assert.equal(claimName, `${started.id}.json`);
    assert.deepEqual(await readdir(join(dataDirectory, 'verify-db', 'in-use')), []);
    await assert.rejects(stat(join(dataDirectory, 'verificacoes', projectId, 'andamento', '.running')));
    const progress = await readVerificationProgress(dataDirectory, projectId);
    assert.equal(progress[0]?.status, 'failed');
    assert.deepEqual(await readdir(toolsDir), []);
  } finally {
    if (observed) await observed.catch(() => undefined);
    await rm(dataDirectory, {recursive: true, force: true});
  }
});

test('uma base podada entre a leitura do current.json e a reivindicação recusa o exame e solta o claim', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-stamp-gone-'));
  const databases = join(dataDirectory, 'verify-db', '20261117-030405');
  const projectId = randomUUID();
  let toolsCalled = false;
  try {
    // A pasta existe mas já não tem manifest: foi posta de lado por uma poda.
    await mkdir(databases, {recursive: true, mode: 0o700});
    const seed = await commitDirectory(dataDirectory);
    await assert.rejects(beginPersonalVerification({
      ...blockedInput(dataDirectory, databases, {projectId, commit: seed}),
      runTools: async () => { toolsCalled = true; },
    }), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_DB_REPLACED');
    assert.equal(toolsCalled, false);
    assert.deepEqual(await readdir(join(dataDirectory, 'verify-db', 'in-use')), []);
    await assert.rejects(stat(join(dataDirectory, 'verificacoes', projectId, 'andamento', '.running')));
  } finally {
    await rm(dataDirectory, {recursive: true, force: true});
  }
});

test('o andamento só aceita contagem coerente de arquivos julgados', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-progress-'));
  try {
    const project = randomUUID();
    const directory = join(dataDirectory, 'verificacoes', project, 'andamento');
    await mkdir(directory, {recursive: true});
    const base = {status: 'running', phase: 'exame', startedAt: '2026-11-22T10:00:00.000Z'};
    await writeFile(join(directory, 'a.json'), JSON.stringify({...base, id: 'a', judged: 40, total: 120, modelCalls: 9}));
    await writeFile(join(directory, 'b.json'), JSON.stringify({...base, id: 'b', judged: 130, total: 120}));
    await writeFile(join(directory, 'c.json'), JSON.stringify({...base, id: 'c', judged: '4', total: 9}));
    const rows = await readVerificationProgress(dataDirectory, project);
    assert.deepEqual(rows.map(row => [row.id, row.judged, row.total]), [['a', 40, 120], ['b', undefined, undefined], ['c', undefined, undefined]]);
    assert.equal(rows[0]?.modelCalls, 9);
  } finally {
    await rm(dataDirectory, {recursive: true, force: true});
  }
});
