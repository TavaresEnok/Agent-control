import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {moduleCollectorArguments, parseModuleCollectorOutput} from '../src/verification-modules.ts';
import {join} from 'node:path';
import test from 'node:test';
// @ts-expect-error Os coletores usam JavaScript nativo.
import {collectQaBancoLocal, measureBancoPlan} from '../deploy/modules/qa/banco-local/index.mjs';
// @ts-expect-error Os coletores usam JavaScript nativo.
import {manifestPath, planBancoLocal} from '../deploy/modules/qa/banco-local/plan.mjs';
// @ts-expect-error Os coletores usam JavaScript nativo.
import {attestPostgres, bancoLocalVersion, createLocalPostgres, parseTap, setupPostgres} from '../deploy/modules/qa/banco-local/postgres.mjs';

function snapshot(name = 'controle') {
  const workspace = join(import.meta.dirname, 'fixtures', 'module-qa-banco-local', name);
  const copiedFiles = readdirSync(workspace, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(workspace.length + 1));
  return {workspace, copiedFiles, incomplete: false};
}

function syntheticDatabase(options: {fail?: string, changed?: boolean, unconfirmedScope?: string} = {}) {
  const events: string[] = [];
  const command = async (event: string) => {
    events.push(event);
    if (options.fail === event) throw new Error('diagnóstico bruto deliberadamente omitido');
  };
  return {
    events,
    start: () => command('start'),
    stop: () => command('stop'),
    dump: () => command('dump'),
    restore: () => command('restore'),
    sql(db: string, sql: string) {
      const kind = sql.startsWith('CREATE TABLE') ? 'prefix' : sql.startsWith('INSERT') ? 'seed' : 'tail';
      if (db === 'upgraded') {
        assert.equal(sql.includes('conteudo-substituido'), options.changed === true);
      }
      return command(`${db}:${kind}`);
    },
    async assert(db: string, predicate: string) {
      assert.match(predicate, db === 'fresh' ? /information_schema\.columns/ : /dado-sintetico/);
      await command(`${db}:assert`);
      if (options.unconfirmedScope === db) return 'scope-unconfirmed';
      const changed = options.changed && db === 'upgraded' && events.includes('upgraded:tail');
      return parseTap(`1..1\n${changed ? 'not ok' : 'ok'} 1 - invariante funcional\n`);
    },
  };
}

test('exige declaração sintética e a ordem completa das migrações copiadas', () => {
  const fixture = snapshot();
  const plan = planBancoLocal(fixture);
  assert.deepEqual(plan.migrations?.map(({file}: {file: string}) => file), [
    'db/migrations/001_items.sql', 'db/migrations/002_revision.sql',
  ]);
  const without = (file: string) => ({...fixture, copiedFiles: fixture.copiedFiles.filter(path => path !== file)});
  assert.match(planBancoLocal(without(manifestPath)).reason, /nenhuma fixture sintética/);
  assert.match(planBancoLocal(without('db/migrations/001_items.sql')).reason, /divergem do inventário/);
  assert.match(planBancoLocal({...fixture, incomplete: true}).reason, /snapshot parcial/);
  assert.match(planBancoLocal({...fixture, copiedFiles: [...fixture.copiedFiles, 'db/migrations/003_pending.sql']}).reason,
    /divergem do inventário/);
});

test('controle percorre banco novo, origem, restauração e atualização em ordem', async () => {
  const driver = syntheticDatabase();
  const report = await measureBancoPlan(planBancoLocal(snapshot()), driver);
  assert.deepEqual(driver.events, [
    'start', 'fresh:prefix', 'fresh:tail', 'fresh:assert', 'previous:prefix', 'previous:seed',
    'previous:assert', 'dump', 'restore', 'upgraded:assert', 'upgraded:tail', 'upgraded:assert', 'stop',
  ]);
  assert.equal(report.steps.length, driver.events.length);
  assert.ok(report.steps.every(({status}: {status: string}) => status === 'ok'));
  assert.deepEqual(report.findings, []);
});

