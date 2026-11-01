# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "base64"
require "digest"

class AcRemoteGatewayServiceTest < ActiveSupport::TestCase
  # Runner simulado para testes determinísticos de rede e supervisor remoto
  class MockRunner
    attr_accessor :executions, :responses, :failure_on_command

    def initialize
      @executions = []
      @responses = {}
      @failure_on_command = {}
    end

    def execute(transport, remote_command)
      @executions << {
        transport: transport,
        command: remote_command
      }

      matched_failure = @failure_on_command[remote_command] ||
        @failure_on_command.find do |pattern, _|
          pattern_str = pattern.to_s
          core = pattern_str.include?("&&") ? pattern_str.split("&&").last.strip : pattern_str
          remote_command.include?(core)
        end&.last

      if matched_failure
        raise AcRemoteGatewayService::RemoteTransportError, matched_failure
      end

      response = @responses[remote_command] ||
        @responses.find do |pattern, _|
          pattern_str = pattern.to_s
          core = pattern_str.include?("&&") ? pattern_str.split("&&").last.strip : pattern_str
          remote_command.include?(core)
        end&.last || {
        stdout: "MOCK_SUCCESS",
        stderr: "",
        exit_code: 0,
        success: true
      }
      response
    end
  end

  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)

    @dir = Dir.mktmpdir("ac_remote_gateway_test")
    @identity_path = File.join(@dir, "id_ed25519")
    @known_hosts_path = File.join(@dir, "known_hosts")
    File.write(@identity_path, "synthetic private key")

    key_blob = Base64.strict_encode64("synthetic-ed25519-public-key")
    File.write(@known_hosts_path, "f0-lab-pinned ssh-ed25519 #{key_blob}\n")
    @fingerprint = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(key_blob))).delete_suffix('=')}"

    # Destino 1: NexoISP (§14.2)
    @env_nexoisp = AcRemoteEnvironment.create!(
      company: @company,
      project: @project,
      name: "NexoISP Remote Target",
      environment_slug: "nexoisp-target",
      host: "127.0.0.1",
      port: 22,
      user: "deploy",
      fingerprint: @fingerprint,
      identity_key_path: @identity_path,
      known_hosts_path: @known_hosts_path,
      authorized_directories: ["/home/enok/Documentos/projetos/nexoisp"],
      state: "active"
    )

    # Destino 2: Ajust ERP (§14.2)
    @env_ajust_erp = AcRemoteEnvironment.create!(
      company: @company,
      project: @project,
      name: "Ajust ERP Remote Target",
      environment_slug: "ajust-erp-target",
      host: "127.0.0.1",
      port: 2222,
      user: "ajust",
      fingerprint: @fingerprint,
      identity_key_path: @identity_path,
      known_hosts_path: @known_hosts_path,
      authorized_directories: ["/home/enok/Documentos/projetos/ajust_erp"],
      state: "active"
    )

    @mock_runner = MockRunner.new
  end

  teardown do
    FileUtils.remove_entry(@dir) if @dir && Dir.exist?(@dir)
  end

  # Prova G4-E1: Dois destinos autorizados sem credenciais ou CLIs de IA nos destinos (§14.1, §14.2)
  test "G4-E1: executes in two distinct remote targets without AI credentials on destinations" do
    # 1. Destino 1: NexoISP
    op1 = AcRemoteGatewayService.dispatch_operation!(
      environment: @env_nexoisp,
      operation_id: "op-nexoisp-#{SecureRandom.hex(4)}",
      command: "bundle exec rake test:core",
      working_directory: "/home/enok/Documentos/projetos/nexoisp",
      artifact_hash: "git-commit-nexoisp-1",
      runner: @mock_runner
    )

    assert_equal "completed", op1.state
    assert_equal 0, op1.exit_code
    assert_equal @env_nexoisp.id, op1.ac_remote_environment_id

    # 2. Destino 2: Ajust ERP
    op2 = AcRemoteGatewayService.dispatch_operation!(
      environment: @env_ajust_erp,
      operation_id: "op-ajust-#{SecureRandom.hex(4)}",
      command: "npm test",
      working_directory: "/home/enok/Documentos/projetos/ajust_erp",
      artifact_hash: "git-commit-ajust-2",
      runner: @mock_runner
    )

    assert_equal "completed", op2.state
    assert_equal 0, op2.exit_code
    assert_equal @env_ajust_erp.id, op2.ac_remote_environment_id

    # 3. Verificação de isolamento central: nenhuma credencial de IA é exportada ao destino (§14.1)
    [ @env_nexoisp, @env_ajust_erp ].each do |env|
      transport = env.build_transport(lab_opt_in: true)
      assert_equal({ "PATH" => "/usr/bin:/bin", "HOME" => "/nonexistent", "LANG" => "C" }, transport.environment)
      assert_equal({ unsetenv_others: true }, transport.spawn_options)
      assert_raises(ArgumentError) { transport.validate_job_env!("OPENAI_API_KEY" => "leak") }
      assert_raises(ArgumentError) { transport.validate_job_env!("ANTHROPIC_API_KEY" => "leak") }
    end
  end

  # Prova G4-E2: Desconexão recuperável via remote_job_id sem retry cego (§14.3)
  test "G4-E2: recoverable disconnect via remote_job_id without duplicate execution" do
    op_id = "op-disconnect-#{SecureRandom.hex(4)}"
    cmd = "bundle exec rake long_test"
    work_dir = "/home/enok/Documentos/projetos/nexoisp"
    wrapped_cmd = "cd #{work_dir} && #{cmd}"

    # Simula desconexão durante o início do comando remoto
    @mock_runner.failure_on_command[wrapped_cmd] = "SSH connection dropped (Connection reset by peer)"

    op = AcRemoteGatewayService.dispatch_operation!(
      environment: @env_nexoisp,
      operation_id: op_id,
      command: cmd,
      working_directory: work_dir,
      artifact_hash: "commit-persisted-hash",
      runner: @mock_runner
    )

    # Permanece registrado com remote_job_id durável
    assert_equal "running", op.state
    assert op.remote_job_id.present?
    remote_job_id = op.remote_job_id
    assert_includes op.error_log, "Transport error during dispatch"

    # Restaura conexão: supervisor remoto comprova que o job persistente concluiu com sucesso (exit 0)
    query_cmd = "test -f #{work_dir}/.ac_job_#{remote_job_id}.exit && cat #{work_dir}/.ac_job_#{remote_job_id}.exit || echo RUNNING"
    @mock_runner.responses[query_cmd] = { stdout: "0\n", stderr: "", exit_code: 0, success: true }

    status = AcRemoteGatewayService.query_operation_status!(operation: op, runner: @mock_runner)

    op.reload
    assert_equal "completed", op.state
    assert_equal 0, op.exit_code
    assert_equal remote_job_id, op.remote_job_id
    assert_equal true, status[:started]
    assert_equal false, status[:running]
    assert_equal 0, status[:result][:exit_code]

    # Verifica que NÃO houve execução duplicada do comando principal
    main_executions = @mock_runner.executions.select { |e| e[:command].include?(cmd) && !e[:command].include?("test -f") && !e[:command].include?("rm -f") }
    assert_equal 1, main_executions.count, "Não deve executar cópia cega após desconexão"
  end

  # Prova G4-E3: Idempotência estrita por operation_id (§11.2, §11.3)
  test "G4-E3: strict idempotency on repeated operation_id returns same operation without re-running" do
    op_id = "op-idempotent-#{SecureRandom.hex(4)}"

    op_first = AcRemoteGatewayService.dispatch_operation!(
      environment: @env_nexoisp,
      operation_id: op_id,
      command: "echo test",
      working_directory: "/home/enok/Documentos/projetos/nexoisp",
      runner: @mock_runner
    )

    initial_execution_count = @mock_runner.executions.count

    op_second = AcRemoteGatewayService.dispatch_operation!(
      environment: @env_nexoisp,
      operation_id: op_id,
      command: "echo test",
      working_directory: "/home/enok/Documentos/projetos/nexoisp",
      runner: @mock_runner
    )

    assert_equal op_first.id, op_second.id
    assert_equal initial_execution_count, @mock_runner.executions.count, "Nenhum novo comando deve ser executado no destino"
  end

  # Prova G4-E4: Rejeição estrita de diretório não autorizado (§14.2)
  test "G4-E4: strict rejection of unauthorized directory outside registered scope" do
    unauthorized_dirs = [
      "/etc",
      "/var/run",
      "/home/enok/Documentos/projetos/painel_provedores",
      "/home/enok/Documentos/projetos/nexoisp/../../etc"
    ]

    unauthorized_dirs.each do |unauth_dir|
      assert_raises(AcRemoteGatewayService::UnauthorizedRemoteDirectoryError) do
        AcRemoteGatewayService.dispatch_operation!(
          environment: @env_nexoisp,
          operation_id: "op-unauth-#{SecureRandom.hex(4)}",
          command: "ls -la",
          working_directory: unauth_dir,
          runner: @mock_runner
        )
      end
    end
  end

  # Prova G4-E5: Transição para uncertain quando estado pós-desconexão é indemonstrável (§14.3)
  test "G4-E5: transitions to uncertain when remote state cannot be proven after disconnect" do
    op_id = "op-uncertain-#{SecureRandom.hex(4)}"
    cmd = "bundle exec rake critical_migration"
    work_dir = "/home/enok/Documentos/projetos/nexoisp"
    wrapped_cmd = "cd #{work_dir} && #{cmd}"

    @mock_runner.failure_on_command[wrapped_cmd] = "SSH timeout"

    op = AcRemoteGatewayService.dispatch_operation!(
      environment: @env_nexoisp,
      operation_id: op_id,
      command: cmd,
      working_directory: work_dir,
      artifact_hash: "migration-hash",
      runner: @mock_runner
    )

    assert_equal "running", op.state
    remote_job_id = op.remote_job_id

    # Consulta de status também falha com desconexão permanente ou resposta desconhecida
    query_cmd = "test -f #{work_dir}/.ac_job_#{remote_job_id}.exit && cat #{work_dir}/.ac_job_#{remote_job_id}.exit || echo RUNNING"
    @mock_runner.failure_on_command[query_cmd] = "SSH host unreachable"

    status = AcRemoteGatewayService.query_operation_status!(operation: op, runner: @mock_runner)

    op.reload
    assert_equal "uncertain", op.state
    assert_equal true, op.terminal?
    assert_equal true, status[:result][:uncertain]
    assert_includes op.error_log, "UNCERTAIN: Desconexão de transporte durante verificação de status"
  end

  # Teste das 5 perguntas de §14.3
  test "answers five remote questions precisely (§14.3)" do
    op_id = "op-5q-#{SecureRandom.hex(4)}"
    commit_hash = "git-sha-20261101"

    op = AcRemoteGatewayService.dispatch_operation!(
      environment: @env_nexoisp,
      operation_id: op_id,
      command: "bundle exec rake spec",
      working_directory: "/home/enok/Documentos/projetos/nexoisp",
      artifact_hash: commit_hash,
      metadata: { "repeatable" => true },
      runner: @mock_runner
    )

    questions = AcRemoteGatewayService.query_operation_status!(operation: op, runner: @mock_runner)

    # 1. Já iniciou?
    assert_equal true, questions[:started]
    # 2. Ainda executa?
    assert_equal false, questions[:running]
    # 3. Qual resultado?
    assert_equal 0, questions[:result][:exit_code]
    assert_equal true, questions[:result][:terminal]
    # 4. Qual commit usou?
    assert_equal commit_hash, questions[:artifact_hash]
    # 5. Pode ser repetida?
    assert_equal true, questions[:repeatable]
  end
end
