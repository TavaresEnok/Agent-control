# frozen_string_literal: true

require "digest"
require "json"
require "open3"
require "tmpdir"

module Banco
  PG_VERSION = "17.12"
  VERSIONS = {
    "squawk" => "2.73.0",
    "pg-migrate" => PG_VERSION,
    "pg_restore" => PG_VERSION,
    "pg_stat_statements" => "1.11 (PostgreSQL #{PG_VERSION})",
    "EXPLAIN" => PG_VERSION,
    "dexter" => "0.6.3 (HypoPG 1.4.1)"
  }.freeze
  DB_TOOLS = VERSIONS.keys - ["squawk"]
  MAX_SQL_BYTES = 256 * 1024
  MAX_FINDINGS = 999
  MAX_QUERIES = 40
  MAX_QUERY_ISSUES = 40
  SAMPLES = 3
  SLOW_MS = 100
  MIGRATION_NAME = /\A\d+_[a-zA-Z0-9_.-]+\.sql\z/
  QUERY_NAME = /\A[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.sql\z/
  SEED = "banco/seed.sql"
  WORKLOAD_SEED = "banco/workload.sql"
  ASSERTION = "banco/assert.sql"
  Source = Struct.new(:path, :sql) do
    def line
      sql.lines.index { |text| !text.strip.empty? && !text.lstrip.start_with?("--") }.to_i + 1
    end
  end

  class ToolError < StandardError; end

  class Inventory
    def initialize(root)
      @root = root
    end

    def load(relative)
      path = checked_path(relative)
      return unless path

      raise ToolError, "entrada deve ser um arquivo regular: #{relative}" unless File.file?(path)

      sql = (File.binread(path, MAX_SQL_BYTES + 1) || String.new).force_encoding(Encoding::UTF_8)
      unless sql.bytesize.between?(1, MAX_SQL_BYTES) && sql.valid_encoding? && !sql.include?("\0")
        raise ToolError, "arquivo vazio, não UTF-8 ou maior que 256 KiB: #{relative}"
      end
      Source.new(relative, sql)
    end

    def list(relative, pattern, maximum)
      path = checked_path(relative)
      return [] unless path

      raise ToolError, "entrada deve ser um diretório: #{relative}" unless File.directory?(path)

      names = []
      Dir.each_child(path) do |name|
        next unless name.end_with?(".sql")

        unless name.bytesize <= 160 && name.ascii_only? && pattern.match?(name)
          raise ToolError, "nome SQL fora da convenção em #{relative}"
        end
        names << name
        raise ToolError, "limite de #{maximum} arquivos SQL em #{relative}" if names.size > maximum
      end
      names.sort.map { |name| load("#{relative}/#{name}") }
    end

    # Um arquivo de consulta defeituoso não invalida os demais.
    def queries
      relative = "banco/queries"
      path = checked_path(relative)
      return [] unless path
      raise ToolError, "entrada deve ser um diretório: #{relative}" unless File.directory?(path)

      sources = []
      issues = []
      omitted_invalid = 0
      omitted_excess = 0
      Dir.children(path).select { |name| name.end_with?(".sql") }.sort.each do |name|
        display = "#{relative}/#{name.dump}"
        begin
          raise ToolError, "nome SQL fora da convenção" unless name.bytesize <= 160 && name.ascii_only? && QUERY_NAME.match?(name)
          if sources.size >= MAX_QUERIES
            if issues.size < MAX_QUERY_ISSUES
              issues << [display, "entrada excedente ao limite de #{MAX_QUERIES} consultas; conteúdo não avaliado"]
            else
              omitted_excess += 1
            end
            next
          end

          source = load("#{relative}/#{name}")
          raise ToolError, "arquivo desapareceu" unless source
          yield source if block_given?
          sources << source
        rescue ToolError, SystemCallError => error
          if issues.size < MAX_QUERY_ISSUES
            issues << [display, error.is_a?(ToolError) ? error.message : error.class.name]
          else
            omitted_invalid += 1
          end
        end
      end
      if omitted_invalid.positive?
        issues << [relative, "#{omitted_invalid} entradas inválidas adicionais omitidas da cobertura individual"]
      end
      if omitted_excess.positive?
        issues << [relative, "Entradas excedentes adicionais ao limite de #{MAX_QUERIES} consultas (#{omitted_excess}); conteúdo não avaliado"]
      end
      sources + issues
    end

    private

    def checked_path(relative)
      path = @root
      relative.split("/").each do |part|
        path = File.join(path, part)
        raise ToolError, "link simbólico recusado: #{relative}" if File.lstat(path).symlink?
      end
      path
    rescue Errno::ENOENT
      nil
    end
  end

  class Report
    attr_reader :coverage, :findings

    def initialize
      @coverage = []
      @findings = []
      @truncated = false
    end

    def cover(tool, status, detail, files: nil)
      row = {tool: tool, version: VERSIONS.fetch(tool), status: status, detail: detail}
      row[:files] = files if files
      coverage << row
    end

    def find(tool, rule, source, severity, message, evidence, line: source.line)
      if findings.size < MAX_FINDINGS
        findings << {tool: tool, rule: rule, file: source.path, line: line, severity: severity,
                     message: message, evidence: evidence}
      elsif !@truncated
        @truncated = true
        cover(tool, "failed", "Limite de #{MAX_FINDINGS} achados atingido; saída parcial.")
      end
    end

    def measure(tool, detail)
      yield
    rescue ToolError => error
      cover(tool, "failed", "#{detail}: #{error.message}")
      nil
    rescue StandardError => error
      cover(tool, "failed", "#{detail}: #{error.class}")
      nil
    end

    def to_json
      JSON.generate({coverage: coverage, findings: findings})
    end
  end

  def self.error_line(error, source, prefix: "")
    # O cursor de ambos os diagnósticos começa em 1 e conta caracteres UTF-8.
    position = if error.is_a?(PgQuery::ParseError)
      error.location
    elsif error.is_a?(PG::Error)
      error.result&.error_field(PG::Result::PG_DIAG_STATEMENT_POSITION)&.to_i
    end
    position -= prefix.length if position
    return source.line unless position && position.positive?

    source.sql[0, position - 1].count("\n") + 1
  end

  def self.select_only!(source)
    statements = PgQuery.parse(source.sql).tree.stmts
    raise ToolError, "é exigido um único SELECT" unless statements.size == 1 && statements.first.stmt.select_stmt
  rescue PgQuery::ParseError => error
    raise ToolError, "SELECT inválido para o parser PostgreSQL; linha #{error_line(error, source)}"
  end

  def self.statement_line(source, offset: 0)
    token = PgQuery.scan(source.sql).first.tokens.find do |entry|
      entry.start >= offset && !%i[SQL_COMMENT C_COMMENT ASCII_59].include?(entry.token)
    end
    token ? source.sql.byteslice(0, token.start).count("\n") + 1 : source.line
  end

  def self.lint(migrations, report, executable: "/usr/local/bin/squawk")
    report.measure("squawk", "Versão do executável") do
      output, _, status = Open3.capture3("timeout", "15s", executable, "--version", chdir: "/tmp")
      raise ToolError, "versão esperada #{VERSIONS.fetch('squawk')}" unless status.success? && output.split.last == VERSIONS.fetch("squawk")

      migrations.each do |source|
        report.measure("squawk", source.path) do
          out, _, status = Open3.capture3("timeout", "15s", executable,
            "--config", "/dev/null", "--assume-in-transaction", "--pg-version=#{PG_VERSION}", "--reporter=json",
            stdin_data: source.sql, chdir: "/tmp")
          unless [0, 1].include?(status.exitstatus)
            raise ToolError, "processo terminou com código #{status.exitstatus || 'sinal'}"
          end

          rows = JSON.parse(out)
          raise ToolError, "relatório inválido" unless rows.is_a?(Array) && (status.success? || !rows.empty?)

          rows.each do |row|
            rule = row.fetch("rule_name")
            line = row.fetch("line")
            column = row.fetch("column")
            unless rule.is_a?(String) && rule.match?(/\A[a-z][a-z0-9-]{0,120}\z/) &&
                line.is_a?(Integer) && line.between?(0, source.sql.count("\n")) &&
                column.is_a?(Integer) && column >= 0
              raise ToolError, "violação sem localização ou regra válida"
            end

            severity = {"Error" => "alta", "Warning" => "media"}.fetch(row.fetch("level"))
            report.find("squawk", "SQUAWK-#{rule.upcase}", source, severity,
              "Squawk sinalizou a regra #{rule} na migração.", "Regra #{rule}; coluna #{column + 1}; migração analisada em modo transacional.",
              line: line + 1)
          end
          report.cover("squawk", "ok", "squawk:file:#{source.path}: #{rows.size} alertas", files: [source.path])
        end
      end
    end
  end

  # Prova suficiente de escritor único, limitada a tabelas criadas neste lote.
  # Comandos fora deste subconjunto invalidam a prova para o lote inteiro.
  class DeclarativeWriters
    PLAIN_TYPES = %w[int2 int4 int8 bool text uuid].freeze
    SIMPLE_CONSTRAINTS = %i[CONSTR_NULL CONSTR_NOTNULL CONSTR_PRIMARY CONSTR_UNIQUE
      CONSTR_ATTR_DEFERRABLE CONSTR_ATTR_NOT_DEFERRABLE CONSTR_ATTR_DEFERRED CONSTR_ATTR_IMMEDIATE].freeze
    SIMPLE_SELECT = {limit_option: :LIMIT_OPTION_DEFAULT, op: :SETOP_NONE}.freeze

    def initialize
      @tables = {}
    end

    def observe(source, statements)
      return unless @tables

      @tables = nil unless statements.all? { |entry| declarative?(source, entry.stmt) }
    end

    def origin(error)
      diagnostic = error.result
      return unless @tables && diagnostic &&
        diagnostic.error_field(PG::Result::PG_DIAG_SQLSTATE) == "23503" &&
        diagnostic.error_field(PG::Result::PG_DIAG_SOURCE_FUNCTION) == "ri_ReportViolation" &&
        diagnostic.error_field(PG::Result::PG_DIAG_SCHEMA_NAME) == "public" &&
        diagnostic.error_field(PG::Result::PG_DIAG_CONSTRAINT_NAME)

      writers = @tables[diagnostic.error_field(PG::Result::PG_DIAG_TABLE_NAME)]
      writers.first if writers&.one?
    end

    private

    def declarative?(source, statement)
      if (create = statement.create_stmt)
        table = public_table(create.relation)
        return false unless table && !@tables.key?(table) && plain_create?(create, table)

        @tables[table] = []
      elsif (insert = statement.insert_stmt)
        writers = @tables[public_table(insert.relation)]
        return false unless writers && literal_insert?(insert)

        writers << source unless writers.last.equal?(source)
        true
      elsif (select = statement.select_stmt)
        select == PgQuery::SelectStmt.new(**SIMPLE_SELECT, target_list: select.target_list.to_a) &&
          select.target_list.all? { |node| node.res_target&.val&.a_const }
      else
        statement.constraints_set_stmt || timeout_setting?(statement.variable_set_stmt)
      end
    end

    def public_table(relation)
      if relation && ["", "public"].include?(relation.schemaname) &&
          relation.catalogname.empty? && relation.relpersistence == "p" && !relation.alias
        relation.relname
      end
    end

    def plain_create?(create, table)
      return false unless create == PgQuery::CreateStmt.new(relation: create.relation,
        table_elts: create.table_elts.to_a, oncommit: :ONCOMMIT_NOOP)

      create.table_elts.all? do |entry|
        entry.column_def ? plain_column?(entry.column_def, table) : plain_constraint?(entry.constraint, table)
      end
    end

    def plain_column?(column, table)
      type = column.type_name
      names = type&.names&.map { |node| node.string&.sval }
      names && names.size == 2 && names.first == "pg_catalog" && PLAIN_TYPES.include?(names.last) &&
        type.array_bounds.empty? && type.typmods.empty? && !type.pct_type && !type.setof &&
        column == PgQuery::ColumnDef.new(colname: column.colname, type_name: type, is_local: true,
          constraints: column.constraints.to_a, location: column.location) &&
        column.constraints.all? { |node| plain_constraint?(node.constraint, table) }
    end

    def plain_constraint?(constraint, table)
      return false unless constraint

      attributes = {contype: constraint.contype, conname: constraint.conname, location: constraint.location,
                    deferrable: constraint.deferrable, initdeferred: constraint.initdeferred}
      if SIMPLE_CONSTRAINTS.include?(constraint.contype)
        return constraint == PgQuery::Constraint.new(**attributes, keys: constraint.keys.to_a)
      end
      return false unless constraint.contype == :CONSTR_FOREIGN &&
        constraint == PgQuery::Constraint.new(**attributes, initially_valid: true, pktable: constraint.pktable,
          fk_attrs: constraint.fk_attrs.to_a, pk_attrs: constraint.pk_attrs.to_a,
          fk_matchtype: "s", fk_upd_action: "a", fk_del_action: "a")

      parent = public_table(constraint.pktable)
      parent == table || @tables.key?(parent)
    end

    def literal_insert?(insert)
      return false unless insert == PgQuery::InsertStmt.new(relation: insert.relation,
        cols: insert.cols.to_a, select_stmt: insert.select_stmt, override: :OVERRIDING_NOT_SET)
      return false unless insert.cols.all? { |node| node.res_target&.indirection&.empty? }

      values = insert.select_stmt&.select_stmt
      values && !values.values_lists.empty? &&
        values == PgQuery::SelectStmt.new(**SIMPLE_SELECT, values_lists: values.values_lists.to_a) &&
        values.values_lists.all? { |row| row.list&.items&.all? { |node| node.a_const } }
    end

    def timeout_setting?(setting)
      setting && %w[lock_timeout statement_timeout].include?(setting.name) &&
        setting.kind == :VAR_SET_VALUE && setting.args.one? && setting.args.first.a_const
    end
  end

  class Database
    def initialize(directory, report)
      @directory = directory
      @data = File.join(directory, "data")
      @report = report
    end

    def run(*args)
      _, _, status = Open3.capture3("timeout", "90s", *args, chdir: @directory)
      raise ToolError, "#{args.first} terminou com código #{status.exitstatus || 'sinal'}" unless status.success?
    end

    def start
      run("initdb", "-D", @data, "-U", "banco_admin", "--no-locale", "--encoding=UTF8",
        "--auth-local=trust", "--auth-host=reject")
      options = [
        "-c listen_addresses=''", "-c unix_socket_directories=#{@directory}", "-c unix_socket_permissions=0700",
        "-c shared_preload_libraries=pg_stat_statements", "-c compute_query_id=on",
        "-c shared_buffers=32MB", "-c dynamic_shared_memory_type=mmap", "-c max_connections=12", "-c temp_file_limit=64MB",
        "-c autovacuum=off", "-c jit=off"
      ]
      run("pg_ctl", "-D", @data, "-l", File.join(@directory, "postgres.log"), "-w", "-t", "15",
        "-o", options.join(" "), "start")
      connect("postgres", admin: true) do |db|
        version = db.exec("SHOW server_version_num").getvalue(0, 0)
        raise ToolError, "versão inesperada do servidor" unless version == "170012"

        db.exec("CREATE ROLE projeto LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION")
        %w[fresh previous upgraded].each { |name| db.exec("CREATE DATABASE #{name} OWNER projeto") }
      end
    end

    def stop
      return unless File.file?(File.join(@data, "postmaster.pid"))

      run("pg_ctl", "-D", @data, "-m", "immediate", "-w", "-t", "15", "stop")
    end

    def connect(name, admin: false, readonly: false)
      args = connection_options
      args += " -c default_transaction_read_only=on" if readonly
      PG.connect(host: @directory, port: 5432, dbname: name,
        user: admin ? "banco_admin" : "projeto", connect_timeout: 4, options: args) do |db|
        db.set_notice_processor { |_message| }
        yield db
      end
    end

    def migrate(name, sources)
      connect(name) do |db|
        db.exec("BEGIN")
        writers = DeclarativeWriters.new
        sources.each_with_index do |source, index|
          begin
            statements = PgQuery.parse(source.sql).tree.stmts
            if statements.empty? || statements.any? { |entry| entry.stmt.transaction_stmt }
              raise ToolError, "esperado SQL de migração sem controle explícito de transação"
            end

            writers.observe(source, statements)
            db.exec(source.sql)
          rescue PG::Error, PgQuery::ParseError, ToolError => error
            evidence = error.is_a?(ToolError) ? error.message : sql_diagnostic(error)
            rejected = error.is_a?(PgQuery::ParseError) || (error.is_a?(PG::Error) && rejection?(error))
            rollback(db)
            sources.take(index).each do |prior|
              @report.cover("pg-migrate", "skipped", "pg-migrate:#{name}:#{prior.path}: transação não confirmada (#{evidence})")
            end
            detection = deferred_check_detection(error, source, statements) if rejected && error.is_a?(PG::Error)
            outcome = "execução interrompida (#{evidence})"
            if detection
              origin = report_batch_rejection(name, sources.take(index + 1), error, detection, writers.origin(error))
              outcome = "lote rejeitado (#{evidence}); #{detection}; #{origin}"
            elsif rejected
              @report.find("pg-migrate", "BANCO-MIGRACAO-REJEITADA", source, "alta",
                "A migração foi rejeitada no cenário #{name}.", evidence, line: migration_error_line(error, source, statements))
              outcome = "rejeitada (#{evidence})"
            end
            @report.cover("pg-migrate", rejected ? "ok" : "failed", "pg-migrate:#{name}:#{source.path}: #{outcome}; transação não confirmada")
            sources.drop(index + 1).each do |blocked|
              @report.cover("pg-migrate", "skipped", "pg-migrate:#{name}:#{blocked.path}: migração anterior não concluída")
            end
            return false
          end
        end
        begin
          db.exec("COMMIT")
        rescue PG::Error => error
          evidence = sql_diagnostic(error)
          rollback(db)
          rejected = rejection?(error)
          outcome = rejected ? "lote rejeitado no commit" : "medição interrompida no commit; confirmação indisponível"
          if rejected && !sources.empty?
            origin = report_batch_rejection(name, sources, error, "detecção no commit", writers.origin(error))
            outcome += "; #{origin}"
          end
          @report.cover("pg-migrate", rejected ? "ok" : "failed", "pg-migrate:#{name}: #{outcome} (#{evidence})")
          sources.each do |source|
            @report.cover("pg-migrate", "skipped", "pg-migrate:#{name}:#{source.path}: transação não confirmada; consulte o resultado do lote no commit")
          end
          return false
        end
      end
      sources.each do |source|
        @report.cover("pg-migrate", "ok", "pg-migrate:#{name}:#{source.path}: SQL aplicado e confirmado", files: [source.path])
      end
      @report.cover("pg-migrate", "ok", "pg-migrate:#{name}: commit de #{sources.size} migrações")
      true
    rescue PG::Error => error
      raise ToolError, sql_diagnostic(error)
    end

    def exercise_restore(migrations, seed, assertion)
      if migrations.size < 2
        @report.cover("pg_restore", "skipped", "São necessárias duas migrações para repartir histórico e atualização.")
        return
      end
      return @report.cover("pg_restore", "skipped", "A transação do prefixo histórico não foi confirmada.") unless migrate("previous", migrations[0...-1])

      if seed
        connect("previous") { |db| db.exec(seed.sql) }
        @report.cover("pg_restore", "ok", "pg_restore:previous:#{seed.path}: valores sintéticos inseridos")
      else
        @report.cover("pg_restore", "skipped", "banco/seed.sql ausente; a prova histórica cobre somente o conteúdo gerado pelo prefixo.")
      end
      baseline = assertion && check_assertion("previous", assertion)
      archive = File.join(@directory, "previous.dump")
      run("pg_dump", *client_args("previous"), "--format=custom", "--no-owner", "--no-privileges", "--file", archive)
      run("pg_restore", *client_args("upgraded"), "--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", archive)
      @report.cover("pg_restore", "ok", "pg_restore:upgraded: arquivo custom restaurado em banco vazio")
      check_assertion("upgraded", assertion) if baseline
      upgraded = migrate("upgraded", migrations.last(1))
      if baseline && upgraded
        check_assertion("upgraded", assertion, after_migration: true)
      elsif !assertion
        @report.cover("pg_restore", "skipped", "banco/assert.sql ausente; nenhum invariante de dados foi especificado.")
      end
    rescue PG::Error => error
      raise ToolError, sql_diagnostic(error)
    end

    def prepare_workload(seed)
      connect("fresh") do |db|
        if seed
          begin
            statements = PgQuery.parse(seed.sql).tree.stmts
            if statements.empty? || statements.any? { |entry| entry.stmt.transaction_stmt }
              raise ToolError, "carga deve ser SQL sem controle explícito de transação"
            end
            db.exec("BEGIN")
            db.exec(seed.sql)
            db.exec("COMMIT")
            @report.cover("EXPLAIN", "ok", "Carga #{seed.path} confirmada no esquema final.")
          rescue PG::Error, PgQuery::ParseError, ToolError => error
            rollback(db)
            detail = error.is_a?(ToolError) ? error.message : sql_diagnostic(error)
            @report.cover("EXPLAIN", "failed", "Carga #{seed.path} não confirmada: #{detail}; linha #{Banco.error_line(error, seed)} (linha inicial se posição indisponível). Medição continua sem essa carga.")
          end
        end
        db.exec("ANALYZE")
      end
      connect("fresh", admin: true) do |db|
        db.exec("CREATE SCHEMA banco_tools")
        db.exec("CREATE EXTENSION pg_stat_statements WITH SCHEMA banco_tools")
        db.exec("CREATE EXTENSION hypopg WITH SCHEMA banco_tools")
        db.exec("GRANT USAGE ON SCHEMA banco_tools TO projeto")
      end
    rescue PG::Error => error
      raise ToolError, sql_diagnostic(error)
    end

    def workload(source)
      @report.measure("EXPLAIN", source.path) do
        Banco.select_only!(source)
        line = Banco.statement_line(source)
        template = "EXPLAIN (VERBOSE, FORMAT JSON) "
        identifier = connect("fresh", readonly: true) do |db|
          JSON.parse(db.exec_params(template + source.sql, []).getvalue(0, 0)).first.fetch("Query Identifier")
        end
        @report.measure("pg_stat_statements", source.path) { observe(source, identifier, line: line) }
        @report.measure("EXPLAIN", source.path) { explain(source, line: line) }
        @report.measure("dexter", source.path) { advise(source, line: line) }
      rescue PG::Error => error
        %w[pg_stat_statements dexter].each do |tool|
          @report.cover(tool, "skipped", "#{source.path}: plano inicial indisponível")
        end
        raise ToolError, "#{sql_diagnostic(error)}; linha #{Banco.error_line(error, source, prefix: template)} (linha inicial se posição indisponível)"
      rescue ToolError
        %w[pg_stat_statements dexter].each do |tool|
          @report.cover(tool, "skipped", "#{source.path}: consulta fora do contrato")
        end
        raise
      end
    end

    private

    # Inclui RAISE EXCEPTION e os desvios de cardinalidade do SELECT INTO STRICT.
    def rejection?(error)
      code = sqlstate(error)
      code && code != "25P04" &&
        (%w[P0001 P0002 P0003].include?(code) || %w[0A 21 22 23 25 2B 2D 3D 3F 42 44].include?(code[0, 2]))
    end

    def sqlstate(error)
      error.result&.error_field(PG::Result::PG_DIAG_SQLSTATE)
    end

    def inline_constraint_command(context)
      # O comando pode ocupar várias linhas. Um segundo frame indica uma chamada indireta.
      match = context&.match(/\ASQL statement "(.*?)"\nPL\/pgSQL function inline_code_block line \d+ at SQL statement\z/m)
      return unless match && !match[1].match?(/^(?:PL\/pgSQL function|SQL function|SQL statement) /)

      statements = PgQuery.parse(match[1]).tree.stmts
      statements.first.stmt.constraints_set_stmt if statements.one?
    rescue PgQuery::ParseError
      nil
    end

    def direct_constraint_error?(error, statements)
      return false unless error.is_a?(PG::Error) && %w[42704 42809].include?(sqlstate(error)) &&
        error.result&.error_field(PG::Result::PG_DIAG_SOURCE_FUNCTION) == "AfterTriggerSetState"

      # Um gatilho de um arquivo anterior também pode chamar SET CONSTRAINTS.
      context = error.result.error_field(PG::Result::PG_DIAG_CONTEXT)
      if context
        statements.any? { |entry| entry.stmt.do_stmt } && inline_constraint_command(context)
      else
        statements.any? { |entry| entry.stmt.constraints_set_stmt }
      end
    end

    def migration_error_line(error, source, statements)
      if direct_constraint_error?(error, statements) && !error.result.error_field(PG::Result::PG_DIAG_CONTEXT)
        commands = statements.select { |entry| entry.stmt.constraints_set_stmt }
        return Banco.statement_line(source, offset: commands.first.stmt_location) if commands.one?
      end
      Banco.error_line(error, source)
    end

    def deferred_check_detection(error, source, statements)
      return if direct_constraint_error?(error, statements)

      # A checagem também pode ser disparada por PL/pgSQL. O contexto bruto fica fora da saída.
      context = error.result&.error_field(PG::Result::PG_DIAG_CONTEXT)
      if context&.match?(/^SQL statement "[[:space:]]*SET[[:space:]]+CONSTRAINTS\b/i)
        return "detecção em SET CONSTRAINTS chamado pelo arquivo; posição externa indisponível"
      end

      immediate = statements.select { |entry| entry.stmt.constraints_set_stmt&.deferred == false }
      return if immediate.empty?

      if statements.one?
        return "detecção em SET CONSTRAINTS IMMEDIATE na linha #{Banco.statement_line(source)}"
      end

      position = error.result&.error_field(PG::Result::PG_DIAG_STATEMENT_POSITION)&.to_i
      unless position&.positive?
        return "detecção durante a execução do arquivo; SET CONSTRAINTS IMMEDIATE pode ter antecipado a checagem de alterações anteriores"
      end

      # Os limites dos comandos na árvore são offsets em bytes.
      offset = source.sql[0, position - 1].bytesize
      if immediate.any? { |entry| offset >= entry.stmt_location && (entry.stmt_len.zero? || offset <= entry.stmt_location + entry.stmt_len) }
        "detecção em SET CONSTRAINTS IMMEDIATE na linha #{Banco.error_line(error, source)}"
      end
    end

    def report_batch_rejection(name, sources, error, detection, origin)
      evidence = "#{sql_diagnostic(error)}; #{detection}; lote de #{sources.size} arquivos " \
        "(#{sources.first.path} até #{sources.last.path}, inclusive, em ordem lexicográfica)"
      if origin
        @report.find("pg-migrate", "BANCO-MIGRACAO-REJEITADA", origin, "alta",
          "A violação de chave estrangeira do lote foi atribuída a esta migração no cenário #{name}.",
          "#{evidence}; diagnóstico da execução original e único arquivo com inserções na tabela indicada; linha exata não informada.",
          line: Banco.statement_line(origin))
        "origem atribuída a #{origin.path}"
      else
        @report.find("pg-migrate", "BANCO-LOTE-MIGRACAO-REJEITADO", sources.last, "alta",
          "O lote de migrações foi rejeitado no cenário #{name}.",
          "#{evidence}; origem entre arquivos indeterminada; arquivo e linha referenciam o último arquivo alcançado pela execução.",
          line: Banco.statement_line(sources.last))
        "origem entre arquivos indeterminada"
      end
    end

    def rollback(db)
      db.exec("ROLLBACK")
    rescue PG::Error
      # Uma conexão perdida também impede confirmar a transação.
    end

    def client_args(database)
      ["--host", @directory, "--port", "5432", "--username", "projeto", "--no-password", "--dbname", database]
    end

    def connection_options
      "-c statement_timeout=5000 -c lock_timeout=1000 -c client_min_messages=error -c search_path=public"
    end

    def sql_diagnostic(error)
      code = error.is_a?(PG::Error) && sqlstate(error)
      code ? "SQLSTATE #{code}" : error.class.name
    end

    def check_assertion(database, assertion, after_migration: false)
      phase = after_migration ? "após atualização" : "antes da atualização"
      Banco.select_only!(assertion)
      evidence = "O SELECT de verificação não retornou true (#{phase})."
      line = assertion.line
      begin
        passed = connect(database, readonly: true) do |db|
          result = db.exec_params(assertion.sql, [])
          result.nfields == 1 && result.ftype(0) == 16 && result.ntuples == 1 && result.getvalue(0, 0) == "t"
        end
      rescue PG::Error => error
        raise ToolError, sql_diagnostic(error) unless rejection?(error)

        passed = false
        evidence = "O SELECT de verificação foi rejeitado (#{phase}; #{sql_diagnostic(error)})."
        line = Banco.error_line(error, assertion)
      end
      @report.cover("pg_restore", "ok", "pg_restore:#{database}:#{assertion.path}: #{phase}, invariante #{passed ? 'preservado' : 'falhou'}")
      unless passed
        @report.find("pg_restore", "BANCO-INVARIANTE-HISTORICO", assertion, "alta",
          "O invariante dos dados antigos falhou em #{database}.", evidence, line: line)
      end
      passed
    end

    def stats(identifier)
      connect("fresh", admin: true) do |db|
        db.exec_params(<<~SQL, [identifier.to_s]).first
          SELECT calls, total_exec_time, shared_blks_hit, shared_blks_read
          FROM banco_tools.pg_stat_statements
          WHERE queryid = $1 AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND userid = (SELECT oid FROM pg_roles WHERE rolname = 'projeto') AND toplevel
        SQL
      end
    end

    def observe(source, identifier, line:)
      before = stats(identifier) || {}
      connect("fresh", readonly: true) do |db|
        SAMPLES.times do
          db.send_query_params(source.sql, [])
          db.set_single_row_mode
          while (result = db.get_result)
            result.check
            result.clear
          end
        end
      end
      after = stats(identifier) || {}
      calls = after.fetch("calls", "0").to_i - before.fetch("calls", "0").to_i
      raise ToolError, "pg_stat_statements registrou #{calls} de #{SAMPLES} chamadas esperadas" unless calls == SAMPLES

      mean = (after.fetch("total_exec_time").to_f - before.fetch("total_exec_time", "0").to_f) / calls
      blocks = %w[shared_blks_hit shared_blks_read].map do |key|
        after.fetch(key).to_i - before.fetch(key, "0").to_i
      end
      evidence = format("queryid=%d; amostras=%d; média=%.3f ms; blocos hit/read=%d/%d", identifier, calls, mean, *blocks)
      @report.cover("pg_stat_statements", "ok", "pg_stat_statements:query:#{source.path}: linha #{line}; #{evidence}", files: [source.path])
      if mean >= SLOW_MS
        @report.find("pg_stat_statements", "BANCO-CONSULTA-LENTA", source, "media",
          "A consulta atingiu a média de #{SLOW_MS} ms na carga ensaiada.", evidence, line: line)
      end
    rescue PG::Error => error
      raise ToolError, "#{sql_diagnostic(error)}; linha #{Banco.error_line(error, source)} (linha inicial se posição indisponível)"
    end

    def explain(source, line:)
      document = connect("fresh", readonly: true) do |db|
        sql = "EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) #{source.sql}"
        JSON.parse(db.exec_params(sql, []).getvalue(0, 0)).first
      end
      plan = document.fetch("Plan")
      node = plan.fetch("Node Type")
      raise ToolError, "tipo de nó inesperado" unless node.match?(/\A[A-Za-z ]+\z/)

      evidence = format("nó=%s; custo=%.2f; linhas reais=%d; execução=%.3f ms; blocos hit/read=%d/%d",
        node, plan.fetch("Total Cost"), plan.fetch("Actual Rows"), document.fetch("Execution Time"),
        plan.fetch("Shared Hit Blocks"), plan.fetch("Shared Read Blocks"))
      @report.cover("EXPLAIN", "ok", "EXPLAIN:query:#{source.path}: linha #{line}; #{evidence}", files: [source.path])
    rescue PG::Error => error
      raise ToolError, "#{sql_diagnostic(error)}; linha #{Banco.error_line(error, source, prefix: 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ')} (linha inicial se posição indisponível)"
    end

    def advisor
      return @advisor if @advisor

      # Dexter mantém uma única sessão para a carga e reinicia os índices hipotéticos em cada análise.
      previous = ENV["PGOPTIONS"]
      begin
        ENV["PGOPTIONS"] = "#{connection_options} -c search_path=banco_tools,public -c default_transaction_read_only=on"
        connection = Dexter::Connection.new(dbname: "fresh", host: @directory, port: 5432, username: "projeto", log_sql: false)
        connection.setup(false)
        @advisor = Dexter::Indexer.new(connection: connection, create: false, analyze: false, log_level: "error",
          exclude: [], min_cost: 100, min_cost_savings_pct: 50)
      ensure
        ENV["PGOPTIONS"] = previous
      end
    end

    def advise(source, line:)
      $log_level = "error"
      query = Dexter::Query.new(source.sql, PgQuery.fingerprint(source.sql))
      advisor.process_queries([query])
      if query.fully_analyzed?
        @report.cover("dexter", "ok", "dexter:query:#{source.path}: linha #{line}; planos hipotéticos comparados", files: [source.path])
        if query.suggest_index
          index = query.indexes.map do |candidate|
            [candidate.fetch(:table), *candidate.fetch(:columns)].map do |identifier|
              identifier.match?(/\A[A-Za-z_][A-Za-z0-9_.]{0,126}\z/) ? identifier : "[identificador omitido]"
            end.join(" / ")
          end.join(", ")
          evidence = format("redução estimada de %.2f para %.2f unidades de custo; candidatos: %s",
            query.initial_cost, query.new_cost, index[0, 900])
          @report.find("dexter", "BANCO-INDICE-CANDIDATO", source, "media",
            "Dexter encontrou um índice hipotético que reduz o custo do plano.", evidence, line: line)
        end
      elsif query.missing_tables || query.candidate_tables.empty? || (query.initial_cost && query.initial_cost < 100) ||
          (query.initial_cost && query.candidate_columns.empty?)
        @report.cover("dexter", "skipped", "dexter:query:#{source.path}: linha #{line}; sem tabela/coluna elegível ou custo inicial abaixo de 100")
      else
        raise ToolError, "Dexter não obteve os planos necessários"
      end
    rescue PG::Error, Dexter::Error => error
      raise ToolError, sql_diagnostic(error)
    end
  end

  def self.collect(root, squawk: "/usr/local/bin/squawk")
    report = Report.new
    inventory = Inventory.new(root)
    migrations = report.measure("squawk", "Inventário de migrações") { inventory.list("db/migrations", MIGRATION_NAME, 400) }
    queries = report.measure("EXPLAIN", "Inventário de consultas") do
      next inventory.queries if migrations.nil? || migrations.empty?

      require "pg_query"
      inventory.queries { |source| select_only!(source) }
    rescue LoadError
      # Preserve o inventário de arquivos para a cobertura da falha de inicialização.
      inventory.queries
    end
    query_tools = %w[pg_stat_statements EXPLAIN dexter]
    if queries
      invalid, queries = queries.partition { |entry| entry.is_a?(Array) }
      invalid.each do |path, detail|
        query_tools.each { |tool| report.cover(tool, tool == "EXPLAIN" ? "failed" : "skipped", "#{path}: #{detail}") }
      end
    end
    if migrations.nil? || migrations.empty?
      status = migrations ? "skipped" : "failed"
      report.cover("squawk", status, "db/migrations: nenhuma migração disponível") if migrations
      DB_TOOLS.each { |tool| report.cover(tool, "skipped", "Sem migrações disponíveis para criar o esquema.") }
      queries&.each { |source| query_tools.each { |tool| report.cover(tool, "skipped", "#{source.path}: sem migrações disponíveis") } }
      return report
    end

    lint(migrations, report, executable: squawk)
    restore_inputs = report.measure("pg_restore", "Inventário de dados antigos") { [inventory.load(SEED), inventory.load(ASSERTION)] }
    workload_seed = report.measure("EXPLAIN", "Inventário da carga final") do
      inventory.load(WORKLOAD_SEED) || restore_inputs&.first
    end
    Dir.mktmpdir("ac-banco-", "/tmp") do |directory|
      db = Database.new(directory, report)
      begin
        require "dexter"
        db.start
      rescue LoadError, StandardError => error
        detail = error.is_a?(ToolError) ? error.message : error.class.name
        DB_TOOLS.each { |tool| report.cover(tool, "failed", "Inicialização do banco isolado: #{detail}") }
        queries&.each { |source| query_tools.each { |tool| report.cover(tool, "skipped", "#{source.path}: banco isolado indisponível") } }
        next
      end
      fresh = report.measure("pg-migrate", "Cenário do zero") { db.migrate("fresh", migrations) }
      if restore_inputs
        report.measure("pg_restore", "Restauração histórica") { db.exercise_restore(migrations, *restore_inputs) }
      end
      if !fresh || !queries || queries.empty?
        query_tools.each do |tool|
          status = !queries && tool == "EXPLAIN" ? "failed" : "skipped"
          report.cover(tool, status, "Consultas indisponíveis ou migrações do zero não concluídas.")
        end
        queries&.each { |source| query_tools.each { |tool| report.cover(tool, "skipped", "#{source.path}: migrações do zero não concluídas") } }
      else
        begin
          db.prepare_workload(workload_seed)
          query_tools.each { |tool| report.cover(tool, "ok", "Esquema final preparado para medição.") }
          queries.each { |source| db.workload(source) }
        rescue StandardError => error
          detail = error.is_a?(ToolError) ? error.message : error.class.name
          query_tools.each { |tool| report.cover(tool, "failed", "Preparo da carga: #{detail}") }
          queries.each { |source| query_tools.each { |tool| report.cover(tool, "skipped", "#{source.path}: preparo indisponível") } }
        end
      end
    ensure
      report.measure("pg-migrate", "Encerramento do banco isolado") { db&.stop }
    end
    report
  end
end

if $PROGRAM_NAME == __FILE__
  # Libpq só recebe o socket efêmero e as identidades locais escolhidas pelo coletor.
  ENV.delete_if { |key, _| key.start_with?("PG") }
  begin
    puts Banco.collect("/repo").to_json
  rescue StandardError => error
    report = Banco::Report.new
    report.cover("pg-migrate", "failed", "Falha inesperada no coletor: #{error.class}")
    puts report.to_json
  end
end