test('defeito em dados históricos aparece somente após a migração final', async () => {
  const driver = syntheticDatabase({changed: true});
  const report = await measureBancoPlan(planBancoLocal(snapshot('defeito')), driver);
  assert.deepEqual(report.steps.filter(({status}: {status: string}) => status === 'failed'),
    [{name: 'historico-atualizado', status: 'failed', detail: 'banco/assert.sql; pgTAP reprovou 1/1'}]);
  assert.deepEqual(report.findings.map(({rule, file, line}: {rule: string, file: string, line: number}) => [rule, file, line]),
    [['QA-BANCO-PGTAP', 'banco/assert.sql', 2]]);
});

test('escopo efetivo inconclusivo omite a cobertura sem registrar reprovação pgTAP', async () => {
  const driver = syntheticDatabase({unconfirmedScope: 'previous'});
  const report = await measureBancoPlan(planBancoLocal(snapshot()), driver);
  assert.deepEqual(driver.events.slice(-2), ['previous:assert', 'stop']);
  assert.deepEqual(report.steps.filter(({status}: {status: string}) => status === 'skipped'), [
    {name: 'historico-antes-do-dump', status: 'skipped',
      detail: 'banco/assert.sql; cobertura inconclusiva por falta de confirmação do escopo dos privilégios efetivos'},
    {name: 'historico-atualizado', status: 'skipped', detail: 'pré-requisito da atualização histórica interrompido'},
  ]);
  assert.ok(report.steps.every(({status}: {status: string}) => status !== 'failed'));
  assert.deepEqual(report.findings, []);
});

test('explica entradas ausentes e mantém a prova do zero independente', async () => {
  const fixture = snapshot();
  const driver = syntheticDatabase();
  const report = await measureBancoPlan(planBancoLocal({...fixture,
    copiedFiles: fixture.copiedFiles.filter(file => !['banco/seed.sql', 'banco/pgtap-fresh.sql'].includes(file)),
  }), driver);
  assert.deepEqual(driver.events, ['start', 'fresh:prefix', 'fresh:tail', 'stop']);
  assert.deepEqual(report.steps.filter(({status}: {status: string}) => status === 'skipped').map(
    ({detail}: {detail: string}) => detail), ['banco/pgtap-fresh.sql ausente', 'entradas históricas ausentes (banco/seed.sql)']);
});

test('falha de restauração interrompe a atualização, higieniza a saída e limpa a instância', async () => {
  const driver = syntheticDatabase({fail: 'restore'});
  const report = await measureBancoPlan(planBancoLocal(snapshot()), driver);
  assert.deepEqual(driver.events.slice(-3), ['dump', 'restore', 'stop']);
  assert.equal(report.steps.find(({name}: {name: string}) => name === 'historico-restauracao')?.status, 'failed');
  assert.equal(report.steps.find(({name}: {name: string}) => name === 'historico-atualizado')?.status, 'skipped');
  assert.doesNotMatch(JSON.stringify(report), /diagnóstico bruto/);
  assert.deepEqual(report.findings, []);
});

test('sempre encerra tentativa de inicialização malsucedida', async () => {
  const driver = syntheticDatabase({fail: 'start'});
  const report = await measureBancoPlan(planBancoLocal(snapshot()), driver);
  assert.deepEqual(driver.events, ['start', 'stop']);
  assert.deepEqual(report.steps.map(({status}: {status: string}) => status), ['failed', 'skipped', 'skipped', 'ok']);
});

test('pgTAP exige plano e resultado inequívocos', () => {
  assert.equal(parseTap('1..1\nok 1 - invariante funcional\n'), 'passed');
  assert.equal(parseTap('1..1\nnot ok 1 - invariante funcional\n# diagnóstico\n'), 'failed');
  for (const output of ['', 'ok 1 - invariante funcional', '1..0 # SKIP', '1..1\nok 1 - invariante funcional # TODO',
    '1..1\nok 1 - invariante funcional\nBail out!', '1..1\nok 1 - invariante funcional\n# resultado contraditório', '1..2\nok 1 - invariante funcional']) {
    assert.equal(parseTap(output), 'invalid');
  }
});

