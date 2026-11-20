import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {promisify} from 'node:util';
import {Capacity, CapacityPolicy} from '../src/capacity.ts';
import {Refusal} from '../src/contracts.ts';
import {parseDesignInvocation} from '../src/design-command.ts';
import {formatDesignPrepare, prepareDesignSpecialist} from '../src/design-prepare.ts';
import {Ledger} from '../src/ledger.ts';
import {designCliFailureText} from '../src/personal-design-cli.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const roles = ['manager', 'programmer', 'reviewer', 'qa', 'specialist', 'judge'] as const;

test('preparar aceita --conta-prioritaria <UUID> em qualquer ordem e recusa uso inválido', () => {
  const project = randomUUID();
  const account = randomUUID();

  const preview = parseDesignInvocation(['preparar', 'instalacao.json', project, '--conta-prioritaria', account]);
  assert.deepEqual(preview, {
    kind: 'prepare',
    installationPath: 'instalacao.json',
    projectId: project,
    apply: false,
    primaryAccountId: account,
  });

  const applied = parseDesignInvocation(['preparar', '--conta-prioritaria', account, 'instalacao.json', project, '--aplicar']);
  assert.deepEqual(applied, {
    kind: 'prepare',
    installationPath: 'instalacao.json',
    projectId: project,
    apply: true,
    primaryAccountId: account,
  });

  for (const invalid of [
    ['preparar', 'instalacao.json', project, '--conta-prioritaria'],
    ['preparar', 'instalacao.json', project, '--conta-prioritaria', '--aplicar'],
    ['preparar', 'instalacao.json', project, '--conta-prioritaria', 'nao-e-uuid'],
    ['preparar', 'instalacao.json', project, '--conta-prioritaria', account, '--conta-prioritaria', randomUUID()],
  ]) {
    assert.throws(
      () => parseDesignInvocation(invalid),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_USAGE',
    );
  }

  assert.match(designCliFailureText(new Refusal('DESIGN_PREPARE_ACCOUNT_UNAVAILABLE', 409)), /conta prioritária/i);
});

