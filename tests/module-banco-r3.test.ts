import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const collector = join(root, 'deploy/modules/banco/collector.rb');
type Row = {tool: string; status: string; detail: string};
type Finding = {rule: string; file: string; line: number; evidence: string};
type Report = {coverage: Row[]; findings: Finding[]};

test('inventário conserva consultas válidas ao lado de entradas inválidas', () => {
  const dir = mkdtempSync(join(root, '.c5-r3-'));
  try {
    mkdirSync(join(dir, 'banco/queries'), {recursive: true});
    writeFileSync(join(dir, 'banco/queries/valida.sql'), 'SELECT 1');
    writeFileSync(join(dir, 'banco/queries/vazia.sql'), '');
    writeFileSync(join(dir, 'banco/queries/nome invalido.sql'), 'SELECT 1');
    symlinkSync('valida.sql', join(dir, 'banco/queries/link.sql'));
    const output = execFileSync('ruby', ['--disable=rubyopt', '-r', collector, '-e', `
      entries = Banco::Inventory.new(ARGV.fetch(0)).queries
      puts JSON.generate(entries.map { |entry| entry.is_a?(Array) ? entry : [entry.path, 'ok'] })
    `, dir], {encoding: 'utf8'});
    const entries: string[][] = JSON.parse(output);
    assert.ok(entries.some(([path, result]) => path.endsWith('/valida.sql') && result === 'ok'));
    for (const name of ['vazia.sql', 'nome invalido.sql', 'link.sql']) {
      assert.ok(entries.some(([path, result]) => path.includes(name) && result !== 'ok'), name);
    }
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
  const image = process.env.AC_BANCO_IMAGE!;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
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
        ddl = 'CREATE TABLE parent(id integer PRIMARY KEY); CREATE TABLE child(id integer REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);'
        db.migrate('fresh', [source('db/migrations/001_schema.sql', ddl), source('db/migrations/002_data.sql', 'INSERT INTO child VALUES (42);')])
        reports[:ambiguous] = JSON.parse(initial.to_json)
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
        workload = Banco::Report.new
        db.instance_variable_set(:@report, workload)
        db.migrate('fresh', [source('db/migrations/001_final.sql', 'CREATE TABLE items(new_name integer); INSERT INTO items VALUES (1);')])
        db.prepare_workload(source('banco/seed.sql', 'INSERT INTO items(old_name) VALUES (2);'))
        db.workload(source('banco/queries/valida.sql', 'SELECT new_name FROM items;'))
        db.workload(source('banco/queries/invalid.sql', "SELECT\\n FROM;"))
        db.workload(source('banco/queries/missing.sql', "SELECT 1\\nFROM missing_table;"))
        db.workload(source('banco/queries/out.sql', 'DELETE FROM items;'))
        reports[:workload] = JSON.parse(workload.to_json)
      ensure
        db.stop
      end
    end
    puts JSON.generate(reports)
  `;
  const output = execFileSync('docker', [
    'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '65532:65532',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
    '--workdir', '/tmp', '--mount', `type=bind,src=${collector},dst=/collector.rb,readonly`, '--entrypoint', '/usr/bin/ruby',
    image, '--disable=rubyopt', '-e', script,
  ], {encoding: 'utf8', timeout: 80_000, maxBuffer: 1024 * 1024});
  const result: Record<string, Report> = JSON.parse(output);
  const {ambiguous, single, timeout, rejected, workload} = result;
  assert.equal(ambiguous.findings.length, 0);
  for (const name of ['001_schema.sql', '002_data.sql']) {
    assert.ok(ambiguous.coverage.some(row => row.status === 'failed' && row.detail.includes(name) && /SQLSTATE 23503.*indeterminada/.test(row.detail)));
    assert.ok(!ambiguous.coverage.some(row => row.status === 'ok' && row.detail.includes(name)));
  }
  assert.ok(single.findings.some(f => f.file.endsWith('001_single.sql') && /SQLSTATE 23503.*linha exata não informada/.test(f.evidence)));
  assert.ok(timeout.coverage.some(row => row.status === 'failed' && /001_slow.sql.*SQLSTATE 57014/.test(row.detail)));
  assert.ok(timeout.coverage.some(row => row.status === 'skipped' && row.detail.includes('002_next.sql')));
  assert.equal(timeout.findings.length, 0);
  assert.ok(rejected.findings.some(f => f.file.endsWith('002_bad.sql') && f.line === 2 && /SQLSTATE 42703/.test(f.evidence)));
  assert.ok(rejected.coverage.some(row => row.status === 'skipped' && /001_ok.sql.*não confirmada/.test(row.detail)));
  assert.ok(rejected.coverage.some(row => row.status === 'skipped' && row.detail.includes('003_next.sql')));
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
  assert.ok(!JSON.stringify(result).includes('INSERT INTO'));
});

test('coleta integrada separa seed histórico da carga final e mantém consultas individuais', {
  skip: !process.env.AC_BANCO_IMAGE && 'AC_BANCO_IMAGE aponta para imagem já disponível', timeout: 90_000,
}, () => {
  const dir = mkdtempSync(join(root, '.c5-r3-collect-'));
  try {
    chmodSync(dir, 0o755);
    for (const variant of ['legacy', 'explicit']) {
      const base = join(dir, variant);
      mkdirSync(join(base, 'db/migrations'), {recursive: true});
      mkdirSync(join(base, 'banco/queries'), {recursive: true});
      writeFileSync(join(base, 'db/migrations/001_create.sql'), 'CREATE TABLE items(old_name integer);');
      writeFileSync(join(base, 'db/migrations/002_rename.sql'), 'ALTER TABLE items RENAME COLUMN old_name TO new_name;');
      writeFileSync(join(base, 'banco/seed.sql'), 'INSERT INTO items(old_name) VALUES (1);');
      writeFileSync(join(base, 'banco/assert.sql'), 'SELECT count(*) = 1 FROM items;');
      if (variant === 'explicit') writeFileSync(join(base, 'banco/workload.sql'), 'INSERT INTO items(new_name) VALUES (1);');
      writeFileSync(join(base, 'banco/queries/good.sql'), 'SELECT new_name FROM items;');
      writeFileSync(join(base, 'banco/queries/empty.sql'), '');
      writeFileSync(join(base, 'banco/queries/bad.sql'), 'SELECT\n FROM;');
      writeFileSync(join(base, 'banco/queries/out.sql'), 'DELETE FROM items;');
    }
    const script = `require '/collector.rb'; puts JSON.generate(['legacy', 'explicit'].to_h { |name| [name, JSON.parse(Banco.collect('/repo/' + name).to_json)] })`;
    const output = execFileSync('docker', [
      'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '65532:65532',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
      '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
      '--workdir', '/tmp', '--mount', `type=bind,src=${dir},dst=/repo,readonly`,
      '--mount', `type=bind,src=${collector},dst=/collector.rb,readonly`, '--entrypoint', '/usr/bin/ruby',
      process.env.AC_BANCO_IMAGE!, '--disable=rubyopt', '-e', script,
    ], {encoding: 'utf8', timeout: 80_000, maxBuffer: 1024 * 1024});
    const reports: Record<string, Report> = JSON.parse(output);
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
    assert.ok(!reports.explicit.coverage.some(row => /Carga banco\/seed.sql/.test(row.detail)));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
