import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Capacity, CapacityPolicy} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {resolvePersonalDesign} from '../src/design-command.ts';
import {runDesignCreate} from '../src/design-create.ts';
import {runDesignModule} from '../src/design-module.ts';
import {prepareDesignSpecialist} from '../src/design-prepare.ts';
import {Ledger} from '../src/ledger.ts';
import {designCliFailureText, runDesignSession} from '../src/personal-design-cli.ts';
import {runPersonalVerifySession} from '../src/personal-verify-cli.ts';
import {beginPersonalVerification, resolvePersonalVerification} from '../src/verify-command.ts';
import {runSecurityVerification} from '../src/verify-runtime.ts';
import {WorkflowGenerations} from '../src/workflow-generations.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const roles = ['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge'] as const;

async function initRepo(root: string): Promise<string> {
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), {recursive: true});
  await writeFile(join(repo, 'src', 'index.html'), '<!doctype html><html><body><h1>Painel</h1></body></html>\n');
  await writeFile(join(repo, 'src', 'app.ts'), "export function route() { return '/painel'; }\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  await exec('git', ['init'], {cwd: repo, env});
  await exec('git', ['add', '.'], {cwd: repo, env});
  await exec('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'init'], {cwd: repo, env});
  return repo;
}

async function writeInstallation(root: string, opts: {
  databaseUrl: string;
  projectId: string;
  repo: string;
  owner: string;
  dataDirectory: string;
}): Promise<string> {
  const file = join(root, 'installation.json');
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      mode: 'administration-only',
      activation: 'personal',
      databaseUrl: opts.databaseUrl,
      dataDirectory: opts.dataDirectory,
      project: {id: opts.projectId, label: 'Projeto Teste', repo: opts.repo, owner: opts.owner},
      http: {listen: '127.0.0.1', port: 18415, publicOrigin: 'http://127.0.0.1:18415'},
      happier: {
        upstreamOrigin: 'http://127.0.0.1:18411',
        webOrigin: 'http://127.0.0.1:18410',
        publicServerOrigin: 'http://127.0.0.1:18411',
      },
    }),
    {mode: 0o600},
  );
  await chmod(file, 0o600);
  return file;
}

function benchDesignSupervisor(accountIds: readonly string[]) {
  const jobs = new Map<string, string>();
  return {
    active: true,
    supportsAccount(accountId: string) {
      return accountIds.includes(accountId);
    },
    async start(_principal: string, _authority: unknown, request: {jobId: string; task: string}) {
      jobs.set(request.jobId, request.task);
      return {state: 'running'};
    },
    async reconcile(_principal: string, _authority: unknown, request: {jobId: string}) {
      const task = jobs.get(request.jobId) ?? '';
      if (task.startsWith('Pedido de criação.')) {
        return {
          state: 'completed',
          output: JSON.stringify({
            kind: 'criacao',
            tokens: {color: {bg: {$value: '#f6f4ef', $type: 'color'}, fg: {$value: '#1b1917', $type: 'color'}}},
            screens: [
              {name: 'inicio', html: '<!doctype html><html><body><main>Início</main></body></html>', css: 'body { background: #f6f4ef; color: #1b1917; }\n'},
            ],
          }),
        };
      }
      if (task.startsWith('Pedido de confirmação.')) {
        return {
          state: 'completed',
          output: JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'Falso positivo.', proof: 'CSS válido.'}),
        };
      }
      if (task.startsWith('Pedido de crítica visual.')) {
        return {
          state: 'completed',
          output: JSON.stringify({kind: 'visual', score: 9, notes: ['Bom contraste.'], findings: []}),
        };
      }
      return {
        state: 'completed',
        output: JSON.stringify({kind: 'exame', filesRead: ['src/index.html'], checklist: ['DESIGN-CONTRASTE'], findings: []}),
      };
    },
    async retireTerminal() {
      return {state: 'removed'};
    },
  };
}

function benchVerifySupervisor(accountIds: readonly string[]) {
  const jobs = new Map<string, string>();
  return {
    active: true,
    supportsAccount(accountId: string) {
      return accountIds.includes(accountId);
    },
    async start(_principal: string, _authority: unknown, request: {jobId: string; task: string}) {
      jobs.set(request.jobId, request.task);
      return {state: 'running'};
    },
    async reconcile(_principal: string, _authority: unknown, request: {jobId: string}) {
      const task = jobs.get(request.jobId) ?? '';
      if (task.startsWith('Pedido de mapa.')) {
        return {state: 'completed', output: JSON.stringify({kind: 'mapa', routes: [], surfaces: []})};
      }
      if (task.startsWith('Pedido de confirmação.')) {
        return {state: 'completed', output: JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'Sem falha.', proof: 'ok'})};
      }
      const lines = task.split('\n');
      const at = lines.findIndex(line => line === 'Arquivos:');
      const files: string[] = [];
      for (const line of lines.slice(at + 1)) {
        if (!line.startsWith('- ')) break;
        files.push(line.slice(2));
      }
      const items = (task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
      return {
        state: 'completed',
        output: JSON.stringify({
          kind: 'exame',
          filesRead: files.length ? files : ['src/app.ts'],
          checklist: items.length ? items : ['ASVS-5-V1'],
          findings: [],
        }),
      };
    },
    async retireTerminal() {
      return {state: 'removed'};
    },
  };
}