test('preparar com --conta-prioritaria prioriza Max na cadeia regular, distingue Opus HIGH de medium e Sonnet medium/high', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepmax');
  const db = new Ledger(database.url);
  const root = await mkdtemp(join(tmpdir(), 'ac-design-prep-cli-'));
  try {
    await db.migrate();
    const principal = 'prepare-max-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Max Priority']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });

    // Garante UUID da conta primária (Max) lexicograficamente MAIOR que a conta secundária (Pro).
    const proAccount = `00000000-0000-4000-8000-${randomUUID().slice(24)}`;
    const maxAccount = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(24)}`;
    await capacity.addAccount(principal, project, {
      id: proAccount, provider: 'claude', label: 'claude-pro', resourceIdentity: `claude:${proAccount}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepmax', maxConcurrent: 4,
    });
    await capacity.addAccount(principal, project, {
      id: maxAccount, provider: 'claude', label: 'claude-max', resourceIdentity: `claude:${maxAccount}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepmax', maxConcurrent: 4,
    });

    const mainContext = await db.createContext(principal, project, randomUUID());
    const otherContext = await db.createContext(principal, project, randomUUID());

    // Encaminhamento real pela CLI `personal-design-cli.ts preparar --conta-prioritaria <UUID> --aplicar`.
    const repo = join(root, 'repo');
    const dataDirectory = join(root, 'data');
    await mkdir(repo, {mode: 0o755});
    await mkdir(dataDirectory, {mode: 0o700});
    const installationPath = join(root, 'instalacao.json');
    await writeFile(installationPath, JSON.stringify({
      schemaVersion: 1,
      mode: 'administration-only',
      activation: 'personal',
      databaseUrl: database.url,
      dataDirectory,
      project: {id: project, label: 'Max Priority', repo, owner: principal},
      http: {listen: '127.0.0.1', port: 43123, publicOrigin: 'http://127.0.0.1:43123'},
      happier: {
        upstreamOrigin: 'http://127.0.0.1:43124',
        webOrigin: 'http://127.0.0.1:43125',
        publicServerOrigin: 'http://127.0.0.1:43126',
      },
    }), {mode: 0o600});
    await chmod(installationPath, 0o600);

    const cliOut = await execFileAsync(process.execPath, [
      '--import', 'tsx',
      'src/personal-design-cli.ts',
      'preparar',
      installationPath,
      project,
      '--conta-prioritaria',
      maxAccount,
      '--aplicar',
    ], {cwd: process.cwd(), encoding: 'utf8'});
    assert.match(cliOut.stdout, /Preparação aplicada\./);
    assert.match(cliOut.stdout, new RegExp(`Conta prioritária: ${maxAccount}`));

    const snapshot = CapacityPolicy.parse((await db.pool.query(
      'SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',
      [project],
    )).rows[0].snapshot);
    const specialist = snapshot.roles.specialist!;
    assert.equal(specialist.regular.length, 5);
    assert.equal(specialist.emergency.length, 2);

    const allIds = [...specialist.regular, ...specialist.emergency];
    assert.equal(new Set(allIds).size, 7);
    const profileRows = (await db.pool.query<{id: string; account_id: string; model: string; effort: string; enabled: boolean}>(
      'SELECT id::text AS id, account_id::text AS account_id, model, effort, enabled FROM ac_profiles WHERE id=ANY($1::uuid[])',
      [allIds],
    )).rows;
    const byId = new Map(profileRows.map(row => [row.id, row]));

    // Regular deve priorizar Max (3 primeiros) antes de Pro (2 últimos).
    const regularProfiles = specialist.regular.map(id => byId.get(id)!);
    assert.deepEqual(
      regularProfiles.map(row => ({accountId: row.account_id, model: row.model, effort: row.effort})),
      [
        {accountId: maxAccount, model: 'claude-opus-5-5', effort: 'high'},
        {accountId: maxAccount, model: 'claude-sonnet-5-5', effort: 'medium'},
        {accountId: maxAccount, model: 'claude-sonnet-5-5', effort: 'high'},
        {accountId: proAccount, model: 'claude-sonnet-5-5', effort: 'medium'},
        {accountId: proAccount, model: 'claude-sonnet-5-5', effort: 'high'},
      ],
    );

    // Emergency tem revisor na conta Pro distinta e Opus medium distinto na conta Max para revisão de achados altos.
    const emergencyProfiles = specialist.emergency.map(id => byId.get(id)!);
    assert.deepEqual(
      emergencyProfiles.map(row => ({accountId: row.account_id, model: row.model, effort: row.effort})),
      [
        {accountId: proAccount, model: 'claude-sonnet-5-5', effort: 'medium'},
        {accountId: maxAccount, model: 'claude-opus-5-5', effort: 'medium'},
      ],
    );

    // Consumidor distingue claramente Opus HIGH (regular) vs Opus medium (emergency) com IDs distintos.
    const opusHighId = specialist.regular.find(id => byId.get(id)?.model === 'claude-opus-5-5' && byId.get(id)?.effort === 'high');
    const opusMediumId = specialist.emergency.find(id => byId.get(id)?.model === 'claude-opus-5-5' && byId.get(id)?.effort === 'medium');
    assert.ok(opusHighId && opusMediumId);
    assert.notEqual(opusHighId, opusMediumId);
    assert.equal(byId.get(opusHighId)?.account_id, maxAccount);
    assert.equal(byId.get(opusMediumId)?.account_id, maxAccount);

    // Ambos os contextos não arquivados recebem a revisão.
    for (const ctx of [mainContext, otherContext]) {
      const rev = Number((await db.pool.query('SELECT capacity_policy_revision FROM ac_contexts WHERE id=$1', [ctx])).rows[0].capacity_policy_revision);
      assert.equal(rev, 1);
    }

    // Idempotência com e sem --conta-prioritaria explícita.
    const repeatWithFlag = await prepareDesignSpecialist({
      ledger: db, owner: principal, projectId: project, apply: true, primaryAccountId: maxAccount,
    });
    assert.equal(repeatWithFlag.unchanged, true);
    assert.equal(repeatWithFlag.primaryAccountId, maxAccount);

    const repeatWithoutFlag = await prepareDesignSpecialist({
      ledger: db, owner: principal, projectId: project, apply: true,
    });
    assert.equal(repeatWithoutFlag.unchanged, true);
    assert.equal(repeatWithoutFlag.primaryAccountId, maxAccount);
  } finally {
    await db.close();
    await database.close();
    await rm(root, {recursive: true, force: true});
  }
});

async function catalogFixture(label: string) {
  const database = await isolatedDatabase(databaseUrl!, label);
  const db = new Ledger(database.url);
  await db.migrate();
  const principal = `${label}-owner`;
  const project = randomUUID();
  const capacity = new Capacity(db);
  await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, label]);
  await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
  await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
  await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
  await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 6});
  const account = randomUUID();
  const addClaude = async () => capacity.addAccount(principal, project, {
    id: account, provider: 'claude', label: 'claude', resourceIdentity: `claude:${account}`, mode: 'synthetic',
    eligibility: 'documented_supported', eligibilitySource: `synthetic://${label}`, maxConcurrent: 4,
  });
  const catalogRows = async () => (await db.pool.query<{provider: string; model: string; efforts: string[]; roles: string[]; source: string}>(
    'SELECT provider, model, efforts, roles, source FROM ac_model_catalog ORDER BY provider, model',
  )).rows;
  const counts = async () => ({
    profiles: Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_profiles')).rows[0].n),
    revisions: Number((await db.pool.query('SELECT count(*)::int AS n FROM ac_policy_revisions')).rows[0].n),
  });
  return {
    database, db, principal, project, capacity, account, addClaude, catalogRows, counts,
    close: async () => { await db.close(); await database.close(); },
  };
}

