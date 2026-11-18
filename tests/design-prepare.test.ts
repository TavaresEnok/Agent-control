import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Capacity, CapacityPolicy} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {parseDesignInvocation} from '../src/design-command.ts';
import {formatDesignPrepare, prepareDesignSpecialist} from '../src/design-prepare.ts';
import {Ledger} from '../src/ledger.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const roles = ['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge'] as const;

test('o texto da preparação distingue prévia e gravação do catálogo', () => {
  const base = {
    unchanged: false,
    catalogAction: 'registrar' as const,
    profiles: [],
    chain: {regular: ['novo:criar'], emergency: ['novo:revisor']},
    contexts: [],
    revisionFrom: 1,
    revisionTo: null,
  };
  assert.match(formatDesignPrepare({...base, apply: false}), /entraria por personal:\/\/account-add/);
  assert.match(formatDesignPrepare({...base, apply: true, revisionTo: 2}), /entrou por personal:\/\/account-add/);
  assert.equal(formatDesignPrepare({...base, apply: true, unchanged: true, catalogAction: 'presente', revisionTo: 2}), 'Nada a mudar.');
});

test('preparar exige instalação, projeto e no máximo um --aplicar', () => {
  const project = randomUUID();
  const dry = parseDesignInvocation(['preparar', 'instalacao.json', project]);
  assert.deepEqual(dry, {kind: 'prepare', installationPath: 'instalacao.json', projectId: project, apply: false});
  const apply = parseDesignInvocation(['preparar', 'instalacao.json', project, '--aplicar']);
  assert.equal(apply.kind === 'prepare' && apply.apply, true);
  assert.throws(() => parseDesignInvocation(['preparar', 'instalacao.json', project, '--aplicar', '--aplicar']), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_USAGE');
  assert.throws(() => parseDesignInvocation(['preparar', 'instalacao.json', project, '--outro']), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_USAGE');
  assert.throws(() => parseDesignInvocation(['preparar', 'instalacao.json']), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_USAGE');
  assert.throws(() => parseDesignInvocation(['preparar', 'instalacao.json', 'nao-e-uuid']), (error: unknown) => error instanceof Refusal && error.code === 'NOT_FOUND');
});

test('preparar acrescenta só specialist, a segunda vez não muda, e sem Claude recusa', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prep');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Preparar']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 4});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    const add = async (provider: 'claude' | 'grok') => {
      const id = randomUUID();
      await capacity.addAccount(principal, project, {
        id, provider, label: provider, resourceIdentity: `${provider}:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 4,
      });
      return id;
    };
    const claude = [await add('claude'), await add('claude')].sort();
    const primary = claude[0]!;
    const secondary = claude[1]!;
    await add('grok');
    const profile = async (accountId: string, role: 'manager' | 'reviewer' | 'programmer', effort: 'low' | 'medium') => {
      const id = randomUUID();
      await capacity.addProfile(principal, project, {id, accountId, model: 'claude-sonnet-5-5', effort, role});
      return id;
    };
    const manager = await profile(primary, 'manager', 'medium');
    const reviewer = await profile(primary, 'reviewer', 'medium');
    const programmer = await profile(primary, 'programmer', 'low');
    const previous = CapacityPolicy.parse({
      schemaVersion: 1,
      maxProgrammersPerContext: 3,
      maxEvaluatorsPerContext: 4,
      roles: {
        manager: {regular: [manager], emergency: []},
        reviewer: {regular: [reviewer], emergency: []},
        programmer: {regular: [programmer], emergency: []},
      },
      combo: 'economia',
      programmerTiers: {standard: [programmer], basic: []},
      qaModel: false,
    });
    const revision = await capacity.publish(principal, project, 0, previous);
    const kept = await db.createContext(principal, project, randomUUID());
    const fresh = await db.createContext(principal, project, randomUUID());
    await capacity.assignPolicy(principal, kept, revision);
    const counts = async () => ({
      profiles: Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_profiles')).rows[0].n),
      revisions: Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_policy_revisions WHERE project_id=$1', [project])).rows[0].n),
      catalog: Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_model_catalog')).rows[0].n),
    });
    const before = await counts();
    const preview = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: false});
    assert.equal(preview.unchanged, false);
    assert.equal(preview.catalogAction, 'registrar');
    assert.equal(preview.profiles.find(item => item.purpose === 'criar')?.model, 'claude-opus-5-5');
    assert.equal(preview.profiles.find(item => item.purpose === 'criar')?.effort, 'medium');
    assert.equal(preview.profiles.find(item => item.purpose === 'revisor')?.accountId, secondary);
    assert.equal(preview.profiles.find(item => item.purpose === 'revisor')?.seat, 'outra conta');
    assert.deepEqual(preview.contexts.sort(), [fresh, kept].sort());
    assert.deepEqual(await counts(), before);
    assert.equal(Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [kept])).rows[0].capacity_policy_revision), revision);

    const applied = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(applied.revisionFrom, revision);
    assert.equal(applied.revisionTo, revision + 1);
    assert.equal(applied.contexts.length, 2);
    const after = await counts();
    assert.equal(after.revisions, before.revisions + 1);
    assert.equal(after.catalog, before.catalog + 1);
    assert.equal(after.profiles, before.profiles + 3);
    const stored = (await db.pool.query('SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision', [project])).rows.map(row => row.snapshot);
    assert.equal(stored.length, 2);
    const older = CapacityPolicy.parse(stored[0]);
    const newer = CapacityPolicy.parse(stored[1]);
    assert.equal(older.roles.specialist, undefined);
    assert.equal(newer.roles.specialist?.regular.length, 2);
    assert.equal(newer.roles.specialist?.emergency.length, 1);
    const strip = (policy: ReturnType<typeof CapacityPolicy.parse>) => {
      const copy = structuredClone(policy);
      delete copy.roles.specialist;
      return copy;
    };
    assert.deepEqual(strip(older), strip(newer));
    assert.equal(newer.combo, 'economia');
    assert.equal(newer.maxProgrammersPerContext, 3);
    const ids = [...newer.roles.specialist!.regular, ...newer.roles.specialist!.emergency];
    assert.equal(new Set(ids).size, 3);
    const seats = (await db.pool.query<{id: string; account_id: string; model: string; effort: string; role: string; enabled: boolean}>(
      'SELECT id::text AS id, account_id::text AS account_id, model, effort, role, enabled FROM ac_profiles WHERE id=ANY($1::uuid[])',
      [ids],
    )).rows;
    const byId = new Map(seats.map(row => [row.id, row]));
    const criar = byId.get(newer.roles.specialist!.regular[0]!);
    const examinador = byId.get(newer.roles.specialist!.regular[1]!);
    const revisor = byId.get(newer.roles.specialist!.emergency[0]!);
    assert.equal(criar?.model, 'claude-opus-5-5');
    assert.equal(criar?.effort, 'medium');
    assert.equal(criar?.account_id, primary);
    assert.equal(criar?.role, 'specialist');
    assert.equal(criar?.enabled, true);
    assert.equal(examinador?.model, 'claude-sonnet-5-5');
    assert.equal(examinador?.account_id, primary);
    assert.equal(revisor?.account_id, secondary);
    assert.equal(revisor?.role, 'specialist');
    assert.equal(Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [kept])).rows[0].capacity_policy_revision), applied.revisionTo);
    assert.equal(Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [fresh])).rows[0].capacity_policy_revision), applied.revisionTo);

    const again = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(again.unchanged, true);
    assert.deepEqual(await counts(), after);
    assert.equal(Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [kept])).rows[0].capacity_policy_revision), applied.revisionTo);
    const opusCatalog = (await db.pool.query<{efforts: string[]; roles: string[]; source: string}>(
      "SELECT efforts, roles, source FROM ac_model_catalog WHERE provider='claude' AND model='claude-opus-5-5'",
    )).rows[0];
    assert.deepEqual(opusCatalog, {efforts: ['medium'], roles: ['specialist'], source: 'personal://account-add'});
  } finally {
    await db.close();
    await database.close();
  }
});

test('preparar com uma conta Claude abre outra sessão para o revisor', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepsolo');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Solo']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 4});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    const account = randomUUID();
    await capacity.addAccount(principal, project, {
      id: account, provider: 'claude', label: 'claude', resourceIdentity: `claude:${account}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 4,
    });
    const manager = randomUUID();
    await capacity.addProfile(principal, project, {id: manager, accountId: account, model: 'claude-sonnet-5-5', effort: 'medium', role: 'manager'});
    await capacity.publish(principal, project, 0, {
      schemaVersion: 1, maxProgrammersPerContext: 1, maxEvaluatorsPerContext: 2,
      roles: {manager: {regular: [manager], emergency: []}},
    });
    const applied = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(applied.profiles.find(item => item.purpose === 'revisor')?.seat, 'outra sessão');
    assert.equal(applied.profiles.find(item => item.purpose === 'revisor')?.accountId, account);
    assert.equal(new Set(applied.chain.regular.concat(applied.chain.emergency)).size, 3);
    const again = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(again.unchanged, true);
  } finally {
    await db.close();
    await database.close();
  }
});

