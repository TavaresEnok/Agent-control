import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createPublicKey, generateKeyPairSync, randomUUID, sign, verify} from 'node:crypto';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {Capacity, CapacityPolicy} from '../src/capacity.ts';
import {canonical, Refusal} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {authorizedStaticCliPolicy, beginPersonalVerification, resolvePersonalVerification} from '../src/verify-command.ts';
import {createCapacityNativeWorker} from '../src/verify-native-launch.ts';
import {
  runResolvedPersonalSecurityVerification,
  runSecurityVerification,
  type SecurityVerificationInput,
} from '../src/verify-runtime.ts';
import type {VerifyWorker} from '../src/verify-types.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const exec = promisify(execFile);
const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const roles = ['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge'] as const;

type LaunchRecord = {
  phase: 'map' | 'exam' | 'confirm';
  task: string;
  grantId: string;
  sessionId: string;
  accountId: string;
  profileId: string;
  model: string;
  effort: string;
  role: string;
};

async function initRepo(root: string): Promise<string> {
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), {recursive: true});
  await writeFile(join(repo, 'src', 'app.ts'), "export function route() { return '/admin'; }\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'verify',
    GIT_AUTHOR_EMAIL: 'verify@example.com',
    GIT_COMMITTER_NAME: 'verify',
    GIT_COMMITTER_EMAIL: 'verify@example.com',
  };
  await exec('git', ['init'], {cwd: repo, env});
  await exec('git', ['add', '.'], {cwd: repo, env});
  await exec('git', ['-c', 'user.email=verify@example.com', '-c', 'user.name=verify', 'commit', '-m', 'init'], {cwd: repo, env});
  return repo;
}

async function setupEnvironment(label: string) {
  assert.ok(databaseUrl);
  const database = await isolatedDatabase(databaseUrl, label);
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), `ac-${label}-`));
  const dataDirectory = join(root, 'data');
  const databasesDirectory = join(dataDirectory, 'verify-db', '20261120-000000');
  await mkdir(databasesDirectory, {recursive: true, mode: 0o700});
    // A published stamp has its manifest; the exam confirms it after claiming the stamp.
    await writeFile(join(databasesDirectory, 'manifest.json'), '{}\n');
  await writeFile(join(dataDirectory, 'verify-image.json'), JSON.stringify({image: `sha256:${'ab'.repeat(32)}`}), {mode: 0o600});
  await writeFile(
    join(dataDirectory, 'verify-db', 'current.json'),
    JSON.stringify({directory: databasesDirectory, fetchedAt: new Date().toISOString(), manifestSha256: 'c'.repeat(64)}),
    {mode: 0o600},
  );
  await db.migrate();
  const principal = `${label}-owner`;
  const projectId = randomUUID();
  const capacity = new Capacity(db);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [projectId, `Project ${label}`]);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [projectId, principal]);
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await capacity.configure(principal, {programmingLimit: 6, evaluationLimit: 6});
  const repo = await initRepo(root);
  const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: repo})).stdout.trim();
  const installationPath = join(root, 'installation.json');
  await writeFile(
    installationPath,
    JSON.stringify({
      schemaVersion: 1,
      mode: 'administration-only',
      activation: 'personal',
      databaseUrl: database.url,
      dataDirectory,
      project: {id: projectId, label: `Project ${label}`, repo, owner: principal},
      http: {listen: '127.0.0.1', port: 18425, publicOrigin: 'http://127.0.0.1:18425'},
    }),
    {mode: 0o600},
  );
  await chmod(installationPath, 0o600);
  return {
    db,
    capacity,
    principal,
    projectId,
    repo,
    commit,
    dataDirectory,
    databasesDirectory,
    installationPath,
    async close() {
      await db.close();
      await database.close();
      await rm(root, {recursive: true, force: true});
    },
  };
}

type FixtureRequest = {jobId: string; intentId: string; grantId: string; sessionId: string};

const RECEIPT_DOMAIN = 'agent-control:native-execution-receipt:v1\n';
const executorKeys = generateKeyPairSync('ed25519');
const executorPublicKey = createPublicKey(executorKeys.privateKey);
const strangerKeys = generateKeyPairSync('ed25519');

const signReceiptPayload = (payload: unknown, key = executorKeys.privateKey) =>
  sign(null, Buffer.from(RECEIPT_DOMAIN + canonical(payload)), key).toString('hex');

