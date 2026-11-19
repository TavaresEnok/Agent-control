import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const collector = join(root, 'deploy/modules/banco/collector.rb');
const fixtures = join(root, 'tests/fixtures/module-banco');

type Report = {
  coverage: Array<{tool: string; version: string; status: 'ok' | 'failed' | 'skipped'; detail: string}>;
  findings: Array<{
    tool: string; rule: string; file: string; line: number; severity: string; message: string; evidence: string;
  }>;
};

function rubyReport(program: string, ...args: string[]): Report {
  const output = execFileSync('ruby', ['--disable=rubyopt', '-r', collector, '-e', program, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return JSON.parse(output);
}

test('C5 distingue inventário vazio de uma entrada SQL que é link simbólico', () => {
  const repository = mkdtempSync(join(root, '.c5-test-'));
  const collect = 'puts Banco.collect(ARGV.fetch(0)).to_json';
  try {
    const missing = rubyReport(collect, repository);
    assert.equal(missing.coverage.length, 6);
    assert.ok(missing.coverage.every(row => row.status === 'skipped'));
    assert.deepEqual(missing.findings, []);

    mkdirSync(join(repository, 'db/migrations'), {recursive: true});
    writeFileSync(join(repository, 'synthetic.sql'), 'SELECT 42;');
    symlinkSync('../../synthetic.sql', join(repository, 'db/migrations/001_ref.sql'));
    const rejected = rubyReport(collect, repository);
    assert.match(rejected.coverage.find(row => row.tool === 'squawk' && row.status === 'failed')?.detail ?? '', /link simbólico/);
    assert.deepEqual(rejected.findings, []);
  } finally {
    rmSync(repository, {recursive: true, force: true});
  }
});

test('C5 registra falha da ferramenta e mantém stdout como um JSON', () => {
  const report = rubyReport(`
    report = Banco::Report.new
    source = Banco::Source.new("db/migrations/001.sql", "SELECT 1;")
    Banco.lint([source], report, executable: "/bin/false")
    puts report.to_json
  `);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.coverage.map(row => [row.tool, row.status]), [['squawk', 'failed']]);
});

test('C5 registra exceção do Dexter sem expor a mensagem', () => {
  const report = rubyReport(`
    module PG
      class Error < StandardError; end
    end
    module Dexter
      class Error < StandardError; end
      class Query
        def initialize(*); end
      end
    end
    module PgQuery
      def self.fingerprint(*); "synthetic"; end
    end
    report = Banco::Report.new
    db = Banco::Database.new("/tmp", report)
    advisor = Object.new
    def advisor.process_queries(*); raise "detalhe privado"; end
    db.define_singleton_method(:advisor) { advisor }
    source = Banco::Source.new("banco/queries/test.sql", "SELECT 1;")
    report.measure("dexter", source.path) { db.send(:advise, source, line: 1) }
    puts report.to_json
  `);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.coverage.map(row => [row.tool, row.status, row.detail]), [
    ['dexter', 'failed', 'banco/queries/test.sql: RuntimeError'],
  ]);
});

test('C5 Dexter real compara índice hipotético com o controle indexado', {
  skip: !process.env.AC_BANCO_IMAGE && 'AC_BANCO_IMAGE aponta para a imagem PostgreSQL fixada já disponível',
  timeout: 120_000,
}, () => {
  const image = process.env.AC_BANCO_IMAGE!;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const program = `
    require "dexter"
    require "/collector.rb"
    report = Banco::Report.new
    inventory = Banco::Inventory.new("/repo")
    hypothetical = real = nil
    Dir.mktmpdir("c5-contract-", "/tmp") do |dir|
      db = Banco::Database.new(dir, report)
      begin
        db.start
        raise "migration failed" unless db.migrate("fresh", inventory.list("db/migrations", Banco::MIGRATION_NAME, 400))
        db.prepare_workload(inventory.load(Banco::SEED))
        source = inventory.load("banco/queries/by-code.sql")
        report.measure("dexter", source.path) { db.send(:advise, source, line: Banco.statement_line(source)) }
        connection = db.send(:advisor).instance_variable_get(:@connection)
        raise "session is not read-only" unless connection.execute("SHOW default_transaction_read_only").first.values.first == "on"
        hypothetical = connection.execute("SELECT count(*) AS n FROM banco_tools.hypopg()").first.fetch("n").to_i
        real = connection.execute("SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'items_item_code_idx'").first.fetch("n").to_i
      ensure
        db.stop
      end
    end
    puts JSON.generate({report: JSON.parse(report.to_json), hypothetical: hypothetical, real: real})
  `;
  const run = (variant: string): {report: Report; hypothetical: number; real: number} => JSON.parse(execFileSync('docker', [
    'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '65532:65532',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
    '--workdir', '/tmp', '--mount', `type=bind,src=${join(fixtures, variant)},dst=/repo,readonly`,
    '--mount', `type=bind,src=${collector},dst=/collector.rb,readonly`, '--entrypoint', '/usr/bin/ruby',
    image, '--disable=rubyopt', '-e', program,
  ], {encoding: 'utf8', timeout: 55_000, maxBuffer: 1024 * 1024}));

  const defectiveResult = run('defective');
  const cleanResult = run('clean');
  assert.ok(defectiveResult.hypothetical > 0);
  assert.equal(defectiveResult.real, 0);
  assert.equal(cleanResult.real, 1);
  const defective = defectiveResult.report;
  const clean = cleanResult.report;
  for (const report of [defective, clean]) {
    assert.deepEqual(report.coverage.filter(row => row.status === 'failed'), []);
  }
  assert.ok(defective.coverage.some(row => row.tool === 'dexter' && row.status === 'ok' && row.detail.includes('planos hipotéticos comparados')));
  const finding = defective.findings.find(row => row.rule === 'BANCO-INDICE-CANDIDATO');
  assert.equal(finding?.file, 'banco/queries/by-code.sql');
  assert.equal(finding.line, 2);
  const costs = /redução estimada de ([\d.]+) para ([\d.]+).*public\.items \/ item_code/.exec(finding.evidence);
  assert.ok(costs, finding.evidence);
  assert.ok(Number(costs[2]) < Number(costs[1]) * 0.5);
  assert.equal(clean.findings.some(row => row.rule === 'BANCO-INDICE-CANDIDATO'), false);
  assert.ok(clean.coverage.some(row => row.tool === 'dexter' && ['ok', 'skipped'].includes(row.status) && row.detail.includes('banco/queries/by-code.sql')));
});

