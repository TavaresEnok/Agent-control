import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Ledger} from '../src/ledger.ts';
import {Capacity} from '../src/capacity.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

// grok-4.7 left the Grok account catalog. Migration 123 moves the catalog entry and the Grok profiles already recorded in an
// installation to grok-4.6, so applying the code is enough: no manual profile change.
test('migration 123 moves recorded Grok catalog and profiles from grok-4.7 to grok-4.6, idempotently', async () => {
  const url = process.env.AC_TEST_DATABASE_URL; if (!url) throw Error('ISOLATED_DATABASE_REQUIRED');
  const isolated = await isolatedDatabase(url, 'grok_model'), db = new Ledger(isolated.url);
  try {
    await db.migrate();
    // An installation from before the migration: forget it ran, then record what account-add used to write.
    await db.pool.query('DELETE FROM ac_schema_migrations WHERE version=123');
    const project = randomUUID(), principal = 'grok-owner-' + randomUUID(), admin = 'synthetic-capacity-administrator';
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Synthetic Grok catalog']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1) ON CONFLICT DO NOTHING', [admin]);
    const capacity = new Capacity(db);
    const roles = ['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge'] as const;
    await capacity.registerModel(admin, {provider: 'grok', model: 'grok-4.7', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add'});
    // Another provider's model of the same name is not Grok's and stays.
    await capacity.registerModel(admin, {provider: 'synthetic', model: 'grok-4.7', efforts: ['medium'], roles: ['programmer'], source: 'synthetic://fixture'});
    const grok = randomUUID(), other = randomUUID();
    for (const [id, provider] of [[grok, 'grok'], [other, 'synthetic']] as const) {
      await capacity.addAccount(principal, project, {id, provider, label: provider, resourceIdentity: 'fixture-' + id, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://fixture', maxConcurrent: 2});
    }
    const programmer = randomUUID(), specialist = randomUUID(), foreign = randomUUID();
    await capacity.addProfile(principal, project, {id: programmer, accountId: grok, model: 'grok-4.7', effort: 'medium', role: 'programmer'});
    await capacity.addProfile(principal, project, {id: specialist, accountId: grok, model: 'grok-4.7', effort: 'high', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: foreign, accountId: other, model: 'grok-4.7', effort: 'medium', role: 'programmer'});
    const profiles = async () => new Map((await db.pool.query('SELECT id,model,revision FROM ac_profiles WHERE id=ANY($1::uuid[])',
      [[programmer, specialist, foreign]])).rows.map(row => [row.id, {model: row.model, revision: Number(row.revision)}]));
    const catalog = async () => (await db.pool.query("SELECT provider,model,roles FROM ac_model_catalog WHERE model LIKE 'grok-4.%' ORDER BY provider,model")).rows;
    const before = await profiles();

    await db.migrate();
    const after = await profiles();
    for (const id of [programmer, specialist]) {
      assert.equal(after.get(id)!.model, 'grok-4.6');
      assert.equal(after.get(id)!.revision, before.get(id)!.revision + 1);
    }
    assert.deepEqual(after.get(foreign), before.get(foreign));
    const migrated = await catalog();
    assert.deepEqual(migrated.map(row => [row.provider, row.model]), [['grok', 'grok-4.6'], ['synthetic', 'grok-4.7']]);
    assert.ok(migrated[0].roles.includes('specialist'), 'the reviewer role survives');

    // Idempotent: running the same statements again changes nothing.
    const sql = await readFile(new URL('../db/migrations/123_grok_model_4_6.sql', import.meta.url), 'utf8');
    await db.pool.query(sql);
    assert.deepEqual(await profiles(), after);
    assert.deepEqual(await catalog(), migrated);
    // The migrated specialist can still be chosen for the reviewer chain: the catalog accepts it for that role.
    await capacity.addProfile(principal, project, {id: randomUUID(), accountId: grok, model: 'grok-4.6', effort: 'medium', role: 'specialist'});
  } finally { await db.close(); await isolated.close(); }
});