test('o instalador fixa servidor, cliente e libpq no snapshot corrigido do Ubuntu', () => {
  const install = readFileSync(join(import.meta.dirname, '../deploy/modules/qa/banco-local/install.sh'), 'utf8');
  assert.match(install, /^snapshot=20261118T000000Z$/m);
  assert.match(install, /^pg_release=16\.15$/m);
  assert.match(install, /^pg_version=\$pg_release-0ubuntu0\.24\.04\.1$/m);
  assert.match(install, /"libpq5=\$pg_version" "postgresql-16=\$pg_version" "postgresql-client-16=\$pg_version"/);
  assert.match(install, /signed-by=\/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/);
  assert.equal(bancoLocalVersion, 'PostgreSQL 16.15 / pgTAP 1.3.2');
});

test('só encaminha ao pgTAP um booleano escalar validado na sessão de leitura', async () => {
  const predicate = planBancoLocal(snapshot()).fresh.sql;
  assert.match(predicate, /; -- Fim da assertiva do zero\.\n$/);

  for (const [scalar, expected] of [
    ['{16}\nt\n', 'passed'], ['{16}\nf\n', 'failed'],
    ['{16}\nt\nf\n', 'invalid'], ['{16,16}\nt|f\n', 'invalid'],
    ['{16}\n', 'invalid'], ['{16}\n\n', 'invalid'], ['{25}\nt\n', 'invalid'],
  ]) {
    const phases: string[] = [];
    let reader: string;
    const psql = async (db: string, commands: string[], user: string) => {
      if (db === 'fresh') {
        if (phases.length === 0) {
          phases.push('grant');
          assert.equal(user, 'qa_admin');
          reader = /CREATE ROLE (qa_reader_[a-f0-9]{24}) LOGIN NOINHERIT/.exec(commands.join('\n'))![1]!;
          assert.equal(commands.at(-1), 'COMMIT');
        } else if (user === reader) {
          phases.push('read');
          assert.deepEqual(commands.slice(0, 4), [
            'BEGIN READ ONLY', 'SET LOCAL search_path TO pg_catalog, public', '\\bind', `PREPARE qa_scalar AS\n${predicate}`,
          ]);
          assert.match(commands[4]!, /SELECT result_types::pg_catalog\.oid\[\] FROM pg_catalog\.pg_prepared_statements/);
          assert.deepEqual(commands.slice(5), ['EXECUTE qa_scalar', 'ROLLBACK']);
          return scalar;
        } else if (commands[0] === 'BEGIN READ ONLY') {
          phases.push('scope');
          assert.equal(user, 'qa_admin');
          assert.ok(commands[2]!.includes(`has_schema_privilege('${reader}'::regrole::oid, c.relnamespace, 'USAGE')`));
          assert.match(commands[2]!, /has_any_column_privilege/);
          assert.ok(commands.every(sql => !sql.includes(predicate)));
          return 't\n';
        } else {
          phases.push('revoke');
          assert.equal(user, 'qa_admin');
          assert.ok(commands.some(sql => sql.includes(`DROP OWNED BY ${reader};`) && sql.includes(`DROP ROLE ${reader};`)));
          assert.equal(commands.at(-1), 'COMMIT');
        }
        return '';
      }
      phases.push('tap');
      assert.equal(db, 'qa_attestation');
      assert.equal(user, 'qa_admin');
      assert.deepEqual(commands, [
        'BEGIN', 'SET LOCAL search_path TO pg_catalog, qa_tap, pg_temp', 'SELECT qa_tap.plan(1)',
        `SELECT qa_tap.ok(${expected === 'passed' ? 'TRUE' : 'FALSE'}, 'invariante funcional')`,
        'SELECT * FROM qa_tap.finish()', 'ROLLBACK',
      ]);
      return `1..1\n${expected === 'passed' ? 'ok' : 'not ok'} 1 - invariante funcional\n`;
    };
    assert.equal(await attestPostgres(psql, 'fresh', predicate), expected);
    const order = ['grant', 'scope', 'read', 'revoke'];
    assert.deepEqual(phases, expected === 'invalid' ? order : [...order, 'tap']);
  }

  const incompleteTap = async (db: string, commands: string[], user: string) =>
    user.startsWith('qa_reader_') ? '{16}\nt\n' : db === 'qa_attestation' ? '1..1\n' :
      commands[0] === 'BEGIN READ ONLY' ? 't\n' : '';
  assert.equal(await attestPostgres(incompleteTap, 'fresh', predicate), 'invalid');
});