/** Same contract as NativeExecutionSupervisor.receiptSignedByThisExecutor, over the fixture key. */
function fixtureVouches(receipt: unknown): boolean {
  const saved = receipt as {payload?: unknown; signature?: unknown} | undefined;
  return Boolean(saved?.payload)
    && typeof saved?.signature === 'string'
    && /^[a-f0-9]{128}$/.test(saved.signature)
    && verify(null, Buffer.from(RECEIPT_DOMAIN + canonical(saved.payload)), executorPublicKey, Buffer.from(saved.signature, 'hex'));
}

/** Terminal receipt in the shape the signed native execution contract emits for a started, successful job. */
async function terminalReceipt(db: Ledger, authority: unknown, request: FixtureRequest, over: Record<string, unknown> = {}) {
  const row = (await db.pool.query<{account_id: string; profile_id: string}>(
    'SELECT account_id::text AS account_id, profile_id::text AS profile_id FROM ac_capacity_grants WHERE id=$1',
    [request.grantId],
  )).rows[0]!;
  const payload = {
      schemaVersion: 1,
      accountId: row.account_id,
      profileId: row.profile_id,
      jobId: request.jobId,
      intentId: request.intentId,
      contextId: (authority as {contextId: string}).contextId,
      grantId: request.grantId,
      sessionId: request.sessionId,
      exitCode: 0,
      workerExitCode: 0,
      ...over,
  };
  return {payload, signature: signReceiptPayload(payload)};
}

