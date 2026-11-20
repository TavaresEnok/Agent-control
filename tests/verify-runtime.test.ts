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
import {secretPreview} from '../src/verify-redact.ts';
import {buildHistoryGitInvocation, coerceExamResult, DEFAULT_MODEL_CALL_BUDGET, deletedHistoryExcerpt, hasRefusedSecretText, readRepoText, runSecurityVerification} from '../src/verify-runtime.ts';
import {listExamFiles} from '../src/verify-slices.ts';
import {ExamResult, REMEDIATION_ACCEPTANCE, type RawFinding, type VerifyWorker} from '../src/verify-types.ts';
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

test('verificação somente leitura confirma com revisor Claude em outra conta', async () => {
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
    await capacity.registerModel(principal, {provider: 'claude', model: 'fixture-model', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verify-runtime'});
    await capacity.registerModel(principal, {provider: 'codex', model: 'gpt-6.1-sol', efforts: ['medium'], roles: ['reviewer'], source: 'synthetic://verify-runtime'});
    const labels = ['claude-a', 'claude-b'] as const;
    const accounts = labels.map(() => randomUUID());
    const specialistProfiles = labels.map(() => randomUUID());
    const codexAccount = randomUUID();
    const codexReviewer = randomUUID();
    const adapters = labels.map(label => createSyntheticProviderAdapter({
      id: 'fixture-' + label,
      provider: 'claude',
      version: 'verify-v1',
      runner: async input => ({protocol: 'ac-synthetic-quota-v1', provider: 'claude', accountId: input.accountId, status: 'available', remainingPercent: 75, resetAt: null}),
    }));
    const codexAdapter = createSyntheticProviderAdapter({
      id: 'fixture-codex-reviewer',
      provider: 'codex',
      version: 'verify-v1',
      runner: async input => ({protocol: 'ac-synthetic-quota-v1', provider: 'codex', accountId: input.accountId, status: 'available', remainingPercent: 75, resetAt: null}),
    });
    const collectors = new ProviderCollectors(db, [...adapters, codexAdapter]);
    for (let i = 0; i < labels.length; i++) {
      await capacity.addAccount(principal, project, {id: accounts[i], provider: 'claude', label: 'Synthetic ' + labels[i], resourceIdentity: 'verify-' + accounts[i], mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-runtime', maxConcurrent: 2});
      await capacity.addProfile(principal, project, {id: specialistProfiles[i], accountId: accounts[i], model: 'fixture-model', effort: 'medium', role: 'specialist'});
      await collectors.bind(principal, project, {accountId: accounts[i], adapterId: adapters[i].manifest.id, expectedRevision: 0, minimumIntervalSeconds: 1});
    }
    await capacity.addAccount(principal, project, {id: codexAccount, provider: 'codex', label: 'Synthetic codex', resourceIdentity: 'verify-' + codexAccount, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-runtime', maxConcurrent: 2});
    await capacity.addProfile(principal, project, {id: codexReviewer, accountId: codexAccount, model: 'gpt-6.1-sol', effort: 'medium', role: 'reviewer'});
    await collectors.bind(principal, project, {accountId: codexAccount, adapterId: codexAdapter.manifest.id, expectedRevision: 0, minimumIntervalSeconds: 1});
    const revision = await capacity.publish(principal, project, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 1,
      roles: {specialist: {regular: [specialistProfiles[0]!], emergency: [specialistProfiles[1]!]}, reviewer: {regular: [codexReviewer], emergency: []}},
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
    for (const accountId of [...accounts, codexAccount]) await collectors.collect(principal, project, accountId, randomUUID());
    const result = await runSecurityVerification(base);
    assert.equal(result.achados.length, 1);
    assert.equal(result.achados[0].id, 'ACH-001');
    assert.equal(result.achados[0].status, 'confirmado');
    assert.equal(result.achados[0].scenario, SENTINEL);
    assert.equal(result.achados[0].suggestion, SUGGESTION);
    assert.equal(result.achados[0].acceptance, REMEDIATION_ACCEPTANCE);
    assert.equal(result.achados[0].secretPreview, null);
    assert.ok(bench.roles.length >= 2);
    assert.ok(bench.roles.every(role => role === 'specialist'));
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
      `SELECT g.role, a.provider, g.account_id, g.profile_id, g.state FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id
       WHERE g.intent_id=$1 ORDER BY g.created_at`,
      [stored.intent_id],
    )).rows;
    const specialists = grants.filter(row => row.role === 'specialist');
    const reviewers = grants.filter(row => row.role === 'reviewer');
    assert.ok(specialists.length >= 2);
    assert.equal(reviewers.length, 0);
    assert.ok(specialists.every(row => row.provider === 'claude'));
    const confirmGrant = specialists.at(-1)!;
    const examGrant = specialists.at(-2)!;
    assert.notEqual(String(confirmGrant.profile_id), String(examGrant.profile_id));
    assert.notEqual(String(confirmGrant.account_id), String(examGrant.account_id));
    assert.equal(result.achados[0].verifier?.provider, confirmGrant.provider);
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

test('validador sem segundo perfil Claude na cadeia specialist recusa com DESIGN_REVIEWER_UNAVAILABLE e ignora reviewer Codex', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'verify_no_rev');
  const db = new Ledger(database.url);
  const capacity = new Capacity(db);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-repo-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  const bench = benchWorker();
  try {
    await db.migrate();
    const principal = 'verify-owner';
    const project = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Sem Segundo Specialist']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 2});
    await capacity.registerModel(principal, {provider: 'claude', model: 'fixture-model', efforts: ['medium'], roles: ['specialist'], source: 'synthetic://verify-runtime'});
    await capacity.registerModel(principal, {provider: 'codex', model: 'gpt-6.1-sol', efforts: ['medium'], roles: ['reviewer'], source: 'synthetic://verify-runtime'});
    const claudeAccount = randomUUID();
    const codexAccount = randomUUID();
    const specProfile = randomUUID();
    const codexReviewer = randomUUID();
    await capacity.addAccount(principal, project, {id: claudeAccount, provider: 'claude', label: 'claude-only', resourceIdentity: `claude:${claudeAccount}`, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-runtime', maxConcurrent: 2});
    await capacity.addAccount(principal, project, {id: codexAccount, provider: 'codex', label: 'codex-rev', resourceIdentity: `codex:${codexAccount}`, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-runtime', maxConcurrent: 2});
    await capacity.addProfile(principal, project, {id: specProfile, accountId: claudeAccount, model: 'fixture-model', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: codexReviewer, accountId: codexAccount, model: 'gpt-6.1-sol', effort: 'medium', role: 'reviewer'});
    await capacity.observeQuota(principal, claudeAccount, {status: 'available', source: 'synthetic://verify-runtime', ttlSeconds: 3600});
    await capacity.observeQuota(principal, codexAccount, {status: 'available', source: 'synthetic://verify-runtime', ttlSeconds: 3600});
    const revision = await capacity.publish(principal, project, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 1,
      roles: {specialist: {regular: [specProfile], emergency: []}, reviewer: {regular: [codexReviewer], emergency: []}},
    });
    const context = await db.createContext(principal, project, randomUUID());
    await capacity.assignPolicy(principal, context, revision);
    await mkdir(join(repo, 'src'), {recursive: true});
    await writeFile(join(repo, 'src', 'app.ts'), "export function register(app: {get(path: string, handler: () => string): void}) {\n  app.get('/admin', () => 'painel');\n}\n");
    const gitEnv = {...process.env, GIT_AUTHOR_NAME: 'verify', GIT_AUTHOR_EMAIL: 'verify@example.com', GIT_COMMITTER_NAME: 'verify', GIT_COMMITTER_EMAIL: 'verify@example.com'};
    await exec('git', ['init'], {cwd: repo, env: gitEnv});
    await exec('git', ['add', 'src/app.ts'], {cwd: repo, env: gitEnv});
    await exec('git', ['-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'init'], {cwd: repo, env: gitEnv});
    const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo})).stdout.trim();
    const authority = await db.acquire(principal, context, randomUUID(), 'verify-no-rev', 60);
    await assert.rejects(
      () => runSecurityVerification({ledger: db, principal, authority, projectId: project, repoPath: repo, dataDirectory, commit, policyRevision: revision, worker: bench.worker}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_REVIEWER_UNAVAILABLE',
    );
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ac_capacity_grants WHERE role='reviewer'")).rows[0].n, 0);
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

test('..evil dentro do repositório não conta como fora', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'verify_rt_out');
  const db = new Ledger(database.url);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-repo-'));
  const outside = await mkdtemp(join(tmpdir(), 'ac-verify-out-'));
  const inside = join(repo, '..evil');
  await mkdir(inside);
  try {
    await db.migrate();
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const authority = {contextId: randomUUID(), instanceId: randomUUID(), epoch: 1};
    const base = {
      ledger: db,
      principal: 'verify-owner',
      authority,
      projectId: randomUUID(),
      repoPath: repo,
      dataDirectory: outside,
      commit: '0123456789abcdef0123456789abcdef01234567',
      policyRevision: 1,
      worker: {async run() { return '{}'; }},
    };
    let outsideCode = '';
    try {
      await runSecurityVerification(base);
    } catch (error) {
      outsideCode = error instanceof Refusal ? error.code : 'other';
    }
    assert.notEqual(outsideCode, 'VERIFY_REPORT_INSIDE_REPO');
    await assert.rejects(() => runSecurityVerification({...base, dataDirectory: inside}), (error: unknown) => {
      assert.equal(error instanceof Refusal, true);
      assert.equal((error as Refusal).code, 'VERIFY_REPORT_INSIDE_REPO');
      return true;
    });
  } finally {
    await db.close();
    await database.close();
    await rm(repo, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});

async function bootVerify(label: string) {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, label);
  const db = new Ledger(database.url);
  const capacity = new Capacity(db);
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-repo-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'ac-verify-data-'));
  await db.migrate();
  const principal = 'verify-owner';
  const project = randomUUID();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Verificação']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
  await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 2});
  await capacity.registerModel(principal, {provider: 'claude', model: 'fixture-model', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verify-runtime'});
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
    await capacity.addAccount(principal, project, {id: accounts[i], provider: 'claude', label: 'Synthetic ' + labels[i], resourceIdentity: 'verify-' + accounts[i], mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://verify-runtime', maxConcurrent: 2});
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
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await db.pool.query("UPDATE ac_provider_bindings SET last_started_at=clock_timestamp()-interval '2 seconds'");
  for (const accountId of accounts) await collectors.collect(principal, project, accountId, randomUUID());
  const authority = await db.acquire(principal, context, randomUUID(), label, 60);
  return {
    db, database, repo, dataDirectory, principal, project, authority,
    async close() {
      await db.close();
      await database.close();
      await rm(repo, {recursive: true, force: true});
      await rm(dataDirectory, {recursive: true, force: true});
    },
  };
}

function examWorker(confirmTasks: string[], findings: unknown[], onCall?: () => Promise<void>): VerifyWorker {
  return {
    async run(call) {
      if (onCall) await onCall();
      const task = call.task;
      if (task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: ['http']});
      if (task.startsWith('Pedido de exame.')) {
        const items = (task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        return JSON.stringify({
          kind: 'exame',
          filesRead: ['identity.ts'],
          checklist: items.length ? items : ['SEM-ITEM'],
          findings,
        });
      }
      if (task.startsWith('Pedido de confirmação.')) {
        confirmTasks.push(task);
        return JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'nao reproduz', proof: 'sem prova'});
      }
      throw new Error('task desconhecida');
    },
  };
}

async function reportBlob(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) parts.push(await readFile(full, 'utf8'));
    }
  };
  await walk(root);
  return parts.join('\n');
}

test('arquivo secreto vai só com nome e linha e ..evil ainda é lido', async () => {
  const envSecret = 'super-secreto-nao-enviar';
  const keySecret = 'conteudo-privado-id-rsa';
  const evil = 'CONTEUDO-PONTO-EVIL';
  const pub = 'identidade-publica';
  const ready = await bootVerify('verify_rt_sec');
  const confirmTasks: string[] = [];
  try {
    await writeFile(join(ready.repo, '.env'), `# comentario\nSENHA_ENV=${envSecret}\n`);
    await writeFile(join(ready.repo, 'identity.ts'), `export const nome = '${pub}';\n`);
    await writeFile(join(ready.repo, 'id_rsa'), `${keySecret}\n`);
    await writeFile(join(ready.repo, '..evil'), `${evil}\n`);
    const worker = examWorker(confirmTasks, [
      {title: 'env', severity: 'alta', file: '.env', line: 2, scenario: 'arquivo de ambiente', suggestion: 'tirar do repo', cwe: 'CWE-798', reference: 'ASVS-5.0-V6', snippet: 'env'},
      {title: 'chave', severity: 'alta', file: 'id_rsa', line: 1, scenario: 'chave privada', suggestion: 'tirar do repo', cwe: 'CWE-798', reference: 'ASVS-5.0-V6', snippet: 'chave'},
      {title: 'identidade', severity: 'baixa', file: 'identity.ts', line: 1, scenario: 'arquivo publico', suggestion: 'nenhuma', cwe: null, reference: 'ASVS-5.0-V1', snippet: 'export'},
      {title: 'evil', severity: 'baixa', file: '..evil', line: 1, scenario: 'nome parecido com escape', suggestion: 'nada', cwe: null, reference: 'ASVS-5.0-V1', snippet: 'evil'},
    ]);
    const commit = '0123456789abcdef0123456789abcdef01234567';
    await runSecurityVerification({
      ledger: ready.db,
      principal: ready.principal,
      authority: ready.authority,
      projectId: ready.project,
      repoPath: ready.repo,
      dataDirectory: ready.dataDirectory,
      commit,
      policyRevision: 1,
      worker,
    });
    const taskFor = (file: string) => confirmTasks.find(task => task.includes(`Arquivo: ${file}\n`));
    const envTask = taskFor('.env');
    const keyTask = taskFor('id_rsa');
    const idTask = taskFor('identity.ts');
    const evilTask = taskFor('..evil');
    assert.deepEqual([
      envTask ? '' : 'env-task',
      envTask?.includes(envSecret) ? 'env-bytes' : '',
      envTask?.includes('nome: .env\nlinha: 2\n') ? '' : 'env-stub',
      keyTask ? '' : 'key-task',
      keyTask?.includes(keySecret) ? 'key-bytes' : '',
      keyTask?.includes('nome: id_rsa\nlinha: 1\n') ? '' : 'key-stub',
      idTask?.includes(pub) ? '' : 'identity-missing',
      evilTask?.includes(evil) ? '' : 'evil-missing',
    ].filter(Boolean), []);
  } finally {
    await ready.close();
  }
});

test('texto de modelo e ferramenta é redigido e o diretório é reservado antes', async () => {
  const token = `glpat-${'b'.repeat(20)}`;
  const assigned = 'password = "hunter2-ficticio"';
  const aiza = `AIza${'D'.repeat(35)}`;
  const ready = await bootVerify('verify_rt_red');
  let sawReserved = false;
  const confirmTasks: string[] = [];
  try {
    await writeFile(join(ready.repo, 'identity.ts'), 'export const nome = "identidade-publica";\n');
    const rawFinding: RawFinding = {
      tool: 'opengrep',
      rule: 'regra-linha',
      cwe: null,
      file: 'identity.ts',
      line: 1,
      severity: 'media',
      snippet: `linha ${token}`,
      fingerprint: 'ab'.repeat(32),
    };
    const worker: VerifyWorker = {
      async run(call) {
        if (!sawReserved) {
          try {
            const names = await readdir(join(ready.dataDirectory, 'verificacoes', ready.project));
            sawReserved = names.some(name => /^\d{8}-\d{6}-[a-f0-9]{8}-seguranca$/.test(name));
          } catch {
            sawReserved = false;
          }
        }
        const task = call.task;
        if (task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: ['http']});
        if (task.startsWith('Pedido de exame.')) {
          const items = (task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
          return JSON.stringify({
            kind: 'exame',
            filesRead: ['identity.ts'],
            checklist: items.length ? items : ['SEM-ITEM'],
            findings: [{
              title: `titulo ${token}`,
              severity: 'alta',
              file: 'identity.ts',
              line: 1,
              scenario: `cenario ${token}`,
              suggestion: assigned,
              cwe: 'CWE-798',
              reference: 'ASVS-5.0-V6',
              snippet: `trecho ${token}`,
            }],
          });
        }
        if (task.startsWith('Pedido de confirmação.')) {
          confirmTasks.push(task);
          return JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'nao reproduz', proof: `prova ${aiza}`});
        }
        throw new Error('task desconhecida');
      },
    };
    const result = await runSecurityVerification({
      ledger: ready.db,
      principal: ready.principal,
      authority: ready.authority,
      projectId: ready.project,
      repoPath: ready.repo,
      dataDirectory: ready.dataDirectory,
      commit: '0123456789abcdef0123456789abcdef01234567',
      policyRevision: 1,
      worker,
      rawFindings: [rawFinding],
    });
    const blob = await reportBlob(result.directory);
    const stored = (await ready.db.pool.query('SELECT payload::text AS payload FROM ac_verify_findings WHERE run_id=$1', [result.runId])).rows
      .map(row => String(row.payload)).join('\n');
    const held = `${blob}\n${stored}\n${confirmTasks.join('\n')}`;
    assert.deepEqual([
      held.includes(token) ? 'glpat-cru' : '',
      held.includes('hunter2-ficticio') ? 'password-cru' : '',
      held.includes(aiza) ? 'aiza-cru' : '',
      sawReserved ? '' : 'sem-reserva',
      result.directory.endsWith('-seguranca') && /[a-f0-9]{8}-seguranca$/.test(result.directory) ? '' : 'sufixo',
      held.includes(secretPreview(token).sha256) ? '' : 'sha-glpat',
      held.includes(secretPreview(aiza).sha256) ? '' : 'sha-aiza',
    ].filter(Boolean), []);
  } finally {
    await ready.close();
  }
});

test('orçamento inválido não chega ao worker', async () => {
  assert.equal(DEFAULT_MODEL_CALL_BUDGET, 600);
  const worker: VerifyWorker = {async run() { throw new Error('worker-nao-deve-rodar'); }};
  for (const modelCallBudget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => runSecurityVerification({modelCallBudget, worker} as never),
      (error: unknown) => {
        assert.equal(error instanceof Refusal, false);
        assert.equal(error instanceof Error, true);
        assert.equal((error as Error).message, 'VERIFY_MODEL_BUDGET');
        return true;
      },
    );
  }
});

test('orçamento de chamadas barra a próxima e o padrão permite mais de uma', async () => {
  const ready = await bootVerify('verify_rt_budget');
  const calls: string[] = [];
  const worker: VerifyWorker = {
    async run(call) {
      calls.push(call.role);
      if (call.task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: ['http']});
      if (call.task.startsWith('Pedido de exame.')) {
        const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        return JSON.stringify({
          kind: 'exame',
          filesRead: ['src/app.ts'],
          checklist: items.length ? items : ['SEM-ITEM'],
          findings: [{
            title: 'Achado de SQL',
            severity: 'media',
            file: 'src/app.ts',
            line: 1,
            scenario: 'A consulta concatena a entrada.',
            suggestion: 'Usar placeholder.',
            cwe: 'CWE-89',
            reference: 'ASVS-5.0-V5',
            snippet: 'SQL concatenado',
          }],
        });
      }
      if (call.task.startsWith('Pedido de confirmação.')) {
        return JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'nao reproduz', proof: 'sem prova'});
      }
      throw new Error('task desconhecida');
    },
  };
  const base = {
    ledger: ready.db,
    principal: ready.principal,
    authority: ready.authority,
    projectId: ready.project,
    repoPath: ready.repo,
    dataDirectory: ready.dataDirectory,
    commit: '0123456789abcdef0123456789abcdef01234567',
    policyRevision: 1,
    worker,
  };
  try {
    await mkdir(join(ready.repo, 'src'), {recursive: true});
    await writeFile(join(ready.repo, 'src', 'app.ts'), 'export const q = "SQL concatenado";\n');
    const budgetRefused = (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal((error as Error).message, 'VERIFY_MODEL_BUDGET');
      return true;
    };
    const first = {count: 0};
    calls.length = 0;
    await assert.rejects(() => runSecurityVerification({...base, modelCalls: first, modelCallBudget: 1}), budgetRefused);
    assert.equal(calls.length, 1);
    assert.equal(first.count, 1);
    const second = {count: 0};
    calls.length = 0;
    await assert.rejects(() => runSecurityVerification({...base, modelCalls: second, modelCallBudget: 2}), budgetRefused);
    assert.equal(calls.length, 2);
    assert.equal(second.count, 2);
    const open = {count: 0};
    calls.length = 0;
    const result = await runSecurityVerification({...base, modelCalls: open});
    assert.equal(result.achados.length, 1);
    assert.equal(result.achados[0]?.title, 'Achado de SQL');
    assert.ok(open.count > 1);
    assert.ok(calls.length > 1);
    assert.equal(calls.length, open.count);
  } finally {
    await ready.close();
  }
});