test('preparar não alarga catálogo misto: prévia aponta modelo, esforço e papéis; aplicar recusa sem gravar', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const fx = await catalogFixture('prepmixed');
  try {
    // Registros antigos com um só esforço, compartilhados com outros papéis.
    await fx.capacity.registerModel(fx.principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium'], roles: ['manager', 'specialist'], source: 'custom://opus-legacy',
    });
    await fx.capacity.registerModel(fx.principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: ['programmer', 'specialist'], source: 'custom://sonnet-legacy',
    });
    await fx.capacity.registerModel(fx.principal, {
      provider: 'grok', model: 'grok-4.7', efforts: ['low'], roles: ['programmer'], source: 'custom://grok',
    });
    await fx.addClaude();
    const catalogBefore = await fx.catalogRows();
    const countsBefore = await fx.counts();

    const preview = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: false});
    assert.equal(preview.catalogAction, 'bloqueado');
    assert.deepEqual(preview.catalog, [
      {model: 'claude-opus-5-5', action: 'bloqueado', efforts: ['medium'], missing: ['high'], sharedRoles: ['manager']},
      {model: 'claude-sonnet-5-5', action: 'bloqueado', efforts: ['medium'], missing: ['high'], sharedRoles: ['programmer']},
    ]);
    const text = formatDesignPrepare(preview);
    assert.match(text, /claude-opus-5-5: bloqueado; falta high e o registro também serve manager/);
    assert.match(text, /claude-sonnet-5-5: bloqueado; falta high e o registro também serve programmer/);
    assert.match(text, /--aplicar não grava nada/);
    assert.match(text, /- claude-opus-5-5: high \(papéis afetados: manager\)/);

    await assert.rejects(
      prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: true}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CATALOG_SHARED_EFFORT',
    );
    assert.match(designCliFailureText(new Refusal('DESIGN_CATALOG_SHARED_EFFORT', 409)), /compartilhado.*nada foi gravado.*prévia/);
    assert.deepEqual(await fx.catalogRows(), catalogBefore);
    assert.deepEqual(await fx.counts(), countsBefore);

    // Só um modelo misto incompleto já bloqueia; o outro, só de specialist, não é gravado sozinho.
    await fx.db.pool.query("UPDATE ac_model_catalog SET roles=ARRAY['specialist']::text[] WHERE provider='claude' AND model='claude-sonnet-5-5'");
    const partial = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: false});
    assert.deepEqual(partial.catalog.map(item => [item.model, item.action]), [
      ['claude-opus-5-5', 'bloqueado'],
      ['claude-sonnet-5-5', 'atualizar'],
    ]);
    await assert.rejects(
      prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: true}),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_CATALOG_SHARED_EFFORT',
    );
    const sonnet = (await fx.catalogRows()).find(row => row.model === 'claude-sonnet-5-5');
    assert.deepEqual(sonnet?.efforts, ['medium']);
    assert.deepEqual((await fx.counts()), countsBefore);

    // Decisão explícita do administrador (fora da preparação): o registro misto passa a ter os dois esforços.
    await fx.db.pool.query("UPDATE ac_model_catalog SET efforts=ARRAY['medium','high']::text[] WHERE provider='claude' AND model='claude-opus-5-5'");
    const unblocked = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: true});
    assert.deepEqual(unblocked.catalog.map(item => [item.model, item.action]), [
      ['claude-opus-5-5', 'presente'],
      ['claude-sonnet-5-5', 'atualizar'],
    ]);
    const after = await fx.catalogRows();
    assert.deepEqual(after.find(row => row.model === 'claude-opus-5-5'), {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium', 'high'], roles: ['manager', 'specialist'], source: 'custom://opus-legacy',
    });
    assert.deepEqual(after.find(row => row.provider === 'grok'), catalogBefore.find(row => row.provider === 'grok'));
  } finally {
    await fx.close();
  }
});

