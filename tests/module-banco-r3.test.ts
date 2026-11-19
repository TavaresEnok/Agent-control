import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const collector = join(root, 'deploy/modules/banco/collector.rb');
const fixtures = join(root, 'tests/fixtures/module-banco');
type Row = {tool: string; status: string; detail: string; files?: string[]};
type Finding = {rule: string; file: string; line: number; evidence: string};
type Report = {coverage: Row[]; findings: Finding[]};

const native = process.env.AC_BANCO_NATIVE === '1';
const skipPostgres = !native && !process.env.AC_BANCO_IMAGE && 'AC_BANCO_NATIVE=1 usa o PostgreSQL efêmero local';
const collect = 'puts collect_fixture.to_json';

function runIsolated<T>(program: string, repo?: string, args: string[] = []): T {
  const script = 'def collect_fixture(name = ""); Banco.collect(File.join(ENV.fetch("AC_BANCO_TEST_REPO"), name),'
    + ' squawk: ENV.fetch("AC_BANCO_SQUAWK", "/usr/local/bin/squawk")); end; ' + program;
  const options = {encoding: 'utf8', timeout: 80_000, maxBuffer: 1024 * 1024} as const;
  if (native) {
    const squawk = process.env.AC_BANCO_SQUAWK;
    assert.ok(squawk, 'AC_BANCO_SQUAWK aponta para o executável pinado');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
    return JSON.parse(execFileSync('ruby', ['--disable=rubyopt', '-r', collector, '-e', script, '--', ...args], {
      ...options, env: {...env, AC_BANCO_SQUAWK: resolve(squawk), AC_BANCO_TEST_REPO: repo},
    }));
  }
  const image = process.env.AC_BANCO_IMAGE!;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const output = execFileSync('docker', [
    'run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--user', '65532:65532',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp',
    '--workdir', '/tmp', '--mount', `type=bind,src=${collector},dst=/collector.rb,readonly`,
    ...(repo ? ['--env', 'AC_BANCO_TEST_REPO=/repo', '--mount', `type=bind,src=${repo},dst=/repo,readonly`] : []),
    '--entrypoint', '/usr/bin/ruby', image, '--disable=rubyopt', '-r', '/collector.rb', '-e', script, '--', ...args,
  ], options);
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

test('diagnóstico de migração separa contexto, início da instrução e cursor externo', {
  skip: skipPostgres, timeout: 90_000,
}, () => {
  const reports = runIsolated<Record<string, Report>>(String.raw`
    require 'pg'
    require 'pg_query'

    diagnostic = Struct.new(:fields) do
      def error_field(field) = fields[field]
    end
    failure = Class.new(PG::Error) { attr_accessor :result }
    source_sql = <<~'SQL'
      SELECT 'ação 🌱';
      DO $$ BEGIN
        SET CONSTRAINTS
          falta.child_fk IMMEDIATE;
      END $$;
    SQL
    multi_command_block = source_sql.sub('END $$', "  PERFORM 1;\nEND $$")
    set_sql = "SET CONSTRAINTS\n  falta.child_fk IMMEDIATE"
    set_frame = %Q(SQL statement "#{set_sql}")
    inline = 'PL/pgSQL function inline_code_block line 42 at SQL statement'
    cursor = (source_sql.index('falta') + 1).to_s
    other_cursor = (source_sql.index('ação') + 1).to_s
    other_inner_cursor = (multi_command_block.index('PERFORM') + 1).to_s
    select_sql = 'SELECT check_task()'
    select_frame = %Q(SQL statement "#{select_sql}")
    internal_sql = "SELECT check_task();\nSELECT 'ação 🌱';\n#{set_sql}"
    internal_fields = {
      context: inline, internal_position: (internal_sql.index('falta') + 1).to_s, internal_query: internal_sql
    }
    single_internal = {
      context: inline, internal_query: set_sql, internal_position: (set_sql.index('falta') + 1).to_s
    }
    deferred_check = {
      context: inline, sqlstate: '23503', source_function: nil, internal_query: 'SET CONSTRAINTS ALL IMMEDIATE'
    }
    malformed_frame = {
      context: 'PL/pgSQL function inline_code_block line x at EXECUTE',
      sqlstate: '42703', source_function: nil, statement_position: cursor
    }
    writer_fields = {
      sqlstate: '23503', source_function: 'ri_ReportViolation',
      schema_name: 'public', table_name: 'child', constraint_name: 'child_fk'
    }
    cases = {
      start: {context: [set_frame, inline].join("\n")},
      cursor: {context: [set_frame, inline].join("\n"), statement_position: cursor},
      same_block_other_command_cursor: single_internal.merge(
        context: [set_frame, inline].join("\n"), statement_position: other_inner_cursor
      ),
      inline_cursor_without_context: {statement_position: other_inner_cursor},
      inline_without_query: {context: inline, statement_position: cursor},
      top_level_exact: {sqlstate: '42703', source_function: nil},
      single_internal_cursor: single_internal,
      single_corroborated_frame: single_internal.merge(context: [set_frame, inline].join("\n")),
      stack_matches_first: single_internal.merge(context: [set_frame, select_frame, inline].join("\n")),
      stack_matches_last: single_internal.merge(context: [select_frame, set_frame, inline].join("\n")),
      stack_without_internal: {context: [set_frame, select_frame, inline].join("\n")},
      stack_repeated_sql: single_internal.merge(context: [set_frame, inline, set_frame, inline].join("\n")),
      unparseable_sql_frame: {context: [%q{SQL statement "SELECT FROM ("}, inline].join("\n")},
      eof_cursor: {context: [set_frame, inline].join("\n"), statement_position: (source_sql.length + 1).to_s},
      malformed_cursor: {context: [set_frame, inline].join("\n"), statement_position: "#{cursor}x"},
      different_command_cursor: {context: [set_frame, inline].join("\n"), statement_position: other_cursor},
      between_commands_cursor: {context: [set_frame, inline].join("\n"), statement_position: source_sql.index('DO').to_s},
      internal_cursor: internal_fields,
      corroborated_frame: single_internal.merge(context: [set_frame, inline].join("\n"), statement_position: cursor),
      corroborated_query: internal_fields.merge(context: [%Q(SQL statement "#{internal_sql}"), inline].join("\n")),
      different_internal_query: single_internal.merge(
        context: [set_frame, inline].join("\n"), internal_query: select_sql, internal_position: '8', statement_position: cursor
      ),
      different_internal_position: internal_fields.merge(
        context: [set_frame, inline].join("\n"), internal_position: '8', statement_position: cursor
      ),
      different_textual_frame: single_internal.merge(context: [select_frame, inline].join("\n")),
      internal_missing_routine: single_internal.merge(source_function: nil),
      internal_without_context: internal_fields.merge(context: nil),
      internal_query_only: deferred_check,
      internal_malformed_position: deferred_check.merge(internal_position: '2x', statement_position: cursor),
      internal_out_of_range: deferred_check.merge(internal_position: (deferred_check[:internal_query].length + 1).to_s),
      internal_position_only: internal_fields.merge(internal_query: nil),
      internal_unparseable: internal_fields.merge(internal_query: 'SELECT FROM (', internal_position: '8'),
      internal_unterminated_literal: internal_fields.merge(internal_query: "SELECT 'aberto", internal_position: '9'),
      malformed_frame: malformed_frame,
      malformed_frame_with_internal: internal_fields.merge(malformed_frame),
      malformed_sql_suffix: {context: [set_frame, "#{inline} inesperado"].join("\n"), statement_position: cursor},
      malformed_execute_suffix: {context: inline.sub(/SQL statement$/, 'EXECUTE inesperado'), statement_position: cursor},
      missing_routine: {context: [set_frame, inline].join("\n"), source_function: nil},
      missing_routine_cursor: {context: [set_frame, inline].join("\n"), source_function: nil, statement_position: cursor},
      partial: {context: [set_frame, inline, 'contexto externo desconhecido'].join("\n")},
      unterminated: {context: 'SQL statement "SET CONSTRAINTS ALL IMMEDIATE', statement_position: cursor},
      ambiguous_name: {context: %Q(SQL function "task"\nSQL statement "SET CONSTRAINTS ALL IMMEDIATE"\n#{inline})},
      competing: {context: %Q(SQL statement "SELECT check_task(); SET CONSTRAINTS ALL IMMEDIATE"\n#{inline})},
      sql_statement: {context: [%q(SQL function "check"task" statement 2), set_frame, inline].join("\n")},
      sql_startup: {context: [%Q(SQL function "check\ntask" during startup), set_frame, inline].join("\n")},
      sql_inlining: {context: [%q(SQL function "check" during inlining), set_frame, inline].join("\n")},
      sql_bare: {context: [%q(SQL function "a_long_but_ordinary_name_for_check_task"), set_frame, inline].join("\n")},
      compilation: {context: [%q(compilation of PL/pgSQL function "check_task" near line 2), set_frame, inline].join("\n")},
      expression: {context: [%q(SQL expression "'SET CONSTRAINTS ALL IMMEDIATE'"), inline].join("\n")},
      assignment: {context: [%q(PL/pgSQL assignment "label := 'SET CONSTRAINTS ALL IMMEDIATE'"), inline].join("\n")},
      writer_consistent: writer_fields,
      writer_conflict: writer_fields.merge(
        context: 'SQL statement "SET CONSTRAINTS ALL IMMEDIATE"', internal_query: select_sql, internal_position: '8'
      )
    }
    reports = cases.to_h do |name, fields|
      report = Banco::Report.new
      db = Banco::Database.new('/tmp', report)
      fields = {sqlstate: '3F000', source_function: 'get_namespace_oid'}.merge(fields)
      fields = fields.to_h { |key, value| [PG::Result.const_get("PG_DIAG_#{key.upcase}"), value] }
      error = failure.new('mensagem sintética privada')
      error.result = diagnostic.new(fields)
      prior_sql = 'SELECT 1;'
      migration_sql = source_sql
      if %i[same_block_other_command_cursor inline_cursor_without_context].include?(name)
        migration_sql = multi_command_block
      elsif name == :top_level_exact
        migration_sql = "SELECT 'ação 🌱';\nSELECT missing;"
        fields[PG::Result::PG_DIAG_STATEMENT_POSITION] = (migration_sql.index('missing') + 1).to_s
      elsif name.to_s.start_with?('writer_')
        prior_sql = 'CREATE TABLE parent(id integer PRIMARY KEY); ' \
          'CREATE TABLE child(id integer CONSTRAINT child_fk REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); ' \
          'INSERT INTO child VALUES (42);'
        migration_sql = 'SET CONSTRAINTS ALL IMMEDIATE;'
      end
      applied = []
      connection = Object.new
      connection.define_singleton_method(:exec) do |sql|
        applied << sql
        raise error if sql == migration_sql
      end
      db.define_singleton_method(:connect) { |_name, &block| block.call(connection) }
      prior = Banco::Source.new('db/migrations/001_prior.sql', prior_sql)
      source = Banco::Source.new('db/migrations/002_diagnostic.sql', migration_sql)
      next_source = Banco::Source.new('db/migrations/003_not_reached.sql', 'SELECT 3;')
      raise 'migração deveria ser rejeitada' if db.migrate('fresh', [prior, source, next_source])
      raise 'sequência inesperada' unless applied == ['BEGIN', prior.sql, source.sql, 'ROLLBACK']
      [name, JSON.parse(report.to_json)]
    end
    puts JSON.generate(reports)
  `);

  for (const name of ['start', 'single_internal_cursor', 'single_corroborated_frame']) {
    const [finding] = reports[name].findings;
    assert.equal(finding.rule, 'BANCO-MIGRACAO-REJEITADA', name);
    assert.equal(finding.line, 2, name);
    assert.match(finding.evidence, /linha inicial da instrução; posição exata indisponível/, name);
  }
  const [exact] = reports.top_level_exact.findings;
  assert.equal(exact.rule, 'BANCO-MIGRACAO-REJEITADA');
  assert.equal(exact.file, 'db/migrations/002_diagnostic.sql');
  assert.equal(exact.line, 2);
  assert.equal(exact.evidence, 'SQLSTATE 42703; linha indicada pelo cursor do servidor');

  for (const [names, detection] of [
    [['partial', 'unterminated', 'ambiguous_name', 'malformed_frame', 'malformed_frame_with_internal',
      'malformed_sql_suffix', 'malformed_execute_suffix'],
      /contexto do PostgreSQL inconclusivo/],
    [['eof_cursor', 'malformed_cursor', 'different_command_cursor', 'between_commands_cursor'],
      /cursor externo sem correspondência com o bloco inline/],
    [['cursor', 'corroborated_frame', 'same_block_other_command_cursor', 'inline_without_query'],
      /posição do comando interno sem correspondência verificável/],
    [['stack_matches_first', 'stack_matches_last', 'stack_without_internal', 'stack_repeated_sql'],
      /pilha com vários quadros de SQL.*SET CONSTRAINTS IMMEDIATE pode ter antecipado/],
    [['corroborated_query', 'unparseable_sql_frame'], /quadro de SQL sem instrução única verificável/],
    [['inline_cursor_without_context'], /posição do comando interno sem correspondência verificável/],
    [['expression', 'assignment'], /origem do comando interno inconclusiva/],
    [['internal_cursor', 'different_internal_position'], /selecionou uma instrução entre várias na consulta interna/],
    [['different_internal_query', 'different_textual_frame', 'writer_conflict'],
      /consulta ou posição interna diverge do quadro textual de SQL.*SET CONSTRAINTS IMMEDIATE pode ter antecipado/],
    [['competing', 'internal_without_context', 'internal_missing_routine'], /SET CONSTRAINTS IMMEDIATE pode ter antecipado/],
    [['internal_query_only', 'internal_malformed_position', 'internal_out_of_range'],
      /diagnóstico interno parcial.*SET CONSTRAINTS IMMEDIATE pode ter antecipado/],
    [['internal_position_only', 'internal_unparseable', 'internal_unterminated_literal'], /diagnóstico interno parcial/],
    [['missing_routine', 'missing_routine_cursor', 'sql_statement', 'sql_startup', 'sql_inlining', 'sql_bare', 'compilation'],
      /detecção em SET CONSTRAINTS chamado pelo arquivo/],
  ] as const) {
    for (const name of names) {
      const [finding] = reports[name].findings;
      assert.equal(finding.rule, 'BANCO-LOTE-MIGRACAO-REJEITADO', name);
      assert.equal(finding.file, 'db/migrations/002_diagnostic.sql', name);
      assert.equal(finding.line, 1, name);
      assert.match(finding.evidence, detection, name);
      assert.match(finding.evidence, /origem entre arquivos indeterminada/, name);
      assert.match(finding.evidence, /arquivo e linha referenciam o início do último arquivo alcançado/, name);
      assert.match(finding.evidence, /cobertura parcial da origem/, name);
      assert.doesNotMatch(finding.evidence, /linha indicada pelo cursor do servidor/, name);
      const {coverage} = reports[name];
      assert.ok(coverage.some(row => row.status === 'ok' && /002_diagnostic.sql.*cobertura parcial da origem/.test(row.detail)), name);
      assert.ok(coverage.some(row => row.status === 'skipped' && row.detail.includes('003_not_reached.sql')), name);
    }
  }
  for (const name of ['same_block_other_command_cursor', 'inline_cursor_without_context']) {
    assert.match(reports[name].findings[0].evidence, /cursor do servidor na linha 5/, name);
  }
  for (const name of ['unterminated', 'missing_routine_cursor', 'malformed_frame', 'malformed_frame_with_internal',
    'internal_malformed_position', 'different_internal_query', 'different_internal_position', 'cursor', 'corroborated_frame',
    'malformed_sql_suffix', 'malformed_execute_suffix']) {
    assert.match(reports[name].findings[0].evidence, /cursor do servidor na linha 4/, name);
  }
  assert.match(reports.internal_query_only.findings[0].evidence, /consulta interna presente; posição interna ausente/);
  assert.match(reports.internal_malformed_position.findings[0].evidence,
    /consulta interna presente; posição interna presente, sem instrução identificável/);
  assert.match(reports.internal_position_only.findings[0].evidence,
    /consulta interna ausente; posição interna presente, sem instrução identificável/);
  assert.match(reports.malformed_frame_with_internal.findings[0].evidence,
    /consulta interna presente; posição interna selecionou uma instrução entre várias na consulta interna/);
  assert.equal(reports.writer_consistent.findings[0].file, 'db/migrations/001_prior.sql');
  assert.match(reports.writer_consistent.findings[0].evidence, /único arquivo com inserções/);
  assert.doesNotMatch(JSON.stringify(reports), /mensagem sintética privada|inline_code_block|falta\.child_fk|check_task\(\)|inesperado/);
});

test('PostgreSQL isolado preserva atribuição e medições após falhas sintéticas', {
  skip: skipPostgres, timeout: 90_000,
}, () => {
  const script = `
    require 'dexter'
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
        prefix = [
          source('db/migrations/001_schema.sql', ddl + ' INSERT INTO public.parent VALUES (1);'),
          source('db/migrations/002_data.sql', 'INSERT INTO child VALUES (424242);')
        ]
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
        db.migrate('fresh', prefix + [source('db/migrations/003_nested.sql', "DO $$ BEGIN SET\\nCONSTRAINTS ALL\\nIMMEDIATE; END $$;")])
        reports[:nested] = JSON.parse(nested.to_json)
        positioned = Banco::Report.new
        db.instance_variable_set(:@report, positioned)
        db.migrate('fresh', prefix + [source('db/migrations/003_direct.sql', "-- ação\\nSELECT missing;\\nSET CONSTRAINTS ALL IMMEDIATE;")])
        reports[:positioned] = JSON.parse(positioned.to_json)
        missing_constraint = Banco::Report.new
        db.instance_variable_set(:@report, missing_constraint)
        db.migrate('fresh', prefix + [
          source('db/migrations/003_missing.sql', "SELECT 1;\\n/* ação */\\nSET CONSTRAINTS missing IMMEDIATE;")
        ])
        reports[:missing_constraint] = JSON.parse(missing_constraint.to_json)
        missing_nested = Banco::Report.new
        db.instance_variable_set(:@report, missing_nested)
        db.migrate('fresh', prefix + [
          source('db/migrations/003_missing_nested.sql', <<~SQL)
            -- ação
            DO $$ BEGIN
              SET
              CONSTRAINTS missing
              IMMEDIATE;
            END $$;
          SQL
        ])
        reports[:missing_nested] = JSON.parse(missing_nested.to_json)
        missing_in_trigger = Banco::Report.new
        db.instance_variable_set(:@report, missing_in_trigger)
        db.migrate('fresh', [
          source('db/migrations/001_trigger.sql', <<~SQL),
            CREATE TABLE task (id integer);
            CREATE FUNCTION check_task() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              SET CONSTRAINTS
                missing IMMEDIATE;
              RETURN NEW;
            END;
            $$;
            CREATE CONSTRAINT TRIGGER deferred_task AFTER INSERT ON task
              DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_task();
          SQL
          source('db/migrations/002_data.sql', 'INSERT INTO task VALUES (1);'),
          source('db/migrations/003_check.sql', 'DO $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; END $$;')
        ])
        reports[:missing_in_trigger] = JSON.parse(missing_in_trigger.to_json)
        different = Banco::Report.new
        db.instance_variable_set(:@report, different)
        db.migrate('fresh', [
          source('db/migrations/001_first.sql', ddl + ' INSERT INTO child VALUES (19);'),
          source('db/migrations/002_second.sql', 'INSERT INTO parent VALUES (19); INSERT INTO child VALUES (424242);'),
          source('db/migrations/003_tail.sql', 'SELECT 1;')
        ])
        reports[:different] = JSON.parse(different.to_json)
        single = Banco::Report.new
        db.instance_variable_set(:@report, single)
        db.migrate('previous', [source('db/migrations/001_single.sql', ddl + ' INSERT INTO child VALUES (42);')])
        reports[:single] = JSON.parse(single.to_json)
        timeout = Banco::Report.new
        db.instance_variable_set(:@report, timeout)
        db.migrate('upgraded', [source('db/migrations/001_slow.sql', 'SELECT pg_sleep(6);'), source('db/migrations/002_next.sql', 'SELECT 1;')])
        reports[:timeout] = JSON.parse(timeout.to_json)
        transaction_timeout = Banco::Report.new
        db.instance_variable_set(:@report, transaction_timeout)
        # A desconexão do timeout real pode fazer libpq entregar apenas PG::ConnectionBad.
        # O erro sintético exercita a classificação quando o SQLSTATE está disponível.
        db.migrate('upgraded', [
          source('db/migrations/001_ok.sql', 'CREATE TABLE pending(id integer);'),
          source('db/migrations/002_deadline.sql', "DO $$ BEGIN RAISE SQLSTATE '25P04'; END $$;"),
          source('db/migrations/003_next.sql', 'SELECT 1;')
        ])
        reports[:transaction_timeout] = JSON.parse(transaction_timeout.to_json)
        unavailable = Banco::Report.new
        db.instance_variable_set(:@report, unavailable)
        unavailable.measure('pg-migrate', 'Cenário indisponível') do
          db.migrate('absent_test_database', [source('db/migrations/001_unused.sql', 'SELECT 1;')])
        end
        reports[:unavailable] = JSON.parse(unavailable.to_json)
        rejected = Banco::Report.new
        db.instance_variable_set(:@report, rejected)
        db.migrate('upgraded', [source('db/migrations/001_ok.sql', 'CREATE TABLE t(id integer);'), source('db/migrations/002_bad.sql', "SELECT 1;\\nSELECT missing FROM t;"), source('db/migrations/003_next.sql', 'SELECT 1;')])
        reports[:rejected] = JSON.parse(rejected.to_json)
        internal_column = Banco::Report.new
        db.instance_variable_set(:@report, internal_column)
        db.migrate('upgraded', [source('db/migrations/001_table.sql', 'CREATE TABLE task(id integer);'),
          source('db/migrations/002_internal_column.sql', <<~'SQL')])
            SELECT 1;
            DO $$ BEGIN
              PERFORM missing_task_column FROM task;
            END $$;
          SQL
        reports[:internal_column] = JSON.parse(internal_column.to_json)
        app = Banco::Report.new
        db.instance_variable_set(:@report, app)
        db.migrate('fresh', [source('db/migrations/001_raise.sql', "DO $$ BEGIN RAISE EXCEPTION 'synthetic-private'; END $$;")])
        db.exercise_restore([
          source('db/migrations/001_function.sql', "CREATE FUNCTION app_check() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private'; END $$;"),
          source('db/migrations/002_new.sql', 'CREATE TABLE extra(id integer);')
        ], nil, source('banco/assert.sql', 'SELECT app_check();'))
        reports[:app] = JSON.parse(app.to_json)
        [0, 2].each do |rows|
          strict = Banco::Report.new
          db.instance_variable_set(:@report, strict)
          ddl_strict = "CREATE FUNCTION strict_check() RETURNS boolean LANGUAGE plpgsql AS $$ DECLARE n integer; BEGIN SELECT i INTO STRICT n FROM generate_series(1, #{rows}) AS i; RETURN true; END $$;"
          db.migrate('fresh', [
            source('db/migrations/001_strict_function.sql', ddl_strict),
            source('db/migrations/002_strict.sql', "-- ação\\nSELECT strict_check();")
          ])
          reports["strict_#{rows}"] = JSON.parse(strict.to_json)
        end
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
  const result = runIsolated<Record<string, Report>>(script);
  const {early, mixed, nested, positioned, missing_constraint, missing_nested, different, single, timeout, unavailable, rejected, app, syntax, workload} = result;
  assert.ok(early.coverage.some(row => row.status === 'ok' && /003_check.sql.*lote rejeitado.*SQLSTATE 23503.*SET CONSTRAINTS IMMEDIATE na linha 2.*002_data.sql/.test(row.detail)));
  assert.ok(early.findings.some(f => f.rule === 'BANCO-MIGRACAO-REJEITADA' && f.file.endsWith('002_data.sql')
    && /diagnóstico da execução original e único arquivo com inserções/.test(f.evidence)));
  for (const name of ['001_schema.sql', '002_data.sql', '004_next.sql']) {
    assert.ok(early.coverage.some(row => row.status === 'skipped' && row.detail.includes(name)));
  }
  assert.ok(mixed.findings.some(f => f.rule === 'BANCO-MIGRACAO-REJEITADA' && f.file.endsWith('002_data.sql')));
  assert.ok(mixed.coverage.some(row => row.status === 'ok' && /003_mix.sql.*detecção durante a execução.*pode ter antecipado.*origem atribuída a .*002_data.sql/.test(row.detail)));
  assert.ok(nested.findings.some(f => f.rule === 'BANCO-LOTE-MIGRACAO-REJEITADO' && f.file.endsWith('003_nested.sql')));
  assert.ok(nested.coverage.some(row => row.status === 'ok' && /003_nested.sql.*SET CONSTRAINTS chamado pelo arquivo.*indeterminada/.test(row.detail)));
  assert.ok(positioned.findings.some(f => f.file.endsWith('003_direct.sql') && f.line === 2 && /SQLSTATE 42703/.test(f.evidence)));
  for (const [report, file, line] of [[missing_constraint, '003_missing.sql', 3], [missing_nested, '003_missing_nested.sql', 2]] as const) {
    assert.deepEqual(report.findings, [{rule: 'BANCO-MIGRACAO-REJEITADA', tool: 'pg-migrate', severity: 'alta',
      file: `db/migrations/${file}`, line, message: 'A migração foi rejeitada no cenário fresh.',
      evidence: 'SQLSTATE 42704; linha inicial da instrução; posição exata indisponível'}]);
  }
  assert.equal(result.missing_in_trigger.findings.length, 1);
  assert.ok(result.missing_in_trigger.findings.some(f => f.rule === 'BANCO-LOTE-MIGRACAO-REJEITADO'
    && /SQLSTATE 42704.*001_trigger.sql.*origem entre arquivos indeterminada/.test(f.evidence)));
  assert.equal(different.findings.length, 1);
  assert.ok(different.findings.some(f => f.rule === 'BANCO-LOTE-MIGRACAO-REJEITADO' && f.file.endsWith('003_tail.sql')
    && /SQLSTATE 23503.*lote de 3 arquivos.*001_first.sql.*003_tail.sql.*origem entre arquivos indeterminada.*referenciam/.test(f.evidence)));
  assert.doesNotMatch(JSON.stringify(different), /424242|INSERT INTO/);
  assert.ok(single.findings.some(f => f.file.endsWith('001_single.sql') && /SQLSTATE 23503.*linha exata não informada/.test(f.evidence)));
  assert.ok(single.coverage.some(row => row.status === 'ok' && /lote rejeitado no commit.*SQLSTATE 23503/.test(row.detail)));
  assert.ok(timeout.coverage.some(row => row.status === 'failed' && /001_slow.sql.*SQLSTATE 57014/.test(row.detail)));
  assert.ok(timeout.coverage.some(row => row.status === 'skipped' && row.detail.includes('002_next.sql')));
  assert.equal(timeout.findings.length, 0);
  assert.ok(result.transaction_timeout.coverage.some(row => row.status === 'failed' && /002_deadline.sql.*SQLSTATE 25P04/.test(row.detail)));
  assert.ok(result.transaction_timeout.coverage.some(row => row.status === 'skipped' && /001_ok.sql.*transação não confirmada/.test(row.detail)));
  assert.ok(result.transaction_timeout.coverage.some(row => row.status === 'skipped' && row.detail.includes('003_next.sql')));
  assert.deepEqual(result.transaction_timeout.findings, []);
  assert.deepEqual(unavailable.findings, []);
  assert.ok(unavailable.coverage.some(row => row.status === 'failed' && /Cenário indisponível.*PG::ConnectionBad/.test(row.detail)));
  assert.ok(rejected.findings.some(f => f.file.endsWith('002_bad.sql') && f.line === 2 && /SQLSTATE 42703/.test(f.evidence)));
  assert.ok(rejected.coverage.some(row => row.status === 'skipped' && /001_ok.sql.*não confirmada/.test(row.detail)));
  assert.ok(rejected.coverage.some(row => row.status === 'skipped' && row.detail.includes('003_next.sql')));
  for (const [report, code, file, line] of [
    [result.internal_column, '42703', '002_internal_column.sql', 1],
    [app, 'P0001', '001_raise.sql', 1],
    [result.strict_0, 'P0002', '002_strict.sql', 2],
    [result.strict_2, 'P0003', '002_strict.sql', 2],
  ] as const) {
    const finding = report.findings.find(f => f.file.endsWith(file));
    assert.ok(finding, file);
    assert.equal(finding.rule, 'BANCO-LOTE-MIGRACAO-REJEITADO', file);
    assert.equal(finding.line, line, file);
    assert.match(finding.evidence, new RegExp(`SQLSTATE ${code}; cobertura parcial da origem; .*origem entre arquivos indeterminada`), file);
    assert.ok(report.coverage.some(row => row.status === 'ok' && row.detail.includes(file)
      && row.detail.includes('cobertura parcial da origem')), file);
    assert.ok(report.coverage.every(row => row.status !== 'failed'), file);
  }
  assert.ok(app.findings.some(f => f.rule === 'BANCO-INVARIANTE-HISTORICO' && /SQLSTATE P0001/.test(f.evidence)));
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
  assert.doesNotMatch(JSON.stringify(result), /INSERT INTO|synthetic-private|424242|inline_code_block|missing_task_column/);
});

test('coleta integrada separa seed histórico da carga final e mantém consultas individuais', {
  skip: skipPostgres, timeout: 90_000,
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
      writeFileSync(join(base, 'banco/queries/good.sql'), '/* ação\n   consulta */\n-- origem\nSELECT new_name FROM items;');
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
    const script = 'puts JSON.generate(ARGV.to_h { |name| [name, JSON.parse(collect_fixture(name).to_json)] })';
    const reports = runIsolated<Record<string, Report>>(script, dir, variants);
    for (const report of Object.values(reports)) {
      assert.ok(report.coverage.some(row => row.tool === 'pg_restore' && row.status === 'ok' && /após atualização, invariante preservado/.test(row.detail)));
      for (const tool of ['pg_stat_statements', 'EXPLAIN', 'dexter']) {
        for (const file of ['good.sql', 'empty.sql', 'bad.sql', 'out.sql']) {
          assert.ok(report.coverage.some(row => row.tool === tool && row.detail.includes(file)), `${tool}: ${file}`);
        }
      }
      for (const tool of ['pg_stat_statements', 'EXPLAIN']) {
        assert.ok(report.coverage.some(row => row.tool === tool && row.status === 'ok'
          && row.files?.includes('banco/queries/good.sql') && /good.sql: linha 4;/.test(row.detail)));
      }
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

test('saída do coletor distingue rejeição no lote de três arquivos e cancelamento no commit', {
  skip: skipPostgres, timeout: 90_000,
}, () => {
  const rejected = runIsolated<Report>(collect, join(fixtures, 'r5-commit/rejected'));
  assert.ok(rejected.coverage.some(row => row.status === 'ok'
    && /pg-migrate:fresh: lote rejeitado no commit.*origem atribuída a db\/migrations\/002_data.sql.*SQLSTATE 23503/.test(row.detail)));
  assert.ok(rejected.coverage.every(row => row.status !== 'failed'));
  assert.ok(rejected.findings.some(f => f.rule === 'BANCO-MIGRACAO-REJEITADA' && f.file.endsWith('002_data.sql')
    && /SQLSTATE 23503.*lote de 3 arquivos.*003_tail.sql.*diagnóstico da execução original e único arquivo com inserções/.test(f.evidence)));
  assert.ok(rejected.findings.every(f => f.rule !== 'BANCO-MIGRACAO-REJEITADA' || f.file.endsWith('002_data.sql')));
  const canceled = runIsolated<Report>(collect, join(fixtures, 'r4-commit/canceled'));
  assert.ok(canceled.coverage.some(row => row.status === 'failed'
    && /pg-migrate:fresh: medição interrompida no commit.*SQLSTATE 57014/.test(row.detail)));
  assert.ok(canceled.findings.every(f => !['BANCO-MIGRACAO-REJEITADA', 'BANCO-LOTE-MIGRACAO-REJEITADO'].includes(f.rule)));
  for (const report of [rejected, canceled]) {
    const files = ['001_schema.sql', '002_data.sql'];
    if (report === rejected) files.push('003_tail.sql');
    for (const name of files) {
      assert.ok(report.coverage.some(row => row.status === 'skipped'
        && row.detail.startsWith(`pg-migrate:fresh:db/migrations/${name}:`)));
      assert.ok(report.coverage.every(row => !row.detail.startsWith(`pg-migrate:fresh:db/migrations/${name}:`)
        || !row.files?.length));
    }
  }
  assert.doesNotMatch(JSON.stringify([rejected, canceled]), /424242|INSERT INTO/);
});

test('rejeições ambíguas preservam o ponto de detecção e usam uma única execução do lote', {
  skip: skipPostgres, timeout: 90_000,
}, () => {
  const result = runIsolated<Record<string, Report>>(String.raw`
    require 'dexter'
    schema = <<~SQL
      CREATE TABLE parent (id integer PRIMARY KEY);
      CREATE TABLE child (id integer REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    SQL
    builtin_schema = <<~SQL
      CREATE TABLE parent (label text, id uuid, PRIMARY KEY (label, id));
      CREATE TABLE child (label "text", id UUID,
        FOREIGN KEY (label, id) REFERENCES parent(label, id) DEFERRABLE INITIALLY DEFERRED);
    SQL
    builtin_insert = "INSERT INTO child VALUES ('sintético', '00000000-0000-0000-0000-000000000001');"
    cases = {
      replacement: [schema,
        'INSERT INTO child VALUES (42);',
        'DELETE FROM child WHERE id = 42;',
        'INSERT INTO child VALUES (42);',
        'SELECT 1;'
      ],
      parent_removal: [schema,
        'INSERT INTO parent VALUES (42);',
        'INSERT INTO child VALUES (42);',
        'DELETE FROM parent WHERE id = 42;',
        'SET CONSTRAINTS ALL IMMEDIATE;'
      ],
      conditional: [schema,
        "DO $$ BEGIN IF current_database() <> 'fresh' THEN INSERT INTO child VALUES (42); END IF; END $$;",
        'SELECT 1;',
        "DO $$ BEGIN IF current_database() = 'fresh' THEN INSERT INTO child VALUES (42); END IF; END $$;",
        'SELECT 1;'
      ],
      builtin_commit: [builtin_schema, builtin_insert, 'SELECT 1;'],
      builtin_early: [builtin_schema, builtin_insert, 'SET /* checagem */ CONSTRAINTS ALL IMMEDIATE;'],
      builtin_two_writers: [builtin_schema, builtin_insert, builtin_insert, 'SELECT 1;'],
      type_path: [
        "SET LOCAL search_path = public, pg_catalog; #{builtin_schema}",
        builtin_insert, 'SELECT 1;'
      ],
      type_qualified: [
        builtin_schema.gsub(/\buuid\b/i, 'public.uuid'),
        builtin_insert, 'SELECT 1;'
      ],
    }
    reports = {}
    Dir.mktmpdir('c5-r6-', '/tmp') do |dir|
      db = Banco::Database.new(dir, Banco::Report.new)
      begin
        db.start
        db.connect('fresh') do |connection|
          connection.exec('CREATE DOMAIN public.text AS pg_catalog.text; CREATE DOMAIN public.uuid AS pg_catalog.uuid;')
        end
        connections = []
        executed = []
        db.define_singleton_method(:connect) do |name, **options, &block|
          connections << name
          super(name, **options) do |connection|
            connection.define_singleton_method(:exec) do |sql|
              executed << sql
              super(sql)
            end
            block.call(connection)
          end
        end
        cases.each do |name, commands|
          report = Banco::Report.new
          db.instance_variable_set(:@report, report)
          sources = commands.map.with_index(1) do |sql, index|
            Banco::Source.new(format('db/migrations/%03d_%s.sql', index, name), sql)
          end
          connections.clear
          executed.clear
          raise "unexpected commit for #{name}" if db.migrate('fresh', sources)
          raise "unexpected connections for #{name}: #{connections}" unless connections == ['fresh']
          expected = ['BEGIN', *sources.map(&:sql)]
          expected << 'COMMIT' unless %i[parent_removal builtin_early].include?(name)
          expected << 'ROLLBACK'
          raise "unexpected SQL execution sequence for #{name}" unless executed == expected
          reports[name] = JSON.parse(report.to_json)
        end
      ensure
        db.stop
      end
    end
    puts JSON.generate(reports)
  `);
  for (const [scenario, detection, count] of [
    ['replacement', 'detecção no commit', 5],
    ['parent_removal', 'detecção em SET CONSTRAINTS IMMEDIATE na linha 1', 5],
    ['conditional', 'detecção no commit', 5],
    ['builtin_two_writers', 'detecção no commit', 4],
    ['type_path', 'detecção no commit', 3],
    ['type_qualified', 'detecção no commit', 3],
  ] as const) {
    const report = result[scenario];
    assert.equal(report.findings.length, 1, scenario);
    const [finding] = report.findings;
    assert.equal(finding.rule, 'BANCO-LOTE-MIGRACAO-REJEITADO', scenario);
    assert.equal(finding.file, `db/migrations/00${count}_${scenario}.sql`, scenario);
    assert.ok(finding.evidence.includes(`SQLSTATE 23503; ${detection}`), scenario);
    assert.match(finding.evidence, new RegExp(`lote de ${count} arquivos.*origem entre arquivos indeterminada.*último arquivo alcançado`));
    assert.ok(report.coverage.some(row => row.status === 'ok' && /lote rejeitado.*origem entre arquivos indeterminada/.test(row.detail)), scenario);
    assert.ok(report.coverage.every(row => row.status !== 'failed' && !row.files?.length), scenario);
  }
  for (const [scenario, detection] of [
    ['builtin_commit', 'detecção no commit'],
    ['builtin_early', 'detecção em SET CONSTRAINTS IMMEDIATE na linha 1'],
  ] as const) {
    const report = result[scenario];
    assert.equal(report.findings.length, 1, scenario);
    const [finding] = report.findings;
    const origin = `db/migrations/002_${scenario}.sql`;
    assert.equal(finding.rule, 'BANCO-MIGRACAO-REJEITADA', scenario);
    assert.equal(finding.file, origin, scenario);
    assert.ok(finding.evidence.includes(`SQLSTATE 23503; ${detection}`), scenario);
    assert.match(finding.evidence, /execução original e único arquivo com inserções/);
    assert.ok(report.coverage.some(row => row.status === 'ok' && row.detail.includes(`origem atribuída a ${origin}`)), scenario);
    assert.ok(report.coverage.every(row => row.status !== 'failed' && !row.files?.length), scenario);
  }
  assert.doesNotMatch(JSON.stringify(result), /INSERT INTO|DELETE FROM|current_database|inline_code_block|00000000-0000/);
});

test('diagnóstico de SET CONSTRAINTS distingue resolução direta, checagem diferida e texto em quadros SQL', {
  skip: skipPostgres, timeout: 90_000,
}, () => {
  const result = runIsolated<Record<string, Report>>(String.raw`
    require 'dexter'
    pending = <<~SQL
      CREATE TABLE parent (id integer PRIMARY KEY);
      CREATE TABLE child (id integer CONSTRAINT child_fk
        REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
      INSERT INTO child VALUES (42);
    SQL
    cases = {
      schema: [pending, <<~'SQL'],
        SELECT 'ação';
        /* resolução */
        SET CONSTRAINTS "falta""esquema"."falta.constraint" IMMEDIATE;
      SQL
      constraint: [pending, <<~'SQL'],
        SELECT 'SET CONSTRAINTS';
        SET /* ação */ CONSTRAINTS public."falta""constraint" IMMEDIATE;
      SQL
      catalog: [pending, "SET CONSTRAINTS absent.public.child_fk IMMEDIATE;"],
      schema_acl: [
        "CREATE SCHEMA restricted; REVOKE USAGE ON SCHEMA restricted FROM projeto;",
        "SET CONSTRAINTS restricted.child_fk IMMEDIATE;"
      ],
      nondeferrable: [
        "CREATE TABLE task (id integer CONSTRAINT task_unique UNIQUE);",
        "SET CONSTRAINTS public.task_unique DEFERRED;"
      ],
      inline_schema: [pending, <<~'SQL'],
        SELECT 'ação';
        /* o bloco começa na terceira linha */
        DO $$ BEGIN
          SET /* comentário "
        SQL statement "SELECT 1"
        PL/pgSQL function inline_code_block line 99 at SQL statement
            /* comentário interno */ */
          CONSTRAINTS "falta""esquema"."falta.constraint" IMMEDIATE;
        END $$;
      SQL
      execute_schema: [pending, <<~'SQL'],
        DO $$ BEGIN
          EXECUTE $cmd$SELECT 1;
            SET CONSTRAINTS "falta
        SQL statement ""SELECT 1"""."falta.constraint" IMMEDIATE;$cmd$;
        END $$;
      SQL
      nested_do: [pending, <<~'SQL'],
        SELECT 1;
        DO $$ BEGIN
          EXECUTE $cmd$DO $inner$ BEGIN
            SET CONSTRAINTS "falta""esquema".child_fk DEFERRED;
          END $inner$;$cmd$;
        END $$;
      SQL
      timeout_schema: [pending, <<~'SQL'],
        SET LOCAL statement_timeout = '15s';
        SET CONSTRAINTS falta.child_fk IMMEDIATE;
      SQL
      repeated_names: [pending, <<~'SQL'],
        SET LOCAL statement_timeout = '15s';
        SET CONSTRAINTS falta.child_fk IMMEDIATE;
        SET CONSTRAINTS falta.child_fk IMMEDIATE;
      SQL
      repeated_blocks: [pending, <<~'SQL'],
        SELECT 1;
        DO $$ BEGIN SET CONSTRAINTS falta.child_fk IMMEDIATE; END $$;
        DO $$ BEGIN SET CONSTRAINTS falta.child_fk IMMEDIATE; END $$;
      SQL
      unpositioned: [pending, <<~'SQL'],
        -- referência no primeiro comando
        SELECT 1;
        CREATE TYPE falta.ty AS ENUM ('a');
      SQL
      cursor: [pending, <<~'SQL'],
        SELECT 'ação';
        SELECT 'a'::falta.tipo;
        SET CONSTRAINTS falta.child_fk IMMEDIATE;
      SQL
      raise_message: [pending, <<~'SQL'],
        SELECT 'ação';
        DO $$ BEGIN
          RAISE SQLSTATE '3F000' USING MESSAGE = 'SET CONSTRAINTS synthetic-private';
        END $$;
        SET CONSTRAINTS falta.child_fk IMMEDIATE;
      SQL
      comment_frame: [<<~'SQL', <<~'QUERY'],
        CREATE FUNCTION failed_query() RETURNS int LANGUAGE plpgsql AS $$
        BEGIN
          RAISE SQLSTATE '3F000' USING MESSAGE = 'SET CONSTRAINTS synthetic-private';
        END $$;
      SQL
        DO $$ BEGIN
          EXECUTE $cmd$SELECT failed_query() /* comentário "
        SQL statement "SET CONSTRAINTS ALL IMMEDIATE"
        PL/pgSQL function inline_code_block line 99 at SQL statement
          */$cmd$;
        END $$;
      QUERY
      fk_check: [pending, <<~'SQL'],
        DO $$ BEGIN
          SET /* resolução */ CONSTRAINTS public.child_fk IMMEDIATE;
        END $$;
      SQL
      line_comment: [pending, <<~'SQL'],
        DO $$ BEGIN
          EXECUTE $cmd$SET -- checagem da restrição "
          CONSTRAINTS ALL IMMEDIATE;$cmd$;
        END $$;
      SQL
      trailing_comment: [pending, <<~'SQL'],
        DO $$ BEGIN
          EXECUTE $cmd$SET CONSTRAINTS ALL IMMEDIATE; -- checagem$cmd$;
        END $$;
      SQL
      nested_check: [pending, <<~'SQL'],
        DO $$ BEGIN
          EXECUTE $cmd$DO $inner$ BEGIN
            SET CONSTRAINTS ALL IMMEDIATE;
          END $inner$;$cmd$;
        END $$;
      SQL
      quoted_routine: [<<~'SQL', 'INSERT INTO task VALUES (1);', 'DO $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; END $$;'],
        CREATE TABLE task (id integer);
        CREATE FUNCTION "check""task"(integer) RETURNS integer LANGUAGE sql SET search_path = public AS $$
          SELECT $1 / 0;
        $$;
        CREATE FUNCTION "check""task"(text) RETURNS integer LANGUAGE sql SET search_path = public AS $$
          SELECT "check""task"($1::integer);
        $$;
        CREATE FUNCTION "check
        task"(text) RETURNS integer LANGUAGE sql SET search_path = public AS $$
          SELECT "check""task"($1);
        $$;
        CREATE FUNCTION check_task() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM "check
        task"(NEW.id::text);
          RETURN NEW;
        END $$;
        CREATE CONSTRAINT TRIGGER deferred_task AFTER INSERT ON task
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_task();
      SQL
      trigger_schema: [<<~'SQL', 'INSERT INTO task VALUES (1);', 'DO $$ BEGIN SET CONSTRAINTS ALL IMMEDIATE; END $$;'],
        CREATE TABLE task (id integer);
        CREATE FUNCTION check_task() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          SET /* resolução */ CONSTRAINTS falta.constraint DEFERRED;
          RETURN NEW;
        END $$;
        CREATE CONSTRAINT TRIGGER deferred_task AFTER INSERT ON task
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_task();
      SQL
      mixed: [pending, "CREATE TYPE falta.ty AS ENUM ('a'); SET CONSTRAINTS ALL IMMEDIATE;"]
    }
    reports = {}
    Dir.mktmpdir('c5-r8-', '/tmp') do |dir|
      db = Banco::Database.new(dir, Banco::Report.new)
      begin
        db.start
        connections = []
        executed = []
        db.define_singleton_method(:connect) do |name, **options, &block|
          connections << name
          super(name, **options) do |connection|
            connection.define_singleton_method(:exec) do |sql|
              executed << sql
              super(sql)
            end
            block.call(connection)
          end
        end
        cases.each do |name, commands|
          report = Banco::Report.new
          db.instance_variable_set(:@report, report)
          sources = commands.map.with_index(1) do |sql, index|
            Banco::Source.new(format('db/migrations/%03d_%s.sql', index, name), sql)
          end
          connections.clear
          executed.clear
          raise "unexpected commit for #{name}" if db.migrate('fresh', sources)
          raise "unexpected connections for #{name}" unless connections == ['fresh']
          raise "unexpected SQL execution sequence for #{name}" unless executed == ['BEGIN', *commands, 'ROLLBACK']
          reports[name] = JSON.parse(report.to_json)
        end
      ensure
        db.stop
      end
    end
    puts JSON.generate(reports)
  `);
  for (const [scenario, code, line] of [
    ['schema', '3F000', 3], ['constraint', '42704', 2], ['catalog', '0A000', 1],
    ['schema_acl', '42501', 1], ['nondeferrable', '42809', 1],
    ['inline_schema', '3F000', 3], ['cursor', '3F000', 2], ['timeout_schema', '3F000', 2],
  ] as const) {
    const report = result[scenario];
    const path = `db/migrations/002_${scenario}.sql`;
    assert.deepEqual(report.findings, [{rule: 'BANCO-MIGRACAO-REJEITADA', tool: 'pg-migrate', severity: 'alta',
      file: path, line, message: 'A migração foi rejeitada no cenário fresh.', evidence: scenario === 'cursor'
        ? `SQLSTATE ${code}; linha indicada pelo cursor do servidor`
        : `SQLSTATE ${code}; linha inicial da instrução; posição exata indisponível`}], scenario);
    assert.ok(report.coverage.some(row => row.status === 'ok' && row.detail.includes(`${path}: rejeitada (SQLSTATE ${code})`)), scenario);
  }
  for (const [scenario, file, code, detection] of [
    ['fk_check', '002_fk_check.sql', '23503', /detecção em SET CONSTRAINTS chamado pelo arquivo/],
    ['line_comment', '002_line_comment.sql', '23503', /detecção em SET CONSTRAINTS chamado pelo arquivo/],
    ['trailing_comment', '002_trailing_comment.sql', '23503', /detecção em SET CONSTRAINTS chamado pelo arquivo/],
    ['nested_check', '002_nested_check.sql', '23503', /cobertura parcial da origem; pilha com vários quadros de SQL/],
    ['execute_schema', '002_execute_schema.sql', '3F000', /cobertura parcial da origem; quadro de SQL sem instrução única verificável/],
    ['nested_do', '002_nested_do.sql', '3F000', /cobertura parcial da origem; pilha com vários quadros de SQL/],
    ['repeated_blocks', '002_repeated_blocks.sql', '3F000', /cobertura parcial da origem; origem do comando interno inconclusiva/],
    ['raise_message', '002_raise_message.sql', '3F000', /cobertura parcial da origem; origem do comando interno inconclusiva/],
    ['comment_frame', '002_comment_frame.sql', '3F000', /cobertura parcial da origem; origem do comando interno inconclusiva/],
    ['quoted_routine', '003_quoted_routine.sql', '22012', /pilha com vários quadros de SQL.*SET CONSTRAINTS IMMEDIATE pode ter antecipado/],
    ['trigger_schema', '003_trigger_schema.sql', '3F000', /pilha com vários quadros de SQL.*SET CONSTRAINTS IMMEDIATE pode ter antecipado/],
    ['mixed', '002_mixed.sql', '3F000', /SET CONSTRAINTS IMMEDIATE pode ter antecipado/],
  ] as const) {
    const report = result[scenario];
    assert.equal(report.findings.length, 1, scenario);
    const [finding] = report.findings;
    assert.equal(finding.rule, 'BANCO-LOTE-MIGRACAO-REJEITADO', scenario);
    assert.equal(finding.file, 'db/migrations/' + file, scenario);
    assert.match(finding.evidence, new RegExp('SQLSTATE ' + code));
    assert.match(finding.evidence, detection);
    assert.match(finding.evidence, /origem entre arquivos indeterminada/);
  }
  for (const [scenario, reference] of [['repeated_names', 1], ['unpositioned', 2]] as const) {
    assert.equal(result[scenario].findings.length, 1, scenario);
    const [finding] = result[scenario].findings;
    assert.equal(finding.rule, 'BANCO-MIGRACAO-REJEITADA', scenario);
    assert.equal(finding.file, `db/migrations/002_${scenario}.sql`);
    assert.equal(finding.line, reference, scenario);
    assert.match(finding.evidence, /SQLSTATE 3F000; posição exata indisponível; linha de referência do arquivo/);
  }
  for (const report of Object.values(result)) {
    assert.ok(report.coverage.every(row => row.status !== 'failed' && !row.files?.length));
  }
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|inline_code_block|SQL statement|falta\.constraint|failed_query/);
});

test('coletor atribui as medições e o candidato Dexter e valida o controle limpo com Squawk', {
  skip: skipPostgres, timeout: 90_000,
}, () => {
  const clean = runIsolated<Report>(collect, join(fixtures, 'clean'));
  const defective = runIsolated<Report>(collect, join(fixtures, 'defective'));
  assert.ok(clean.coverage.every(row => row.status !== 'failed'));
  assert.ok(clean.coverage.some(row => row.status === 'ok' && /pg_restore:upgraded:.*após atualização, invariante preservado/.test(row.detail)));
  assert.deepEqual(clean.findings, []);
  const lint = clean.coverage.filter(row => row.tool === 'squawk');
  assert.equal(lint.length, 2);
  assert.ok(lint.every(row => row.status === 'ok' && row.files?.length === 1 && /: 0 alertas$/.test(row.detail)));
  for (const report of [defective, clean]) {
    for (const file of ['banco/queries/by-code.sql', 'banco/queries/latency.sql']) {
      for (const tool of ['pg_stat_statements', 'EXPLAIN']) {
        assert.ok(report.coverage.some(row => row.tool === tool && row.status === 'ok'
          && row.files?.includes(file) && row.detail.includes(file + ': linha 2;')), tool + ' / ' + file);
      }
    }
  }
  const query = 'banco/queries/latency.sql';
  const digest = createHash('sha256').update(readFileSync(join(fixtures, 'defective', query))).digest('hex');
  const slow = defective.findings.find(f => f.rule === 'BANCO-CONSULTA-LENTA' && f.file === query);
  assert.ok(slow);
  assert.ok(defective.coverage.some(row => row.tool === 'pg_stat_statements' && row.status === 'ok'
    && row.detail === `pg_stat_statements:query:${query}: linha ${slow.line}; ${slow.evidence} | SQL medido (sha256:${digest})`));
  assert.ok(defective.coverage.some(row => row.tool === 'dexter' && row.status === 'ok'
    && row.files?.includes('banco/queries/by-code.sql') && /by-code.sql: linha 2; planos hipotéticos comparados/.test(row.detail)));
  const finding = defective.findings.find(f => f.rule === 'BANCO-INDICE-CANDIDATO');
  assert.equal(finding?.file, 'banco/queries/by-code.sql');
  assert.equal(finding.line, 2);
  const costs = /redução estimada de ([\d.]+) para ([\d.]+).*public\.items \/ item_code/.exec(finding.evidence);
  assert.ok(costs, finding.evidence);
  assert.ok(Number(costs[2]) < Number(costs[1]) * 0.5);
});