test('design criar e exame rodam em contexto dedicado com gerente ativo no principal, e segunda execução recusa com DESIGN_BUSY', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'designctx');
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-design-ctx-'));
  const dataDirectory = join(root, 'data');
  try {
    await mkdir(dataDirectory, {recursive: true, mode: 0o700});
    await db.migrate();
    const principal = 'design-owner';
    const projectId = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Design Dedicado']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 6, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    const addClaude = async () => {
      const id = randomUUID();
      await capacity.addAccount(principal, projectId, {
        id, provider: 'claude', label: 'claude', resourceIdentity: `claude:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://designctx', maxConcurrent: 4,
      });
      await capacity.observeQuota(principal, id, {status: 'available', source: 'fixture', ttlSeconds: 3600});
      return id;
    };
    const accounts = [await addClaude(), await addClaude()];
    const mainContext = await db.createContext(principal, projectId, randomUUID());
    await prepareDesignSpecialist({ledger: db, owner: principal, projectId, apply: true});
    const mainPolicy = Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [mainContext])).rows[0].capacity_policy_revision);
    assert.ok(mainPolicy >= 1);

    const gatewayAuthority = await db.acquire(principal, mainContext, randomUUID(), 'gateway-manager', 60);
    const repo = await initRepo(root);
    const installationPath = await writeInstallation(root, {databaseUrl: database.url, projectId, repo, owner: principal, dataDirectory});
    const composeRuntime = async () => ({executions: [benchDesignSupervisor(accounts)]}) as never;

    const first = await resolvePersonalDesign([], {installationPath, projectId, composeRuntime});
    let dedicatedContext: string;
    try {
      dedicatedContext = first.authority.contextId;
      assert.notEqual(dedicatedContext, mainContext);
      const linkRow = (await db.pool.query<{context_id: string}>(
        "SELECT context_id::text AS context_id FROM ac_exam_contexts WHERE project_id=$1 AND module='design'",
        [projectId],
      )).rows[0];
      assert.equal(linkRow?.context_id, dedicatedContext);
      assert.equal(
        Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [dedicatedContext])).rows[0].capacity_policy_revision),
        mainPolicy,
      );

      // Segunda execução simultânea recusa com DESIGN_BUSY (não MANAGER_ACTIVE).
      await assert.rejects(
        () => resolvePersonalDesign([], {installationPath, projectId, composeRuntime}),
        (error: unknown) => {
          assert.ok(error instanceof Refusal);
          assert.equal(error.code, 'DESIGN_BUSY');
          const msg = designCliFailureText(error);
          assert.match(msg, /design/i);
          assert.equal(msg.includes('MANAGER_ACTIVE'), false);
          return true;
        },
      );

      // O criar com bancada e o exame dentro dele reservam capacidade e rodam no contexto dedicado.
      const created = await runDesignCreate({
        dataDirectory: first.dataDirectory,
        runId: randomUUID(),
        repository: first.repo,
        briefing: 'Painel calmo e legível.',
        screens: 1,
        rounds: 1,
        referenceNote: '',
        worker: first.worker,
        reserve: () => first.reserve('specialist'),
        release: seat => first.release(seat),
        intentId: first.intentId,
        examine: async (_round, files) => {
          const exam = await runDesignModule({
            activation: 'personal',
            projectId: first.projectId,
            repo: first.repo,
            targetUrl: 'http://127.0.0.1:4173',
            dataDirectory: first.dataDirectory,
            intentId: first.intentId,
            runId: randomUUID(),
            createdAt: new Date(),
            commit: first.commit,
            files,
            worker: first.worker,
            reserve: first.reserve,
            release: first.release,
            tools: {},
          });
          return {
            screens: files.filter(f => f.path.endsWith('.html')).map(f => ({
              name: f.path.slice(0, -'.html'.length),
              rejected: false,
              findings: exam.findings,
              visualNotes: [],
            })),
            notes: [],
          };
        },
      });
      assert.ok(created.directory);
      const grantContexts = (await db.pool.query<{context_id: string}>(
        'SELECT DISTINCT context_id::text AS context_id FROM ac_capacity_grants WHERE intent_id=$1',
        [first.intentId],
      )).rows.map(r => r.context_id);
      assert.deepEqual(grantContexts, [dedicatedContext]);

      await db.pool.query("UPDATE ac_intents SET state='done' WHERE id=$1 AND state='accepted'", [first.intentId]);
    } finally {
      await first.close();
    }

    // O gerente do contexto principal permanece intacto e com o mesmo epoch.
    const mainManager = (await db.pool.query<{epoch: string; instance_id: string; active: boolean}>(
      'SELECT epoch::text AS epoch, instance_id::text AS instance_id, lease_until > clock_timestamp() AS active FROM ac_managers WHERE context_id=$1',
      [mainContext],
    )).rows[0];
    assert.equal(Number(mainManager?.epoch), gatewayAuthority.epoch);
    assert.equal(mainManager?.instance_id, gatewayAuthority.instanceId);
    assert.equal(mainManager?.active, true);

    // Segunda execução após o término reaproveita o mesmo contexto dedicado e roda o exame.
    const second = await resolvePersonalDesign([], {installationPath, projectId, composeRuntime});
    try {
      assert.equal(second.authority.contextId, dedicatedContext);
      const examOnly = await runDesignModule({
        activation: 'personal',
        projectId: second.projectId,
        repo: second.repo,
        targetUrl: 'http://127.0.0.1:4173',
        dataDirectory: second.dataDirectory,
        intentId: second.intentId,
        runId: randomUUID(),
        createdAt: new Date(Date.now() + 2000),
        commit: second.commit,
        files: [{path: 'src/index.html', text: '<!doctype html><html><body><h1>Painel</h1></body></html>'}],
        worker: second.worker,
        reserve: second.reserve,
        release: second.release,
        tools: {},
      });
      assert.ok(examOnly.directory);
    } finally {
      await second.close();
    }
    const stillMain = (await db.pool.query<{epoch: string}>('SELECT epoch::text AS epoch FROM ac_managers WHERE context_id=$1', [mainContext])).rows[0];
    assert.equal(Number(stillMain?.epoch), gatewayAuthority.epoch);
  } finally {
    await db.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('preparar --aplicar atribui a revisão nova ao contexto principal e ao contexto dedicado já existente', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepded');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-owner';
    const projectId = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Preparar Dedicado']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 6, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: [...roles], source: 'personal://account-add',
    });
    const claude = randomUUID();
    await capacity.addAccount(principal, projectId, {
      id: claude, provider: 'claude', label: 'claude', resourceIdentity: `claude:${claude}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepded', maxConcurrent: 4,
    });
    const manager = randomUUID();
    await capacity.addProfile(principal, projectId, {id: manager, accountId: claude, model: 'claude-sonnet-5-5', effort: 'medium', role: 'manager'});
    const rev1 = await capacity.publish(principal, projectId, 0, CapacityPolicy.parse({
      schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: 2,
      roles: {manager: {regular: [manager], emergency: []}},
    }));
    const mainContext = await db.createContext(principal, projectId, randomUUID());
    await capacity.assignPolicy(principal, mainContext, rev1);
    const exam = await db.ensureExamContext(principal, projectId, 'design');
    await capacity.assignPolicy(principal, exam.contextId, rev1);
    const mainAuth = await db.acquire(principal, mainContext, randomUUID(), 'gateway-manager', 60);

    const applied = await prepareDesignSpecialist({ledger: db, owner: principal, projectId, apply: true});
    assert.equal(applied.revisionFrom, rev1);
    assert.equal(applied.revisionTo, rev1 + 1);
    assert.deepEqual(applied.contexts.sort(), [exam.contextId, mainContext].sort());
    assert.equal(
      Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [mainContext])).rows[0].capacity_policy_revision),
      applied.revisionTo,
    );
    assert.equal(
      Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [exam.contextId])).rows[0].capacity_policy_revision),
      applied.revisionTo,
    );
    const mainEpoch = Number((await db.pool.query('SELECT epoch FROM ac_managers WHERE context_id=$1', [mainContext])).rows[0].epoch);
    assert.equal(mainEpoch, mainAuth.epoch);
  } finally {
    await db.close();
    await database.close();
  }
});