test('preparar migra catálogo só de specialist e relata por modelo; prévia e aplicação idempotentes', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const fx = await catalogFixture('prepspec');
  try {
    // Opus antigo só com medium; Sonnet só com low (nenhum dos esforços novos).
    await fx.capacity.registerModel(fx.principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium'], roles: ['specialist'], source: 'custom://opus-legacy',
    });
    await fx.capacity.registerModel(fx.principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low'], roles: ['specialist'], source: 'custom://sonnet-legacy',
    });
    await fx.addClaude();

    const preview = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: false});
    assert.deepEqual(preview.catalog, [
      {model: 'claude-opus-5-5', action: 'atualizar', efforts: ['medium', 'high'], missing: ['high'], sharedRoles: []},
      {model: 'claude-sonnet-5-5', action: 'atualizar', efforts: ['low', 'medium', 'high'], missing: ['medium', 'high'], sharedRoles: []},
    ]);
    const previewText = formatDesignPrepare(preview);
    assert.match(previewText, /claude-opus-5-5: receberia high \(registro só de specialist\)/);
    assert.match(previewText, /claude-sonnet-5-5: receberia medium, high \(registro só de specialist\)/);
    assert.deepEqual((await fx.catalogRows()).map(row => row.efforts), [['medium'], ['low']]);

    // Sem admin de controle, recusa sem alterar o catálogo.
    await fx.db.pool.query('DELETE FROM ac_control_admins WHERE principal_id=$1', [fx.principal]);
    await assert.rejects(
      prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: true}),
      (error: unknown) => error instanceof Refusal && error.code === 'CONTROL_ADMIN_REQUIRED',
    );
    assert.deepEqual((await fx.catalogRows()).map(row => row.efforts), [['medium'], ['low']]);
    await fx.db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [fx.principal]);

    const applied = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: true});
    const appliedText = formatDesignPrepare(applied);
    assert.match(appliedText, /claude-opus-5-5: recebeu high/);
    assert.match(appliedText, /claude-sonnet-5-5: recebeu medium, high/);
    assert.deepEqual(await fx.catalogRows(), [
      {provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium', 'high'], roles: ['specialist'], source: 'custom://opus-legacy'},
      {provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'], roles: ['specialist'], source: 'custom://sonnet-legacy'},
    ]);
    assert.ok(applied.profiles.every(profile => profile.action === 'criar'));

    const repeatPreview = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: false});
    assert.equal(repeatPreview.unchanged, true);
    const repeat = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: true});
    assert.equal(repeat.unchanged, true);
    assert.deepEqual(repeat.catalog.map(item => item.action), ['presente', 'presente']);
  } finally {
    await fx.close();
  }
});

test('preparar com catálogo misto completo (instalação viva) funciona sem mexer no catálogo', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const fx = await catalogFixture('prepfull');
  try {
    await fx.capacity.registerModel(fx.principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    await fx.capacity.registerModel(fx.principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    await fx.addClaude();
    const before = await fx.catalogRows();
    const applied = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: true});
    assert.equal(applied.catalogAction, 'presente');
    assert.match(formatDesignPrepare(applied), /claude-opus-5-5: já tem low, medium, high; nada muda\./);
    assert.equal(applied.revisionTo, 1);
    assert.deepEqual(await fx.catalogRows(), before);
    const repeat = await prepareDesignSpecialist({ledger: fx.db, owner: fx.principal, projectId: fx.project, apply: true});
    assert.equal(repeat.unchanged, true);
  } finally {
    await fx.close();
  }
});