test('title e snippet com segredo são substituídos e o texto normal fica', () => {
  const entropy = '7f3a9c2e1b804d6f55aa0199cc33e7ab';
  const base64 = 'A'.repeat(40);
  const masked = `glpa\u2026 (sha256:${'ab'.repeat(32)})`;
  assert.equal(entropy.length >= 32, true);
  assert.equal(hasRefusedSecretText(entropy), true);
  assert.equal(hasRefusedSecretText(`prefixo ${base64} fim`), true);
  assert.equal(hasRefusedSecretText('Achado de SQL'), false);
  assert.equal(hasRefusedSecretText('SQL concatenado'), false);
  assert.equal(hasRefusedSecretText("app.get('/admin', () => 'painel')"), false);
  assert.equal(hasRefusedSecretText(masked), false);
  const secret = `glpat-${'b'.repeat(20)}`;
  const parsed = ExamResult.parse(coerceExamResult({
    kind: 'exame',
    filesRead: ['src/app.ts'],
    checklist: ['ASVS-5-V1'],
    findings: [
      {title: 'Achado de SQL', severity: 'alta', file: 'src/app.ts', line: 1, scenario: 'concat', suggestion: 'placeholder', snippet: 'SQL concatenado'},
      {title: entropy, severity: 'alta', file: 'src/app.ts', line: 2, scenario: 'nao gravar', suggestion: 'tirar', snippet: 'curto'},
      {title: 'Trecho suspeito', severity: 'media', file: 'src/app.ts', line: 3, scenario: 'nao gravar', suggestion: 'tirar', snippet: base64},
      {title: `titulo ${secret}`, severity: 'baixa', file: 'src/app.ts', line: 4, scenario: 'token conhecido', suggestion: 'redigir', snippet: "app.get('/admin', () => 'painel')"},
    ],
  }));
  assert.equal(parsed.findings.length, 4);
  assert.equal(parsed.findings[0]?.title, 'Achado de SQL');
  assert.equal(parsed.findings[0]?.snippet, 'SQL concatenado');
  assert.equal(parsed.findings[1]?.title, '[removido: alta entropia]');
  assert.equal(parsed.findings[1]?.snippet, 'curto');
  assert.equal(parsed.findings[2]?.title, 'Trecho suspeito');
  assert.equal(parsed.findings[2]?.snippet, '[removido: alta entropia]');
  assert.equal(parsed.findings[3]?.title.startsWith('titulo '), true);
  assert.equal(parsed.findings[3]?.title.includes(secret), false);
  assert.equal(parsed.findings[3]?.snippet, "app.get('/admin', () => 'painel')");
  assert.equal(JSON.stringify(parsed).includes(entropy), false);
  assert.equal(JSON.stringify(parsed).includes(base64), false);
  assert.equal(JSON.stringify(parsed).includes(secret), false);
});

