import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { digest, Refusal } from '../src/contracts.ts';
import type { Ledger } from '../src/ledger.ts';
import { isolatedDatabase } from './fixtures/isolated-database.ts';

const skip = process.env.AC_TEST_DATABASE_URL ? false : 'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado';
const verifier = 'ab'.repeat(32);
const historical = { schemaVersion: 1 as const, requiredReviews: 1, allowLowRiskQaWaiver: true, requireJudge: false, requireHumanIntegration: false, verifierDigest: verifier };
const protectedPolicy = { ...historical, allowLowRiskQaWaiver: false, protectedGatePaths: ['package.json', '.github/workflows/', 'tests/quality-gate-paths.test.ts'] };

describe('quality gate integrity', { skip }, () => {
  let db: Ledger;
  let closeDatabase: (() => Promise<void>) | undefined;
  let QualityPolicies: typeof import('../src/quality-policy.ts').QualityPolicies;
  let waiveQaInTransaction: typeof import('../src/quality.ts').waiveQaInTransaction;
  let Capacity: typeof import('../src/capacity.ts').Capacity;
  let Templates: typeof import('../src/templates.ts').Templates;
  let NativeImplementation: typeof import('../src/native-implementation.ts').NativeImplementation;
  let Quality: typeof import('../src/quality.ts').Quality;
  const quality = () => new Quality(db, randomBytes(32), { identity: async () => { throw new Error('unused'); } });

  test.before(async () => {
    const base = process.env.AC_TEST_DATABASE_URL;
    if (!base) throw new Error('ISOLATED_DATABASE_REQUIRED');
    ({ QualityPolicies } = await import('../src/quality-policy.ts'));
    ({ Quality, waiveQaInTransaction } = await import('../src/quality.ts'));
    ({ Capacity } = await import('../src/capacity.ts'));
    ({ Templates } = await import('../src/templates.ts'));
    ({ NativeImplementation } = await import('../src/native-implementation.ts'));
    const { Ledger } = await import('../src/ledger.ts');
    const fixture = await isolatedDatabase(base, 'gateint');
    closeDatabase = fixture.close;
    db = new Ledger(fixture.url);
    await db.migrate();
  });
  test.after(async () => {
    await db?.close();
    await closeDatabase?.();
  });

  async function project(owner: string, policy: typeof historical) {
    const id = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [id, owner]);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner'),($1,$3,'operator')", [id, owner, owner + '-operator']);
    const revision = await new QualityPolicies(db).publish(owner, id, 0, policy);
    await db.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,1,$2,$3,$4)', [id, digest({ schemaVersion: 1 }), { schemaVersion: 1 }, owner]);
    const account = randomUUID();
    const profile = randomUUID();
    await db.pool.query(`INSERT INTO ac_accounts(id,owner_id,provider,label,resource_identity,mode,eligibility,eligibility_source,max_concurrent)
      VALUES($1,$2,'fixture','fixture',$3,'synthetic','documented_supported','synthetic://fixture',4)`, [account, owner, account]);
    await db.pool.query("INSERT INTO ac_profiles(id,account_id,model,effort,role) VALUES($1,$2,'fixture-model','medium','programmer')", [profile, account]);
    const context = await db.createContext(owner, id, randomUUID());
    const authority = await db.acquire(owner, context, randomUUID(), 'fixture-manager', 60);
    return { id, owner, operator: owner + '-operator', revision, account, profile, context, authority };
  }

  async function grant(env: Awaited<ReturnType<typeof project>>, intentId: string) {
    const id = randomUUID();
    await db.pool.query(`INSERT INTO ac_capacity_grants(id,attempt_id,intent_id,context_id,manager_epoch,account_id,profile_id,role,project_id,policy_revision,config_revision,request_digest,emergency,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,'programmer',$8,1,1,$9,false,'released')`,
      [id, randomUUID(), intentId, env.context, env.authority.epoch, env.account, env.profile, env.id, digest(id)]);
    return id;
  }

  async function artifact(env: Awaited<ReturnType<typeof project>>, input: { risk: 'low' | 'medium' | 'high'; commit: string; writePaths?: readonly string[]; evidence?: readonly { kind: 'qa' | 'review'; status: string }[] }) {
    const intentId = randomUUID();
    const operationId = randomUUID();
    const base = 'c'.repeat(40);
    const tree = 'd'.repeat(40);
    const command = { schemaVersion: 1, intentId };
    await db.pool.query(`INSERT INTO ac_intents(id,context_id,principal_id,digest,command,operation_id,run_id,manager_epoch,plan_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)`, [intentId, env.context, env.owner, digest(command), command, operationId, randomUUID(), env.authority.epoch]);
    await db.pool.query("INSERT INTO ac_operations(id,intent_id,state,manager_epoch) VALUES($1,$2,'completed',$3)", [operationId, intentId, env.authority.epoch]);
    const implementationGrantId = await grant(env, intentId);
    const artifactId = randomUUID();
    await db.pool.query('INSERT INTO ac_artifacts VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [artifactId, env.context, intentId, implementationGrantId, randomUUID(), env.id, env.revision, input.commit, tree, base, digest({ commit: input.commit, tree, base }), input.risk]);
    if (input.writePaths) {
      const snapshot = { schemaVersion: 1, intentId, contextId: env.context, base, writePaths: input.writePaths, qualityRevision: env.revision, targetRef: 'refs/heads/protected', messageRef: 'message:gate', messageDigest: verifier };
      await db.pool.query('INSERT INTO ac_native_task_inputs VALUES($1,$2,$3,$4)', [intentId, base, snapshot, digest(snapshot)]);
    }
    for (const item of input.evidence ?? []) {
      const evidenceGrant = await grant(env, intentId);
      const receipt = { kind: item.kind, status: item.status };
      await db.pool.query(`INSERT INTO ac_verification_evidence(id,artifact_id,kind,session_id,grant_id,policy_revision,status,receipt,receipt_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), artifactId, item.kind, randomUUID(), evidenceGrant, env.revision, item.status, receipt, digest(receipt)]);
    }
    return artifactId;
  }

  test('owner waiver on a low-risk artifact is explicit, idempotent and does not travel to another commit', async () => {
    const env = await project('waiver-owner', historical);
    const stored = (await db.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2', [env.id, env.revision])).rows[0];
    assert.equal(stored.digest, digest(historical));
    assert.equal(stored.snapshot.protectedGatePaths, undefined);
    const passed = [{ kind: 'review' as const, status: 'passed' }];
    const low = await artifact(env, { risk: 'low', commit: 'a'.repeat(40), evidence: passed });
    const waive = (principal: string, id: string, reason: string) => db.tx(c => waiveQaInTransaction(c, principal, env.context, id, reason));
    assert.deepEqual(await waive(env.owner, low, 'reason:explicit'), { artifactId: low, waived: true });
    assert.deepEqual(await waive(env.owner, low, 'reason:explicit'), { artifactId: low, waived: true });
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers WHERE artifact_id=$1', [low])).rows[0].n, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_audit WHERE kind='qa.waived' AND detail->>'artifactId'=$1", [low])).rows[0].n, 1);
    const ready = await db.tx(c => quality().assertReady(c, low, env.authority));
    assert.equal(ready.id, low);
    await assert.rejects(waive(env.owner, low, 'reason:other'), (error: unknown) => error instanceof Refusal && error.code === 'QA_WAIVER_CONFLICT');
    const untouched = await artifact(env, { risk: 'low', commit: 'b'.repeat(40), evidence: passed });
    await assert.rejects(waive(env.operator, untouched, 'reason:explicit'), (error: unknown) => error instanceof Refusal && error.code === 'PROJECT_OWNER_REQUIRED');
    for (const risk of ['medium', 'high'] as const) {
      const blocked = await artifact(env, { risk, commit: risk === 'medium' ? 'c'.repeat(40) : 'd'.repeat(40) });
      await assert.rejects(waive(env.owner, blocked, 'reason:explicit'), (error: unknown) => error instanceof Refusal && error.code === 'QA_WAIVER_FORBIDDEN');
      assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers WHERE artifact_id=$1', [blocked])).rows[0].n, 0);
    }
    for (const status of ['failed', 'canceled', 'missing_result', 'stale']) {
      const commit = digest(status).slice(0, 40);
      const blocked = await artifact(env, { risk: 'low', commit, evidence: [...passed, { kind: 'qa', status }] });
      assert.deepEqual(await waive(env.owner, blocked, 'reason:explicit'), { artifactId: blocked, waived: true });
      await assert.rejects(db.tx(c => quality().assertReady(c, blocked, env.authority)), (error: unknown) => error instanceof Refusal && error.code === 'VERIFICATION_NOT_PASSED');
    }
    const successorCommit = 'e'.repeat(40);
    const successor = await artifact(env, { risk: 'low', commit: successorCommit, evidence: passed });
    assert.notEqual(successorCommit, 'a'.repeat(40));
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_qa_waivers WHERE artifact_id=$1', [successor])).rows[0].n, 0);
    assert.equal((await db.pool.query("SELECT count(*)::int n FROM ac_verification_evidence WHERE artifact_id=$1 AND kind='qa'", [successor])).rows[0].n, 0);
    await assert.rejects(db.tx(c => quality().assertReady(c, successor, env.authority)), (error: unknown) => error instanceof Refusal && error.code === 'QA_MISSING');
  });

  test('protected gate paths are refused before native execution and again at assertReady', async () => {
    const owner = 'gate-owner';
    const env = await project(owner, protectedPolicy);
    const stored = (await db.pool.query('SELECT snapshot,digest FROM ac_quality_policies WHERE project_id=$1 AND revision=$2', [env.id, env.revision])).rows[0];
    const parsed = (await import('../src/quality-policy.ts')).QualityPolicy.parse(stored.snapshot);
    assert.deepEqual(parsed.protectedGatePaths, protectedPolicy.protectedGatePaths);
    assert.equal(stored.digest, digest(parsed));
    const passed = [{ kind: 'qa' as const, status: 'passed' }, { kind: 'review' as const, status: 'passed' }];
    const touched = await artifact(env, { risk: 'low', commit: '1'.repeat(40), writePaths: ['package.json'], evidence: passed });
    await assert.rejects(db.tx(c => quality().assertReady(c, touched, env.authority)), (error: unknown) => error instanceof Refusal && error.code === 'QUALITY_GATE_PATH_PROTECTED');
    const nested = await artifact(env, { risk: 'low', commit: '2'.repeat(40), writePaths: ['.github/workflows/ci.yml'], evidence: passed });
    await assert.rejects(db.tx(c => quality().assertReady(c, nested, env.authority)), (error: unknown) => error instanceof Refusal && error.code === 'QUALITY_GATE_PATH_PROTECTED');
    const clear = await artifact(env, { risk: 'low', commit: '3'.repeat(40), evidence: passed });
    assert.equal((await db.tx(c => quality().assertReady(c, clear, env.authority))).id, clear);
    const scoped = await artifact(env, { risk: 'low', commit: '4'.repeat(40), writePaths: ['src/app.ts'], evidence: passed });
    assert.equal((await db.tx(c => quality().assertReady(c, scoped, env.authority))).id, scoped);

    const repo = '/tmp/quality-gate-integrity-repo';
    await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [env.id, repo]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [owner]);
    const capacity = new Capacity(db);
    await capacity.configure(owner, { programmingLimit: 4, evaluationLimit: 2 });
    await capacity.registerModel(owner, { provider: 'fixture-native', model: 'fixture-model', efforts: ['medium'], roles: ['programmer'], source: 'synthetic://fixture' });
    const account = randomUUID();
    const profile = randomUUID();
    await capacity.addAccount(owner, env.id, { id: account, provider: 'fixture-native', label: 'fixture metadata only', resourceIdentity: account, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://fixture', maxConcurrent: 4 });
    await capacity.addProfile(owner, env.id, { id: profile, accountId: account, model: 'fixture-model', effort: 'medium', role: 'programmer' });
    await capacity.observeQuota(owner, account, { status: 'available', source: 'synthetic://fixture', ttlSeconds: 300 });
    const revision = await capacity.publish(owner, env.id, 1, { schemaVersion: 1, maxProgrammersPerContext: 4, maxEvaluatorsPerContext: 2, roles: { programmer: { regular: [profile], emergency: [] } } });
    let starts = 0;
    const supervisor = { ledger: db, supportsAccount: (id: string) => id === account, start: async () => { starts += 1; throw new Error('MUST_NOT_START'); } };
    const native = new NativeImplementation(db, repo, quality(), [supervisor as never]);
    const launch = async (writePaths: string[]) => {
      const context = await db.createContext(owner, env.id, randomUUID());
      await capacity.assignPolicy(owner, context, revision);
      await new Templates(db).publish(owner, context, 0, { workflow: 'engineering-native-v1', qualityRevision: env.revision, targetRef: 'refs/heads/protected', writePaths });
      const authority = await db.acquire(owner, context, randomUUID(), 'fixture-manager', 60);
      const text = 'authorized request ' + writePaths.join(',');
      native.bindSource(authority, async () => text);
      const intent = await db.accept(owner, { schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId: context, policyRevision: 1, action: 'plan.start', payload: { workflow: 'engineering-native-v1', messageRef: 'message:gate', localId: 'local-' + randomUUID(), messageDigest: digest(text), qualityRevision: env.revision, targetRef: 'refs/heads/protected', writePaths } }, authority, 'happier', async () => {});
      const before = starts;
      const session = native.start(intent, authority, { sessionId: randomUUID() } as never);
      let error: unknown;
      try { await session.result; } catch (caught) { error = caught; }
      return { error, intent, started: starts - before };
    };
    const blocked = await launch(['package.json']);
    assert.ok(blocked.error instanceof Refusal && blocked.error.code === 'QUALITY_GATE_PATH_PROTECTED');
    assert.equal(blocked.started, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_task_inputs WHERE intent_id=$1', [blocked.intent.id])).rows[0].n, 0);
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_native_execution_jobs WHERE intent_id=$1', [blocked.intent.id])).rows[0].n, 0);
    const directory = await launch(['.github/workflows/ci.yml']);
    assert.ok(directory.error instanceof Refusal && directory.error.code === 'QUALITY_GATE_PATH_PROTECTED');
    assert.equal(directory.started, 0);
    const allowed = await launch(['src/app.ts']);
    assert.ok(!(allowed.error instanceof Refusal) || allowed.error.code !== 'QUALITY_GATE_PATH_PROTECTED');
  });

  test('managed freeze refuses a protected write path before the native input is accepted', async () => {
    const owner = 'managed-gate-owner';
    const env = await project(owner, protectedPolicy);
    const area = await mkdtemp(join(tmpdir(), 'quality-gate-managed-'));
    const repo = join(area, 'repo');
    let runtime: { close(): Promise<void> } | undefined;
    const effects = async (parentId: string) => (await db.pool.query(`SELECT
      (SELECT count(*) FROM ac_native_task_inputs n JOIN ac_intents i ON i.id=n.intent_id WHERE i.parent_intent_id=$1)::int AS inputs,
      (SELECT count(*) FROM ac_managed_delivery_inputs d JOIN ac_intents i ON i.id=d.intent_id WHERE i.parent_intent_id=$1)::int AS deliveries,
      (SELECT count(*) FROM ac_native_execution_jobs j JOIN ac_intents i ON i.id=j.intent_id WHERE i.parent_intent_id=$1)::int AS jobs,
      (SELECT count(*) FROM ac_execution_launches l JOIN ac_intents i ON i.operation_id=l.operation_id WHERE i.parent_intent_id=$1)::int AS launches`, [parentId])).rows[0] as { inputs: number; deliveries: number; jobs: number; launches: number };
    try {
      execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
      const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@invalid');
      await mkdir(join(repo, 'src'));
      await writeFile(join(repo, 'src/.gitkeep'), '');
      git('add', '.');
      git('commit', '-qm', 'base');
      git('update-ref', 'refs/heads/protected', git('rev-parse', 'HEAD'));
      await mkdir(join(repo, '.ai/cezar'), { recursive: true });
      await writeFile(join(repo, '.ai/cezar/config.json'), JSON.stringify({ baseBranch: 'main', skillsRepos: [], worktreeRetention: 0 }));
      await db.pool.query('INSERT INTO ac_project_repositories(project_id,repo) VALUES($1,$2)', [env.id, repo]);
      const [{ CezarRuntime }, { ManagerPlans }, { readManagedRecipe }, { GitArtifacts }, { Quality }] = await Promise.all([
        import('../src/cezar.ts'),
        import('../src/planning.ts'),
        import('../src/managed-plan.ts'),
        import('../src/git.ts'),
        import('../src/quality.ts'),
      ]);
      const gitArtifacts = new GitArtifacts(repo);
      const quality = new Quality(db, randomBytes(32), gitArtifacts);
      runtime = new CezarRuntime(db, repo, env.id, { quality, git: gitArtifacts, verifierKey: randomBytes(32), allowedTargets: ['refs/heads/protected'], targetRef: 'refs/heads/protected' });
      const freezer = runtime as unknown as {
        freezeManagedBatch(parent: { id: string }, authority: typeof env.authority, recipe: unknown, nodeId: string): Promise<void>;
        freezeCorrectionBatch(parent: { id: string }, authority: typeof env.authority, recipe: unknown, nodeId: string): Promise<void>;
      };
      const acceptPlan = async (writePaths: string[]) => {
        const context = await db.createContext(owner, env.id, randomUUID());
        const authority = await db.acquire(owner, context, randomUUID(), 'fixture-manager', 60);
        await new Templates(db).publish(owner, context, 0, { workflow: 'engineering-native-v1', qualityRevision: env.revision, targetRef: 'refs/heads/protected', writePaths: ['package.json', '.github', 'src', 'tests'], execution: 'plan' });
        const proposal = await new ManagerPlans(db).publish(owner, authority, 0, {
          schemaVersion: 1, contextId: context, objectiveRef: 'message:objective', sourceMessageRef: 'message:request', parallelism: 1, constraintRefs: [],
          tasks: [{ id: 'gate', objectiveRef: 'message:gate', acceptanceRefs: ['acceptance:real-tests'], inputRefs: [], outputRefs: ['output:gate'], dependsOn: [], writePaths, qualityRevision: env.revision, targetRef: 'refs/heads/protected', maxCorrections: 0 }],
        });
        const parent = await db.accept(owner, { schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId: context, policyRevision: 1, action: 'plan.start', payload: { workflow: 'managed-synthetic-v1', messageRef: 'encrypted:gate', proposalRevision: proposal.revision, proposalDigest: proposal.digest, native: true } }, authority, 'api');
        const recipe = await readManagedRecipe(db, parent.id);
        const nodeId = Object.entries(recipe.launches).find(([, ids]) => ids.some(id => recipe.units.find(unit => unit.id === id)?.kind === 'task'))?.[0];
        assert.ok(nodeId);
        return { parent, authority, recipe, nodeId };
      };
      const blocked = await acceptPlan(['package.json']);
      await assert.rejects(freezer.freezeManagedBatch(blocked.parent, blocked.authority, blocked.recipe, blocked.nodeId), (error: unknown) => error instanceof Refusal && error.code === 'QUALITY_GATE_PATH_PROTECTED');
      assert.deepEqual(await effects(blocked.parent.id), { inputs: 0, deliveries: 0, jobs: 0, launches: 0 });
      const correctionRecipe = { ...blocked.recipe, schemaVersion: 2 as const };
      await assert.rejects(freezer.freezeCorrectionBatch(blocked.parent, blocked.authority, correctionRecipe, blocked.nodeId), (error: unknown) => error instanceof Refusal && error.code === 'QUALITY_GATE_PATH_PROTECTED');
      assert.deepEqual(await effects(blocked.parent.id), { inputs: 0, deliveries: 0, jobs: 0, launches: 0 });
      const nested = await acceptPlan(['.github/workflows/ci.yml']);
      await assert.rejects(freezer.freezeManagedBatch(nested.parent, nested.authority, nested.recipe, nested.nodeId), (error: unknown) => error instanceof Refusal && error.code === 'QUALITY_GATE_PATH_PROTECTED');
      assert.deepEqual(await effects(nested.parent.id), { inputs: 0, deliveries: 0, jobs: 0, launches: 0 });
      const clear = await acceptPlan(['src/app.ts']);
      await freezer.freezeManagedBatch(clear.parent, clear.authority, clear.recipe, clear.nodeId);
      const saved = await effects(clear.parent.id);
      assert.equal(saved.inputs, 1);
      assert.equal(saved.deliveries, 1);
      assert.equal(saved.jobs, 0);
      assert.equal(saved.launches, 0);
    } finally {
      await runtime?.close();
      await rm(area, { recursive: true, force: true });
    }
  });
});