test('preparar recusa projeto sem conta Claude e não grava', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepnoclaude');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Sem Claude']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 4});
    const grok = randomUUID();
    await capacity.addAccount(principal, project, {
      id: grok, provider: 'grok', label: 'grok', resourceIdentity: `grok:${grok}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 2,
    });
    const before = Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_policy_revisions')).rows[0].n);
    await assert.rejects(
      prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PREPARE_NO_CLAUDE',
    );
    assert.equal(Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_policy_revisions')).rows[0].n), before);
  } finally {
    await db.close();
    await database.close();
  }
});

test('preparar recusa Opus no catálogo sem esforço medium', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepopus');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Opus']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 4});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['low'], roles: [...roles], source: 'personal://account-add',
    });
    const account = randomUUID();
    await capacity.addAccount(principal, project, {
      id: account, provider: 'claude', label: 'claude', resourceIdentity: `claude:${account}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 2,
    });
    const before = Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_profiles')).rows[0].n);
    await assert.rejects(
      prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: false}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_MODEL_UNAVAILABLE',
    );
    assert.equal(Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_profiles')).rows[0].n), before);
  } finally {
    await db.close();
    await database.close();
  }
});

test('preparar não altera linha existente do Opus no catálogo e recusa se faltar specialist', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepcat');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Cat']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 4});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: [...roles], source: 'custom://sonnet',
    });
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'], roles: ['manager', 'specialist'], source: 'custom://opus',
    });
    const account = randomUUID();
    await capacity.addAccount(principal, project, {
      id: account, provider: 'claude', label: 'claude', resourceIdentity: `claude:${account}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 4,
    });
    const applied = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(applied.catalogAction, 'presente');
    const row = (await db.pool.query<{efforts: string[]; roles: string[]; source: string}>(
      "SELECT efforts, roles, source FROM ac_model_catalog WHERE provider='claude' AND model='claude-opus-5-5'",
    )).rows[0];
    assert.deepEqual(row, {efforts: ['low', 'medium', 'high'], roles: ['manager', 'specialist'], source: 'custom://opus'});

    const project2 = randomUUID();
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project2, 'Cat2']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project2, principal]);
    await capacity.addAccount(principal, project2, {
      id: randomUUID(), provider: 'claude', label: 'claude2', resourceIdentity: 'claude:cat2', mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 4,
    });
    await db.pool.query("UPDATE ac_model_catalog SET roles=ARRAY['manager']::text[] WHERE provider='claude' AND model='claude-opus-5-5'");
    await assert.rejects(
      prepareDesignSpecialist({ledger: db, owner: principal, projectId: project2, apply: true}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CREATE_MODEL_UNAVAILABLE',
    );
    const unchangedRow = (await db.pool.query<{roles: string[]; source: string}>(
      "SELECT roles, source FROM ac_model_catalog WHERE provider='claude' AND model='claude-opus-5-5'",
    )).rows[0];
    assert.deepEqual(unchangedRow, {roles: ['manager'], source: 'custom://opus'});
  } finally {
    await db.close();
    await database.close();
  }
});

test('preparar acrescenta perfis que faltam à cadeia specialist existente sem substituir os antigos', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepmerge');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Merge']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 6, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    await capacity.registerModel(principal, {
      provider: 'grok', model: 'grok-4.7', efforts: ['medium'], roles: ['specialist'], source: 'personal://account-add',
    });
    const claudeAccount = randomUUID();
    const grokAccount = randomUUID();
    await capacity.addAccount(principal, project, {
      id: claudeAccount, provider: 'claude', label: 'claude', resourceIdentity: `claude:${claudeAccount}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 4,
    });
    await capacity.addAccount(principal, project, {
      id: grokAccount, provider: 'grok', label: 'grok', resourceIdentity: `grok:${grokAccount}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 4,
    });
    const oldGrokRegular = randomUUID();
    const oldClaudeRegular = randomUUID();
    const oldGrokEmergency = randomUUID();
    await capacity.addProfile(principal, project, {id: oldGrokRegular, accountId: grokAccount, model: 'grok-4.7', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: oldClaudeRegular, accountId: claudeAccount, model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: oldGrokEmergency, accountId: grokAccount, model: 'grok-4.7', effort: 'medium', role: 'specialist'});
    const revision1 = await capacity.publish(principal, project, 0, {
      schemaVersion: 1,
      maxProgrammersPerContext: 1,
      maxEvaluatorsPerContext: 2,
      roles: {
        specialist: {regular: [oldGrokRegular, oldClaudeRegular], emergency: [oldGrokEmergency]},
      },
    });

    const preview = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: false});
    assert.equal(preview.unchanged, false);
    assert.deepEqual(preview.chain.regular.slice(0, 2), [oldGrokRegular, oldClaudeRegular]);
    assert.equal(preview.chain.regular.length, 3);
    assert.deepEqual(preview.chain.emergency.slice(0, 1), [oldGrokEmergency]);
    assert.equal(preview.chain.emergency.length, 2);

    const applied = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(applied.revisionFrom, revision1);
    assert.equal(applied.revisionTo, revision1 + 1);
    assert.deepEqual(applied.chain.regular.slice(0, 2), [oldGrokRegular, oldClaudeRegular]);
    assert.equal(applied.chain.regular.length, 3);
    assert.deepEqual(applied.chain.emergency.slice(0, 1), [oldGrokEmergency]);
    assert.equal(applied.chain.emergency.length, 2);

    const stored = CapacityPolicy.parse((await db.pool.query(
      'SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',
      [project],
    )).rows[0].snapshot);
    assert.deepEqual(stored.roles.specialist, applied.chain);
    const createdId = applied.chain.regular[2]!;
    const createdRow = (await db.pool.query<{model: string; effort: string}>(
      'SELECT model, effort FROM ac_profiles WHERE id=$1',
      [createdId],
    )).rows[0];
    assert.deepEqual(createdRow, {model: 'claude-opus-5-5', effort: 'medium'});

    const again = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(again.unchanged, true);
  } finally {
    await db.close();
    await database.close();
  }
});

test('preparar lê o plano e aplica na mesma transação', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'preptx');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Tx']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 4});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: [...roles], source: 'personal://account-add',
    });
    const account = randomUUID();
    await capacity.addAccount(principal, project, {
      id: account, provider: 'claude', label: 'claude', resourceIdentity: `claude:${account}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepare', maxConcurrent: 4,
    });
    let txCalls = 0;
    const originalTx = db.tx.bind(db);
    db.tx = ((fn: Parameters<Ledger['tx']>[0]) => {
      txCalls += 1;
      return originalTx(fn);
    }) as Ledger['tx'];
    const applied = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(applied.unchanged, false);
    assert.equal(txCalls, 1);
  } finally {
    await db.close();
    await database.close();
  }
});