test('token GitHub hardcoded permanece e o ghp_ sai mascarado', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  assert.equal(token.length >= 24, true);
  assert.equal(hasRefusedSecretText(token), false);
  const parsed = ExamResult.parse(coerceExamResult({
    kind: 'exame',
    filesRead: ['src/app.ts'],
    checklist: ['ASVS-5-V1'],
    findings: [{
      title: 'token GitHub hardcoded',
      severity: 'alta',
      file: 'src/app.ts',
      line: 1,
      scenario: 'token no fonte',
      suggestion: 'tirar o token',
      snippet: token,
    }],
  }));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.title, 'token GitHub hardcoded');
  assert.equal(JSON.stringify(parsed).includes(token), false);
  assert.match(parsed.findings[0]?.snippet ?? '', /sha256:/);
});

test('caminho longo no snippet permanece inteiro', () => {
  const path = '/home/app/projects/some-very-long-directory-name/src/handlers/auth-controller.ts';
  assert.equal(path.length, 80);
  assert.equal(hasRefusedSecretText(path), false);
  const parsed = ExamResult.parse(coerceExamResult({
    kind: 'exame',
    filesRead: ['src/app.ts'],
    checklist: ['ASVS-5-V1'],
    findings: [{
      title: 'Caminho longo no trecho',
      severity: 'baixa',
      file: 'src/app.ts',
      line: 1,
      scenario: 'o caminho aparece no codigo',
      suggestion: 'nada',
      snippet: path,
    }],
  }));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.title, 'Caminho longo no trecho');
  assert.equal(parsed.findings[0]?.snippet, path);
});