test('preparar migra política antiga com Pro na frente e Opus medium em regular para Max na frente e Opus medium em emergency', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepreord');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-reorder-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'Reorder']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await capacity.configure(principal, {programmingLimit: 10, evaluationLimit: 6});
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium', 'high'], roles: [...roles], source: 'personal://account-add',
    });
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium'], roles: ['specialist'], source: 'personal://account-add',
    });

    const proAccount = `00000000-0000-4000-8000-${randomUUID().slice(24)}`;
    const maxAccount = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(24)}`;
    const grokAccount = randomUUID();
    await capacity.addAccount(principal, project, {
      id: proAccount, provider: 'claude', label: 'pro', resourceIdentity: `claude:${proAccount}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://reorder', maxConcurrent: 4,
    });
    await capacity.addAccount(principal, project, {
      id: maxAccount, provider: 'claude', label: 'max', resourceIdentity: `claude:${maxAccount}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://reorder', maxConcurrent: 4,
    });
    await capacity.addAccount(principal, project, {
      id: grokAccount, provider: 'grok', label: 'grok', resourceIdentity: `grok:${grokAccount}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://reorder', maxConcurrent: 4,
    });

    const oldProSonnetMed = randomUUID();
    const oldMaxOpusMed = randomUUID();
    const oldMaxSonnetMed = randomUUID();
    const oldProReviewer = randomUUID();
    const otherManager = randomUUID();
    await capacity.addProfile(principal, project, {id: oldProSonnetMed, accountId: proAccount, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: oldMaxOpusMed, accountId: maxAccount, model: 'claude-opus-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: oldMaxSonnetMed, accountId: maxAccount, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: oldProReviewer, accountId: proAccount, model: 'claude-sonnet-5-5', effort: 'medium', role: 'specialist'});
    await capacity.addProfile(principal, project, {id: otherManager, accountId: maxAccount, model: 'claude-sonnet-5-5', effort: 'high', role: 'manager'});

    const rev1 = await capacity.publish(principal, project, 0, CapacityPolicy.parse({
      schemaVersion: 1,
      maxProgrammersPerContext: 2,
      maxEvaluatorsPerContext: 3,
      roles: {
        manager: {regular: [otherManager], emergency: []},
        specialist: {regular: [oldProSonnetMed, oldMaxOpusMed, oldMaxSonnetMed], emergency: [oldProReviewer]},
      },
      combo: 'intermediário',
    }));

    // Conta prioritária desconhecida ou não-Claude recusa sem gravar.
    for (const badAccount of [grokAccount, randomUUID()]) {
      await assert.rejects(
        prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true, primaryAccountId: badAccount}),
        (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PREPARE_ACCOUNT_UNAVAILABLE',
      );
    }

    const applied = await prepareDesignSpecialist({
      ledger: db, owner: principal, projectId: project, apply: true, primaryAccountId: maxAccount,
    });
    assert.equal(applied.unchanged, false);
    assert.equal(applied.revisionFrom, rev1);
    assert.equal(applied.revisionTo, rev1 + 1);

    const snapshot = CapacityPolicy.parse((await db.pool.query(
      'SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1',
      [project],
    )).rows[0].snapshot);
    assert.deepEqual(snapshot.roles.manager, {regular: [otherManager], emergency: []});
    assert.equal(snapshot.combo, 'intermediário');

    const regular = snapshot.roles.specialist!.regular;
    const emergency = snapshot.roles.specialist!.emergency;
    assert.equal(regular.includes(oldMaxOpusMed), false);
    assert.equal(emergency.includes(oldMaxOpusMed), true);
    assert.equal(emergency.includes(oldProReviewer), true);

    const rows = (await db.pool.query<{id: string; account_id: string; model: string; effort: string}>(
      'SELECT id::text AS id, account_id::text AS account_id, model, effort FROM ac_profiles WHERE id=ANY($1::uuid[])',
      [[...regular, ...emergency]],
    )).rows;
    const byId = new Map(rows.map(row => [row.id, row]));

    // Todos os perfis Max vêm antes dos perfis Pro em regular.
    const regularAccounts = regular.map(id => byId.get(id)!.account_id);
    const firstProIndex = regularAccounts.indexOf(proAccount);
    assert.ok(firstProIndex > 0);
    assert.equal(regularAccounts.slice(0, firstProIndex).every(id => id === maxAccount), true);
    assert.equal(regularAccounts.slice(firstProIndex).every(id => id === proAccount), true);

    // Em regular, o único perfil Opus é o Opus HIGH na conta Max; em emergency, o perfil Opus medium antigo foi reaproveitado.
    const opusInRegular = regular.map(id => byId.get(id)!).filter(row => row.model === 'claude-opus-5-5');
    assert.equal(opusInRegular.length, 1);
    assert.equal(opusInRegular[0]?.effort, 'high');
    assert.equal(opusInRegular[0]?.account_id, maxAccount);

    const opusInEmergency = emergency.map(id => byId.get(id)!).filter(row => row.model === 'claude-opus-5-5');
    assert.equal(opusInEmergency.length, 1);
    assert.equal(opusInEmergency[0]?.id, oldMaxOpusMed);
    assert.equal(opusInEmergency[0]?.effort, 'medium');

    const repeat = await prepareDesignSpecialist({
      ledger: db, owner: principal, projectId: project, apply: true, primaryAccountId: maxAccount,
    });
    assert.equal(repeat.unchanged, true);
  } finally {
    await db.close();
    await database.close();
  }
});