test('verificação pessoal via CLI usa contexto dedicado verify, convive com gerente ativo e recusa concorrência com VERIFY_ALREADY_RUNNING', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'verifyctx');
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-verify-ctx-'));
  const dataDirectory = join(root, 'data');
  const databasesDirectory = join(dataDirectory, 'verify-db', '20261118-000000');
  try {
    await mkdir(databasesDirectory, {recursive: true, mode: 0o700});
    await writeFile(join(dataDirectory, 'verify-image.json'), JSON.stringify({image: `sha256:${'ab'.repeat(32)}`}), {mode: 0o600});
    await writeFile(
      join(dataDirectory, 'verify-db', 'current.json'),
      JSON.stringify({directory: databasesDirectory, fetchedAt: new Date().toISOString(), manifestSha256: 'c'.repeat(64)}),
      {mode: 0o600},
    );
    await db.migrate();
    const principal = 'verify-owner';
    const projectId = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Verify Dedicado']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 6, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: ['specialist', 'reviewer'], source: 'synthetic://verifyctx',
    });
    const addClaude = async () => {
      const id = randomUUID();
      await capacity.addAccount(principal, projectId, {
        id, provider: 'claude', label: 'claude', resourceIdentity: `claude:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://verifyctx', maxConcurrent: 4,
      });
      await capacity.observeQuota(principal, id, {status: 'available', source: 'fixture', ttlSeconds: 3600});
      const spec = randomUUID();
      const rev = randomUUID();
      await capacity.addProfile(principal, projectId, {id: spec, accountId: id, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
      await capacity.addProfile(principal, projectId, {id: rev, accountId: id, model: 'claude-sonnet-5-5', effort: 'medium', role: 'reviewer'});
      return {id, spec, rev};
    };
    const a = await addClaude();
    const b = await addClaude();
    const policyRev = await capacity.publish(principal, projectId, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {
        specialist: {regular: [a.spec, b.spec], emergency: []},
        reviewer: {regular: [a.rev, b.rev], emergency: []},
      },
    });
    const mainContext = await db.createContext(principal, projectId, randomUUID());
    await capacity.assignPolicy(principal, mainContext, policyRev);
    const gatewayAuthority = await db.acquire(principal, mainContext, randomUUID(), 'gateway-manager', 60);

    const repo = await initRepo(root);
    const installationPath = await writeInstallation(root, {databaseUrl: database.url, projectId, repo, owner: principal, dataDirectory});
    const composeRuntime = async () => ({executions: [benchVerifySupervisor([a.id, b.id])]}) as never;

    const first = await resolvePersonalVerification([installationPath, projectId], {composeRuntime});
    let verifyContext: string;
    try {
      verifyContext = first.input.authority!.contextId;
      assert.notEqual(verifyContext, mainContext);
      assert.equal(
        Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [verifyContext])).rows[0].capacity_policy_revision),
        policyRev,
      );

      await assert.rejects(
        () => resolvePersonalVerification([installationPath, projectId], {composeRuntime}),
        (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_ALREADY_RUNNING',
      );

      let pending = Promise.resolve();
      const started = await beginPersonalVerification({
        ...first.input,
        runTools: async () => {},
        observe(job) {
          pending = job;
        },
      });
      await pending;
      const runRow = (await db.pool.query<{context_id: string; status: string}>(
        'SELECT context_id::text AS context_id, status FROM ac_verify_runs WHERE id=$1',
        [started.id],
      )).rows[0];
      assert.equal(runRow?.context_id, verifyContext);
      assert.equal(runRow?.status, 'done');
    } finally {
      await first.close();
    }

    const mainManager = (await db.pool.query<{epoch: string; active: boolean}>(
      'SELECT epoch::text AS epoch, lease_until > clock_timestamp() AS active FROM ac_managers WHERE context_id=$1',
      [mainContext],
    )).rows[0];
    assert.equal(Number(mainManager?.epoch), gatewayAuthority.epoch);
    assert.equal(mainManager?.active, true);

    const second = await resolvePersonalVerification([installationPath, projectId], {composeRuntime});
    try {
      assert.equal(second.input.authority!.contextId, verifyContext);
    } finally {
      await second.close();
    }
  } finally {
    await db.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('exame de design, criar e validador deixam intenção em failed na falha e no Ctrl-C', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'examfail');
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-exam-fail-'));
  const dataDirectory = join(root, 'data');
  const databasesDirectory = join(dataDirectory, 'verify-db', '20261118-000000');
  try {
    await mkdir(databasesDirectory, {recursive: true, mode: 0o700});
    await writeFile(join(dataDirectory, 'verify-image.json'), JSON.stringify({image: `sha256:${'ab'.repeat(32)}`}), {mode: 0o600});
    await writeFile(
      join(dataDirectory, 'verify-db', 'current.json'),
      JSON.stringify({directory: databasesDirectory, fetchedAt: new Date().toISOString(), manifestSha256: 'c'.repeat(64)}),
      {mode: 0o600},
    );
    await db.migrate();
    const principal = 'exam-fail-owner';
    const projectId = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Exam Fail']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 6, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: [...roles], source: 'synthetic://examfail',
    });
    const accountId = randomUUID();
    await capacity.addAccount(principal, projectId, {
      id: accountId, provider: 'claude', label: 'claude', resourceIdentity: `claude:${accountId}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://examfail', maxConcurrent: 4,
    });
    await capacity.observeQuota(principal, accountId, {status: 'available', source: 'fixture', ttlSeconds: 3600});
    const spec = randomUUID();
    const rev = randomUUID();
    await capacity.addProfile(principal, projectId, {id: spec, accountId, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, projectId, {id: rev, accountId, model: 'claude-sonnet-5-5', effort: 'medium', role: 'reviewer'});
    const policyRev = await capacity.publish(principal, projectId, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {specialist: {regular: [spec], emergency: []}, reviewer: {regular: [rev], emergency: []}},
    });
    const mainContext = await db.createContext(principal, projectId, randomUUID());
    await capacity.assignPolicy(principal, mainContext, policyRev);
    const repo = await initRepo(root);
    const installationPath = await writeInstallation(root, {databaseUrl: database.url, projectId, repo, owner: principal, dataDirectory});
    const composeRuntime = async () => ({executions: [benchDesignSupervisor([accountId])]}) as never;

    // 1) Falha por exceção no exame/criar de design deixa intenção em failed.
    const designFail = await resolvePersonalDesign([], {installationPath, projectId, composeRuntime});
    await assert.rejects(
      () => runDesignSession(designFail, async () => { throw new Refusal('DESIGN_IMAGE_FAILED'); }),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_IMAGE_FAILED',
    );
    assert.equal(
      (await db.pool.query<{state: string}>('SELECT state FROM ac_intents WHERE id=$1', [designFail.intentId])).rows[0]?.state,
      'failed',
    );

    // 2) Ctrl-C (SIGINT) no exame/criar de design deixa intenção em failed.
    const designInterrupt = await resolvePersonalDesign([], {installationPath, projectId, composeRuntime});
    await assert.rejects(
      () => runDesignSession(designInterrupt, () => new Promise<void>(resolveLater => {
        setImmediate(() => { process.emit('SIGINT', 'SIGINT'); });
        void resolveLater;
      })),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_INTERRUPTED',
    );
    assert.equal(
      (await db.pool.query<{state: string}>('SELECT state FROM ac_intents WHERE id=$1', [designInterrupt.intentId])).rows[0]?.state,
      'failed',
    );

    // 3) Sucesso em runDesignSession deixa intenção em done.
    const designDone = await resolvePersonalDesign([], {installationPath, projectId, composeRuntime});
    await runDesignSession(designDone, async () => 'ok');
    assert.equal(
      (await db.pool.query<{state: string}>('SELECT state FROM ac_intents WHERE id=$1', [designDone.intentId])).rows[0]?.state,
      'done',
    );

    // 4) Falha direta em runSecurityVerification deixa run e intenção em failed.
    const verifyRes1 = await resolvePersonalVerification([installationPath, projectId], {composeRuntime});
    try {
      await assert.rejects(
        () => runSecurityVerification({
          ledger: verifyRes1.input.ledger!,
          principal: verifyRes1.input.principal!,
          authority: verifyRes1.input.authority!,
          projectId,
          repoPath: repo,
          dataDirectory,
          commit: verifyRes1.input.commit!,
          policyRevision: verifyRes1.input.policyRevision!,
          worker: {async run() { throw new Refusal('CLAUDE_SPAWN_EACCES'); }},
        }),
        (error: unknown) => error instanceof Refusal && error.code === 'CLAUDE_SPAWN_EACCES',
      );
      const lastVerify = (await db.pool.query<{status: string; intent_state: string}>(
        `SELECT r.status, i.state AS intent_state
         FROM ac_verify_runs r JOIN ac_intents i ON i.id=r.intent_id
         WHERE r.context_id=$1 ORDER BY r.created_at DESC LIMIT 1`,
        [verifyRes1.input.authority!.contextId],
      )).rows[0];
      assert.equal(lastVerify?.status, 'failed');
      assert.equal(lastVerify?.intent_state, 'failed');
    } finally {
      await verifyRes1.close();
    }

    // 5) Ctrl-C (SIGINT) em runPersonalVerifySession deixa run e intenção em failed.
    const verifyRes2 = await resolvePersonalVerification([installationPath, projectId], {composeRuntime});
    const runIdInterrupt = randomUUID();
    await assert.rejects(
      () => runPersonalVerifySession(verifyRes2, {
        begin: async input => {
          const pending = runSecurityVerification({
            ledger: input.ledger!,
            principal: input.principal!,
            authority: input.authority!,
            projectId: input.projectId,
            repoPath: input.repoPath,
            dataDirectory: input.dataDirectory,
            commit: input.commit!,
            policyRevision: input.policyRevision!,
            runId: runIdInterrupt,
            worker: {
              async run() {
                setImmediate(() => { process.emit('SIGINT', 'SIGINT'); });
                await new Promise(resolveWait => setTimeout(resolveWait, 200));
                return '{}';
              },
            },
          }).then(() => undefined);
          input.observe?.(pending);
          return {id: runIdInterrupt, status: 'running', phase: 'mapa'};
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_INTERRUPTED',
    );
    const interruptedRow = (await db.pool.query<{status: string; intent_state: string}>(
      `SELECT r.status, i.state AS intent_state
       FROM ac_verify_runs r JOIN ac_intents i ON i.id=r.intent_id
       WHERE r.id=$1`,
      [runIdInterrupt],
    )).rows[0];
    assert.equal(interruptedRow?.status, 'failed');
    assert.equal(interruptedRow?.intent_state, 'failed');
  } finally {
    await db.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('selectForNew do projeto não é bloqueado por intenção accepted em contexto de exame, mas continua bloqueado em contexto comum', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'examselect');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'select-owner';
    const projectId = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Exam Select']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await db.createContext(principal, projectId, randomUUID());
    const exam = await db.ensureExamContext(principal, projectId, 'design');
    const stat = await readFile('/proc/self/stat', 'utf8');
    const processStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]!;
    const buildId = `cezar-${'b'.repeat(32)}`;
    await db.pool.query(
      `INSERT INTO ac_workflow_runtime_instances(project_id,instance_id,build_id,executable_digest,runtime_digest,process_id,process_start,protocol,workflow_digests,lease_until)
       VALUES($1,$2,$3,$4,$5,$6,$7,'cezar-frozen-graph-generation-v1','[]'::jsonb,clock_timestamp()+interval '60 seconds')`,
      [projectId, randomUUID(), buildId, 'a'.repeat(64), 'b'.repeat(64), process.pid, processStart],
    );
    await db.pool.query(
      `INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,1,0,'accepted')`,
      [randomUUID(), exam.contextId, principal, '0'.repeat(64), JSON.stringify({schemaVersion: 1}), randomUUID(), randomUUID()],
    );
    const generations = new WorkflowGenerations(db);
    await generations.selectForNew(principal, projectId, buildId);
    const saved = (await db.pool.query<{build_id: string}>(
      'SELECT build_id FROM ac_workflow_runtime_defaults WHERE project_id=$1',
      [projectId],
    )).rows[0];
    assert.equal(saved?.build_id, buildId);

    const normalContext = await db.createContext(principal, projectId, randomUUID());
    await db.pool.query(
      `INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision,state)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,1,0,'accepted')`,
      [randomUUID(), normalContext, principal, '1'.repeat(64), JSON.stringify({schemaVersion: 1}), randomUUID(), randomUUID()],
    );
    await assert.rejects(
      () => generations.selectForNew(principal, projectId, buildId),
      (error: unknown) => error instanceof Refusal && error.code === 'WORKFLOW_LEGACY_RETENTION_REQUIRED',
    );
  } finally {
    await db.close();
    await database.close();
  }
});