test('base64 com barra é redigido só no token e caminho ou snake_case ficam', () => {
  const secret = 'Zx9/Qw8+Er7tYu6iOp5aSd4fGh3jKl2zXc1vBn0M/q8WeRtYuIoPaSdF';
  const path = '/home/app/projects/some-very-long-directory-name/src/handlers/auth-controller.ts';
  const relativePath = 'src/handlers/auth-controller.ts';
  const snake = 'user_password_reset_token_table_name_for_the_account_row';
  assert.equal(secret.split('/')[1]?.length, 36);
  assert.equal(hasRefusedSecretText(secret), true);
  assert.equal(hasRefusedSecretText(`antes ${secret} resto`), true);
  assert.equal(hasRefusedSecretText(path), false);
  assert.equal(hasRefusedSecretText(relativePath), false);
  assert.equal(hasRefusedSecretText(snake), false);
  const parsed = ExamResult.parse(coerceExamResult({
    kind: 'exame',
    filesRead: ['src/app.ts'],
    checklist: ['ASVS-5-V1'],
    findings: [
      {
        title: `antes ${secret} resto`,
        severity: 'alta',
        file: 'src/app.ts',
        line: 1,
        scenario: 'segredo no meio da frase',
        suggestion: 'tirar o token',
        snippet: path,
      },
      {
        title: snake,
        severity: 'baixa',
        file: 'src/app.ts',
        line: 2,
        scenario: 'identificador longo',
        suggestion: 'nada',
        snippet: relativePath,
      },
    ],
  }));
  assert.equal(parsed.findings[0]?.title, 'antes [removido: alta entropia] resto');
  assert.equal(parsed.findings[0]?.snippet, path);
  assert.equal(parsed.findings[1]?.title, snake);
  assert.equal(parsed.findings[1]?.snippet, relativePath);
  assert.equal(JSON.stringify(parsed).includes(secret), false);
});