test('preparar migra política antiga com outros provedores intercalados e vários papéis, achando a primária anterior pelo Opus medium', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const fx = await catalogFixture('prepinter');
  try {
    const {db, capacity, principal, project} = fx;
    // Catálogo misto completo (como a instalação viva) e dois provedores não Claude que também servem specialist.
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
      await capacity.registerModel(principal, {provider: 'claude', model, efforts: ['low', 'medium', 'high'], roles: [...roles], source: 'personal://account-add'});
    }
    await capacity.registerModel(principal, {provider: 'grok', model: 'grok-4.7', efforts: ['medium', 'high'], roles: ['specialist', 'programmer'], source: 'custom://grok'});
    await capacity.registerModel(principal, {provider: 'gemini', model: 'gemini-4-hydrogen-high', efforts: ['high'], roles: ['specialist'], source: 'custom://gemini'});

    // Pro tem UUID menor: sem a regra da primária anterior, cairia como primária.
    const proAccount = `00000000-0000-4000-8000-${randomUUID().slice(24)}`;
    const maxAccount = `ffffffff-ffff-4fff-8fff-${randomUUID().slice(24)}`;
    const grokAccount = randomUUID();
    const geminiAccount = randomUUID();
    for (const [id, provider] of [[proAccount, 'claude'], [maxAccount, 'claude'], [grokAccount, 'grok'], [geminiAccount, 'gemini']] as const) {
      await capacity.addAccount(principal, project, {
        id, provider, label: `${provider}-${id.slice(0, 4)}`, resourceIdentity: `${provider}:${id}`, mode: 'synthetic',
        eligibility: 'documented_supported', eligibilitySource: 'synthetic://prepinter', maxConcurrent: 4,
      });
    }
    const profile = async (accountId: string, model: string, effort: 'medium' | 'high', role: (typeof roles)[number] = 'specialist') => {
      const id = randomUUID();
      await capacity.addProfile(principal, project, {id, accountId, model, effort, role});
      return id;
    };
    const grokFirst = await profile(grokAccount, 'grok-4.7', 'high');
    const proSonnet = await profile(proAccount, 'claude-sonnet-5-5', 'medium');
    const geminiMiddle = await profile(geminiAccount, 'gemini-4-hydrogen-high', 'high');
    const maxOpusMedium = await profile(maxAccount, 'claude-opus-5-5', 'medium');
    const grokLast = await profile(grokAccount, 'grok-4.7', 'medium');
    const proReviewer = await profile(proAccount, 'claude-sonnet-5-5', 'medium');
    const grokEmergency = await profile(grokAccount, 'grok-4.7', 'medium');
    const manager = await profile(maxAccount, 'claude-sonnet-5-5', 'high', 'manager');
    const programmer = await profile(grokAccount, 'grok-4.7', 'high', 'programmer');

    const rev1 = await capacity.publish(principal, project, 0, CapacityPolicy.parse({
      schemaVersion: 1,
      maxProgrammersPerContext: 2,
      maxEvaluatorsPerContext: 3,
      roles: {
        manager: {regular: [manager], emergency: []},
        programmer: {regular: [programmer], emergency: []},
        specialist: {regular: [grokFirst, proSonnet, geminiMiddle, maxOpusMedium, grokLast], emergency: [grokEmergency, proReviewer]},
      },
      combo: 'intermediário',
    }));
    const catalogBefore = await fx.catalogRows();

    const preview = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: false});
    assert.equal(preview.primaryAccountId, maxAccount);
    assert.equal(preview.revisionTo, null);
    const previewMoved = preview.profiles.find(item => item.purpose === 'revisor-alto');
    assert.deepEqual(previewMoved && {id: previewMoved.profileId, action: previewMoved.action}, {id: maxOpusMedium, action: 'mover'});
    assert.match(formatDesignPrepare(preview), new RegExp(`revisor-alto: claude-opus-5-5 medium conta ${maxAccount} perfil ${maxOpusMedium} \\(mover`));
    assert.equal((await fx.counts()).revisions, 1);

    const applied = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(applied.primaryAccountId, maxAccount);
    assert.equal(applied.revisionTo, rev1 + 1);
    // A prévia mostra a mesma forma da cadeia gravada; só os perfis novos trocam o marcador pelo id.
    const novos = new Map(preview.profiles.filter(item => item.profileId === null).map((item, index) => [
      `novo:${item.purpose}:${item.accountId}`, applied.profiles.filter(other => other.action === 'criar')[index]?.profileId,
    ]));
    assert.deepEqual(applied.chain.regular, preview.chain.regular.map(id => novos.get(id) ?? id));
    assert.deepEqual(await fx.catalogRows(), catalogBefore);

    const snapshot = CapacityPolicy.parse((await db.pool.query(
      'SELECT snapshot FROM ac_policy_revisions WHERE project_id=$1 ORDER BY revision DESC LIMIT 1', [project],
    )).rows[0].snapshot);
    // Outros papéis e o resto da política ficam iguais.
    assert.deepEqual(snapshot.roles.manager, {regular: [manager], emergency: []});
    assert.deepEqual(snapshot.roles.programmer, {regular: [programmer], emergency: []});
    assert.equal(snapshot.combo, 'intermediário');

    const {regular, emergency} = snapshot.roles.specialist!;
    // Os novos perfis conservam as posições dos demais provedores.
    assert.equal(regular[0], grokFirst);
    assert.equal(regular[2], geminiMiddle);
    assert.equal(regular[4], grokLast);
    assert.equal(preview.chain.regular[4], grokLast);
    const rows = new Map((await db.pool.query<{id: string; account_id: string; model: string; effort: string}>(
      'SELECT id::text AS id, account_id::text AS account_id, model, effort FROM ac_profiles WHERE id=ANY($1::uuid[])',
      [[...regular, ...emergency]],
    )).rows.map(row => [row.id, row]));
    const claudeRegular = regular.filter(id => !([grokFirst, geminiMiddle, grokLast] as string[]).includes(id)).map(id => rows.get(id)!);
    const firstPro = claudeRegular.findIndex(row => row.account_id === proAccount);
    assert.ok(firstPro > 0);
    assert.ok(claudeRegular.slice(0, firstPro).every(row => row.account_id === maxAccount));
    assert.ok(claudeRegular.slice(firstPro).every(row => row.account_id === proAccount));
    assert.ok(claudeRegular.some(row => row.id === proSonnet));
    assert.deepEqual(
      claudeRegular.filter(row => row.model === 'claude-opus-5-5').map(row => [row.account_id, row.effort]),
      [[maxAccount, 'high']],
    );
    // Opus medium antigo migra para emergency sem perder os perfis que já estavam lá.
    assert.equal(regular.includes(maxOpusMedium), false);
    assert.deepEqual(emergency.slice(0, 2), [grokEmergency, proReviewer]);
    assert.ok(emergency.includes(maxOpusMedium));
    assert.equal(new Set([...regular, ...emergency]).size, regular.length + emergency.length);
    const appliedMoved = applied.profiles.find(item => item.purpose === 'revisor-alto');
    assert.equal(appliedMoved?.action, 'mover');

    const repeatPreview = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: false});
    assert.equal(repeatPreview.unchanged, true);
    assert.deepEqual(repeatPreview.chain, snapshot.roles.specialist);
    const repeat = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(repeat.unchanged, true);
    assert.equal(repeat.revisionTo, rev1 + 1);
  } finally {
    await fx.close();
  }
});
