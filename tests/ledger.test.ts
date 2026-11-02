import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../src/ledger.ts';
import { Command, Refusal } from '../src/contracts.ts';
const database = process.env.AC_TEST_DATABASE_URL;
if (!database || !database.includes('/ac_implementation_test')) throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
const db = new Ledger(database), second = new Ledger(database);
const project = randomUUID(); let one: string, two: string;
before(async () => {
  await db.migrate(); await db.migrate();
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Synthetic project']);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,'owner','owner'),($1,'reader','viewer')", [project]);
  one = await db.createContext('owner', project, 'session-' + randomUUID());
  two = await db.createContext('owner', project, 'session-' + randomUUID());
});
after(async () => { await db.close(); await second.close(); });
const refused = (code: string) => (e: unknown) => e instanceof Refusal && e.code === code;
test('RF-03/04: same project has independent context and session identities', async () => {
  assert.notEqual(one, two);
  const result = await db.pool.query('SELECT * FROM ac_contexts WHERE project_id=$1', [project]);
  assert.equal(result.rowCount, 2);
  await assert.rejects(db.createContext('outsider', project, randomUUID()), refused('PROJECT_FORBIDDEN'));
});
test('RF-04/T19: concurrent managers and same-profile takeover increment epoch; old effects fail', async () => {
  const results = await Promise.allSettled([db.acquire('owner', one, randomUUID(), 'same-profile'), second.acquire('owner', one, randomUUID(), 'same-profile')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const old = results.find(r => r.status === 'fulfilled'); assert(old?.status === 'fulfilled');
  await db.pause('owner', one, true);
  await db.checkpoint(old.value, { schemaVersion: 1, planRevision: 0, objectiveRef: 'encrypted:objective',
    constraintRefs: ['encrypted:constraints'], decisionRefs: ['encrypted:decisions'], artifactRefs: [], pendingIntentIds: [], historyCursor: 7 });
  await db.pool.query("UPDATE ac_managers SET lease_until=clock_timestamp()-interval '1 second' WHERE context_id=$1", [one]);
  const next = await second.acquire('owner', one, randomUUID(), 'same-profile');
  assert.equal(next.epoch, old.value.epoch + 1);
  await assert.rejects(db.tx(c => db.fence(c, old.value)), refused('STALE_MANAGER'));
  await assert.rejects(db.tx(c => db.fence(c, next)), refused('HUMAN_PAUSED'));
  assert.equal((await db.pool.query('SELECT snapshot FROM ac_checkpoints WHERE context_id=$1', [one])).rows[0].snapshot.historyCursor, 7);
  await assert.rejects(db.checkpoint(next, { schemaVersion: 1, planRevision: 99, objectiveRef: '', constraintRefs: [], decisionRefs: [], artifactRefs: [], pendingIntentIds: [], historyCursor: 0 }), refused('CHECKPOINT_REVISION_MISMATCH'));
});
test('RF-45/53/T27: concurrency, semantic retry, payload and cross-context conflicts', async () => {
  const a = await db.acquire('owner', two, randomUUID(), 'manager');
  const command: Command = { schemaVersion: 1, intentId: randomUUID(), deliveryAttemptId: randomUUID(),
    contextId: two, policyRevision: 1, action: 'plan.start', payload: { workflow: 'baseline-synthetic-v1', messageRef: 'encrypted:message' } };
  const result = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? db : second).accept('owner',
    { ...command, deliveryAttemptId: randomUUID() }, a, i % 2 ? 'cockpit' : 'happier')));
  assert.equal(new Set(result.map(r => r.run_id)).size, 1);
  assert.equal((await db.pool.query('SELECT * FROM ac_outbox WHERE intent_id=$1', [command.intentId])).rowCount, 1);
  assert.equal((await db.pool.query('SELECT * FROM ac_deliveries WHERE intent_id=$1', [command.intentId])).rowCount, 12);
  await assert.rejects(db.accept('owner', { ...command, payload: { ...command.payload, messageRef: 'other' } }, a, 'api'), refused('INTENT_PAYLOAD_CONFLICT'));
  await assert.rejects(db.accept('reader', { ...command, intentId: randomUUID() }, a, 'api'), refused('CONTEXT_FORBIDDEN'));
  await assert.rejects(db.accept('outsider', command, a, 'api'), refused('CONTEXT_FORBIDDEN'));
  await assert.rejects(db.accept('owner', { ...command, contextId: one }, a, 'api'), refused('AUTHORITY_SCOPE_MISMATCH'));
  await assert.rejects(db.accept('owner', { ...command, intentId: randomUUID(), policyRevision: 2 }, a, 'api'), refused('POLICY_REVISION_MISMATCH'));
});
test('checkpoint tracks new plans atomically and rejects an older snapshot', async () => {
  const contextId = await db.createContext('owner', project, 'session-' + randomUUID());
  const authority = await db.acquire('owner', contextId, randomUUID(), 'manager');
  await db.checkpoint(authority, { schemaVersion: 1, planRevision: 0, objectiveRef: 'encrypted:objective',
    constraintRefs: ['encrypted:constraint'], decisionRefs: [], artifactRefs: [], pendingIntentIds: [], historyCursor: 7 });
  const command = (id: string): Command => ({ schemaVersion: 1, intentId: id, deliveryAttemptId: randomUUID(),
    contextId, policyRevision: 1, action: 'plan.start', payload: { workflow: 'baseline-synthetic-v1', messageRef: 'encrypted:message' } });
  const commands = [command(randomUUID()), command(randomUUID())];
  await Promise.all(commands.map(c => db.accept('owner', c, authority, 'api')));
  await db.accept('owner', { ...commands[0], deliveryAttemptId: randomUUID() }, authority, 'api');
  const saved = (await db.pool.query('SELECT snapshot FROM ac_checkpoints WHERE context_id=$1', [contextId])).rows[0].snapshot;
  assert.equal(saved.planRevision, 2);
  assert.deepEqual(new Set(saved.pendingIntentIds), new Set(commands.map(c => c.intentId)));
  assert.equal(saved.objectiveRef, 'encrypted:objective');
  assert.equal(saved.historyCursor, 7);
  await db.pool.query("UPDATE ac_checkpoints SET snapshot=jsonb_set(snapshot,'{planRevision}','0') WHERE context_id=$1", [contextId]);
  await assert.rejects(db.accept('owner', command(randomUUID()), authority, 'api'), refused('CHECKPOINT_STALE'));
  assert.equal((await db.pool.query('SELECT plan_revision FROM ac_contexts WHERE id=$1', [contextId])).rows[0].plan_revision, 2);
});
