import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Command, Refusal, digest, type Command as DesignCommand} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {NativeExecutionSupervisor, readonlyDesignExam} from '../src/native-execution-supervisor.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const commit = '0123456789abcdef0123456789abcdef01234567';
const channels = ['cockpit', 'happier', 'api', 'mcp', 'automation'] as const;
const blockedRoles = ['programmer', 'qa', 'judge'] as const;
const examRoles = ['specialist', 'reviewer'] as const;

function refusal(code: string, status: number) {
  return (error: unknown) => error instanceof Refusal && error.code === code && error.status === status;
}

function designCommand(intentId: string, contextId: string, projectId: string): DesignCommand {
  return Command.parse({
    schemaVersion: 1,
    intentId,
    deliveryAttemptId: randomUUID(),
    contextId,
    policyRevision: 1,
    action: 'plan.start',
    payload: {
      workflow: 'design-readonly-v1',
      messageRef: `design:${projectId}:${commit}`.slice(0, 200),
      projectId,
      commit,
    },
  });
}

async function pendingIds(db: Ledger, contextId: string): Promise<string[]> {
  const rows = await db.pool.query(
    "SELECT snapshot->'pendingIntentIds' AS ids FROM ac_checkpoints WHERE context_id=$1",
    [contextId],
  );
  return rows.rows.flatMap(row => Array.isArray(row.ids) ? row.ids as string[] : []);
}

async function absent(db: Ledger, intentId: string) {
  for (const table of ['ac_intents', 'ac_outbox', 'ac_operations', 'ac_frozen_plans', 'ac_deliveries']) {
    const column = table === 'ac_intents' ? 'id' : 'intent_id';
    assert.equal((await db.pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [intentId])).rowCount, 0, table);
  }
}

/** The shortcut is private. The test calls it to show mode and role, then proves the policy through start. */
function personalExam(supervisor: NativeExecutionSupervisor, db: Ledger, intentId: string, role: string) {
  const gate = supervisor as unknown as {
    personalReadonlyExam(client: Ledger['pool'], intentId: string, role: unknown): Promise<boolean>;
  };
  return gate.personalReadonlyExam(db.pool, intentId, role);
}

test('programmer, qa and judge never match the readonly design exam', () => {
  for (const role of blockedRoles) {
    assert.equal(readonlyDesignExam('design-readonly-v1', role), false);
    assert.equal(readonlyDesignExam('security-verify-readonly-v1', role), false);
    assert.equal(readonlyDesignExam('engineering-native-v1', role), false);
  }
  assert.equal(readonlyDesignExam('design-readonly-v1', 'specialist'), true);
  assert.equal(readonlyDesignExam('design-readonly-v1', 'reviewer'), true);
  assert.equal(readonlyDesignExam('engineering-native-v1', 'specialist'), false);
  assert.equal(readonlyDesignExam('engineering-native-v1', 'reviewer'), false);
  assert.equal(readonlyDesignExam('security-verify-readonly-v1', 'specialist'), false);
  assert.equal(readonlyDesignExam(undefined, 'specialist'), false);
  assert.equal(readonlyDesignExam('design-readonly-v1', undefined), false);
});

