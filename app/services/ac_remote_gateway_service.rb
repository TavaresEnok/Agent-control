# frozen_string_literal: true

require "open3"
require "securerandom"

class AcRemoteGatewayService
  class Error < StandardError; end
  class UnauthorizedRemoteDirectoryError < Error; end
  class InactiveRemoteEnvironmentError < Error; end
  class RemoteTransportError < Error; end
  class UnprovableRemoteStateError < Error; end

  class DefaultRunner
    def execute(transport, remote_command)
      argv = transport.argv(remote_command)
      stdout, stderr, status = Open3.capture3(transport.environment, *argv, **transport.spawn_options)
      {
        stdout: stdout,
        stderr: stderr,
        exit_code: status.exitstatus,
        success: status.success?
      }
    rescue StandardError => e
      raise RemoteTransportError, "Transport execution failed: #{e.message}"
    end
  end

  class << self
    def dispatch_operation!(environment:, operation_id:, command:, working_directory:,
                            artifact_hash: nil, task: nil, execution: nil, metadata: {}, runner: nil)
      # 1. Idempotência estrita por operation_id (§11.2, §11.3)
      existing = AcRemoteOperation.find_by(operation_id: operation_id)
      return existing if existing

      # 2. Validações de ambiente e diretório autorizado (§14.1, §14.2)
      raise InactiveRemoteEnvironmentError, "Environment '#{environment.name}' is #{environment.state}" unless environment.active?
      unless environment.directory_authorized?(working_directory)
        raise UnauthorizedRemoteDirectoryError, "Diretório '#{working_directory}' não autorizado para o ambiente '#{environment.name}'"
      end

      # 3. Gera identificador persistente do job no destino (§14.3)
      remote_job_id = "ac-job-#{SecureRandom.hex(8)}"

      operation = AcRemoteOperation.create!(
        company: environment.company,
        project: environment.project,
        ac_remote_environment: environment,
        ac_task: task,
        ac_execution: execution,
        operation_id: operation_id,
        command: command,
        working_directory: working_directory,
        state: "running",
        remote_job_id: remote_job_id,
        artifact_hash: artifact_hash,
        started_at: Time.current,
        metadata: metadata || {}
      )

      # 4. Execução remota persistente via OpenSSH (§14.1, §14.3)
      runner ||= DefaultRunner.new
      transport = environment.build_transport(lab_opt_in: true)

      # Wrapper do comando que roda dentro do working_directory autorizado
      wrapped_cmd = "cd #{working_directory} && #{command}"

      begin
        result = runner.execute(transport, wrapped_cmd)
        if result[:exit_code] == 0
          operation.mark_completed!(
            exit_code: result[:exit_code],
            output: result[:stdout],
            error: result[:stderr]
          )
        else
          operation.mark_failed!(
            exit_code: result[:exit_code] || 1,
            output: result[:stdout],
            error: result[:stderr]
          )
        end
      rescue RemoteTransportError => e
        # Em falha de transporte/desconexão durante despacho de job persistente,
        # mantém como running ou marca uncertain se não puder provar que iniciou
        operation.update!(
          error_log: "Transport error during dispatch: #{e.message}"
        )
      end

      operation
    end

    # Responde às 5 perguntas de §14.3:
    # 1. Já iniciou?
    # 2. Ainda executa?
    # 3. Qual resultado?
    # 4. Qual commit usou?
    # 5. Pode ser repetida?
    def query_operation_status!(operation:, runner: nil)
      env = operation.ac_remote_environment
      runner ||= DefaultRunner.new

      # Se já está em estado terminal verificado, responde diretamente
      if operation.terminal? && operation.state != "uncertain"
        return format_five_questions(operation)
      end

      transport = env.build_transport(lab_opt_in: true)
      status_query_cmd = "test -f #{operation.working_directory}/.ac_job_#{operation.remote_job_id}.exit && cat #{operation.working_directory}/.ac_job_#{operation.remote_job_id}.exit || echo RUNNING"

      begin
        res = runner.execute(transport, status_query_cmd)
        out = res[:stdout].to_s.strip

        if out == "RUNNING"
          operation.update!(state: "running") if operation.state != "running"
        elsif out.match?(/\A\d+\z/)
          exit_code = out.to_i
          if exit_code == 0
            operation.mark_completed!(exit_code: exit_code, output: res[:stdout])
          else
            operation.mark_failed!(exit_code: exit_code, output: res[:stdout])
          end
        else
          # Supervisor não pôde provar o estado do job -> transição para uncertain (§14.3)
          operation.mark_uncertain!(
            reason: "Resposta inconclusiva do supervisor remoto (#{out})",
            error: res[:stderr]
          )
        end
      rescue RemoteTransportError => e
        # Queda de conexão persistente onde o estado do job remoto é indemonstrável:
        # §14.3: "Se o destino não permitir verificar o resultado, a etapa fica incerta e não avança para integração/deploy."
        operation.mark_uncertain!(
          reason: "Desconexão de transporte durante verificação de status: #{e.message}",
          error: e.message
        )
      end

      format_five_questions(operation)
    end

    def reconcile_completion!(operation:, exit_code:, output: nil, error: nil)
      if exit_code == 0
        operation.mark_completed!(exit_code: exit_code, output: output, error: error)
      else
        operation.mark_failed!(exit_code: exit_code, output: output, error: error)
      end
      operation
    end

    private

    def format_five_questions(operation)
      {
        operation_id: operation.operation_id,
        remote_job_id: operation.remote_job_id,
        state: operation.state,
        started: operation.started_at.present? || operation.state != "pending",
        running: operation.state == "running",
        result: {
          exit_code: operation.exit_code,
          terminal: operation.terminal?,
          uncertain: operation.state == "uncertain",
          output: operation.output_log,
          error: operation.error_log
        },
        artifact_hash: operation.artifact_hash,
        repeatable: operation.metadata&.dig("repeatable") == true
      }
    end
  end
end
