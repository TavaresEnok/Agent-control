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

test('preparar migra catálogo pré-existente medium sem alterar outros papéis nem modelos alheios', {skip: databaseUrl ? false : 'AC_TEST_DATABASE_URL is unset'}, async () => {
  const database = await isolatedDatabase(databaseUrl!, 'prepmigcat');
  const db = new Ledger(database.url);
  try {
    await db.migrate();
    const principal = 'prepare-mig-owner';
    const project = randomUUID();
    const capacity = new Capacity(db);
    await db.pool.query('INSERT INTO ac_projects VALUES($1,$2)', [project, 'MigCatalog']);
    await db.pool.query("INSERT INTO ac_memberships VALUES($1,$2,'owner')", [project, principal]);
    await db.pool.query("UPDATE ac_installation_activation SET mode='personal' WHERE id=1");
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    await capacity.configure(principal, {programmingLimit: 4, evaluationLimit: 4});

    // Catálogo pré-existente apenas com 'medium' (como gravado por versões anteriores), preservando outros papéis e source.
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-opus-5-5', efforts: ['medium'], roles: ['manager', 'specialist'], source: 'custom://opus-legacy',
    });
    await capacity.registerModel(principal, {
      provider: 'claude', model: 'claude-sonnet-5-5', efforts: ['medium'], roles: ['programmer', 'specialist'], source: 'custom://sonnet-legacy',
    });
    await capacity.registerModel(principal, {
      provider: 'grok', model: 'grok-4.7', efforts: ['low'], roles: ['programmer'], source: 'custom://grok',
    });

    const claudeAccount = randomUUID();
    await capacity.addAccount(principal, project, {
      id: claudeAccount, provider: 'claude', label: 'claude', resourceIdentity: `claude:${claudeAccount}`, mode: 'synthetic',
      eligibility: 'documented_supported', eligibilitySource: 'synthetic://migcat', maxConcurrent: 4,
    });

    // Prévia detecta atualização sem alterar o banco.
    const preview = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: false});
    assert.equal(preview.catalogAction, 'atualizar');
    assert.match(formatDesignPrepare(preview), /receberia esforço high/);
    const opusBefore = (await db.pool.query<{efforts: string[]; roles: string[]; source: string}>(
      "SELECT efforts, roles, source FROM ac_model_catalog WHERE provider='claude' AND model='claude-opus-5-5'",
    )).rows[0];
    assert.deepEqual(opusBefore, {efforts: ['medium'], roles: ['manager', 'specialist'], source: 'custom://opus-legacy'});

    // Sem admin de controle, recusa atualizar sem alterar o catálogo.
    await db.pool.query('DELETE FROM ac_control_admins WHERE principal_id=$1', [principal]);
    await assert.rejects(
      prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true}),
      (error: unknown) => error instanceof Refusal && error.code === 'CONTROL_ADMIN_REQUIRED',
    );
    const opusStillBefore = (await db.pool.query<{efforts: string[]}>(
      "SELECT efforts FROM ac_model_catalog WHERE provider='claude' AND model='claude-opus-5-5'",
    )).rows[0];
    assert.deepEqual(opusStillBefore?.efforts, ['medium']);

    // Com admin de controle, aplica a migração preservando papéis, source e grok-4.7.
    await db.pool.query('INSERT INTO ac_control_admins VALUES($1)', [principal]);
    const applied = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(applied.catalogAction, 'atualizar');
    assert.match(formatDesignPrepare(applied), /atualizado com esforço high/);

    const opusAfter = (await db.pool.query<{efforts: string[]; roles: string[]; source: string}>(
      "SELECT efforts, roles, source FROM ac_model_catalog WHERE provider='claude' AND model='claude-opus-5-5'",
    )).rows[0];
    assert.deepEqual(opusAfter, {efforts: ['medium', 'high'], roles: ['manager', 'specialist'], source: 'custom://opus-legacy'});

    const sonnetAfter = (await db.pool.query<{efforts: string[]; roles: string[]; source: string}>(
      "SELECT efforts, roles, source FROM ac_model_catalog WHERE provider='claude' AND model='claude-sonnet-5-5'",
    )).rows[0];
    assert.deepEqual(sonnetAfter, {efforts: ['medium', 'high'], roles: ['programmer', 'specialist'], source: 'custom://sonnet-legacy'});

    const grokAfter = (await db.pool.query<{efforts: string[]; roles: string[]; source: string}>(
      "SELECT efforts, roles, source FROM ac_model_catalog WHERE provider='grok' AND model='grok-4.7'",
    )).rows[0];
    assert.deepEqual(grokAfter, {efforts: ['low'], roles: ['programmer'], source: 'custom://grok'});

    const repeat = await prepareDesignSpecialist({ledger: db, owner: principal, projectId: project, apply: true});
    assert.equal(repeat.unchanged, true);
    assert.equal(repeat.catalogAction, 'presente');
  } finally {
    await db.close();
    await database.close();
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
