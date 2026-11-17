import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {promisify} from 'node:util';
import {Capacity} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {ProviderCollectors} from '../src/providers.ts';
import {createSyntheticProviderAdapter} from '../src/synthetic-provider-adapter.ts';
import {createPersonalVerifyWorker, buildReadonlyExamRequest} from '../src/verify-personal-worker.ts';
import {runSecurityVerification} from '../src/verify-runtime.ts';
import {REMEDIATION_ACCEPTANCE, type VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const SENTINEL = 'SENTINELA-EXAMINADOR-NAO-VAZAR';
const SUGGESTION = 'NAO-MOSTRAR-SUGESTAO';

async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full));
    }
  };
  await walk(root);
  return out.sort();
}

function benchWorker(): {worker: VerifyWorker; roles: string[]; confirmTask: string} {
  const roles: string[] = [];
  let confirmTask = '';
  const worker: VerifyWorker = {
    async run(call) {
      assert.equal(call.writePaths.length, 0);
      roles.push(call.role);
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
            scenario: SENTINEL,
            suggestion: SUGGESTION,
            cwe: 'CWE-862',
            reference: 'ASVS-5.0-V4',
            snippet: "app.get('/admin', () => 'painel')",
          }],
        });
      }
      if (task.startsWith('Pedido de confirmação.')) {
        confirmTask = task;
        if (task.includes(SENTINEL) || task.includes(SUGGESTION)) throw new Error('sentinela vazou para a task do revisor');
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
  return {worker, roles, get confirmTask() { return confirmTask; }};
}