test('C5 Squawk real localiza a remoção na linha 2 e distingue o controle', {
  skip: !process.env.AC_BANCO_SQUAWK && 'AC_BANCO_SQUAWK aponta para o executável pinado',
}, () => {
  const lint = (variant: string) => rubyReport(`
    report = Banco::Report.new
    inventory = Banco::Inventory.new(ARGV.fetch(0))
    Banco.lint(inventory.list("db/migrations", Banco::MIGRATION_NAME, 10), report, executable: ARGV.fetch(1))
    puts report.to_json
  `, join(fixtures, variant), resolve(process.env.AC_BANCO_SQUAWK!));
  const defective = lint('defective');
  const clean = lint('clean');
  for (const report of [defective, clean]) {
    assert.equal(report.coverage.length, 2);
    assert.ok(report.coverage.every(row => row.status === 'ok'));
  }
  const rule = 'SQUAWK-BAN-DROP-COLUMN';
  const finding = defective.findings.find(row => row.rule === rule);
  assert.equal(finding?.file, 'db/migrations/002_revision.sql');
  assert.equal(finding.line, 2);
  assert.ok(finding.evidence);
  assert.equal(clean.findings.some(row => row.rule === rule), false);
});

test('C5 laboratório por digest prova a migração, restauração e os três defeitos plantados', {
  skip: process.env.AC_MODULE_LAB !== '1' && 'AC_MODULE_LAB=1 habilita o laboratório por digest',
  timeout: 360_000,
}, () => {
  const digest = readFileSync(join(root, 'deploy/modules/banco/digest.txt'), 'utf8').trim();
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  const run = (variant: string): Report => {
    const stdout = execFileSync('docker', [
      'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '65532:65532',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
      '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
      '--workdir', '/tmp', '--mount', `type=bind,src=${join(fixtures, variant)},dst=/repo,readonly`, digest,
    ], {encoding: 'utf8', timeout: 160_000, maxBuffer: 8 * 1024 * 1024});
    const report: Report = JSON.parse(stdout);
    assert.deepEqual(report.coverage.filter(row => row.status === 'failed'), [], variant);
    for (const [tool, detail] of [
      ['pg-migrate', /pg-migrate:fresh: commit de 2 migrações/],
      ['pg-migrate', /pg-migrate:upgraded: commit de 1 migrações/],
      ['pg_restore', /pg_restore:upgraded: arquivo custom restaurado/],
      ['pg_restore', /pg_restore:upgraded:banco\/assert\.sql: após atualização, invariante preservado/],
      ['pg_stat_statements', /pg_stat_statements:query:banco\/queries\/by-code\.sql: .*amostras=3/],
      ['EXPLAIN', /EXPLAIN:query:banco\/queries\/by-code\.sql:/],
    ] as const) {
      assert.ok(report.coverage.some(row => row.tool === tool && row.status === 'ok' && detail.test(row.detail)), `${variant} / ${detail}`);
    }
    assert.equal(report.findings.some(row => row.rule === 'BANCO-INVARIANTE-HISTORICO'), false);
    return report;
  };
  const defective = run('defective');
  const clean = run('clean');
  for (const [rule, file] of [
    ['SQUAWK-BAN-DROP-COLUMN', 'db/migrations/002_revision.sql'],
    ['BANCO-INDICE-CANDIDATO', 'banco/queries/by-code.sql'],
    ['BANCO-CONSULTA-LENTA', 'banco/queries/latency.sql'],
  ]) {
    assert.ok(defective.findings.some(row => row.rule === rule && row.file === file && row.line === 2 && row.evidence), rule);
    assert.equal(clean.findings.some(row => row.rule === rule), false, rule);
  }
  assert.ok(defective.coverage.some(row => row.tool === 'dexter' && row.status === 'ok' && row.detail.includes('planos hipotéticos comparados')));
});
