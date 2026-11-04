import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { digest, Refusal, type Command } from '../src/contracts.ts';
import type { Capacity, CapacityPolicy } from '../src/capacity.ts';
import type { Ledger } from '../src/ledger.ts';
import { isolatedDatabase } from './fixtures/isolated-database.ts';

const skip = process.env.AC_TEST_DATABASE_URL ? false : 'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado';

describe('capacity wait resources', { skip }, () => {
  let db: Ledger;
  let closeDatabase: (() => Promise<void>) | undefined;
  let capacity: Capacity;
  let control: InstanceType<typeof import('../src/control.ts').Control>;
  let Control: typeof import('../src/control.ts').Control;
  const principal = 'wait-view-' + randomUUID();

  test.before(async () => {
    const base = process.env.AC_TEST_DATABASE_URL;
    if (!base) throw new Error('ISOLATED_DATABASE_REQUIRED');
    const { Ledger } = await import('../src/ledger.ts');
    const { Capacity } = await import('../src/capacity.ts');
    ({ Control } = await import('../src/control.ts'));
    const fixture = await isolatedDatabase(base, 'waitview');
    closeDatabase = fixture.close;
    db = new Ledger(fixture.url);
    await db.migrate();
    capacity = new Capacity(db);
    control = new Control(db);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await capacity.configure(principal, { programmingLimit: 8, evaluationLimit: 8 });
    await capacity.registerModel(principal, { provider: 'synthetic-waitview', model: 'worker', efforts: ['low', 'medium', 'high'], roles: ['programmer'], source: 'synthetic://waitview' });
  });
  test.after(async () => {
    await db?.close();
    await closeDatabase?.();
  });

  async function projectOf(owner = principal, label = 'waitview') {
    const id = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [id, label]);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [id, owner]);
    return id;
  }
  async function opened(project: string) {
    const context = await db.createContext(principal, project, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'waitview-manager', 60);
    const command: Command = { schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId: context, policyRevision: 1, action: 'plan.start', payload: { workflow: 'baseline-synthetic-v1', messageRef: 'encrypted:waitview' } };
    const intent = await db.accept(principal, command, authority, 'api');
    return { context, authority, intentId: intent.id };
  }
  async function account(project: string, label: string, mode: 'synthetic' | 'subscription_cli' = 'synthetic', maxConcurrent = 2) {
    const accountId = randomUUID();
    const profileId = randomUUID();
    await capacity.addAccount(principal, project, { id: accountId, provider: 'synthetic-waitview', label, resourceIdentity: accountId, mode, eligibility: 'documented_supported', eligibilitySource: 'synthetic://waitview', maxConcurrent });
    await capacity.addProfile(principal, project, { id: profileId, accountId, model: 'worker', effort: 'medium', role: 'programmer' });
    return { accountId, profileId };
  }
  function policy(regular: string[], emergency: string[] = []): CapacityPolicy {
    return { schemaVersion: 1, maxProgrammersPerContext: 4, maxEvaluatorsPerContext: 2, roles: { programmer: { regular, emergency } } };
  }
  async function counts() {
    const row = (await db.pool.query(`SELECT
      (SELECT count(*)::int FROM ac_capacity_waits) waits,
      (SELECT count(*)::int FROM ac_capacity_grants) grants,
      (SELECT count(*)::int FROM ac_quota_observations) quotas,
      (SELECT count(*)::int FROM ac_audit) audits`)).rows[0];
    return { waits: row.waits, grants: row.grants, quotas: row.quotas, audits: row.audits };
  }

  test('Control.view publishes ordered exclusions inside the authorized project read', async () => {
    const project = await projectOf();
    const foreignProject = await projectOf(principal, 'foreign-waitview');
    const foreign = await account(foreignProject, 'Rótulo alheio');
    const missing = await account(project, 'removido');
    const removed = await account(project, 'sem acesso');
    const disabled = await account(project, 'conta off');
    const profileOff = await account(project, 'perfil off');
    const dormant = await account(project, 'dormant', 'subscription_cli');
    const ineligible = await account(project, 'inelegível');
    const exhausted = await account(project, 'esgotada');
    const expired = await account(project, 'expirada');
    const chain = [missing.profileId, removed.profileId, disabled.profileId, profileOff.profileId];
    const emergency = [dormant.profileId, ineligible.profileId, exhausted.profileId, expired.profileId];
    await capacity.publish(principal, project, 0, policy(chain, emergency));
    const session = await opened(project);
    await capacity.assignPolicy(principal, session.context, 1);
    await db.pool.query('DELETE FROM ac_profiles WHERE id=$1', [missing.profileId]);
    await db.pool.query('DELETE FROM ac_account_access WHERE account_id=$1 AND project_id=$2', [removed.accountId, project]);
    await capacity.setEnabled(principal, project, 'account', { id: disabled.accountId, enabled: false, expectedRevision: 1 });
    await capacity.setEnabled(principal, project, 'profile', { id: profileOff.profileId, enabled: false, expectedRevision: 1 });
    await db.pool.query("UPDATE ac_accounts SET eligibility='requires_clarification' WHERE id=$1", [ineligible.accountId]);
    await capacity.observeQuota(principal, exhausted.accountId, { status: 'exhausted', source: 'synthetic://waitview', ttlSeconds: 3600 });
    await capacity.observeQuota(principal, expired.accountId, { status: 'exhausted', source: 'synthetic://waitview-expired', ttlSeconds: 3600 });
    await db.pool.query("UPDATE ac_quota_observations SET observed_at=clock_timestamp()-interval '2 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE account_id=$1", [expired.accountId]);
    const attemptId = randomUUID();
    await assert.rejects(capacity.reserve(principal, { attemptId, intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority), (error: unknown) => error instanceof Refusal && error.code === 'NO_ELIGIBLE_CAPACITY');
    const alienAttempt = randomUUID();
    await db.pool.query(`INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,reason,priority,exclusions)
      VALUES($1,$2,$3,'programmer','opaque',$4,'NO_ELIGIBLE_CAPACITY',9,$5::jsonb)`,
      [alienAttempt, session.context, session.intentId, session.authority.epoch, JSON.stringify([{ profileId: foreign.profileId, reason: 'access_removed' }])]);
    const before = await counts();
    const view = await control.view(principal, session.context);
    assert.deepEqual(await counts(), before);
    const refusal = view.waits.find(row => row.attempt_id === attemptId);
    assert.ok(refusal);
    assert.equal(refusal.resource_kind, 'model');
    assert.equal(refusal.role, 'programmer');
    assert.equal(refusal.reason, 'NO_ELIGIBLE_CAPACITY');
    assert.equal(refusal.desired_profile, null);
    assert.deepEqual(refusal.exclusions, [
      { profileId: missing.profileId, reason: 'profile_missing' },
      { profileId: removed.profileId, reason: 'access_removed' },
      { profileId: disabled.profileId, reason: 'account_disabled' },
      { profileId: profileOff.profileId, reason: 'profile_disabled' },
      { profileId: dormant.profileId, reason: 'not_synthetic' },
      { profileId: ineligible.profileId, reason: 'ineligible' },
      { profileId: exhausted.profileId, reason: 'quota_exhausted' },
      { profileId: expired.profileId, reason: 'quota_unknown' },
    ]);
    assert.equal(view.waits[0]?.attempt_id, alienAttempt);
    assert.equal(view.waits[1]?.attempt_id, attemptId);
    assert.deepEqual(view.profiles.map(row => row.id).filter(id => id === foreign.profileId || id === missing.profileId), []);
    assert.equal(view.profiles.some(row => row.id === profileOff.profileId), true);
    assert.equal(JSON.stringify(view.accounts).includes('Rótulo alheio'), false);
    assert.equal(JSON.stringify(view.profiles).includes('Rótulo alheio'), false);
    assert.deepEqual(view.waits.find(row => row.attempt_id === alienAttempt)?.exclusions, [{ profileId: foreign.profileId, reason: 'access_removed' }]);
    const stranger = 'stranger-' + randomUUID();
    await assert.rejects(control.view(stranger, session.context), (error: unknown) => error instanceof Refusal && error.code === 'CONTEXT_FORBIDDEN');
    const otherOwner = 'other-owner-' + randomUUID();
    const otherProject = await projectOf(otherOwner, 'other-waitview');
    const otherContext = await db.createContext(otherOwner, otherProject, randomUUID());
    await assert.rejects(control.view(principal, otherContext), (error: unknown) => error instanceof Refusal && error.code === 'CONTEXT_FORBIDDEN');
    const scopedAway = new Control(db, [], otherProject);
    await assert.rejects(scopedAway.view(principal, session.context), (error: unknown) => error instanceof Refusal && error.code === 'PROJECT_RUNTIME_MISMATCH');
    const scopedHome = new Control(db, [], project);
    const home = await scopedHome.view(principal, session.context);
    assert.equal(home.projectId, project);
    assert.deepEqual(home.waits.find(row => row.attempt_id === attemptId)?.exclusions, refusal.exclusions);
    assert.deepEqual(await counts(), before);
  });

  test('legacy, invalid, busy, queued and local waits keep their stored reason', async () => {
    const project = await projectOf();
    const seat = await account(project, 'vaga', 'synthetic', 1);
    await capacity.observeQuota(principal, seat.accountId, { status: 'available', source: 'synthetic://busy', ttlSeconds: 3600 });
    await capacity.publish(principal, project, 0, policy([seat.profileId]));
    const session = await opened(project);
    await capacity.assignPolicy(principal, session.context, 1);
    const held = await capacity.reserve(principal, { attemptId: randomUUID(), intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority);
    const busyId = randomUUID();
    await assert.rejects(capacity.reserve(principal, { attemptId: busyId, intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority), (error: unknown) => error instanceof Refusal && error.code === 'CAPACITY_BUSY');
    const legacyId = randomUUID();
    await db.pool.query(`INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,reason,priority)
      VALUES($1,$2,$3,'programmer','opaque',$4,'NO_ELIGIBLE_CAPACITY',4)`, [legacyId, session.context, session.intentId, session.authority.epoch]);
    const queuedId = randomUUID();
    await db.pool.query(`INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,reason,priority)
      VALUES($1,$2,$3,'reviewer','opaque',$4,'CAPACITY_QUEUED',3)`, [queuedId, session.context, session.intentId, session.authority.epoch]);
    const invalidId = randomUUID();
    await db.pool.query(`INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,reason,priority,exclusions)
      VALUES($1,$2,$3,'programmer','opaque',$4,'NO_ELIGIBLE_CAPACITY',2,$5::jsonb)`,
      [invalidId, session.context, session.intentId, session.authority.epoch, JSON.stringify([{ profileId: seat.profileId, reason: 'ineligible', note: 'motivo-falso' }])]);
    const before = await counts();
    const view = await control.view(principal, session.context);
    assert.deepEqual(await counts(), before);
    const busy = view.waits.find(row => row.attempt_id === busyId);
    const legacy = view.waits.find(row => row.attempt_id === legacyId);
    const queued = view.waits.find(row => row.attempt_id === queuedId);
    const invalid = view.waits.find(row => row.attempt_id === invalidId);
    assert.ok(busy && legacy && queued && invalid);
    assert.equal(busy.reason, 'CAPACITY_BUSY');
    assert.equal(busy.resource_kind, 'model');
    assert.equal(Object.hasOwn(busy, 'exclusions'), false);
    assert.equal(legacy.reason, 'NO_ELIGIBLE_CAPACITY');
    assert.equal(Object.hasOwn(legacy, 'exclusions'), false);
    assert.equal(queued.reason, 'CAPACITY_QUEUED');
    assert.equal(queued.role, 'reviewer');
    assert.equal(Object.hasOwn(queued, 'exclusions'), false);
    assert.equal(invalid.reason, 'NO_ELIGIBLE_CAPACITY');
    assert.equal(Object.hasOwn(invalid, 'exclusions'), false);
    assert.equal(JSON.stringify(view).includes('motivo-falso'), false);
    assert.equal(held.state, 'reserved');
    assert.equal((await db.pool.query('SELECT state FROM ac_capacity_grants WHERE id=$1', [held.id])).rows[0].state, 'reserved');

    const quality = { schemaVersion: 1 as const, requiredReviews: 1, allowLowRiskQaWaiver: false, requireJudge: false, requireHumanIntegration: false, verifierDigest: 'a'.repeat(64) };
    await db.pool.query('INSERT INTO ac_quality_policies VALUES($1,1,$2,$3)', [project, quality, digest(quality)]);
    await capacity.configure(principal, { programmingLimit: 1, evaluationLimit: 1, expectedRevision: 1 });
    const { ManagerPlans } = await import('../src/planning.ts');
    const task = (id: string) => ({ id, objectiveRef: `message:${id}`, acceptanceRefs: ['acceptance:synthetic-effect-v1'], inputRefs: [], outputRefs: [`output:${id}`], dependsOn: [], writePaths: [`src/${id}.txt`], qualityRevision: 1, targetRef: 'refs/heads/main', maxCorrections: 0 });
    const plan: import('../src/planning.ts').ManagerPlan = { schemaVersion: 1, contextId: session.context, objectiveRef: 'message:goal', sourceMessageRef: 'message:request', constraintRefs: [], tasks: [task('one'), task('two')] };
    const proposal = await new ManagerPlans(db).publish(principal, session.authority, 0, plan);
    const parent = await db.accept(principal, { schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId: session.context, policyRevision: 1, action: 'plan.start', payload: { workflow: 'managed-synthetic-v1', messageRef: 'message:request', proposalRevision: proposal.revision, proposalDigest: proposal.digest } }, session.authority, 'api');
    const rows = (await db.pool.query(`SELECT i.id,i.parent_unit_id,o.execution_attempt_id FROM ac_intents i JOIN ac_operations o ON o.intent_id=i.id WHERE i.parent_intent_id=$1`, [parent.id])).rows;
    const local = rows.find(row => row.parent_unit_id === 'compose-0');
    assert.ok(local);
    const localRequest = { attemptId: local.execution_attempt_id, intentId: local.id, contextId: session.context };
    await assert.rejects(capacity.reserveLocalCompositor(principal, localRequest, session.authority), (error: unknown) => error instanceof Refusal && error.code === 'CAPACITY_BUSY');
    const afterLocal = await control.view(principal, session.context);
    const localWait = afterLocal.waits.find(row => row.attempt_id === local.execution_attempt_id);
    assert.ok(localWait);
    assert.equal(localWait.resource_kind, 'local_compositor');
    assert.equal(localWait.role, 'programmer');
    assert.equal(localWait.desired_profile, null);
    assert.equal(localWait.reason, 'CAPACITY_BUSY');
    assert.equal(Object.hasOwn(localWait, 'exclusions'), false);
    assert.notEqual(localWait.reason, queued.reason);
  });
});