test('exame de design e criar com reviewer Codex e 3 perfis Claude em specialist usam perfis distintos e nunca criam grant reviewer', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'designspec');
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-design-spec-'));
  const dataDirectory = join(root, 'data');
  try {
    await mkdir(dataDirectory, {recursive: true, mode: 0o700});
    await db.migrate();
    const principal = 'design-spec-owner';
    const projectId = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Design Specialist Chain']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 6, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    await capacity.registerModel(principal, {
      provider: 'codex', model: 'gpt-6.1-sol', efforts: ['medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    const claudeId = randomUUID();
    const codexId = randomUUID();
    await capacity.addAccount(principal, projectId, {
      id: claudeId, provider: 'claude', label: 'claude', resourceIdentity: `claude:${claudeId}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://designspec', maxConcurrent: 4,
    });
    await capacity.addAccount(principal, projectId, {
      id: codexId, provider: 'codex', label: 'codex', resourceIdentity: `codex:${codexId}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://designspec', maxConcurrent: 4,
    });
    await capacity.observeQuota(principal, claudeId, {status: 'available', source: 'fixture', ttlSeconds: 3600});
    await capacity.observeQuota(principal, codexId, {status: 'available', source: 'fixture', ttlSeconds: 3600});

    // Cadeia reviewer do projeto é Codex; cadeia specialist ganha 3 perfis Claude via preparar (mesma conta, outra sessão para o revisor).
    const codexReviewerProfile = randomUUID();
    await capacity.addProfile(principal, projectId, {
      id: codexReviewerProfile, accountId: codexId, model: 'gpt-6.1-sol', effort: 'high', role: 'reviewer',
    });
    await capacity.publish(principal, projectId, 0, CapacityPolicy.parse({
      schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: 2,
      roles: {reviewer: {regular: [codexReviewerProfile], emergency: []}},
    }));
    const mainContext = await db.createContext(principal, projectId, randomUUID());
    const prepared = await prepareDesignSpecialist({ledger: db, owner: principal, projectId, apply: true});
    const createProfileId = prepared.profiles.find(p => p.purpose === 'criar')?.profileId;
    const examinerProfileId = prepared.profiles.find(p => p.purpose === 'examinador')?.profileId;
    const reviewerProfileId = prepared.profiles.find(p => p.purpose === 'revisor')?.profileId;
    assert.ok(createProfileId && examinerProfileId && reviewerProfileId);
    assert.equal(new Set([createProfileId, examinerProfileId, reviewerProfileId]).size, 3);

    const repo = await initRepo(root);
    const installationPath = await writeInstallation(root, {databaseUrl: database.url, projectId, repo, owner: principal, dataDirectory});
    const jobs = new Map<string, {task: string; role: string; grantId: string}>();
    const visualScores = [
      'hierarquia', 'tipografia', 'cor', 'ritmo', 'grade', 'densidade', 'componentes', 'marca', 'polimento',
    ].map(axis => ({axis, score: 9, region: 'topo', suggestion: 'Manter #1b1917 e 16px.'}));
    const orderedRoles: string[] = [];
    const supervisor = {
      active: true,
      supportsAccount(accountId: string) {
        return accountId === claudeId;
      },
      async start(_principal: string, _authority: unknown, request: {jobId: string; task: string; role: string; grantId: string}) {
        jobs.set(request.jobId, {task: request.task, role: request.role, grantId: request.grantId});
        return {state: 'running'};
      },
      async reconcile(_principal: string, _authority: unknown, request: {jobId: string}) {
        const job = jobs.get(request.jobId);
        const task = job?.task ?? '';
        assert.equal(job?.role, 'specialist');
        if (task.startsWith('Pedido de criação.')) {
          orderedRoles.push('create');
          return {
            state: 'completed',
            output: JSON.stringify({
              kind: 'criacao',
              tokens: {color: {bg: {$value: '#f6f4ef', $type: 'color'}, fg: {$value: '#1b1917', $type: 'color'}}},
              screens: [{name: 'inicio', html: '<!doctype html><html lang="pt-BR"><head><title>Início</title></head><body><main><h1>Início</h1></main></body></html>', css: 'body { color: #1b1917; }\n'}],
            }),
          };
        }
        if (task.startsWith('Pedido de confirmação.')) {
          orderedRoles.push('reviewer');
          return {state: 'completed', output: JSON.stringify({kind: 'confirmacao', status: 'confirmado', reason: 'Baixo contraste.', proof: 'color:#777'})};
        }
        if (task.startsWith('Pedido de crítica visual do revisor.')) {
          orderedRoles.push('reviewer');
          return {state: 'completed', output: JSON.stringify({kind: 'visual', scores: visualScores})};
        }
        if (task.startsWith('Pedido de crítica visual.')) {
          orderedRoles.push('examiner');
          return {state: 'completed', output: JSON.stringify({kind: 'visual', scores: visualScores})};
        }
        orderedRoles.push('examiner');
        return {
          state: 'completed',
          output: JSON.stringify({
            kind: 'exame',
            filesRead: ['inicio.html'],
            checklist: ['DESIGN-NIELSEN-H1-ESTADO'],
            findings: [{
              title: 'Contraste baixo',
              severity: 'media',
              file: 'inicio.html',
              line: 1,
              scenario: 'Texto cinza.',
              suggestion: 'Usar #1b1917.',
              cwe: null,
              reference: 'WCAG-1-4-3-CONTRASTE',
              snippet: 'color:#777',
            }],
          }),
        };
      },
      async retireTerminal() {
        return {state: 'removed'};
      },
    };
    const composeRuntime = async () => ({executions: [supervisor]}) as never;
    const resolved = await resolvePersonalDesign([], {installationPath, projectId, composeRuntime});
    try {
      await runDesignCreate({
        dataDirectory: resolved.dataDirectory,
        runId: randomUUID(),
        repository: resolved.repo,
        briefing: 'Painel claro.',
        screens: 1,
        rounds: 1,
        referenceNote: '',
        worker: resolved.worker,
        reserve: () => resolved.reserve('specialist', undefined, {purpose: 'create'}),
        release: seat => resolved.release(seat),
        intentId: resolved.intentId,
        examine: async (_round, files) => {
          const exam = await runDesignModule({
            activation: 'personal',
            projectId: resolved.projectId,
            repo: resolved.repo,
            targetUrl: 'http://127.0.0.1:4173',
            dataDirectory: resolved.dataDirectory,
            intentId: resolved.intentId,
            runId: randomUUID(),
            createdAt: new Date(),
            commit: resolved.commit,
            files,
            worker: resolved.worker,
            reserve: resolved.reserve,
            release: resolved.release,
            scoreVisual: true,
            tools: {},
          });
          assert.ok(exam.achados.length >= 1);
          assert.ok(exam.achados.some(item => item.verifier?.provider === 'claude'));
          return {
            screens: files.filter(f => f.path.endsWith('.html')).map(f => ({
              name: f.path.slice(0, -'.html'.length),
              rejected: false,
              findings: exam.findings,
              visualNotes: [],
            })),
            notes: [],
          };
        },
      });
      const grants = (await db.pool.query<{role: string; profile_id: string; provider: string}>(
        `SELECT g.role, g.profile_id::text AS profile_id, a.provider
         FROM ac_capacity_grants g JOIN ac_accounts a ON a.id=g.account_id
         WHERE g.intent_id=$1 ORDER BY g.created_at`,
        [resolved.intentId],
      )).rows;
      assert.equal(grants.some(g => g.role === 'reviewer'), false);
      assert.equal(grants.length, orderedRoles.length);
      assert.ok(grants.length >= 5);
      assert.ok(grants.every(g => g.role === 'specialist' && g.provider === 'claude'));
      const expectedByPurpose = {create: createProfileId, examiner: examinerProfileId, reviewer: reviewerProfileId};
      orderedRoles.forEach((purpose, index) => {
        assert.equal(grants[index]?.profile_id, expectedByPurpose[purpose as keyof typeof expectedByPurpose]);
      });
      assert.notEqual(examinerProfileId, reviewerProfileId);
    } finally {
      await resolved.close();
    }
    void mainContext;
  } finally {
    await db.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('exame de design sem segundo perfil Claude em specialist recusa com DESIGN_REVIEWER_UNAVAILABLE e nunca reserva reviewer Codex', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'designnorev');
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-design-norev-'));
  const dataDirectory = join(root, 'data');
  try {
    await mkdir(dataDirectory, {recursive: true, mode: 0o700});
    await db.migrate();
    const principal = 'design-norev-owner';
    const projectId = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, 'Design Sem Revisor']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 6, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: [...roles], source: 'personal://account-add',
    });
    await capacity.registerModel(principal, {
      provider: 'codex', model: 'gpt-6.1-sol', efforts: ['medium'], roles: [...roles], source: 'personal://account-add',
    });
    await capacity.registerModel(principal, {
      provider: 'grok', model: 'grok-4.7', efforts: ['medium'], roles: [...roles], source: 'personal://account-add',
    });
    const claudeId = randomUUID();
    const codexId = randomUUID();
    const grokId = randomUUID();
    for (const [id, provider] of [[claudeId, 'claude'], [codexId, 'codex'], [grokId, 'grok']] as const) {
      await capacity.addAccount(principal, projectId, {
        id, provider, label: provider, resourceIdentity: `${provider}:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://designnorev', maxConcurrent: 4,
      });
      await capacity.observeQuota(principal, id, {status: 'available', source: 'fixture', ttlSeconds: 3600});
    }
    const specClaude = randomUUID();
    const specGrok = randomUUID();
    const codexRev = randomUUID();
    await capacity.addProfile(principal, projectId, {id: specClaude, accountId: claudeId, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, projectId, {id: specGrok, accountId: grokId, model: 'grok-4.7', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, projectId, {id: codexRev, accountId: codexId, model: 'gpt-6.1-sol', effort: 'medium', role: 'reviewer'});
    const rev = await capacity.publish(principal, projectId, 0, CapacityPolicy.parse({
      schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: 2,
      roles: {
        specialist: {regular: [specClaude, specGrok], emergency: []},
        reviewer: {regular: [codexRev], emergency: []},
      },
    }));
    const mainContext = await db.createContext(principal, projectId, randomUUID());
    await capacity.assignPolicy(principal, mainContext, rev);

    const repo = await initRepo(root);
    const installationPath = await writeInstallation(root, {databaseUrl: database.url, projectId, repo, owner: principal, dataDirectory});
    const composeRuntime = async () => ({executions: [benchDesignSupervisor([claudeId])]}) as never;
    const resolved = await resolvePersonalDesign([], {installationPath, projectId, composeRuntime});
    try {
      await assert.rejects(
        () => runDesignModule({
          activation: 'personal',
          projectId: resolved.projectId,
          repo: resolved.repo,
          targetUrl: 'http://127.0.0.1:4173',
          dataDirectory: resolved.dataDirectory,
          intentId: resolved.intentId,
          runId: randomUUID(),
          createdAt: new Date(),
          commit: resolved.commit,
          files: [{path: 'src/index.html', text: '<!doctype html><html><body><h1>Painel</h1></body></html>'}],
          worker: resolved.worker,
          reserve: resolved.reserve,
          release: resolved.release,
          scoreVisual: true,
          tools: {},
        }),
        (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_REVIEWER_UNAVAILABLE',
      );
      const grants = (await db.pool.query<{role: string; profile_id: string}>(
        'SELECT role, profile_id::text AS profile_id FROM ac_capacity_grants WHERE intent_id=$1',
        [resolved.intentId],
      )).rows;
      assert.equal(grants.some(g => g.role === 'reviewer'), false);
      assert.ok(grants.every(g => g.role === 'specialist' && g.profile_id === specClaude));
    } finally {
      await resolved.close();
    }
  } finally {
    await db.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});