test('omite preparação, execução e pgTAP quando a verificação de privilégios não confirma o escopo', async () => {
  for (const result of ['f\n', '', new Error('verificação interrompida')]) {
    const phases: string[] = [];
    const psql = async (db: string, commands: string[], user: string) => {
      assert.equal(db, 'fresh');
      assert.equal(user, 'qa_admin');
      if (commands[0] === 'BEGIN READ ONLY') {
        phases.push('scope');
        if (result instanceof Error) throw result;
        return result;
      }
      phases.push(commands.some(sql => sql.includes('DROP ROLE')) ? 'revoke' : 'grant');
      return '';
    };
    assert.equal(await attestPostgres(psql, 'fresh', 'SELECT TRUE'), 'scope-unconfirmed');
    assert.deepEqual(phases, ['grant', 'scope', 'revoke']);
  }
});

test('revoga o escopo de leitura quando a execução da assertiva falha', async () => {
  const phases: string[] = [];
  await assert.rejects(attestPostgres(async (db: string, commands: string[], user: string) => {
    assert.equal(db, 'fresh');
    if (user.startsWith('qa_reader_')) {
      phases.push('read');
      throw new Error('leitura interrompida');
    }
    if (commands[0] === 'BEGIN READ ONLY') {
      phases.push('scope');
      return 't\n';
    }
    phases.push(commands.some(sql => sql.includes('DROP ROLE')) ? 'revoke' : 'grant');
    return '';
  }, 'fresh', 'SELECT TRUE'), /leitura interrompida/);
  assert.deepEqual(phases, ['grant', 'scope', 'read', 'revoke']);
});

const testPgBin = process.env.QA_BANCO_TEST_PG_BIN;

