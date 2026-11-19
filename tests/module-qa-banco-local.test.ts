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

function syntheticDatabase(options: {fail?: string, changed?: boolean} = {}) {
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
    ['t\nt\n', 'passed'], ['t\nf\n', 'failed'], ['t\nt\nf\n', 'invalid'], ['f\nt|f\n', 'invalid'],
    ['t\n', 'invalid'], ['t\n\n', 'invalid'], ['f\nt\n', 'invalid'],
  ]) {
    const roles: string[] = [];
    const psql = async (db: string, commands: string[], user: string) => {
      roles.push(user);
      if (user === 'qa_reader') {
        assert.equal(db, 'fresh');
        assert.equal(commands[0], 'BEGIN READ ONLY');
        assert.equal(commands[1], 'SET LOCAL ROLE pg_read_all_data');
        assert.ok(commands.includes(`PREPARE qa_scalar AS\n${predicate}`));
        assert.equal(commands.at(-1), 'ROLLBACK');
        return scalar;
      }
      assert.equal(db, 'qa_attestation');
      assert.deepEqual(commands, [
        'BEGIN', 'SET LOCAL search_path TO pg_catalog, qa_tap, pg_temp', 'SELECT qa_tap.plan(1)',
        `SELECT qa_tap.ok(${expected === 'passed' ? 'TRUE' : 'FALSE'}, 'invariante funcional')`,
        'SELECT * FROM qa_tap.finish()', 'ROLLBACK',
      ]);
      return `1..1\n${expected === 'passed' ? 'ok' : 'not ok'} 1 - invariante funcional\n`;
    };
    assert.equal(await attestPostgres(psql, 'fresh', predicate), expected);
    assert.deepEqual(roles, expected === 'invalid' ? ['qa_reader'] : ['qa_reader', 'qa_admin']);
  }

  const incompleteTap = async (_db: string, _commands: string[], user: string) =>
    user === 'qa_reader' ? 't\nt\n' : '1..1\n';
  assert.equal(await attestPostgres(incompleteTap, 'fresh', predicate), 'invalid');
});

const testPgBin = process.env.QA_BANCO_TEST_PG_BIN;

test('PostgreSQL e pgTAP medem dados sintéticos e preservam os privilégios da sessão e do catálogo', {
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
      "SELECT has_database_privilege('qa_project', 'qa_attestation', 'CONNECT'), " +
      "has_database_privilege('qa_reader', 'qa_attestation', 'CONNECT')",
    ], 'qa_admin'), 'f|f\n');

    const plan = planBancoLocal(snapshot());
    for (const {sql} of plan.migrations) {
      await psql('fresh', [`SET client_min_messages = warning;\n${sql}`], 'qa_project');
    }
    const acl = () => psql('fresh', [
      "SELECT nspname, nspacl FROM pg_catalog.pg_namespace WHERE nspname IN ('pg_catalog', 'information_schema', 'public') ORDER BY nspname",
      "SELECT n.nspname, c.relname, c.relacl FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE n.nspname IN ('pg_catalog', 'information_schema', 'public') ORDER BY 1, 2",
    ], 'qa_admin');
    const originalAcl = await acl();
    const readerPrivileges = "SELECT current_user, has_table_privilege('public.items', 'SELECT'), has_table_privilege('public.items', 'INSERT')";
    const baseline = 'qa_reader|f|f\n';
    assert.equal(await psql('fresh', [readerPrivileges], 'qa_reader'), baseline);

    const psqlWithPrivilegeCheck = async (db: string, commands: string[], user: string) => {
      if (user !== 'qa_reader') return psql(db, commands, user);
      const output = await psql(db, [...commands, readerPrivileges], user);
      assert.ok(output.endsWith(baseline));
      return output.slice(0, -baseline.length);
    };
    for (const [predicate, expected] of [
      [plan.fresh.sql, 'passed'],
      ['SELECT TRUE', 'passed'],
      ['SELECT TRUE; /* Fim da assertiva. */', 'passed'],
      ['SELECT EXISTS (SELECT 1 FROM public.items);', 'failed'],
      ['SELECT value FROM (VALUES (TRUE), (FALSE)) AS fixture(value);', 'invalid'],
      ['SELECT TRUE, FALSE;', 'invalid'],
      ['SELECT TRUE WHERE FALSE;', 'invalid'],
      ['SELECT NULL::boolean;', 'invalid'],
      ["SELECT 't'::text;", 'invalid'],
    ]) {
      assert.equal(await attestPostgres(psqlWithPrivilegeCheck, 'fresh', predicate), expected);
    }
    assert.equal(await acl(), originalAcl);
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
