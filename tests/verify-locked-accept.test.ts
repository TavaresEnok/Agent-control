import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Refusal, type Command} from '../src/contracts.ts';
import {Ledger} from '../src/ledger.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

function refusal(code: string) {
  return (error: unknown) => error instanceof Refusal && error.code === code && error.status === 403;
}

test('locked mode refuses security-verify-readonly-v1 and personal mode accepts it', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  assert.ok(url);
  const database = await isolatedDatabase(url, 'lockaccept');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'verify-lock-owner';
    const project = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Verificação']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    assert.equal((await db.pool.query('SELECT mode FROM ac_installation_activation WHERE id=1')).rows[0].mode, 'locked');
    const context = await db.createContext(principal, project, randomUUID());
    const authority = await db.acquire(principal, context, randomUUID(), 'verify-lock', 60);
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const intentId = randomUUID();
    const command: Command = {
      schemaVersion: 1,
      intentId,
      deliveryAttemptId: randomUUID(),
      contextId: context,
      policyRevision: 1,
      action: 'plan.start',
      payload: {
        workflow: 'security-verify-readonly-v1',
        messageRef: `verify:${project}:${commit}`.slice(0, 200),
        projectId: project,
        commit,
      },
    };
    await assert.rejects(() => db.accept(principal, command, authority, 'api'), refusal('PERSONAL_ACTIVATION_REQUIRED'));
    assert.equal((await db.pool.query('SELECT 1 FROM ac_intents WHERE id=$1', [intentId])).rowCount, 0);
    const pending = (await db.pool.query(
      "SELECT snapshot->'pendingIntentIds' AS ids FROM ac_checkpoints WHERE context_id=$1",
      [context],
    )).rows.flatMap(row => Array.isArray(row.ids) ? row.ids : []);
    assert.equal(pending.includes(intentId), false);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    const accepted = await db.accept(principal, command, authority, 'api');
    assert.equal(accepted.id, intentId);
    assert.equal((await db.pool.query('SELECT id FROM ac_intents WHERE id=$1', [intentId])).rowCount, 1);
    const recorded = (await db.pool.query(
      "SELECT snapshot->'pendingIntentIds' AS ids FROM ac_checkpoints WHERE context_id=$1",
      [context],
    )).rows.flatMap(row => Array.isArray(row.ids) ? row.ids : []);
    assert.equal(recorded.includes(intentId), true);
    await db.pool.query("UPDATE ac_installation_activation SET mode='locked' WHERE id=1");
    await assert.rejects(
      () => db.accept(principal, {...command, deliveryAttemptId: randomUUID()}, authority, 'api'),
      refusal('PERSONAL_ACTIVATION_REQUIRED'),
    );
    assert.equal((await db.pool.query('SELECT id FROM ac_intents WHERE id=$1', [intentId])).rowCount, 1);
  } finally {
    await db.close();
    await database.close();
  }
});