test('PostgreSQL e pgTAP avaliam dados sintéticos com escopo de ACL, herança e partições', {
  skip: !testPgBin,
  timeout: 30_000,
}, async () => {
  const directory = mkdtempSync('/tmp/qa-banco-r2-');
  const data = join(directory, 'data');
  const run = (binary: string, args: string[]) => execFileSync(join(testPgBin!, binary), args, {
    cwd: directory, encoding: 'utf8', timeout: 12_000, env: {
      PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8', TZ: 'UTC',
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? '',
    },
  });
  const psql = async (db: string, commands: string[], user: string) => run('psql', [
    '-XAtqw', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-p', '5432', '-U', user, '-d', db,
    ...commands.flatMap(sql => ['-c', sql]),
  ]);
  try {
    run('initdb', ['-D', data, '-U', 'qa_admin', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject']);
    run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', '-t', '8', '-o',
      `-h '' -k ${directory} -c unix_socket_permissions=0700 -c statement_timeout=5000`, 'start']);
    assert.equal(await psql('postgres', ['SHOW server_version_num'], 'qa_admin'), '160015\n');
    await setupPostgres(psql);
    assert.equal(await psql('postgres', [
      "SELECT has_database_privilege('qa_project', 'qa_attestation', 'CONNECT')",
    ], 'qa_admin'), 'f\n');
    assert.equal(await psql('fresh', ["\\bind 'dado-sintetico'", "SELECT $1::text = 'dado-sintetico'"], 'qa_project'), 't\n');

    const plan = planBancoLocal(snapshot());
    for (const {sql} of plan.migrations) {
      await psql('fresh', [`SET client_min_messages = warning;\n${sql}`], 'qa_project');
    }
    await psql('fresh', [
      'CREATE SCHEMA "fixture QA"',
      'CREATE VIEW "fixture QA"."Items revisados" AS SELECT revision FROM public.items',
      'CREATE MATERIALIZED VIEW "fixture QA".resumo AS SELECT count(*) AS total FROM public.items',
      'CREATE SEQUENCE "fixture QA".sequencia',
    ], 'qa_project');
    await psql('fresh', [
      'CREATE SCHEMA qa_interno',
      'CREATE TABLE public.tabela_admin (id integer)',
      'CREATE TABLE qa_interno.tabela_projeto (id integer)',
      'ALTER TABLE qa_interno.tabela_projeto OWNER TO qa_project',
    ], 'qa_admin');
    const acl = () => psql('fresh', [
      `SELECT nspname, CASE WHEN nspowner = 'qa_project'::regrole THEN coalesce(nspacl, acldefault('n', nspowner)) ELSE nspacl END
       FROM pg_catalog.pg_namespace ORDER BY 1`,
      `SELECT n.nspname, c.relname,
         CASE WHEN (n.nspname = 'public' OR n.nspowner = 'qa_project'::regrole)
           AND c.relowner = 'qa_project'::regrole AND c.relkind IN ('r', 'p', 'v', 'm')
           THEN coalesce(c.relacl, acldefault('r', c.relowner)) ELSE c.relacl END
       FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ORDER BY 1, 2`,
      `SELECT attrelid::regclass, attnum, attacl FROM pg_catalog.pg_attribute
       WHERE attacl IS NOT NULL ORDER BY 1, 2`,
      'SELECT datname, datacl FROM pg_catalog.pg_database ORDER BY 1',
      "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'qa\\_reader\\_%' ORDER BY 1",
    ], 'qa_admin');
    const originalAcl = await acl();
    const psqlWithPrivilegeCheck = async (db: string, commands: string[], user: string) => {
      if (!user.startsWith('qa_reader_')) return psql(db, commands, user);
      assert.match(user, /^qa_reader_[a-f0-9]{24}$/);
      assert.equal(await psql(db, [
        `SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolinherit, rolbypassrls
         FROM pg_catalog.pg_roles WHERE rolname = '${user}'`,
        `SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member = '${user}'::regrole`,
        `SELECT datname, has_database_privilege('${user}', oid, 'CONNECT'), has_database_privilege('${user}', oid, 'TEMP')
         FROM pg_catalog.pg_database ORDER BY 1`,
        `SELECT nspname, a.privilege_type, a.is_grantable
         FROM pg_catalog.pg_namespace CROSS JOIN LATERAL pg_catalog.aclexplode(nspacl) a
         WHERE a.grantee = '${user}'::regrole ORDER BY 1`,
        `SELECT n.nspname, c.relname, a.privilege_type, a.is_grantable FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
         WHERE a.grantee = '${user}'::regrole ORDER BY 1, 2`,
      ], 'qa_admin'), 't|f|f|f|f|f\n0\nfresh|t|f\npostgres|f|f\nprevious|f|f\nqa_attestation|f|f\n' +
        'template0|f|f\ntemplate1|f|f\nupgraded|f|f\n' +
        'fixture QA|USAGE|f\npublic|USAGE|f\nfixture QA|Items revisados|SELECT|f\nfixture QA|resumo|SELECT|f\npublic|items|SELECT|f\n');
      assert.equal(await psql(db, [
        `SELECT session_user = current_user, has_schema_privilege('qa_interno', 'USAGE'),
         has_table_privilege('public.tabela_admin', 'SELECT'), has_table_privilege('public.items', 'INSERT'),
         has_sequence_privilege('"fixture QA".sequencia', 'SELECT')`,
      ], user), 't|f|f|f|f\n');
      return psql(db, commands, user);
    };
    for (const [predicate, expected] of [
      [plan.fresh.sql, 'passed'],
      ['SELECT TRUE', 'passed'],
      ['SELECT TRUE; /* Fim da assertiva. */', 'passed'],
      ["SELECT 'item; sintético' = 'item; sintético';", 'passed'],
      ['SELECT EXISTS (SELECT 1 FROM public.items);', 'failed'],
      [`SELECT total = 0 AND NOT EXISTS (SELECT 1 FROM "fixture QA"."Items revisados")
       AND current_setting('transaction_read_only') = 'on' FROM "fixture QA".resumo;`, 'passed'],
      ['SELECT value FROM (VALUES (TRUE), (FALSE)) AS fixture(value);', 'invalid'],
      ['SELECT TRUE, FALSE;', 'invalid'],
      ['SELECT TRUE WHERE FALSE;', 'invalid'],
      ['SELECT NULL::boolean;', 'invalid'],
      ["SELECT 't'::text;", 'invalid'],
    ]) {
      assert.equal(await attestPostgres(psqlWithPrivilegeCheck, 'fresh', predicate), expected);
      assert.equal(await acl(), originalAcl);
    }

    async function checkReaderScope(
      relation: string, privileges: string, expected: 'passed' | 'scope-unconfirmed', predicate = 'SELECT TRUE',
    ) {
      const before = await acl();
      const calls: string[] = [];
      let observed: {metadata: string, scope: string} | undefined;
      const checkedPsql = async (db: string, commands: string[], user: string) => {
        if (db === 'qa_attestation') calls.push('tap');
        else if (user.startsWith('qa_reader_')) calls.push('read');
        else if (commands[0] === 'BEGIN READ ONLY') {
          calls.push('scope');
          const reader = /'(qa_reader_[a-f0-9]{24})'::regrole/.exec(commands.join('\n'))![1]!;
          const metadata = await psql(db, [
            `SELECT has_schema_privilege('${reader}', relnamespace, 'USAGE'),
               has_table_privilege('${reader}', oid, 'SELECT'),
               has_column_privilege('${reader}', oid, 'id', 'SELECT')
             FROM pg_catalog.pg_class WHERE oid = '${relation}'::regclass`,
            `SELECT has_database_privilege('${reader}', 'qa_attestation', 'CONNECT')`,
          ], 'qa_admin');
          const scope = await psql(db, commands, user);
          observed = {metadata, scope};
          return scope;
        }
        return psql(db, commands, user);
      };
      assert.equal(await attestPostgres(checkedPsql, 'fresh', predicate), expected);
      assert.deepEqual(observed, {metadata: `${privileges}\nf\n`, scope: expected === 'passed' ? 't\n' : 'f\n'});
      assert.deepEqual(calls, expected === 'passed' ? ['scope', 'read', 'tap'] : ['scope']);
      assert.equal(await acl(), before);
    }

    await psql('fresh', ['GRANT SELECT ON TABLE public.tabela_admin TO PUBLIC'], 'qa_admin');
    await checkReaderScope('public.tabela_admin', 't|t|t', 'scope-unconfirmed');
    await psql('fresh', ['REVOKE SELECT ON TABLE public.tabela_admin FROM PUBLIC'], 'qa_admin');

    await psql('fresh', ['GRANT SELECT (id) ON TABLE qa_interno.tabela_projeto TO PUBLIC'], 'qa_admin');
    await checkReaderScope('qa_interno.tabela_projeto', 'f|f|t', 'passed');
    await psql('fresh', ['GRANT USAGE ON SCHEMA qa_interno TO PUBLIC'], 'qa_admin');
    await checkReaderScope('qa_interno.tabela_projeto', 't|f|t', 'scope-unconfirmed');
    await psql('fresh', [
      'REVOKE SELECT (id) ON TABLE qa_interno.tabela_projeto FROM PUBLIC',
      'REVOKE USAGE ON SCHEMA qa_interno FROM PUBLIC',
    ], 'qa_admin');

    await psql('fresh', [
      'CREATE TABLE public.itens_herdados (id integer)',
      'CREATE TABLE "fixture QA".itens_filho () INHERITS (public.itens_herdados)',
      'INSERT INTO public.itens_herdados VALUES (1)',
      'INSERT INTO "fixture QA".itens_filho VALUES (2)',
      'CREATE TABLE public.itens_particionados (id integer) PARTITION BY RANGE (id)',
      'CREATE TABLE "fixture QA".itens_particao PARTITION OF public.itens_particionados FOR VALUES FROM (1) TO (10)',
      'INSERT INTO public.itens_particionados VALUES (1), (2)',
    ], 'qa_project');

    const inheritedCount = 'SELECT count(*) = 2 FROM public.itens_herdados';
    const partitionedCount = 'SELECT count(*) = 2 FROM public.itens_particionados';
    // O mesmo predicado passa quando toda a hierarquia pertence à fixture.
    await checkReaderScope('"fixture QA".itens_filho', 't|t|t', 'passed', inheritedCount);
    await checkReaderScope('"fixture QA".itens_particao', 't|t|t', 'passed', partitionedCount);

    await psql('fresh', [
      'CREATE TABLE qa_interno.itens_neto () INHERITS ("fixture QA".itens_filho)',
      'INSERT INTO qa_interno.itens_neto VALUES (3)',
    ], 'qa_admin');
    await checkReaderScope('qa_interno.itens_neto', 'f|f|f', 'scope-unconfirmed', inheritedCount);
    await psql('fresh', ['ALTER TABLE qa_interno.itens_neto NO INHERIT "fixture QA".itens_filho'], 'qa_admin');
    await checkReaderScope('qa_interno.itens_neto', 'f|f|f', 'passed', inheritedCount);

    await psql('fresh', [
      'CREATE TABLE qa_interno.itens_particao PARTITION OF public.itens_particionados FOR VALUES FROM (10) TO (20)',
      'INSERT INTO qa_interno.itens_particao VALUES (10)',
    ], 'qa_admin');
    await checkReaderScope('qa_interno.itens_particao', 'f|f|f', 'scope-unconfirmed', partitionedCount);
    await psql('fresh', ['ALTER TABLE public.itens_particionados DETACH PARTITION qa_interno.itens_particao'], 'qa_admin');
    await checkReaderScope('qa_interno.itens_particao', 'f|f|f', 'passed', partitionedCount);

    const finalFreshAcl = await acl();

    const dump = join(directory, 'previous.dump');
    const projectConnection = ['--host', directory, '--port', '5432', '--username', 'qa_project', '--no-password'];
    await psql('previous', [plan.migrations[0].sql, plan.history.seed], 'qa_project');
    assert.equal(await attestPostgres(psql, 'previous', plan.history.invariant.sql), 'passed');
    run('pg_dump', [...projectConnection, '--format=custom', '--no-owner', '--no-privileges', '--file', dump, 'previous']);
    run('pg_restore', [...projectConnection, '--dbname', 'upgraded', '--no-owner', '--no-privileges',
      '--exit-on-error', '--single-transaction', dump]);
    assert.equal(await attestPostgres(psql, 'upgraded', plan.history.invariant.sql), 'passed');
    await psql('upgraded', [plan.migrations[1].sql], 'qa_project');
    assert.equal(await attestPostgres(psql, 'upgraded', plan.history.invariant.sql), 'passed');
    assert.equal(await acl(), finalFreshAcl);
  } finally {
    try {
      if (existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '8', 'stop']);
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  }
});