test('nota do relatório cita a remoção por alta entropia', async () => {
  const entropy = '7f3a9c2e1b804d6f55aa0199cc33e7ab';
  const base64 = 'C'.repeat(40);
  const ready = await bootVerify('verify_rt_m1');
  try {
    await mkdir(join(ready.repo, 'src'), {recursive: true});
    await writeFile(join(ready.repo, 'src', 'app.ts'), 'export const q = "SQL concatenado";\n');
    const raw: RawFinding = {
      tool: 'opengrep',
      rule: 'regra-blob',
      cwe: null,
      file: 'src/app.ts',
      line: 1,
      severity: 'alta',
      snippet: base64,
      fingerprint: 'ab'.repeat(32),
    };
    const worker: VerifyWorker = {
      async run(call) {
        if (call.task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: ['http']});
        if (call.task.startsWith('Pedido de exame.')) {
          const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
          return JSON.stringify({
            kind: 'exame',
            filesRead: ['src/app.ts'],
            checklist: items.length ? items : ['SEM-ITEM'],
            findings: [{
              title: entropy,
              severity: 'alta',
              file: 'src/app.ts',
              line: 1,
              scenario: 'segredo no titulo',
              suggestion: 'tirar',
              cwe: null,
              reference: 'ASVS-5.0-V6',
              snippet: 'curto',
            }],
          });
        }
        if (call.task.startsWith('Pedido de confirmação.')) {
          return JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'nao reproduz', proof: 'sem prova'});
        }
        throw new Error('task desconhecida');
      },
    };
    const result = await runSecurityVerification({
      ledger: ready.db,
      principal: ready.principal,
      authority: ready.authority,
      projectId: ready.project,
      repoPath: ready.repo,
      dataDirectory: ready.dataDirectory,
      commit: '0123456789abcdef0123456789abcdef01234567',
      policyRevision: 1,
      worker,
      rawFindings: [raw],
    });
    const run = JSON.parse(await readFile(join(result.directory, 'run.json'), 'utf8')) as {note: string};
    const blob = await reportBlob(result.directory);
    assert.ok(result.achados.some(achado => achado.title === '[removido: alta entropia]'));
    assert.ok(result.achados.some(achado => achado.title === 'regra-blob'));
    assert.equal(run.note.includes('[removido: alta entropia]'), true);
    assert.equal(blob.includes(entropy), false);
    assert.equal(blob.includes(base64), false);
  } finally {
    await ready.close();
  }
});