test('public accept of design-readonly-v1 is refused and leaves no intent', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'designpublic');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'design-public-owner';
    const project = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Design']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    assert.equal((await db.pool.query('SELECT mode FROM ac_installation_activation WHERE id=1')).rows[0].mode, 'locked');
    const context = await db.createContext(principal, project, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'design-public', 60);
    for (const channel of channels) {
      const intentId = randomUUID();
      const command = designCommand(intentId, context, project);
      assert.equal(command.payload.workflow, 'design-readonly-v1');
      await assert.rejects(() => db.accept(principal, command, authority, channel), refusal('DESIGN_INTENT_NOT_PUBLIC', 403));
      await absent(db, intentId);
      assert.equal((await pendingIds(db, context)).includes(intentId), false);
    }
    assert.equal((await db.pool.query('SELECT plan_revision FROM ac_contexts WHERE id=$1', [context])).rows[0].plan_revision, 0);
    const ordinary = await db.accept(principal, {
      schemaVersion: 1,
      intentId: randomUUID(),
      deliveryAttemptId: randomUUID(),
      contextId: context,
      policyRevision: 1,
      action: 'plan.start',
      payload: {workflow: 'baseline-synthetic-v1', messageRef: 'encrypted:still-admitted'},
    }, authority, 'cockpit');
    assert.equal(ordinary.command.payload.workflow, 'baseline-synthetic-v1');
    const revision = Number((await db.pool.query('SELECT plan_revision FROM ac_contexts WHERE id=$1', [context])).rows[0].plan_revision);
    const personalId = randomUUID();
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await assert.rejects(
      () => db.accept(principal, designCommand(personalId, context, project), authority, 'cockpit'),
      refusal('DESIGN_INTENT_NOT_PUBLIC', 403),
    );
    await absent(db, personalId);
    assert.equal((await pendingIds(db, context)).includes(personalId), false);
    assert.equal(Number((await db.pool.query('SELECT plan_revision FROM ac_contexts WHERE id=$1', [context])).rows[0].plan_revision), revision);
    const ownedId = randomUUID();
    const owned = designCommand(ownedId, context, project);
    await db.tx(async c => {
      await c.query(
        `INSERT INTO ac_intents (id, context_id, principal_id, digest, command, operation_id, run_id, manager_epoch, plan_revision)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
        [ownedId, context, principal, digest(owned), JSON.stringify(owned), randomUUID(), randomUUID(), authority.epoch, revision],
      );
    });
    assert.equal(Command.parse((await db.pool.query('SELECT command FROM ac_intents WHERE id=$1', [ownedId])).rows[0].command).payload.workflow, 'design-readonly-v1');
    await assert.rejects(
      () => db.accept(principal, {...owned, deliveryAttemptId: randomUUID()}, authority, 'happier'),
      refusal('DESIGN_INTENT_NOT_PUBLIC', 403),
    );
    assert.equal((await db.pool.query('SELECT id FROM ac_intents WHERE id=$1', [ownedId])).rowCount, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM ac_audit WHERE kind='intent.accepted' AND detail->>'intentId'=$1", [ownedId])).rows[0].n, 0);
  } finally {
    await db.close();
    await database.close();
  }
});

test('locked mode and blocked roles still require a quality policy', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'designpolicy');
  const db = new Ledger(database.url);
  let area: string | undefined;
  try {
    await db.migrate();
    const principal = 'design-policy-owner';
    const project = randomUUID();
    const account = randomUUID();
    const subject = 'a'.repeat(64);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Design policy']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    area = await mkdtemp(join(tmpdir(), 'ac-design-policy-'));
    const repo = join(area, 'repo');
    const spool = join(area, 'spool');
    const accounts = join(area, 'accounts');
    for (const path of [repo, spool, accounts]) await mkdir(path, {mode: 0o700});
    await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [project, repo]);
    const context = await db.createContext(principal, project, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'design-policy', 60);
    await db.pool.query(
      "INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,'{}',$3)",
      [project, 'b'.repeat(64), principal],
    );
    const capacity = new Capacity(db);
    await capacity.addAccount(principal, project, {
      id: account,
      provider: 'codex',
      label: 'design policy fixture',
      resourceIdentity: `codex:${subject}`,
      mode: 'subscription_cli',
      eligibility: 'documented_supported',
      eligibilitySource: 'https://example.invalid/design-policy',
      maxConcurrent: 8,
    });
    await capacity.observeQuota(principal, account, {status: 'available', source: 'fixture', ttlSeconds: 3600});
    const intentId = randomUUID();
    const owned = designCommand(intentId, context, project);
    await db.tx(async c => {
      await c.query(
        `INSERT INTO ac_intents (id, context_id, principal_id, digest, command, operation_id, run_id, manager_epoch, plan_revision)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,0)`,
        [intentId, context, principal, digest(owned), JSON.stringify(owned), randomUUID(), randomUUID(), authority.epoch],
      );
    });
    const grants = new Map<string, string>();
    for (const role of [...blockedRoles, ...examRoles]) {
      const profile = randomUUID();
      const grant = randomUUID();
      await db.pool.query(
        "INSERT INTO ac_profiles(id,account_id,model,effort,role,enabled) VALUES($1,$2,'fixture-model','medium',$3,true)",
        [profile, account, role],
      );
      await db.pool.query(
        `INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,$10,false,'reserved')`,
        [grant, randomUUID(), intentId, context, authority.epoch, account, profile, role, project, digest({role, intentId})],
      );
      grants.set(role, grant);
    }
    const keys = generateKeyPairSync('ed25519');
    const image = `sha256:${'c'.repeat(64)}`;
    const supervisor = new NativeExecutionSupervisor(db, {
      id: 'codex-native-execution',
      workerImage: image,
      toolsImage: image,
      hostRoot: spool,
      accountRoot: accounts,
      repository: repo,
      protectedRepositories: [],
      signingKeyPem: keys.privateKey.export({format: 'pem', type: 'pkcs8'}).toString(),
      providerNetworkId: 'd'.repeat(64),
      provider: 'codex',
      accountSubjects: [{accountId: account, subjectDigest: subject}],
      workerEnv: [],
      toolsEnv: [],
    }, {async assertAdmission() { throw new Error('DISK_GUARD_REACHED'); }});
    const launch = (role: typeof blockedRoles[number] | typeof examRoles[number]) => supervisor.start(principal, authority, {
      jobId: randomUUID(),
      intentId,
      grantId: grants.get(role)!,
      sessionId: randomUUID(),
      base: 'e'.repeat(40),
      role,
      task: 'design exam must not skip the quality policy',
      writePaths: role === 'programmer' ? ['src/example.ts'] : [],
      ...(role === 'programmer' ? {} : {artifactId: randomUUID(), outputSchema: {type: 'object'}}),
    });
    for (const role of examRoles) assert.equal(await personalExam(supervisor, db, intentId, role), true);
    for (const role of blockedRoles) {
      assert.equal(readonlyDesignExam('design-readonly-v1', role), false);
      assert.equal(await personalExam(supervisor, db, intentId, role), false);
      await assert.rejects(launch(role), refusal('NATIVE_EXECUTION_POLICY_REQUIRED', 409));
    }
    // The activation guard forbids an enabled real account while locked.
    // Disable it only to flip the mode, so an already eligible grant still has to require a quality policy.
    await db.pool.query('ALTER TABLE ac_installation_activation DISABLE TRIGGER ac_installation_activation_guard');
    await db.pool.query("UPDATE ac_installation_activation SET mode='locked' WHERE id=1");
    await db.pool.query('ALTER TABLE ac_installation_activation ENABLE TRIGGER ac_installation_activation_guard');
    assert.equal((await db.pool.query('SELECT mode FROM ac_installation_activation WHERE id=1')).rows[0].mode, 'locked');
    assert.equal((await db.pool.query('SELECT enabled FROM ac_accounts WHERE id=$1', [account])).rows[0].enabled, true);
    for (const role of [...examRoles, ...blockedRoles]) assert.equal(await personalExam(supervisor, db, intentId, role), false);
    for (const role of [...examRoles, ...blockedRoles]) {
      await assert.rejects(launch(role), refusal('NATIVE_EXECUTION_POLICY_REQUIRED', 409));
    }
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_native_execution_jobs')).rows[0].n, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ac_execution_contracts WHERE intent_id=$1', [intentId])).rows[0].n, 0);
  } finally {
    await db.close();
    await database.close();
    if (area) await rm(area, {recursive: true, force: true});
  }
});