test('coletor e driver recusam execução fora do isolamento QA', async () => {
  assert.throws(() => createLocalPostgres('/repo'), /QA isolation required/);
  const result = await collectQaBancoLocal({...snapshot(), repoDir: '/repo',
    row: (tool: string, version: string, status: string, detail: string) => ({tool, version, status, detail}),
  });
  assert.equal(result.coverageRow.status, 'skipped');
  assert.match(result.coverageRow.detail, /contêiner QA offline/);
  assert.deepEqual(result.extraRows, []);
  assert.deepEqual(result.findings, []);
});

test('o entrypoint de QA mede a restauração e atribui a regressão ao arquivo de invariante', {
  skip: process.env.AC_MODULE_LAB !== '1',
  timeout: 180_000,
}, () => {
  const image = readFileSync(join(import.meta.dirname, '../deploy/modules/qa/digest.txt'), 'utf8').trim();
  for (const variant of ['controle', 'defeito']) {
    const [runtime, ...args] = moduleCollectorArguments({image, repository: snapshot(variant).workspace});
    const stdout = execFileSync(runtime!, args, {encoding: 'utf8', timeout: 80_000, maxBuffer: 16 * 1024 * 1024});
    const report = parseModuleCollectorOutput(stdout, {module: 'qa'});
    const status = (phase: string) => report.coverage.find(row => row.tool === 'qa-banco-local:' + phase)?.status;
    for (const phase of ['do-zero-assertiva', 'historico-antes-do-dump', 'historico-dump',
      'historico-restauracao', 'historico-restaurado', 'atualizacao-migracao-1', 'limpeza']) {
      assert.equal(status(phase), 'ok', variant + ' ' + phase);
    }
    assert.equal(status('historico-atualizado'), variant === 'controle' ? 'ok' : 'failed');
    const findings = report.findings.filter(finding => finding.tool === 'qa-banco-local');
    assert.deepEqual(findings.map(finding => [finding.rule, finding.file, finding.line]),
      variant === 'controle' ? [] : [['QA-BANCO-PGTAP', 'banco/assert.sql', 2]]);
  }
});