function createRecordingSupervisor(
  db: Ledger,
  accountIds: readonly string[],
  findings: Array<{title: string; severity: 'alta' | 'media' | 'baixa' | 'informativa'}>,
) {
  const jobs = new Map<string, {task: string; grantId: string; sessionId: string}>();
  const launches: LaunchRecord[] = [];
  const supervisor = {
    active: true,
    receiptSignedByThisExecutor: fixtureVouches,
    supportsAccount(accountId: string) {
      return accountIds.includes(accountId);
    },
    async start(_principal: string, _authority: unknown, request: {jobId: string; grantId: string; sessionId: string; task: string}) {
      jobs.set(request.jobId, {task: request.task, grantId: request.grantId, sessionId: request.sessionId});
      const row = (await db.pool.query<{account_id: string; profile_id: string; model: string; effort: string; role: string}>(
        `SELECT g.account_id::text AS account_id, g.profile_id::text AS profile_id, p.model, p.effort, g.role
         FROM ac_capacity_grants g JOIN ac_profiles p ON p.id=g.profile_id
         WHERE g.id=$1`,
        [request.grantId],
      )).rows[0]!;
      const phase: LaunchRecord['phase'] = request.task.startsWith('Pedido de mapa.')
        ? 'map'
        : request.task.startsWith('Pedido de confirmação.')
          ? 'confirm'
          : 'exam';
      launches.push({
        phase,
        task: request.task,
        grantId: request.grantId,
        sessionId: request.sessionId,
        accountId: row.account_id,
        profileId: row.profile_id,
        model: row.model,
        effort: row.effort,
        role: row.role,
      });
      return {state: 'running'};
    },
    async reconcile(_principal: string, authority: unknown, request: FixtureRequest) {
      const job = jobs.get(request.jobId);
      const task = job?.task ?? '';
      const receipt = await terminalReceipt(db, authority, request);
      if (task.startsWith('Pedido de mapa.')) {
        return {state: 'completed', receipt, output: JSON.stringify({kind: 'mapa', routes: [{method: 'GET', path: '/admin', file: 'src/app.ts', line: 1}], surfaces: ['http']})};
      }
      if (task.startsWith('Pedido de confirmação.')) {
        return {
          state: 'completed',
          receipt,
          output: JSON.stringify({kind: 'confirmacao', status: 'confirmado', reason: 'Confirmado.', proof: 'src/app.ts'}),
        };
      }
      const items = (task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
      return {
        state: 'completed',
        receipt,
        output: JSON.stringify({
          kind: 'exame',
          filesRead: ['src/app.ts'],
          checklist: items.length ? items : ['ASVS-5-V1'],
          findings: findings.map(item => ({
            title: item.title,
            severity: item.severity,
            file: 'src/app.ts',
            line: 1,
            scenario: `Cenário ${item.title}`,
            suggestion: 'Corrigir.',
            cwe: 'CWE-862',
            reference: 'ASVS-5.0-V4',
            snippet: "return '/admin'",
          })),
        }),
      };
    },
    async retireTerminal() {
      return {state: 'removed'};
    },
  };
  return {supervisor, launches};
}

test('CLI personal:verify sem --url usa Sonnet 5.5 high na conta Max, Opus 5.5 medium Max em grant e sessão distintas para achado alto do examinador, e revisor padrão para achado médio', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const env = await setupEnvironment('statpol1');
  try {
    await env.capacity.registerModel(env.principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'synthetic://statpol1',
    });
    await env.capacity.registerModel(env.principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'synthetic://statpol1',
    });
    const primaryMax = randomUUID();
    const secondaryPro = randomUUID();
    for (const id of [primaryMax, secondaryPro]) {
      await env.capacity.addAccount(env.principal, env.projectId, {
        id, provider: 'claude', label: id, resourceIdentity: `claude:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://statpol1', maxConcurrent: 4,
      });
      await env.capacity.observeQuota(env.principal, id, {status: 'available', source: 'fixture', ttlSeconds: 3600});
    }
    const pOpusHighMax = randomUUID();
    const pSonnetHighMax = randomUUID();
    const pSonnetMedMax = randomUUID();
    const pOpusMedMax = randomUUID();
    const pSonnetHighSec = randomUUID();
    const pSonnetMedSec = randomUUID();
    const pSonnetRevSec = randomUUID();
    await env.capacity.addProfile(env.principal, env.projectId, {id: pOpusHighMax, accountId: primaryMax, model: 'claude-opus-5-5', effort: 'high', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetHighMax, accountId: primaryMax, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetMedMax, accountId: primaryMax, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pOpusMedMax, accountId: primaryMax, model: 'claude-opus-5-5', effort: 'medium', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetHighSec, accountId: secondaryPro, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetMedSec, accountId: secondaryPro, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetRevSec, accountId: secondaryPro, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});

    const rev = await env.capacity.publish(env.principal, env.projectId, 0, CapacityPolicy.parse({
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {
        specialist: {
          regular: [pOpusHighMax, pSonnetHighMax, pSonnetMedMax, pSonnetHighSec, pSonnetMedSec],
          emergency: [pOpusMedMax, pSonnetRevSec],
        },
      },
    }));
    const mainContext = await env.db.createContext(env.principal, env.projectId, randomUUID());
    await env.capacity.assignPolicy(env.principal, mainContext, rev);

    const {supervisor, launches} = createRecordingSupervisor(env.db, [primaryMax, secondaryPro], [
      {title: 'Achado critico do examinador', severity: 'alta'},
      {title: 'Achado medio do examinador', severity: 'media'},
    ]);
    const composeRuntime = async () => ({executions: [supervisor]}) as never;
    const resolved = await resolvePersonalVerification([env.installationPath, env.projectId], {composeRuntime});
    try {
      assert.equal('staticModelPolicy' in resolved.input, false);
      {
        const held = {
          worker: resolved.input.worker!, projectId: env.projectId, commit: env.commit, authority: resolved.input.authority!,
        };
        const policy = authorizedStaticCliPolicy(held);
        assert.equal(policy?.nativeWorker, resolved.input.worker);
        assert.equal(policy?.contextId, resolved.input.authority!.contextId);
        assert.equal(authorizedStaticCliPolicy({...held, projectId: randomUUID()}), null);
        assert.equal(authorizedStaticCliPolicy({...held, commit: 'd'.repeat(40)}), null);
        assert.equal(authorizedStaticCliPolicy({...held, authority: {...held.authority, contextId: randomUUID()}}), null);
        // A wrapper written by hand does not inherit the capability.
        assert.equal(authorizedStaticCliPolicy({...held, worker: {run: call => held.worker.run(call)}}), null);
      }
      let pending = Promise.resolve();
      const begun = await beginPersonalVerification({
        ...resolved.input,
        runTools: async spec => { assert.equal(spec.staticPersonalExam, true); },
        observe(job) {
          pending = job;
        },
      });
      await pending;

      const mapLaunch = launches.find(l => l.phase === 'map');
      const examLaunch = launches.find(l => l.phase === 'exam');
      const highConfirm = launches.find(l => l.phase === 'confirm' && l.task.includes('Achado critico do examinador'));
      const mediumConfirm = launches.find(l => l.phase === 'confirm' && l.task.includes('Achado medio do examinador'));
      assert.ok(mapLaunch && examLaunch && highConfirm && mediumConfirm);

      assert.equal(mapLaunch.accountId, primaryMax);
      assert.equal(mapLaunch.model, 'claude-sonnet-5-5');
      assert.equal(mapLaunch.effort, 'high');
      assert.equal(examLaunch.accountId, primaryMax);
      assert.equal(examLaunch.model, 'claude-sonnet-5-5');
      assert.equal(examLaunch.effort, 'high');

      assert.equal(highConfirm.accountId, primaryMax);
      assert.equal(highConfirm.profileId, pOpusMedMax);
      assert.equal(highConfirm.model, 'claude-opus-5-5');
      assert.equal(highConfirm.effort, 'medium');
      assert.notEqual(highConfirm.profileId, examLaunch.profileId);
      assert.notEqual(highConfirm.grantId, examLaunch.grantId);
      assert.notEqual(highConfirm.sessionId, examLaunch.sessionId);

      assert.equal(mediumConfirm.accountId, secondaryPro);
      assert.equal(mediumConfirm.model, 'claude-sonnet-5-5');
      assert.equal(mediumConfirm.effort, 'medium');

      const stored = (await env.db.pool.query<{achado_id: string; payload: {title: string; verifier: {model: string; provider: string}}}>(
        'SELECT achado_id, payload FROM ac_verify_findings WHERE run_id=$1 ORDER BY achado_id',
        [begun.id],
      )).rows;
      const highStored = stored.find(row => row.payload.title === 'Achado critico do examinador');
      const mediumStored = stored.find(row => row.payload.title === 'Achado medio do examinador');
      assert.deepEqual(highStored?.payload.verifier, {provider: 'claude', model: 'claude-opus-5-5'});
      assert.deepEqual(mediumStored?.payload.verifier, {provider: 'claude', model: 'claude-sonnet-5-5'});

      const coverage = (await env.db.pool.query<{examiner_model: string}>(
        'SELECT examiner_model FROM ac_verify_coverage WHERE run_id=$1',
        [begun.id],
      )).rows;
      assert.ok(coverage.length >= 1);
      assert.ok(coverage.every(row => row.examiner_model === 'claude-sonnet-5-5'));

      const grants = (await env.db.pool.query<{state: string}>(
        `SELECT state FROM ac_capacity_grants WHERE context_id=$1`,
        [resolved.input.authority!.contextId],
      )).rows;
      assert.ok(grants.every(row => row.state === 'released'));
    } finally {
      await resolved.close();
    }
  } finally {
    await env.close();
  }
});

test('conta Claude única Max confirma achado alto em sessão distinta comprovada e recusa sessão ausente ou repetida', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const env = await setupEnvironment('statpol2');
  try {
    await env.capacity.registerModel(env.principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'synthetic://statpol2',
    });
    await env.capacity.registerModel(env.principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'synthetic://statpol2',
    });
    const primaryMax = randomUUID();
    await env.capacity.addAccount(env.principal, env.projectId, {
      id: primaryMax, provider: 'claude', label: 'max-only', resourceIdentity: `claude:${primaryMax}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://statpol2', maxConcurrent: 4,
    });
    await env.capacity.observeQuota(env.principal, primaryMax, {status: 'available', source: 'fixture', ttlSeconds: 3600});
    const pSonnetHigh = randomUUID();
    const pOpusMed = randomUUID();
    const pSonnetMed = randomUUID();
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetHigh, accountId: primaryMax, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pOpusMed, accountId: primaryMax, model: 'claude-opus-5-5', effort: 'medium', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetMed, accountId: primaryMax, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    const rev = await env.capacity.publish(env.principal, env.projectId, 0, CapacityPolicy.parse({
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {
        specialist: {regular: [pSonnetHigh], emergency: [pOpusMed, pSonnetMed]},
      },
    }));
    const mainContext = await env.db.createContext(env.principal, env.projectId, randomUUID());
    await env.capacity.assignPolicy(env.principal, mainContext, rev);

    // 1) Fluxo CLI completo em conta única Max: funciona com grant e sessionId distintos.
    const {supervisor, launches} = createRecordingSupervisor(env.db, [primaryMax], [
      {title: 'Achado alto conta unica', severity: 'alta'},
    ]);
    const composeRuntime = async () => ({executions: [supervisor]}) as never;
    const resolved = await resolvePersonalVerification([env.installationPath, env.projectId], {composeRuntime});
    try {
      let pending = Promise.resolve();
      await beginPersonalVerification({
        ...resolved.input,
        runTools: async () => {},
        observe(job) {
          pending = job;
        },
      });
      await pending;
      const examLaunch = launches.find(l => l.phase === 'exam')!;
      const confirmLaunch = launches.find(l => l.phase === 'confirm')!;
      assert.equal(examLaunch.accountId, primaryMax);
      assert.equal(examLaunch.model, 'claude-sonnet-5-5');
      assert.equal(examLaunch.effort, 'high');
      assert.equal(confirmLaunch.accountId, primaryMax);
      assert.equal(confirmLaunch.model, 'claude-opus-5-5');
      assert.equal(confirmLaunch.effort, 'medium');
      assert.notEqual(confirmLaunch.grantId, examLaunch.grantId);
      assert.notEqual(confirmLaunch.sessionId, examLaunch.sessionId);
    } finally {
      await resolved.close();
    }

    // 2) No caminho nativo da mesma conta, falha se sessão do supervisor faltar, repetir ou falhar na conclusão.
    for (const mode of [
      'missing-reviewer-session', 'same-session', 'missing-examiner-session', 'failed-reviewer-execution',
      'session-only-examiner', 'session-only-reviewer', 'unstarted-reviewer', 'forged-reviewer-context', 'unretired-reviewer',
      'forged-reviewer-signature', 'tampered-reviewer-receipt', 'foreign-key-reviewer-receipt',
    ] as const) {
      const jobs = new Map<string, {task: string; sessionId: string}>();
      let examSessionId = '';
      let confirmLaunched = false;
      const faultySupervisor = {
        active: true,
        receiptSignedByThisExecutor: fixtureVouches,
        supportsAccount(accountId: string) {
          return accountId === primaryMax;
        },
        async start(_principal: string, _authority: unknown, request: {jobId: string; sessionId: string; task: string}) {
          jobs.set(request.jobId, {task: request.task, sessionId: request.sessionId});
          if (request.task.startsWith('Pedido de exame.')) examSessionId = request.sessionId;
          if (request.task.startsWith('Pedido de confirmação.')) confirmLaunched = true;
          return {state: 'running'};
        },
        async reconcile(_principal: string, authority: unknown, request: FixtureRequest) {
          const job = jobs.get(request.jobId);
          const task = job?.task ?? '';
          const receipt = await terminalReceipt(env.db, authority, request);
          if (task.startsWith('Pedido de mapa.')) {
            return {state: 'completed', output: JSON.stringify({kind: 'mapa', routes: [], surfaces: ['http']})};
          }
          if (task.startsWith('Pedido de exame.')) {
            const items = (task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
            const output = JSON.stringify({
              kind: 'exame',
              sessionId: randomUUID(),
              filesRead: ['src/app.ts'],
              checklist: items.length ? items : ['ASVS-5-V1'],
              findings: [{
                title: 'Alto sem sessao',
                severity: 'alta',
                file: 'src/app.ts',
                line: 1,
                scenario: 's',
                suggestion: 'g',
                cwe: 'CWE-862',
                reference: 'ASVS-5.0-V4',
                snippet: "return '/admin'",
              }],
            });
            if (mode === 'missing-examiner-session') {
              return {state: 'completed', output, receipt: {payload: {executionStarted: false}}};
            }
            if (mode === 'session-only-examiner') {
              return {state: 'completed', output, receipt: {payload: {sessionId: request.sessionId}}};
            }
            return {state: 'completed', output, receipt};
          }
          const confirmOutput = JSON.stringify({kind: 'confirmacao', status: 'confirmado', reason: 'ok', proof: 'src/app.ts'});
          if (mode === 'missing-reviewer-session') {
            return {state: 'completed', output: confirmOutput};
          }
          if (mode === 'session-only-reviewer') {
            return {state: 'completed', output: confirmOutput, receipt: {payload: {sessionId: request.sessionId}}};
          }
          if (mode === 'unstarted-reviewer') {
            return {state: 'completed', output: confirmOutput, receipt: await terminalReceipt(env.db, authority, request, {executionStarted: false})};
          }
          if (mode === 'forged-reviewer-context') {
            return {state: 'completed', output: confirmOutput, receipt: await terminalReceipt(env.db, authority, request, {contextId: randomUUID()})};
          }
          // Every id, the exit code and 128 hex digits are right, but the signature is not the supervisor's.
          if (mode === 'forged-reviewer-signature') {
            return {state: 'completed', output: confirmOutput, receipt: {...receipt, signature: 'ab'.repeat(64)}};
          }
          if (mode === 'tampered-reviewer-receipt') {
            return {state: 'completed', output: confirmOutput, receipt: {...receipt, payload: {...receipt.payload, workerExitCode: 1}}};
          }
          if (mode === 'foreign-key-reviewer-receipt') {
            return {state: 'completed', output: confirmOutput, receipt: {...receipt, signature: signReceiptPayload(receipt.payload, strangerKeys.privateKey)}};
          }
          if (mode === 'same-session') {
            return {state: 'completed', output: confirmOutput, receipt: await terminalReceipt(env.db, authority, request, {sessionId: examSessionId})};
          }
          if (mode === 'failed-reviewer-execution') {
            return {state: 'failed', output: confirmOutput};
          }
          return {state: 'completed', output: confirmOutput, receipt};
        },
        async retireTerminal() {
          return mode === 'unretired-reviewer' && confirmLaunched ? {state: 'retained'} : {state: 'removed'};
        },
      };
      const faultyResolved = await resolvePersonalVerification([env.installationPath, env.projectId], {
        composeRuntime: async () => ({executions: [faultySupervisor]}) as never,
      });
      try {
        let pending = Promise.resolve();
        await beginPersonalVerification({
          ...faultyResolved.input,
          runTools: async () => {},
          observe(job) {
            pending = job;
          },
        });
        await assert.rejects(
          pending,
          (error: unknown) => error instanceof Refusal && error.code === 'MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE',
        );
        if (mode === 'missing-examiner-session' || mode === 'session-only-examiner') {
          assert.equal(confirmLaunched, false);
        } else {
          assert.equal(confirmLaunched, true);
        }
      } finally {
        await faultyResolved.close();
      }
    }
    const unreleased = (await env.db.pool.query<{n: number}>(
      `SELECT count(*)::int AS n FROM ac_capacity_grants WHERE context_id=$1 AND state <> 'released'`,
      [mainContext],
    )).rows[0]!.n;
    assert.equal(unreleased, 0);
  } finally {
    await env.close();
  }
});

