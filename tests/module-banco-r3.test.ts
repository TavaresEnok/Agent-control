import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const collector = join(root, 'deploy/modules/banco/collector.rb');
const fixtures = join(root, 'tests/fixtures/module-banco');
type Row = {tool: string; status: string; detail: string; files?: string[]};
type Finding = {rule: string; file: string; line: number; evidence: string};
type Report = {coverage: Row[]; findings: Finding[]};

function runIsolated<T>(rubyArgs: string[], repo?: string): T {
  const image = process.env.AC_BANCO_IMAGE!;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const output = execFileSync('docker', [
    'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '65532:65532',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
    '--workdir', '/tmp', '--mount', `type=bind,src=${collector},dst=/collector.rb,readonly`,
    ...(repo ? ['--mount', `type=bind,src=${repo},dst=/repo,readonly`] : []),
    '--entrypoint', '/usr/bin/ruby', image, '--disable=rubyopt', ...rubyArgs,
  ], {encoding: 'utf8', timeout: 80_000, maxBuffer: 1024 * 1024});
  return JSON.parse(output);
}

test('inventário conserva consultas válidas ao lado de entradas inválidas', () => {
  const dir = mkdtempSync(join(root, '.c5-r3-'));
  try {
    mkdirSync(join(dir, 'banco/queries'), {recursive: true});
    writeFileSync(join(dir, 'banco/queries/valida.sql'), 'SELECT 1');
    writeFileSync(join(dir, 'banco/queries/vazia.sql'), '');
    writeFileSync(join(dir, 'banco/queries/nome invalido.sql'), 'SELECT 1');
    symlinkSync('valida.sql', join(dir, 'banco/queries/link.sql'));
    for (let index = 0; index < 39; index++) {
      writeFileSync(join(dir, 'banco/queries', `consulta-${index}.sql`), 'SELECT 1');
    }
    writeFileSync(join(dir, 'banco/queries/zz-excedente.sql'), 'SELECT 1');
    for (let index = 0; index < 40; index++) {
      writeFileSync(join(dir, 'banco/queries', `zzz inválida-${index}.sql`), 'SELECT 1');
    }
    writeFileSync(join(dir, 'banco/queries/zzzz-excedente.sql'), 'SELECT 1');
    const output = execFileSync('ruby', ['--disable=rubyopt', '-r', collector, '-e', `
      entries = Banco::Inventory.new(ARGV.fetch(0)).queries
      puts JSON.generate(entries.map { |entry| entry.is_a?(Array) ? entry : [entry.path, 'ok'] })
    `, dir], {encoding: 'utf8'});
    const entries: string[][] = JSON.parse(output);
    assert.equal(entries.filter(([, result]) => result === 'ok').length, 40);
    assert.ok(entries.some(([path, result]) => path.endsWith('/valida.sql') && result === 'ok'));
    for (const name of ['vazia.sql', 'nome invalido.sql', 'link.sql']) {
      assert.ok(entries.some(([path, result]) => path.includes(name) && result !== 'ok'), name);
    }
    assert.ok(entries.some(([path, result]) => path.includes('zz-excedente.sql') && /limite de 40/.test(result)));
    assert.ok(entries.some(([path, result]) => path === 'banco/queries' && /4 entradas inválidas adicionais/.test(result)));
    assert.ok(entries.some(([path, result]) => path === 'banco/queries' && /excedentes adicionais.*\(1\)/.test(result)));
    const report: Report = JSON.parse(execFileSync('ruby', ['--disable=rubyopt', '-r', collector, '-e',
      'puts Banco.collect(ARGV.fetch(0)).to_json', dir], {encoding: 'utf8'}));
    for (const tool of ['pg_stat_statements', 'EXPLAIN', 'dexter']) {
      assert.ok(report.coverage.some(row => row.tool === tool && row.status === 'skipped' && row.detail.includes('valida.sql')));
      assert.ok(report.coverage.some(row => row.tool === tool && row.detail.includes('vazia.sql')));
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('PostgreSQL isolado preserva atribuição e medições após falhas sintéticas', {
  skip: !process.env.AC_BANCO_IMAGE && 'AC_BANCO_IMAGE aponta para imagem já disponível', timeout: 90_000,
}, () => {
  const script = `
    require 'dexter'
    require '/collector.rb'
    def source(path, sql); Banco::Source.new(path, sql); end
    reports = {}
    Dir.mktmpdir('c5-r3-', '/tmp') do |dir|
      initial = Banco::Report.new
      db = Banco::Database.new(dir, initial)
      begin
        db.start
        db.connect('fresh') do |connection|
          role = connection.exec("SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user").values
          raise "unexpected database role" unless role == [['projeto', 'f', 'f', 'f', 'f', 'f']]
          raise "unexpected statement timeout" unless connection.exec("SHOW statement_timeout").getvalue(0, 0) == '5s'
        end
        ddl = 'CREATE TABLE parent(id integer PRIMARY KEY); CREATE TABLE child(id integer REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);'
        prefix = [source('db/migrations/001_schema.sql', ddl), source('db/migrations/002_data.sql', 'INSERT INTO child VALUES (424242);')]
        raise "unexpected commit" if db.migrate('fresh', prefix + [
          source('db/migrations/003_check.sql', "/* ação */\\nSET CONSTRAINTS ALL IMMEDIATE;"),
          source('db/migrations/004_next.sql', 'SELECT 1;')
        ])
        db.connect('fresh') do |connection|
          raise "unconfirmed batch persisted data" unless connection.exec("SELECT to_regclass('public.parent') IS NULL").getvalue(0, 0) == 't'
        end
        reports[:early] = JSON.parse(initial.to_json)
        mixed = Banco::Report.new
        db.instance_variable_set(:@report, mixed)
        db.migrate('fresh', prefix + [source('db/migrations/003_mix.sql', "SELECT 1;\\nSET CONSTRAINTS ALL IMMEDIATE;")])
        reports[:mixed] = JSON.parse(mixed.to_json)
        nested = Banco::Report.new
        db.instance_variable_set(:@report, nested)
        db.migrate('fresh', prefix + [source('db/migrations/003_nested.sql', "DO $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; END $$;")])
        reports[:nested] = JSON.parse(nested.to_json)
        positioned = Banco::Report.new
        db.instance_variable_set(:@report, positioned)
        db.migrate('fresh', prefix + [source('db/migrations/003_direct.sql', "-- ação\\nSELECT missing;\\nSET CONSTRAINTS ALL IMMEDIATE;")])
        reports[:positioned] = JSON.parse(positioned.to_json)
        single = Banco::Report.new
        db.instance_variable_set(:@report, single)
        db.migrate('previous', [source('db/migrations/001_single.sql', ddl + ' INSERT INTO child VALUES (42);')])
        reports[:single] = JSON.parse(single.to_json)
        timeout = Banco::Report.new
        db.instance_variable_set(:@report, timeout)
        db.migrate('upgraded', [source('db/migrations/001_slow.sql', 'SELECT pg_sleep(6);'), source('db/migrations/002_next.sql', 'SELECT 1;')])
        reports[:timeout] = JSON.parse(timeout.to_json)
        rejected = Banco::Report.new
        db.instance_variable_set(:@report, rejected)
        db.migrate('upgraded', [source('db/migrations/001_ok.sql', 'CREATE TABLE t(id integer);'), source('db/migrations/002_bad.sql', "SELECT 1;\\nSELECT missing FROM t;"), source('db/migrations/003_next.sql', 'SELECT 1;')])
        reports[:rejected] = JSON.parse(rejected.to_json)
        app = Banco::Report.new
        db.instance_variable_set(:@report, app)
        db.migrate('fresh', [source('db/migrations/001_raise.sql', "DO $$ BEGIN RAISE EXCEPTION 'synthetic-private'; END $$;")])
        db.exercise_restore([
          source('db/migrations/001_function.sql', "CREATE FUNCTION app_check() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private'; END $$;"),
          source('db/migrations/002_new.sql', 'CREATE TABLE extra(id integer);')
        ], nil, source('banco/assert.sql', 'SELECT app_check();'))
        reports[:app] = JSON.parse(app.to_json)
        syntax = Banco::Report.new
        db.instance_variable_set(:@report, syntax)
        db.migrate('fresh', [source('db/migrations/001_syntax.sql', "-- ação\\n@")])
        reports[:syntax] = JSON.parse(syntax.to_json)
        workload = Banco::Report.new
        db.instance_variable_set(:@report, workload)
        db.migrate('fresh', [source('db/migrations/001_final.sql', 'CREATE TABLE items(new_name integer); INSERT INTO items VALUES (1);')])
        db.prepare_workload(source('banco/seed.sql', 'INSERT INTO items(old_name) VALUES (2);'))
        db.workload(source('banco/queries/valida.sql', 'SELECT new_name FROM items;'))
        db.workload(source('banco/queries/invalid.sql', "-- ação\\n@"))
        db.workload(source('banco/queries/missing.sql', "SELECT 'ação'\\nFROM missing_table;"))
        db.workload(source('banco/queries/out.sql', 'DELETE FROM items;'))
        reports[:workload] = JSON.parse(workload.to_json)
      ensure
        db.stop
      end
    end
    puts JSON.generate(reports)
  `;
  const result = runIsolated<Record<string, Report>>(['-e', script]);
  const {early, mixed, nested, positioned, single, timeout, rejected, app, syntax, workload} = result;
  assert.deepEqual(early.findings, []);
  assert.ok(early.coverage.some(row => row.status === 'ok' && /003_check.sql.*lote rejeitado.*SQLSTATE 23503.*SET CONSTRAINTS IMMEDIATE na linha 2.*indeterminada/.test(row.detail)));
  for (const name of ['001_schema.sql', '002_data.sql', '004_next.sql']) {
    assert.ok(early.coverage.some(row => row.status === 'skipped' && row.detail.includes(name)));
  }
  assert.deepEqual(mixed.findings, []);
  assert.ok(mixed.coverage.some(row => row.status === 'ok' && /003_mix.sql.*detecção durante a execução.*pode ter antecipado.*indeterminada/.test(row.detail)));
  assert.deepEqual(nested.findings, []);
  assert.ok(nested.coverage.some(row => row.status === 'ok' && /003_nested.sql.*SET CONSTRAINTS chamado pelo arquivo.*indeterminada/.test(row.detail)));
  assert.ok(positioned.findings.some(f => f.file.endsWith('003_direct.sql') && f.line === 2 && /SQLSTATE 42703/.test(f.evidence)));
  assert.ok(single.findings.some(f => f.file.endsWith('001_single.sql') && /SQLSTATE 23503.*linha exata não informada/.test(f.evidence)));
  assert.ok(single.coverage.some(row => row.status === 'ok' && /lote rejeitado no commit.*SQLSTATE 23503/.test(row.detail)));
  assert.ok(timeout.coverage.some(row => row.status === 'failed' && /001_slow.sql.*SQLSTATE 57014/.test(row.detail)));
  assert.ok(timeout.coverage.some(row => row.status === 'skipped' && row.detail.includes('002_next.sql')));
  assert.equal(timeout.findings.length, 0);
  assert.ok(rejected.findings.some(f => f.file.endsWith('002_bad.sql') && f.line === 2 && /SQLSTATE 42703/.test(f.evidence)));
  assert.ok(rejected.coverage.some(row => row.status === 'skipped' && /001_ok.sql.*não confirmada/.test(row.detail)));
  assert.ok(rejected.coverage.some(row => row.status === 'skipped' && row.detail.includes('003_next.sql')));
  assert.ok(app.findings.some(f => f.rule === 'BANCO-MIGRACAO-REJEITADA' && /SQLSTATE P0001/.test(f.evidence)));
  assert.ok(app.findings.some(f => f.rule === 'BANCO-INVARIANTE-HISTORICO' && /SQLSTATE P0001/.test(f.evidence)));
  assert.ok(app.coverage.every(row => row.status !== 'failed'));
  assert.ok(syntax.findings.some(f => f.file.endsWith('001_syntax.sql') && f.line === 2 && /PgQuery::ParseError/.test(f.evidence)));
  assert.ok(workload.coverage.some(row => row.status === 'failed' && /banco\/seed.sql.*SQLSTATE 42703/.test(row.detail)));
  for (const tool of ['pg_stat_statements', 'EXPLAIN', 'dexter']) {
    assert.ok(workload.coverage.some(row => row.tool === tool && row.detail.includes('valida.sql')));
    for (const name of ['invalid.sql', 'missing.sql', 'out.sql']) {
      assert.ok(workload.coverage.some(row => row.tool === tool && row.detail.includes(name)), `${tool}: ${name}`);
    }
  }
  assert.ok(workload.coverage.some(row => row.tool === 'pg_stat_statements' && row.status === 'ok' && row.detail.includes('valida.sql')));
  assert.ok(workload.coverage.some(row => row.tool === 'EXPLAIN' && /missing.sql.*SQLSTATE 42P01; linha 2/.test(row.detail)));
  assert.ok(workload.coverage.some(row => row.tool === 'EXPLAIN' && /invalid.sql.*linha 2/.test(row.detail)));
  assert.doesNotMatch(JSON.stringify(result), /INSERT INTO|synthetic-private|424242|inline_code_block/);
});

test('coleta integrada separa seed histórico da carga final e mantém consultas individuais', {
  skip: !process.env.AC_BANCO_IMAGE && 'AC_BANCO_IMAGE aponta para imagem já disponível', timeout: 90_000,
}, () => {
  const dir = mkdtempSync(join(root, '.c5-r3-collect-'));
  try {
    chmodSync(dir, 0o755);
    const variants = ['legacy', 'explicit', 'empty', 'unreadable', 'syntax'];
    for (const variant of variants) {
      const base = join(dir, variant);
      mkdirSync(join(base, 'db/migrations'), {recursive: true});
      mkdirSync(join(base, 'banco/queries'), {recursive: true});
      writeFileSync(join(base, 'db/migrations/001_create.sql'), 'CREATE TABLE items(old_name integer);');
      writeFileSync(join(base, 'db/migrations/002_rename.sql'), 'ALTER TABLE items RENAME COLUMN old_name TO new_name;');
      writeFileSync(join(base, 'banco/seed.sql'), variant === 'legacy'
        ? 'INSERT INTO items(old_name) VALUES (1);' : 'INSERT INTO items VALUES (1);');
      writeFileSync(join(base, 'banco/assert.sql'), 'SELECT count(*) = 1 FROM items;');
      const workload = join(base, 'banco/workload.sql');
      if (variant !== 'legacy') {
        const sql = variant === 'empty' ? '' : variant === 'syntax' ? '-- ação\n@' : 'INSERT INTO items(new_name) VALUES (1);';
        writeFileSync(workload, sql, {mode: variant === 'unreadable' ? 0o000 : 0o644});
      }
      writeFileSync(join(base, 'banco/queries/good.sql'), 'SELECT new_name FROM items;');
      writeFileSync(join(base, 'banco/queries/empty.sql'), '');
      writeFileSync(join(base, 'banco/queries/bad.sql'), '-- ação\n@');
      writeFileSync(join(base, 'banco/queries/out.sql'), 'DELETE FROM items;');
      if (variant === 'explicit') {
        writeFileSync(join(base, 'banco/queries/00 nome.sql'), 'SELECT 1;');
        for (let index = 1; index < 40; index++) {
          writeFileSync(join(base, 'banco/queries', `q${index}.sql`), 'SELECT new_name FROM items;');
        }
        writeFileSync(join(base, 'banco/queries/zz-excedente.sql'), 'SELECT new_name FROM items;');
      }
    }
    const script = `require '/collector.rb'; puts JSON.generate(ARGV.to_h { |name| [name, JSON.parse(Banco.collect('/repo/' + name).to_json)] })`;
    const reports = runIsolated<Record<string, Report>>(['-e', script, ...variants], dir);
    for (const report of Object.values(reports)) {
      assert.ok(report.coverage.some(row => row.tool === 'pg_restore' && row.status === 'ok' && /após atualização, invariante preservado/.test(row.detail)));
      for (const tool of ['pg_stat_statements', 'EXPLAIN', 'dexter']) {
        for (const file of ['good.sql', 'empty.sql', 'bad.sql', 'out.sql']) {
          assert.ok(report.coverage.some(row => row.tool === tool && row.detail.includes(file)), `${tool}: ${file}`);
        }
      }
      assert.ok(report.coverage.some(row => row.tool === 'pg_stat_statements' && row.status === 'ok' && row.detail.includes('good.sql')));
    }
    assert.ok(reports.legacy.coverage.some(row => row.status === 'failed' && /seed.sql.*SQLSTATE 42703/.test(row.detail)));
    assert.ok(reports.explicit.coverage.some(row => row.status === 'ok' && /workload.sql confirmada/.test(row.detail)));
    for (const variant of ['explicit', 'empty', 'unreadable', 'syntax']) {
      assert.ok(!reports[variant].coverage.some(row => /Carga banco\/seed.sql/.test(row.detail)), variant);
      const plan = reports[variant].coverage.find(row => row.tool === 'EXPLAIN' && row.files?.includes('banco/queries/good.sql'));
      assert.match(plan?.detail ?? '', new RegExp(`linhas reais=${variant === 'explicit' ? 1 : 0};`), variant);
    }
    assert.ok(reports.empty.coverage.some(row => row.status === 'failed' && /arquivo vazio.*workload.sql/.test(row.detail)));
    assert.ok(reports.unreadable.coverage.some(row => row.status === 'failed' && /Inventário da carga final.*Errno::EACCES/.test(row.detail)));
    assert.ok(reports.syntax.coverage.some(row => row.status === 'failed' && /workload.sql.*PgQuery::ParseError; linha 2/.test(row.detail)));
    const explicit = reports.explicit.coverage;
    for (const tool of ['pg_stat_statements', 'EXPLAIN']) {
      const measured = explicit.filter(row => row.tool === tool && row.status === 'ok')
        .flatMap(row => row.files ?? []);
      assert.equal(new Set(measured).size, 40, tool);
    }
    assert.equal(explicit.filter(row => row.tool === 'dexter' && /dexter:query:banco\/queries\//.test(row.detail)).length, 40);
    for (const [name, detail] of [
      ['00 nome.sql', /fora da convenção/], ['bad.sql', /parser PostgreSQL; linha 2/],
      ['zz-excedente.sql', /limite de 40 consultas/],
    ] as const) {
      assert.ok(explicit.some(row => row.tool === 'EXPLAIN' && row.status === 'failed'
        && row.detail.includes(name) && detail.test(row.detail)), name);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('saída do coletor distingue rejeição e cancelamento no commit e preserva o controle limpo', {
  skip: !process.env.AC_BANCO_IMAGE && 'AC_BANCO_IMAGE aponta para imagem já disponível', timeout: 90_000,
}, () => {
  const rejected = runIsolated<Report>(['/collector.rb'], join(fixtures, 'r4-commit/rejected'));
  assert.ok(rejected.coverage.some(row => row.status === 'ok'
    && /pg-migrate:fresh: lote rejeitado no commit.*origem entre arquivos indeterminada.*SQLSTATE 23503/.test(row.detail)));
  assert.ok(rejected.coverage.every(row => row.status !== 'failed'));
  assert.ok(rejected.findings.some(f => f.rule === 'BANCO-MIGRACAO-REJEITADA'
    && f.file.endsWith('002_data.sql') && /SQLSTATE 23503/.test(f.evidence)));
  assert.ok(rejected.findings.every(f => f.rule !== 'BANCO-MIGRACAO-REJEITADA' || f.file.endsWith('002_data.sql')));
  const canceled = runIsolated<Report>(['/collector.rb'], join(fixtures, 'r4-commit/canceled'));
  assert.ok(canceled.coverage.some(row => row.status === 'failed'
    && /pg-migrate:fresh: medição interrompida no commit.*SQLSTATE 57014/.test(row.detail)));
  assert.ok(canceled.findings.every(f => f.rule !== 'BANCO-MIGRACAO-REJEITADA'));
  for (const report of [rejected, canceled]) {
    for (const name of ['001_schema.sql', '002_data.sql']) {
      assert.ok(report.coverage.some(row => row.status === 'skipped'
        && row.detail.startsWith(`pg-migrate:fresh:db/migrations/${name}:`)));
      assert.ok(report.coverage.every(row => !row.detail.startsWith(`pg-migrate:fresh:db/migrations/${name}:`)
        || !row.files?.length));
    }
  }
  assert.doesNotMatch(JSON.stringify([rejected, canceled]), /424242|INSERT INTO/);
  const clean = runIsolated<Report>(['/collector.rb'], join(fixtures, 'clean'));
  assert.ok(clean.coverage.every(row => row.status !== 'failed'));
  assert.ok(clean.coverage.some(row => row.status === 'ok' && /pg_restore:upgraded:.*após atualização, invariante preservado/.test(row.detail)));
  assert.ok(clean.coverage.some(row => row.tool === 'EXPLAIN' && row.files?.includes('banco/queries/by-code.sql')));
  assert.ok(clean.findings.every(f => !['BANCO-MIGRACAO-REJEITADA', 'BANCO-INVARIANTE-HISTORICO', 'BANCO-INDICE-CANDIDATO', 'BANCO-CONSULTA-LENTA'].includes(f.rule)));
});