test('histórico apagado não devolve o diff de arquivo secreto', async () => {
  const sentinel = `env-sentinel-${randomUUID()}`;
  const previous = process.env.AC_VERIFY_ENV_SENTINEL;
  process.env.AC_VERIFY_ENV_SENTINEL = sentinel;
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-hist-'));
  const envSecret = 'segredo-env-historico-nao-mostrar';
  const visible = 'texto-normal-do-arquivo-apagado';
  try {
    const built = buildHistoryGitInvocation();
    assert.ok(built.args.includes('--no-ext-diff'));
    assert.ok(built.args.includes('--no-textconv'));
    const hookAt = built.args.indexOf('-c');
    assert.equal(built.args[hookAt + 1], 'core.hooksPath=/dev/null');
    assert.equal(built.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(built.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(built.env.GIT_CONFIG_COUNT, '0');
    assert.equal(built.env.HOME, '/nonexistent');
    assert.equal(built.env.PATH, process.env.PATH || '/usr/bin:/bin');
    assert.deepEqual(Object.keys(built.env).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'PATH']);
    assert.equal(Object.hasOwn(built.env, 'AC_VERIFY_ENV_SENTINEL'), false);
    assert.equal(JSON.stringify(built.args).includes(sentinel), false);
    assert.equal(Object.values(built.env).some(value => value.includes(sentinel)), false);
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'verify',
      GIT_AUTHOR_EMAIL: 'verify@example.com',
      GIT_COMMITTER_NAME: 'verify',
      GIT_COMMITTER_EMAIL: 'verify@example.com',
    };
    await writeFile(join(repo, '.env'), `${envSecret}\n`);
    await writeFile(join(repo, 'nota.txt'), `${visible}\n`);
    await exec('git', ['init'], {cwd: repo, env: gitEnv});
    await exec('git', ['add', '-f', '.env', 'nota.txt'], {cwd: repo, env: gitEnv});
    await exec('git', ['-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'adiciona'], {cwd: repo, env: gitEnv});
    await exec('git', ['rm', '.env', 'nota.txt'], {cwd: repo, env: gitEnv});
    await exec('git', ['-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'apaga'], {cwd: repo, env: gitEnv});
    const excerpt = await deletedHistoryExcerpt(repo);
    assert.equal(excerpt.includes(envSecret), false);
    assert.equal(excerpt.includes('diff --git a/.env'), false);
    assert.equal(excerpt.includes(visible), true);
    assert.equal(excerpt.includes('diff --git a/nota.txt'), true);
    assert.equal(excerpt.includes(sentinel), false);
    assert.ok(excerpt.length <= 8000);
  } finally {
    if (previous === undefined) delete process.env.AC_VERIFY_ENV_SENTINEL;
    else process.env.AC_VERIFY_ENV_SENTINEL = previous;
    await rm(repo, {recursive: true, force: true});
  }
});

test('readRepoText ignora o que está fora da lista e redige o resto', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ac-verify-read-'));
  const marker = 'MARCADOR-NODE-MODULES-NAO-LER';
  const ghp = `ghp_${'c'.repeat(36)}`;
  const akia = 'AKIAIOSFODNN7EXAMPLE';
  const envSecret = 'conteudo-env-nao-ler-xyz';
  try {
    await mkdir(join(repo, 'src'), {recursive: true});
    await mkdir(join(repo, 'node_modules'), {recursive: true});
    await writeFile(join(repo, 'node_modules', 'segredo.txt'), `${marker}\n`);
    await writeFile(join(repo, 'src', 'tok.ts'), `token ${ghp} chave ${akia}\n`);
    await writeFile(join(repo, '.env'), `SENHA=${envSecret}\n`);
    await writeFile(join(repo, 'src', 'ok.ts'), 'const q = "SQL concatenado";\n');
    const allowed = new Set(await listExamFiles(repo));
    assert.equal(allowed.has('node_modules/segredo.txt'), false);
    assert.equal(allowed.has('src/tok.ts'), true);
    assert.equal(allowed.has('.env'), true);
    const hidden = await readRepoText(repo, 'node_modules/segredo.txt', 1, allowed);
    assert.deepEqual(hidden, {text: '', missing: true});
    const tok = await readRepoText(repo, 'src/tok.ts', 1, allowed);
    assert.equal(tok.missing, false);
    assert.equal(tok.text.includes(ghp), false);
    assert.equal(tok.text.includes(akia), false);
    assert.match(tok.text, /token /);
    assert.match(tok.text, /chave /);
    const env = await readRepoText(repo, '.env', 2, allowed);
    assert.equal(env.missing, false);
    assert.equal(env.text.includes(envSecret), false);
    assert.equal(env.text, 'nome: .env\nlinha: 2\n');
    const ok = await readRepoText(repo, 'src/ok.ts', null, allowed);
    assert.equal(ok.missing, false);
    assert.match(ok.text, /SQL concatenado/);
  } finally {
    await rm(repo, {recursive: true, force: true});
  }
});

test('segredo da conta não segue na task do outro provedor', async () => {
  const accountSecret = 'S3cr3t0-Conta-Nao-Vazar-99';
  const entropy = '7f3a9c2e1b804d6f55aa0199cc33e7ab';
  const base64 = 'B'.repeat(40);
  const ready = await bootVerify('verify_rt_acct');
  const tasks: string[] = [];
  try {
    await mkdir(join(ready.repo, 'src'), {recursive: true});
    await writeFile(join(ready.repo, 'src', 'app.ts'), `export const segredo = '${accountSecret}';\nconst q = "SQL concatenado";\n`);
    const rawClean: RawFinding = {
      tool: 'opengrep',
      rule: 'regra-sql',
      cwe: 'CWE-89',
      file: 'src/app.ts',
      line: 2,
      severity: 'media',
      snippet: 'SQL concatenado',
      fingerprint: 'cd'.repeat(32),
    };
    const rawSecret: RawFinding = {
      tool: 'opengrep',
      rule: 'regra-blob',
      cwe: null,
      file: 'src/app.ts',
      line: 1,
      severity: 'alta',
      snippet: base64,
      fingerprint: 'ef'.repeat(32),
    };
    const worker: VerifyWorker = {
      async run(call) {
        tasks.push(call.task);
        if (call.task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: ['http']});
        if (call.task.startsWith('Pedido de exame.')) {
          const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
          return JSON.stringify({
            kind: 'exame',
            filesRead: ['src/app.ts'],
            checklist: items.length ? items : ['SEM-ITEM'],
            findings: [
              {title: 'Achado de SQL', severity: 'media', file: 'src/app.ts', line: 2, scenario: 'concat', suggestion: 'placeholder', cwe: 'CWE-89', reference: 'ASVS-5.0-V5', snippet: `SQL concatenado ${accountSecret}`},
              {title: entropy, severity: 'alta', file: 'src/app.ts', line: 1, scenario: 'segredo', suggestion: 'tirar', cwe: null, reference: 'ASVS-5.0-V6', snippet: 'curto'},
            ],
          });
        }
        if (call.task.startsWith('Pedido de confirmação.')) {
          return JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'nao reproduz', proof: 'sem prova'});
        }
        throw new Error('task desconhecida');
      },
    };
    const result = await runSecurityVerification({
      ledger: ready.db,
      principal: ready.principal,
      authority: ready.authority,
      projectId: ready.project,
      repoPath: ready.repo,
      dataDirectory: ready.dataDirectory,
      commit: '0123456789abcdef0123456789abcdef01234567',
      policyRevision: 1,
      worker,
      accountSecrets: [accountSecret],
      rawFindings: [rawClean, rawSecret],
    });
    const blob = await reportBlob(result.directory);
    assert.ok(tasks.length > 1);
    assert.equal(tasks.some(task => task.includes(accountSecret)), false);
    assert.equal(tasks.some(task => task.includes(secretPreview(accountSecret).sha256)), true);
    assert.equal(tasks.some(task => task.includes(entropy) || task.includes(base64)), false);
    assert.equal(blob.includes(entropy), false);
    assert.equal(blob.includes(base64), false);
    assert.ok(result.achados.some(achado => achado.title === 'Achado de SQL'));
    assert.ok(result.achados.some(achado => achado.title === 'regra-sql'));
    assert.ok(result.achados.some(achado => achado.title === 'regra-blob'));
    assert.ok(result.achados.some(achado => achado.title === '[removido: alta entropia]'));
    assert.equal(result.achados.some(achado => achado.title === entropy), false);
  } finally {
    await ready.close();
  }
});

test('mapa compacto é opcional nas tarefas do examinador de segurança', async () => {
  const ready = await bootVerify('verify_rt_map');
  const tasks: string[] = [];
  try {
    await writeFile(join(ready.repo, 'identity.ts'), 'export function saudacao() { return 1; }\n');
    const worker: VerifyWorker = {async run(call) {
      if (call.task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: []});
      if (call.task.startsWith('Pedido de exame.')) {
        tasks.push(call.task);
        const checklist = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        return JSON.stringify({kind: 'exame', filesRead: ['identity.ts'], checklist, findings: []});
      }
      throw new Error('task inesperada');
    }};
    const base = {ledger: ready.db, principal: ready.principal, authority: ready.authority, projectId: ready.project,
      repoPath: ready.repo, dataDirectory: ready.dataDirectory, commit: '0123456789abcdef0123456789abcdef01234567', policyRevision: 1, worker};
    await runSecurityVerification(base);
    await runSecurityVerification({...base, mapEnabled: false});
    assert.equal(tasks.length, 2);
    assert.match(tasks[0], /Mapa compacto do repositório/);
    assert.doesNotMatch(tasks[1], /Mapa compacto do repositório/);
  } finally { await ready.close(); }
});
