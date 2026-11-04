import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { digest, Refusal, type Command } from '../src/contracts.ts';
import type { Capacity, CapacityPolicy } from '../src/capacity.ts';
import type { Ledger } from '../src/ledger.ts';
import { isolatedDatabase } from './fixtures/isolated-database.ts';

const skip = process.env.AC_TEST_DATABASE_URL ? false : 'AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado';

describe('capacity prelaunch refusals', { skip }, () => {
  let db: Ledger;
  let closeDatabase: (() => Promise<void>) | undefined;
  let capacity: Capacity;
  let readCapacityWaits: typeof import('../src/observability.ts').readCapacityWaits;
  const principal = 'prelaunch-' + randomUUID();

  test.before(async () => {
    const base = process.env.AC_TEST_DATABASE_URL;
    if (!base) throw new Error('ISOLATED_DATABASE_REQUIRED');
    const { Ledger } = await import('../src/ledger.ts');
    const { Capacity } = await import('../src/capacity.ts');
    ({ readCapacityWaits } = await import('../src/observability.ts'));
    const fixture = await isolatedDatabase(base, 'prelaunch');
    closeDatabase = fixture.close;
    db = new Ledger(fixture.url);
    await db.migrate();
    capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await capacity.configure(principal, { programmingLimit: 8, evaluationLimit: 8 });
    await capacity.registerModel(principal, { provider: 'synthetic-prelaunch', model: 'worker', efforts: ['low', 'medium', 'high'], roles: ['programmer'], source: 'synthetic://prelaunch' });
    await capacity.registerModel(principal, { provider: 'synthetic-prelaunch', model: 'narrow', efforts: ['medium'], roles: ['programmer'], source: 'synthetic://prelaunch-narrow' });
  });
  test.after(async () => {
    await db?.close();
    await closeDatabase?.();
  });

  async function projectOf(owner = principal) {
    const id = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [id, 'prelaunch']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [id, owner]);
    return id;
  }
  async function opened(project: string) {
    const context = await db.createContext(principal, project, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'prelaunch-manager', 60);
    const command: Command = { schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(), contextId: context, policyRevision: 1, action: 'plan.start', payload: { workflow: 'baseline-synthetic-v1', messageRef: 'encrypted:prelaunch' } };
    const intent = await db.accept(principal, command, authority, 'api');
    return { context, authority, intentId: intent.id };
  }
  async function account(project: string, mode: 'synthetic' | 'subscription_cli' | 'api' = 'synthetic', maxConcurrent = 2) {
    const accountId = randomUUID();
    const profileId = randomUUID();
    await capacity.addAccount(principal, project, { id: accountId, provider: 'synthetic-prelaunch', label: 'prelaunch', resourceIdentity: accountId, mode, eligibility: 'documented_supported', eligibilitySource: 'synthetic://prelaunch', maxConcurrent });
    await capacity.addProfile(principal, project, { id: profileId, accountId, model: 'worker', effort: 'medium', role: 'programmer' });
    return { accountId, profileId };
  }
  function policy(regular: string[], emergency: string[] = [], maxProgrammersPerContext = 4): CapacityPolicy {
    return { schemaVersion: 1, maxProgrammersPerContext, maxEvaluatorsPerContext: 2, roles: { programmer: { regular, emergency } } };
  }
  async function quotaSnapshot() {
    const rows = (await db.pool.query('SELECT account_id,status,source,observed_at,expires_at FROM ac_quota_observations ORDER BY account_id')).rows;
    return rows.map(row => ({ account_id: row.account_id, status: row.status, source: row.source, observed_at: new Date(row.observed_at).toISOString(), expires_at: new Date(row.expires_at).toISOString() }));
  }
  async function grants(intentId: string) {
    return Number((await db.pool.query('SELECT count(*)::int n FROM ac_capacity_grants WHERE intent_id=$1', [intentId])).rows[0].n);
  }

  test('publish of a profile that is not shared is POLICY_PROFILE_FORBIDDEN', async () => {
    const home = await projectOf();
    const other = await projectOf();
    const owned = await account(home);
    await assert.rejects(capacity.publish(principal, other, 0, policy([owned.profileId])), (error: unknown) => error instanceof Refusal && error.code === 'POLICY_PROFILE_FORBIDDEN');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_policy_revisions WHERE project_id=$1', [other])).rows[0].n, 0);
  });

  test('addProfile rejects an effort outside the catalog', async () => {
    const project = await projectOf();
    const accountId = randomUUID();
    await capacity.addAccount(principal, project, { id: accountId, provider: 'synthetic-prelaunch', label: 'narrow', resourceIdentity: accountId, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://prelaunch', maxConcurrent: 1 });
    await assert.rejects(capacity.addProfile(principal, project, { id: randomUUID(), accountId, model: 'narrow', effort: 'high', role: 'programmer' }), (error: unknown) => error instanceof Refusal && error.code === 'MODEL_EFFORT_NOT_IN_CATALOG');
    assert.equal((await db.pool.query('SELECT count(*)::int n FROM ac_profiles WHERE account_id=$1', [accountId])).rows[0].n, 0);
  });

  test('setEnabled of another owner profile is ACCOUNT_PROFILE_FORBIDDEN', async () => {
    const owner = 'other-owner-' + randomUUID();
    const project = await projectOf();
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, owner]);
    const accountId = randomUUID();
    const profileId = randomUUID();
    await capacity.addAccount(owner, project, { id: accountId, provider: 'synthetic-prelaunch', label: 'foreign', resourceIdentity: accountId, mode: 'synthetic', eligibility: 'documented_supported', eligibilitySource: 'synthetic://prelaunch', maxConcurrent: 1 });
    await capacity.addProfile(owner, project, { id: profileId, accountId, model: 'worker', effort: 'medium', role: 'programmer' });
    await assert.rejects(capacity.setEnabled(principal, project, 'profile', { id: profileId, enabled: false, expectedRevision: 1 }), (error: unknown) => error instanceof Refusal && error.code === 'ACCOUNT_PROFILE_FORBIDDEN');
    assert.equal((await db.pool.query('SELECT enabled,revision FROM ac_profiles WHERE id=$1', [profileId])).rows[0].enabled, true);
  });

  test('a chain with no eligible profile records one ordered reason and does not touch quota or grants', async () => {
    const project = await projectOf();
    const missing = await account(project);
    const removed = await account(project);
    const disabled = await account(project);
    const profileOff = await account(project);
    const dormant = await account(project, 'subscription_cli');
    const ineligible = await account(project);
    const exhausted = await account(project);
    const expired = await account(project);
    const outsider = await account(project);
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
    await capacity.observeQuota(principal, exhausted.accountId, { status: 'exhausted', source: 'synthetic://prelaunch', ttlSeconds: 3600 });
    await capacity.observeQuota(principal, expired.accountId, { status: 'exhausted', source: 'synthetic://prelaunch-expired', ttlSeconds: 3600 });
    await db.pool.query("UPDATE ac_quota_observations SET observed_at=clock_timestamp()-interval '2 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE account_id=$1", [expired.accountId]);
    await capacity.observeQuota(principal, outsider.accountId, { status: 'available', source: 'synthetic://outsider', ttlSeconds: 3600 });
    const before = await quotaSnapshot();
    const attemptId = randomUUID();
    await assert.rejects(capacity.reserve(principal, { attemptId, intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority), (error: unknown) => error instanceof Refusal && error.code === 'NO_ELIGIBLE_CAPACITY');
    assert.equal(await grants(session.intentId), 0);
    assert.deepEqual(await quotaSnapshot(), before);
    const waits = await readCapacityWaits(db, principal, session.context);
    assert.equal(waits.length, 1);
    const wait = waits[0]!;
    assert.equal(wait.attempt_id, attemptId);
    assert.equal(wait.resource_kind, 'model');
    assert.equal(wait.role, 'programmer');
    assert.equal(wait.reason, 'NO_ELIGIBLE_CAPACITY');
    assert.equal(wait.desired_profile, null);
    assert.equal(typeof wait.priority, 'number');
    assert.equal(typeof wait.sequence, 'string');
    assert.deepEqual(wait.exclusions, [
      { profileId: missing.profileId, reason: 'profile_missing' },
      { profileId: removed.profileId, reason: 'access_removed' },
      { profileId: disabled.profileId, reason: 'account_disabled' },
      { profileId: profileOff.profileId, reason: 'profile_disabled' },
      { profileId: dormant.profileId, reason: 'not_synthetic' },
      { profileId: ineligible.profileId, reason: 'ineligible' },
      { profileId: exhausted.profileId, reason: 'quota_exhausted' },
      { profileId: expired.profileId, reason: 'quota_unknown' },
    ]);
    assert.equal((await db.pool.query('SELECT account_id FROM ac_capacity_grants WHERE account_id=$1', [outsider.accountId])).rowCount, 0);
  });

  test('saturation stays CAPACITY_BUSY and does not record exclusions', async () => {
    const project = await projectOf();
    const only = await account(project, 'synthetic', 1);
    await capacity.observeQuota(principal, only.accountId, { status: 'available', source: 'synthetic://busy', ttlSeconds: 3600 });
    await capacity.publish(principal, project, 0, policy([only.profileId]));
    const session = await opened(project);
    await capacity.assignPolicy(principal, session.context, 1);
    const held = await capacity.reserve(principal, { attemptId: randomUUID(), intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority);
    const attemptId = randomUUID();
    await assert.rejects(capacity.reserve(principal, { attemptId, intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority), (error: unknown) => error instanceof Refusal && error.code === 'CAPACITY_BUSY');
    const wait = (await readCapacityWaits(db, principal, session.context)).find(row => row.attempt_id === attemptId);
    assert.ok(wait);
    assert.equal(wait.reason, 'CAPACITY_BUSY');
    assert.equal(Object.hasOwn(wait, 'exclusions'), false);
    assert.equal(held.state, 'reserved');
  });

  test('historical waits without exclusions remain readable', async () => {
    const project = await projectOf();
    const session = await opened(project);
    const attemptId = randomUUID();
    await db.pool.query(`INSERT INTO ac_capacity_waits(attempt_id,context_id,intent_id,role,request_digest,manager_epoch,reason)
      VALUES($1,$2,$3,'programmer','opaque',$4,'NO_ELIGIBLE_CAPACITY')`, [attemptId, session.context, session.intentId, session.authority.epoch]);
    const wait = (await readCapacityWaits(db, principal, session.context))[0]!;
    assert.equal(wait.attempt_id, attemptId);
    assert.equal(wait.reason, 'NO_ELIGIBLE_CAPACITY');
    assert.equal(wait.resource_kind, 'model');
    assert.equal(Object.hasOwn(wait, 'exclusions'), false);
    assert.equal((await db.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='ac_capacity_waits' AND column_name='exclusions'")).rows[0].is_nullable, 'YES');
  });

  test('a grant keeps its policy revision after a later publication, and the next reserve uses the reassigned revision', async () => {
    const project = await projectOf();
    const seat = await account(project);
    await capacity.observeQuota(principal, seat.accountId, { status: 'available', source: 'synthetic://revision', ttlSeconds: 3600 });
    const first = policy([seat.profileId], [], 4);
    const revision = await capacity.publish(principal, project, 0, first);
    assert.equal(revision, 1);
    const session = await opened(project);
    await capacity.assignPolicy(principal, session.context, revision);
    const grant = await capacity.reserve(principal, { attemptId: randomUUID(), intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority);
    const stored = async (id: string) => (await db.pool.query('SELECT policy_revision FROM ac_capacity_grants WHERE id=$1', [id])).rows[0].policy_revision as number;
    assert.equal(await stored(grant.id), 1);
    const second = policy([seat.profileId], [], 3);
    const next = await capacity.publish(principal, project, 1, second);
    assert.equal(next, 2);
    assert.equal(await stored(grant.id), 1);
    await capacity.assignPolicy(principal, session.context, next);
    assert.equal(await stored(grant.id), 1);
    const again = await capacity.reserve(principal, { attemptId: randomUUID(), intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority);
    assert.equal(await stored(grant.id), 1);
    assert.equal(await stored(again.id), 2);
    const published = (await db.pool.query('SELECT digest,snapshot FROM ac_policy_revisions WHERE project_id=$1 AND revision=2', [project])).rows[0];
    assert.equal(published.digest, digest(second));
    assert.notEqual(published.digest, digest(first));
  });

  test('a stored snapshot whose digest does not match is POLICY_DIGEST_MISMATCH and creates no grant', async () => {
    const project = await projectOf();
    const seat = await account(project);
    await capacity.observeQuota(principal, seat.accountId, { status: 'available', source: 'synthetic://digest', ttlSeconds: 3600 });
    await capacity.publish(principal, project, 0, policy([seat.profileId]));
    const session = await opened(project);
    const snapshot = policy([seat.profileId], [], 2);
    await db.pool.query('INSERT INTO ac_policy_revisions(project_id,revision,digest,snapshot,published_by) VALUES($1,2,$2,$3,$4)', [project, 'ab'.repeat(32), snapshot, principal]);
    await capacity.assignPolicy(principal, session.context, 2);
    const attemptId = randomUUID();
    await assert.rejects(capacity.reserve(principal, { attemptId, intentId: session.intentId, contextId: session.context, role: 'programmer' }, session.authority), (error: unknown) => error instanceof Refusal && error.code === 'POLICY_DIGEST_MISMATCH');
    assert.equal(await grants(session.intentId), 0);
    assert.equal((await db.pool.query('SELECT 1 FROM ac_capacity_waits WHERE attempt_id=$1', [attemptId])).rowCount, 0);
  });
});
