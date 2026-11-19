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

      names = Dir.children(path).select { |name| name.end_with?(".sql") }.sort
      raise ToolError, "limite de 40 arquivos SQL em #{relative}" if names.size > 40

      names.map do |name|
        display = "#{relative}/#{name.dump}"
        begin
          raise ToolError, "nome SQL fora da convenção" unless name.bytesize <= 160 && name.ascii_only? && QUERY_NAME.match?(name)
          source = load("#{relative}/#{name}")
          raise ToolError, "arquivo desapareceu" unless source
          source
        rescue ToolError, SystemCallError => error
          [display, error.is_a?(ToolError) ? error.message : error.class.name]
        end
      end
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

    def cover(tool, status, detail)
      coverage << {tool: tool, version: VERSIONS.fetch(tool), status: status, detail: detail}
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
          report.cover("squawk", "ok", "squawk:file:#{source.path}: #{rows.size} alertas")
        end
      end
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
        sources.each_with_index do |source, index|
          begin
            statements = PgQuery.parse(source.sql).tree.stmts
            if statements.empty? || statements.any? { |entry| entry.stmt.transaction_stmt }
              raise ToolError, "esperado SQL de migração sem controle explícito de transação"
            end

            db.exec(source.sql)
          rescue PG::Error, PgQuery::ParseError, ToolError => error
            evidence = error.is_a?(ToolError) ? error.message : sql_diagnostic(error)
            rejected = error.is_a?(PgQuery::ParseError) || (error.is_a?(PG::Error) && rejection?(error))
            rollback(db)
            sources.take(index).each do |prior|
              @report.cover("pg-migrate", "skipped", "pg-migrate:#{name}:#{prior.path}: transação não confirmada (#{evidence})")
            end
            if rejected
              @report.find("pg-migrate", "BANCO-MIGRACAO-REJEITADA", source, "alta",
                "A migração foi rejeitada no cenário #{name}.", evidence, line: error_line(error, source))
            end
            @report.cover("pg-migrate", rejected ? "ok" : "failed", "pg-migrate:#{name}:#{source.path}: #{rejected ? 'rejeitada' : 'execução interrompida'} (#{evidence}); transação não confirmada")
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
          if rejection?(error) && sources.size == 1
            @report.find("pg-migrate", "BANCO-MIGRACAO-REJEITADA", sources.first, "alta",
              "A transação da migração foi rejeitada no commit em #{name}.", "#{evidence}; linha exata não informada no commit.")
          end
          sources.each do |source|
            @report.cover("pg-migrate", "failed", "pg-migrate:#{name}:#{source.path}: commit não confirmado (#{evidence}); #{sources.size > 1 ? 'origem entre arquivos indeterminada' : 'verificação no commit'}")
          end
          return false
        end
      end
      sources.each { |source| @report.cover("pg-migrate", "ok", "pg-migrate:#{name}:#{source.path}: SQL aplicado e confirmado") }
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
      return @report.cover("pg_restore", "skipped", "O prefixo histórico foi rejeitado.") unless migrate("previous", migrations[0...-1])

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
            @report.cover("EXPLAIN", "failed", "Carga #{seed.path} não confirmada: #{detail}; linha #{error_line(error, seed)} (linha inicial se posição indisponível). Medição continua sem essa carga.")
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
        select_only!(source.sql)
        template = "EXPLAIN (VERBOSE, FORMAT JSON) "
        identifier = connect("fresh", readonly: true) do |db|
          JSON.parse(db.exec_params(template + source.sql, []).getvalue(0, 0)).first.fetch("Query Identifier")
        end
        @report.measure("pg_stat_statements", source.path) { observe(source, identifier) }
        @report.measure("EXPLAIN", source.path) { explain(source) }
        @report.measure("dexter", source.path) { advise(source) }
      rescue PG::Error => error
        %w[pg_stat_statements dexter].each do |tool|
          @report.cover(tool, "skipped", "#{source.path}: plano inicial indisponível")
        end
        raise ToolError, "#{sql_diagnostic(error)}; linha #{error_line(error, source, prefix: template)} (linha inicial se posição indisponível)"
      rescue ToolError
        %w[pg_stat_statements dexter].each do |tool|
          @report.cover(tool, "skipped", "#{source.path}: consulta fora do contrato")
        end
        raise
      end
    end

    private

    # Apenas classes de erro atribuíveis ao SQL são tratadas como rejeição.
    def rejection?(error)
      code = error.result&.error_field(PG::Result::PG_DIAG_SQLSTATE)
      code && %w[0A 21 22 23 25 2B 2D 3D 3F 42 44].include?(code[0, 2])
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
      code = error.respond_to?(:result) && error.result&.error_field(PG::Result::PG_DIAG_SQLSTATE)
      code ? "SQLSTATE #{code}" : error.class.name
    end

    def error_line(error, source, prefix: "")
      position = if error.is_a?(PG::Error)
        error.result&.error_field(PG::Result::PG_DIAG_STATEMENT_POSITION)&.to_i
      elsif error.is_a?(PgQuery::ParseError)
        error.location.to_i + 1 if error.location && error.location >= 0
      end
      if error.is_a?(PgQuery::ParseError) && position && position > 0
        return source.sql.byteslice(0, position - 1).count("\n") + 1
      end
      position -= prefix.length if position && error.is_a?(PG::Error)
      return source.line unless position && position > 0

      source.sql[0, position - 1].count("\n") + 1
    end

    def select_only!(sql)
      statements = PgQuery.parse(sql).tree.stmts
      raise ToolError, "é exigido um único SELECT" unless statements.size == 1 && statements.first.stmt.select_stmt
    rescue PgQuery::ParseError => error
      line = error.location && error.location >= 0 ? sql.byteslice(0, error.location).count("\n") + 1 : nil
      raise ToolError, "SELECT inválido para o parser PostgreSQL#{line ? "; linha #{line}" : ''}"
    end

    def check_assertion(database, assertion, after_migration: false)
      phase = after_migration ? "após atualização" : "antes da atualização"
      select_only!(assertion.sql)
      evidence = "O SELECT de verificação não retornou true (#{phase})."
      begin
        passed = connect(database, readonly: true) do |db|
          result = db.exec_params(assertion.sql, [])
          result.nfields == 1 && result.ftype(0) == 16 && result.ntuples == 1 && result.getvalue(0, 0) == "t"
        end
      rescue PG::Error => error
        raise ToolError, sql_diagnostic(error) unless rejection?(error)

        passed = false
        evidence = "O SELECT de verificação foi rejeitado (#{phase}; #{sql_diagnostic(error)})."
      end
      @report.cover("pg_restore", "ok", "pg_restore:#{database}:#{assertion.path}: #{phase}, invariante #{passed ? 'preservado' : 'falhou'}")
      unless passed
        @report.find("pg_restore", "BANCO-INVARIANTE-HISTORICO", assertion, "alta",
          "O invariante dos dados antigos falhou em #{database}.", evidence)
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

    def observe(source, identifier)
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
      @report.cover("pg_stat_statements", "ok", "pg_stat_statements:query:#{source.path}: #{evidence}")
      if mean >= SLOW_MS
        @report.find("pg_stat_statements", "BANCO-CONSULTA-LENTA", source, "media",
          "A consulta atingiu a média de #{SLOW_MS} ms na carga ensaiada.", evidence)
      end
    rescue PG::Error => error
      raise ToolError, "#{sql_diagnostic(error)}; linha #{error_line(error, source)} (linha inicial se posição indisponível)"
    end

    def explain(source)
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
      @report.cover("EXPLAIN", "ok", "EXPLAIN:query:#{source.path}: #{evidence}")
    rescue PG::Error => error
      raise ToolError, "#{sql_diagnostic(error)}; linha #{error_line(error, source, prefix: 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ')} (linha inicial se posição indisponível)"
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

    def advise(source)
      $log_level = "error"
      query = Dexter::Query.new(source.sql, PgQuery.fingerprint(source.sql))
      advisor.process_queries([query])
      if query.fully_analyzed?
        @report.cover("dexter", "ok", "dexter:query:#{source.path}: planos hipotéticos comparados")
        if query.suggest_index
          index = query.indexes.map do |candidate|
            [candidate.fetch(:table), *candidate.fetch(:columns)].map do |identifier|
              identifier.match?(/\A[A-Za-z_][A-Za-z0-9_.]{0,126}\z/) ? identifier : "[identificador omitido]"
            end.join(" / ")
          end.join(", ")
          evidence = format("redução estimada de %.2f para %.2f unidades de custo; candidatos: %s",
            query.initial_cost, query.new_cost, index[0, 900])
          @report.find("dexter", "BANCO-INDICE-CANDIDATO", source, "media",
            "Dexter encontrou um índice hipotético que reduz o custo do plano.", evidence)
        end
      elsif query.missing_tables || query.candidate_tables.empty? || (query.initial_cost && query.initial_cost < 100) ||
          (query.initial_cost && query.candidate_columns.empty?)
        @report.cover("dexter", "skipped", "dexter:query:#{source.path}: sem tabela/coluna elegível ou custo inicial abaixo de 100")
      else
        raise ToolError, "Dexter não obteve os planos necessários"
      end
    rescue PG::Error, Dexter::Error => error
      raise ToolError, sql_diagnostic(error)
    end
  end

  def self.collect(root)
    report = Report.new
    inventory = Inventory.new(root)
    migrations = report.measure("squawk", "Inventário de migrações") { inventory.list("db/migrations", MIGRATION_NAME, 400) }
    queries = report.measure("EXPLAIN", "Inventário de consultas") { inventory.queries }
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

    lint(migrations, report)
    restore_inputs = report.measure("pg_restore", "Inventário de dados antigos") { [inventory.load(SEED), inventory.load(ASSERTION)] }
    workload_seed = report.measure("EXPLAIN", "Inventário da carga final") { [inventory.load(WORKLOAD_SEED)] }
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
          seed = workload_seed&.first || restore_inputs&.first
          db.prepare_workload(seed)
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