test('CLI personal:verify sem --url recusa sem fallback silencioso quando falta Sonnet 5.5 high ou Opus 5.5 medium na conta prioritária Max', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const env = await setupEnvironment('statpol3');
  try {
    await env.capacity.registerModel(env.principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'synthetic://statpol3',
    });
    await env.capacity.registerModel(env.principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'synthetic://statpol3',
    });
    const primaryMax = randomUUID();
    const secondaryPro = randomUUID();
    for (const id of [primaryMax, secondaryPro]) {
      await env.capacity.addAccount(env.principal, env.projectId, {
        id, provider: 'claude', label: id, resourceIdentity: `claude:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://statpol3', maxConcurrent: 4,
      });
      await env.capacity.observeQuota(env.principal, id, {status: 'available', source: 'fixture', ttlSeconds: 3600});
    }
    const pSonnetMedMax = randomUUID();
    const pSonnetHighMax = randomUUID();
    const pOpusHighMax = randomUUID();
    const pSonnetHighSec = randomUUID();
    const pOpusMedSec = randomUUID();
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetMedMax, accountId: primaryMax, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetHighMax, accountId: primaryMax, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pOpusHighMax, accountId: primaryMax, model: 'claude-opus-5-5', effort: 'high', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pSonnetHighSec, accountId: secondaryPro, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pOpusMedSec, accountId: secondaryPro, model: 'claude-opus-5-5', effort: 'medium', role: 'specialist'});

    // 1) Sem Sonnet 5.5 high na conta prioritária (embora exista medium na Max e high na secundária) -> recusa sem fallback.
    const revNoSonnetHigh = await env.capacity.publish(env.principal, env.projectId, 0, CapacityPolicy.parse({
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {specialist: {regular: [pSonnetMedMax, pSonnetHighSec], emergency: [pOpusMedSec]}},
    }));
    const mainContext = await env.db.createContext(env.principal, env.projectId, randomUUID());
    await env.capacity.assignPolicy(env.principal, mainContext, revNoSonnetHigh);

    const rec1 = createRecordingSupervisor(env.db, [primaryMax, secondaryPro], [{title: 'Alto', severity: 'alta'}]);
    const res1 = await resolvePersonalVerification([env.installationPath, env.projectId], {
      composeRuntime: async () => ({executions: [rec1.supervisor]}) as never,
    });
    try {
      let pending = Promise.resolve();
      await beginPersonalVerification({
        ...res1.input,
        runTools: async () => {},
        observe(job) { pending = job; },
      });
      await assert.rejects(
        pending,
        (error: unknown) => error instanceof Refusal && error.code === 'MODULE_EXAM_EXAMINER_UNAVAILABLE',
      );
      assert.equal(rec1.launches.length, 0);
    } finally {
      await res1.close();
    }

    // 2) Com Sonnet 5.5 high na Max, mas sem Opus 5.5 medium na Max (só Opus high na Max e Opus medium na secundária) -> recusa revisor de achado alto.
    const revNoOpusMed = await env.capacity.publish(env.principal, env.projectId, revNoSonnetHigh, CapacityPolicy.parse({
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {specialist: {regular: [pOpusHighMax, pSonnetHighMax], emergency: [pOpusMedSec]}},
    }));
    await env.capacity.assignPolicy(env.principal, mainContext, revNoOpusMed);
    await env.capacity.assignPolicy(env.principal, res1.input.authority!.contextId, revNoOpusMed);

    const rec2 = createRecordingSupervisor(env.db, [primaryMax, secondaryPro], [{title: 'Alto sem opus med', severity: 'alta'}]);
    const res2 = await resolvePersonalVerification([env.installationPath, env.projectId], {
      composeRuntime: async () => ({executions: [rec2.supervisor]}) as never,
    });
    try {
      let pending = Promise.resolve();
      await beginPersonalVerification({
        ...res2.input,
        runTools: async () => {},
        observe(job) { pending = job; },
      });
      await assert.rejects(
        pending,
        (error: unknown) => error instanceof Refusal && error.code === 'MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE',
      );
      assert.equal(rec2.launches.some(l => l.phase === 'confirm'), false);
      assert.equal(rec2.launches.some(l => l.accountId === secondaryPro), false);
    } finally {
      await res2.close();
    }
  } finally {
    await env.close();
  }
});

test('chamadores com --url, beginPersonalVerification direto e runSecurityVerification direto preservam comportamento anterior', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const env = await setupEnvironment('statpol4');
  try {
    await env.capacity.registerModel(env.principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: [...roles], source: 'synthetic://statpol4',
    });
    const accA = randomUUID();
    const accB = randomUUID();
    for (const id of [accA, accB]) {
      await env.capacity.addAccount(env.principal, env.projectId, {
        id, provider: 'claude', label: id, resourceIdentity: `claude:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://statpol4', maxConcurrent: 4,
      });
      await env.capacity.observeQuota(env.principal, id, {status: 'available', source: 'fixture', ttlSeconds: 3600});
    }
    const pA = randomUUID();
    const pB = randomUUID();
    await env.capacity.addProfile(env.principal, env.projectId, {id: pA, accountId: accA, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await env.capacity.addProfile(env.principal, env.projectId, {id: pB, accountId: accB, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    const rev = await env.capacity.publish(env.principal, env.projectId, 0, CapacityPolicy.parse({
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {specialist: {regular: [pA], emergency: [pB]}},
    }));
    const mainContext = await env.db.createContext(env.principal, env.projectId, randomUUID());
    await env.capacity.assignPolicy(env.principal, mainContext, rev);

    // 1) CLI com --url não ativa política estática e funciona com sonnet medium apenas.
    const recUrl = createRecordingSupervisor(env.db, [accA, accB], [{title: 'Alto com url', severity: 'alta'}]);
    const resUrl = await resolvePersonalVerification([env.installationPath, env.projectId, '--url', 'http://127.0.0.1:9/app'], {
      composeRuntime: async () => ({executions: [recUrl.supervisor]}) as never,
    });
    try {
      assert.equal('staticModelPolicy' in resUrl.input, false);
      // The resolver issues the capability only without --url.
      assert.equal(authorizedStaticCliPolicy({
        worker: resUrl.input.worker!, projectId: env.projectId, commit: env.commit, authority: resUrl.input.authority!,
      }), null);
      let pending = Promise.resolve();
      await beginPersonalVerification({
        ...resUrl.input,
        runTools: async spec => { assert.equal(spec.staticPersonalExam, undefined); },
        observe(job) { pending = job; },
      });
      await pending;
      assert.ok(recUrl.launches.some(l => l.phase === 'exam'));
      assert.ok(recUrl.launches.some(l => l.phase === 'confirm'));
      assert.ok(recUrl.launches.every(l => l.model === 'claude-sonnet-5-5' && l.effort === 'medium'));
    } finally {
      await resUrl.close();
    }

    // 2) beginPersonalVerification direto (mesmo tentando forjar staticModelPolicy: true) preserva comportamento anterior.
    const authDirect = await env.db.acquire(env.principal, mainContext, randomUUID(), 'statpol4-direct', 60);
    const directWorker: VerifyWorker = {
      async run(call) {
        (call as {examSessionId?: string}).examSessionId = randomUUID();
        if (call.task.startsWith('Pedido de mapa.')) return JSON.stringify({kind: 'mapa', routes: [], surfaces: ['http']});
        if (call.task.startsWith('Pedido de confirmação.')) {
          return JSON.stringify({kind: 'confirmacao', status: 'confirmado', reason: 'ok', proof: 'src/app.ts'});
        }
        const items = (call.task.match(/^Itens: (.*)$/m)?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean);
        return JSON.stringify({
          kind: 'exame',
          filesRead: ['src/app.ts'],
          checklist: items.length ? items : ['ASVS-5-V1'],
          findings: [{
            title: 'Alto direto',
            severity: 'alta',
            file: 'src/app.ts',
            line: 1,
            scenario: 's',
            suggestion: 'g',
            cwe: 'CWE-862',
            reference: 'ASVS-5.0-V4',
            snippet: "return '/admin'",
          }],
        });
      },
    };
    let directPending = Promise.resolve();
    await beginPersonalVerification({
      projectId: env.projectId,
      dataDirectory: env.dataDirectory,
      repoPath: env.repo,
      commit: env.commit,
      ledger: env.db,
      principal: env.principal,
      authority: authDirect,
      policyRevision: rev,
      worker: directWorker,
      databasesDirectory: env.databasesDirectory,
      image: `sha256:${'ab'.repeat(32)}`,
      staticModelPolicy: true,
      runTools: async () => {},
      observe(job: Promise<void>) { directPending = job; },
    } as never);
    await directPending;

    // 3) Mesmo a partir de resolvePersonalVerification sem --url, acrescentar url ou trocar worker desabilita a política estática.
    const recWithoutUrl = createRecordingSupervisor(env.db, [accA, accB], [{title: 'Alto url sobreposto', severity: 'alta'}]);
    const resWithoutUrl = await resolvePersonalVerification([env.installationPath, env.projectId], {
      composeRuntime: async () => ({executions: [recWithoutUrl.supervisor]}) as never,
    });
    try {
      let urlOverridePending = Promise.resolve();
      await beginPersonalVerification({
        ...resWithoutUrl.input,
        url: 'http://127.0.0.1:9/app',
        runTools: async () => {},
        observe(job) { urlOverridePending = job; },
      });
      await urlOverridePending;
      assert.ok(recWithoutUrl.launches.some(l => l.phase === 'exam'));
      assert.ok(recWithoutUrl.launches.some(l => l.phase === 'confirm'));
      assert.ok(recWithoutUrl.launches.every(l => l.model === 'claude-sonnet-5-5' && l.effort === 'medium'));

      let swappedWorkerPending = Promise.resolve();
      await beginPersonalVerification({
        ...resWithoutUrl.input,
        worker: directWorker,
        runTools: async () => {},
        observe(job) { swappedWorkerPending = job; },
      });
      await swappedWorkerPending;
    } finally {
      await resWithoutUrl.close();
    }

    // 4) runSecurityVerification direto (mesmo tentando staticModelPolicy: true) preserva comportamento anterior.
    const result = await runSecurityVerification({
      ledger: env.db,
      principal: env.principal,
      authority: authDirect,
      projectId: env.projectId,
      repoPath: env.repo,
      dataDirectory: env.dataDirectory,
      commit: env.commit,
      policyRevision: rev,
      worker: directWorker,
      staticModelPolicy: true,
    } as never);
    assert.equal(result.achados.length, 1);
    assert.equal(result.achados[0]?.verifier?.model, 'claude-sonnet-5-5');
  } finally {
    await env.close();
  }
});

test('o runtime só importa o verificador: nenhum worker sem concessão emitida pelo resolvedor ativa a política estática', async () => {
  const projectId = randomUUID();
  const contextId = randomUUID();
  const commit = 'c'.repeat(40);
  const authority = {contextId, instanceId: randomUUID(), epoch: 1};
  const native = createCapacityNativeWorker({supervisors: [], principal: 'owner', authority, ledger: {} as Ledger, base: commit});
  const plain: VerifyWorker = {async run() { return ''; }};
  const wrapper: VerifyWorker = {run: call => native.run(call)};
  // A refused activation never reaches the ledger: an empty ledger would throw a different error.
  const inputFor = (worker: VerifyWorker) => ({
    ledger: {} as Ledger,
    principal: 'owner',
    authority,
    projectId,
    repoPath: '/nonexistent',
    dataDirectory: '/nonexistent',
    commit,
    policyRevision: 1,
    worker,
  }) as SecurityVerificationInput;
  const unauthorized = (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_STATIC_POLICY_UNAUTHORIZED';

  for (const worker of [native, plain, wrapper]) {
    assert.equal(authorizedStaticCliPolicy(inputFor(worker)), null);
    await assert.rejects(runResolvedPersonalSecurityVerification(inputFor(worker)), unauthorized);
  }
  // The runtime module exposes no way to issue or register the capability.
  const exported = Object.keys(await import('../src/verify-runtime.ts'));
  assert.deepEqual(exported.filter(name => /grant|issue|wrap|register/i.test(name)), []);
});