test('verificação somente leitura confirma com revisor de outro provedor', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'verify_runtime');
  const db = new Ledger(database.url);
  const capacity = new Capacity(db);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-repo-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  const bench = benchWorker();
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
      await capacity.registerModel(principal, {provider: providers[i], model: 'fixture-model', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verify-runtime'});
      await capacity.addAccount(principal, project, {id: accounts[i], provider: providers[i], label: 'Synthetic ' + providers[i], resourceIdentity: 'verify-' + accounts[i], mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-runtime', maxConcurrent: 2});
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
    const source = "export function register(app: {get(path: string, handler: () => string): void}) {\n  app.get('/admin', () => 'painel');\n}\n";
    await writeFile(join(repo, 'src', 'app.ts'), source);
    const gitEnv = {...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.com'};
    await exec('git', ['init'], {cwd: repo, env: gitEnv});
    await exec('git', ['add', 'src/app.ts'], {cwd: repo, env: gitEnv});
    await exec('git', ['-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'rota sem checagem'], {cwd: repo, env: gitEnv});
    const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo})).stdout.trim();
    assert.match(commit, /^[a-f0-9]{40}$/);
    const before = await tree(repo);
    const authority = await db.acquire(principal, context, randomUUID(), 'verify-runtime', 60);
    const base = {ledger: db, principal, authority, projectId: project, repoPath: repo, dataDirectory, commit, policyRevision: 1, worker: bench.worker};
    await assert.rejects(() => runSecurityVerification(base), (error: unknown) => {
      assert.equal(error instanceof Refusal, true);
      assert.equal((error as Refusal).code, 'PERSONAL_ACTIVATION_REQUIRED');
      return true;
    });
    assert.equal(bench.roles.length, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_intents')).rows[0].n, 0);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");
    for (const accountId of accounts) await collectors.collect(principal, project, accountId, randomUUID());
    const result = await runSecurityVerification(base);
    assert.equal(result.achados.length, 1);
    assert.equal(result.achados[0].id, 'ACH-001');
    assert.equal(result.achados[0].status, 'confirmado');
    assert.equal(result.achados[0].scenario, SENTINEL);
    assert.equal(result.achados[0].suggestion, SUGGESTION);
    assert.equal(result.achados[0].acceptance, REMEDIATION_ACCEPTANCE);
    assert.equal(result.achados[0].secretPreview, null);
    assert.equal(bench.roles.at(-1), 'reviewer');
    assert.ok(bench.roles.slice(0, -1).every(role => role === 'specialist'));
    assert.equal(bench.confirmTask.includes(SENTINEL), false);
    assert.equal(bench.confirmTask.includes(SUGGESTION), false);
    assert.match(bench.confirmTask, /src\/app\.ts/);
    assert.match(bench.confirmTask, /app\.get\('\/admin'/);
    assert.ok(result.coverage.some(row => row.file.replaceAll('\\', '/').endsWith('src/app.ts')));
    assert.ok(result.directory.startsWith(dataDirectory));
    assert.deepEqual(await tree(repo), before);
    assert.equal(await readFile(join(repo, 'src', 'app.ts'), 'utf8'), source);
    const stored = (await db.pool.query('SELECT intent_id, status, report_dir FROM ac_verify_runs WHERE id=$1', [result.runId])).rows[0];
    assert.equal(stored.status, 'done');
    assert.equal(stored.report_dir, result.directory);
    const intent = (await db.pool.query('SELECT state, command FROM ac_intents WHERE id=$1', [stored.intent_id])).rows[0];
    assert.equal(intent.state, 'done');
    assert.equal(intent.command.payload.workflow, 'security-verify-readonly-v1');
    assert.equal(Object.hasOwn(intent.command.payload, 'writePaths'), false);
    assert.equal(intent.command.payload.commit, commit);
    const finding = (await db.pool.query('SELECT achado_id, status FROM ac_verify_findings WHERE run_id=$1', [result.runId])).rows[0];
    assert.equal(finding.achado_id, 'ACH-001');
    assert.equal(finding.status, 'confirmado');
    const covered = (await db.pool.query('SELECT file, examiner_provider FROM ac_verify_coverage WHERE run_id=$1', [result.runId])).rows;
    assert.ok(covered.some(row => String(row.file).replaceAll('\\', '/').endsWith('src/app.ts')));
    const grants = (await db.pool.query(
      `SELECT g.role, a.provider, g.state FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id
       WHERE g.intent_id=$1 ORDER BY g.created_at`,
      [stored.intent_id],
    )).rows;
    const specialists = grants.filter(row => row.role === 'specialist');
    const reviewers = grants.filter(row => row.role === 'reviewer');
    assert.ok(specialists.length >= 1);
    assert.equal(reviewers.length, 1);
    assert.notEqual(reviewers[0].provider, specialists[specialists.length - 1].provider);
    assert.equal(result.achados[0].verifier?.provider, reviewers[0].provider);
    assert.ok(grants.every(row => row.state === 'released'));
    console.log(JSON.stringify({
      specialist: specialists.map(row => row.provider),
      reviewer: reviewers.map(row => row.provider),
      states: grants.map(row => `${row.role}:${row.provider}:${row.state}`),
    }));
  } finally {
    await db.close();
    await database.close();
    await rm(repo, {recursive: true, force: true});
    await rm(dataDirectory, {recursive: true, force: true});
  }
});

test('worker pessoal pede exame sem caminhos de escrita', async () => {
  const identity = {
    provider: 'grok',
    accountId: randomUUID(),
    profileId: randomUUID(),
    model: 'fixture-model',
    grantId: randomUUID(),
    intentId: randomUUID(),
    repo: '/tmp/repo-leitura',
  };
  let seen: {role: string; writePaths: readonly string[]; intentId: string; grantId: string} | undefined;
  const worker = createPersonalVerifyWorker({
    launch: async request => {
      seen = request;
      assert.equal(request.writePaths.length, 0);
      assert.ok(request.role === 'specialist' || request.role === 'reviewer');
      return '{"ok":true}';
    },
    identity,
  });
  const text = await worker.run({
    role: 'specialist',
    provider: identity.provider,
    accountId: identity.accountId,
    profileId: identity.profileId,
    model: identity.model,
    grantId: identity.grantId,
    intentId: identity.intentId,
    task: 'Pedido de exame.',
    repo: identity.repo,
    writePaths: [],
  });
  assert.equal(text, '{"ok":true}');
  assert.equal(seen?.writePaths.length, 0);
  assert.equal(seen?.role, 'specialist');
  const request = buildReadonlyExamRequest({
    jobId: randomUUID(),
    intentId: identity.intentId,
    grantId: identity.grantId,
    sessionId: randomUUID(),
    base: 'a'.repeat(40),
    role: 'reviewer',
    task: 'Pedido de confirmação.',
    artifactId: randomUUID(),
  });
  assert.equal(request.writePaths.length, 0);
  assert.equal(request.role, 'reviewer');
  assert.equal(typeof request.outputSchema, 'object');
});
