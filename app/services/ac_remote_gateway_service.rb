# frozen_string_literal: true

require "open3"
require "securerandom"
require "shellwords"

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
    def build_wrapped_command(working_directory:, command:, remote_job_id:)
      escaped_dir = Shellwords.shellescape(working_directory)
      exit_file = "#{working_directory}/.ac_job_#{remote_job_id}.exit"
      escaped_exit = Shellwords.shellescape(exit_file)
      "cd #{escaped_dir} && { ( #{command} ) ; ret=$? ; echo $ret > #{escaped_exit} ; exit $ret ; }"
    end

    def dispatch_operation!(environment:, operation_id:, command:, working_directory:,
                            artifact_hash: nil, task: nil, execution: nil, metadata: {}, runner: nil)
      unless task && execution && execution.ac_task_id == task.id &&
             execution.company_id == environment.company_id && task.company_id == environment.company_id &&
             task.project_id == environment.project_id
        raise UnprovableRemoteStateError, "Tarefa e execução autorizadas são obrigatórias"
      end
      AcAdmissionService.validate_execution_authority!(execution_id: execution.id,
        operation_id: execution.operation_id, reported_epoch: execution.epoch)
      raise InactiveRemoteEnvironmentError, "Ambiente inativo" unless environment.active?
      raise UnauthorizedRemoteDirectoryError, "Diretório não autorizado" unless environment.directory_authorized?(working_directory)

      raise ArgumentError, "operation_id é obrigatório" if operation_id.blank?
      supervisor = Rails.application.config.try(:ac_remote_supervisor)
      unless supervisor && %i[dispatch_operation! query_operation_status! verify_operation_receipt!].all? { |method| supervisor.respond_to?(method) }
        raise UnprovableRemoteStateError, "Supervisor remoto verificável não configurado"
      end
      if AcRemoteOperation.connection_pool.with_connection(&:transaction_open?)
        raise UnprovableRemoteStateError, "Intenção remota deve ser confirmada antes da chamada externa"
      end

      operation, created = create_intent!(environment: environment, task: task, execution: execution,
        operation_id: operation_id, command: command, working_directory: working_directory,
        artifact_hash: artifact_hash, metadata: metadata)
      return operation unless created

      dispatched = false
      begin
        receipt = dispatch_under_fence!(operation: operation, environment: environment, task: task,
          execution: execution, supervisor: supervisor, metadata: metadata, runner: runner) { dispatched = true }
        apply_verified_receipt!(operation, supervisor, receipt)
      rescue StandardError
        if dispatched
          record_observation_failure!(operation, "Despacho remoto sem recibo verificável")
        else
          operation.mark_cancelled!(reason: "Despacho recusado antes da chamada ao supervisor")
          raise
        end
      end
      operation
    end

    def query_operation_status!(operation:, runner: nil)
      supervisor = Rails.application.config.try(:ac_remote_supervisor)
      unless supervisor && %i[query_operation_status! verify_operation_receipt!].all? { |method| supervisor.respond_to?(method) }
        record_observation_failure!(operation, "Supervisor remoto verificável não configurado")
        return format_five_questions(operation)
      end
      begin
        receipt = supervisor.query_operation_status!(operation: operation, runner: runner)
        apply_verified_receipt!(operation, supervisor, receipt)
      rescue StandardError
        record_observation_failure!(operation, "Estado remoto sem recibo verificável")
      end
      format_five_questions(operation.reload)
    end

    def reconcile_completion!(operation:, exit_code:, output: nil, error: nil)
      raise UnprovableRemoteStateError, "Resultado remoto requer recibo verificável do supervisor"
    end

    private

    def dispatch_under_fence!(operation:, environment:, task:, execution:, supervisor:, metadata:, runner:)
      AcExecutionFence.synchronize(execution, validate: false) do
        execution.ac_capacity_grant.lock!
        environment.lock!
        AcAdmissionService.validate_execution_authority!(execution_id: execution.id,
          operation_id: execution.operation_id, reported_epoch: operation.metadata.fetch("execution_epoch"))
        raise InactiveRemoteEnvironmentError, "Ambiente inativo" unless environment.active?
        unless environment.directory_authorized?(operation.working_directory)
          raise UnauthorizedRemoteDirectoryError, "Diretório não autorizado"
        end

        yield
        supervisor.dispatch_operation!(environment: environment, operation_id: operation.operation_id,
          command: operation.command, working_directory: operation.working_directory,
          artifact_hash: operation.artifact_hash, task: task, execution: execution, metadata: metadata, runner: runner)
      end
    end

    def create_intent!(environment:, task:, execution:, operation_id:, command:, working_directory:, artifact_hash:, metadata:)
      attributes = { company_id: environment.company_id, project_id: environment.project_id,
        ac_remote_environment_id: environment.id, ac_task_id: task.id, ac_execution_id: execution.id,
        operation_id: operation_id, command: command, working_directory: working_directory, artifact_hash: artifact_hash,
        state: "pending", metadata: (metadata || {}).to_h.stringify_keys.merge("execution_epoch" => execution.epoch.to_s) }
      begin
        [ AcRemoteOperation.create!(attributes), true ]
      rescue ActiveRecord::RecordNotUnique, ActiveRecord::RecordInvalid
        existing = AcRemoteOperation.find_by(operation_id: operation_id)
        raise unless existing

        fields = %i[company_id project_id ac_remote_environment_id ac_task_id ac_execution_id command working_directory artifact_hash]
        unless fields.all? { |field| existing.public_send(field) == attributes[field] } &&
               existing.metadata["execution_epoch"] == execution.epoch.to_s
          raise UnprovableRemoteStateError, "Identidade da operação divergente"
        end
        [ existing, false ]
      end
    end

    def apply_verified_receipt!(operation, supervisor, receipt)
      expected = { "operation_id" => operation.operation_id, "company_id" => operation.company_id,
        "environment_id" => operation.ac_remote_environment_id, "task_id" => operation.ac_task_id,
        "execution_id" => operation.ac_execution_id, "epoch" => operation.metadata["execution_epoch"] }
      valid = receipt.is_a?(Hash) && expected.all? { |key, value| value.present? && receipt[key].to_s == value.to_s } &&
              %w[running completed failed].include?(receipt["state"]) && receipt["remote_job_id"].present? &&
              supervisor.verify_operation_receipt!(operation: operation, receipt: receipt) == true
      if valid && %w[completed failed].include?(receipt["state"])
        valid = receipt["exit_code"].is_a?(Integer) && (receipt["state"] == "completed") == receipt["exit_code"].zero?
      end
      raise UnprovableRemoteStateError, "Recibo remoto inválido" unless valid

      operation.with_lock do
        if %w[completed failed cancelled].include?(operation.state) &&
           (operation.state != receipt["state"] || operation.exit_code != receipt["exit_code"] ||
            operation.output_log != receipt["output"] || operation.error_log != receipt["error"])
          raise UnprovableRemoteStateError, "Resultado remoto terminal divergente"
        end
        if operation.remote_job_id.present? && operation.remote_job_id != receipt["remote_job_id"]
          raise UnprovableRemoteStateError, "Identidade de supervisor divergente"
        end
        next if %w[completed failed cancelled].include?(operation.state)

        operation.remote_job_id = receipt["remote_job_id"]
        operation.state = receipt["state"]
        operation.started_at ||= Time.current
        if %w[completed failed].include?(receipt["state"])
          operation.exit_code = receipt["exit_code"]
          operation.output_log = receipt["output"]
          operation.error_log = receipt["error"]
          operation.finished_at = Time.current
        end
        operation.save!
      end
    end

    def record_observation_failure!(operation, reason)
      operation.with_lock do
        if %w[completed failed cancelled].include?(operation.state)
          operation.update!(metadata: (operation.metadata || {}).merge(
            "last_observation_error" => { "reason" => reason, "at" => Time.current.iso8601 }
          ))
        else
          operation.mark_uncertain!(reason: reason)
        end
      end
    end

    def format_five_questions(operation)
      {
        operation_id: operation.operation_id,
        remote_job_id: operation.remote_job_id,
        state: operation.state,
        started: operation.started_at.present? ? true : nil,
        running: operation.state == "uncertain" ? nil : operation.state == "running",
        result: {
          exit_code: operation.exit_code,
          terminal: operation.terminal?,
          uncertain: operation.state == "uncertain",
          output: operation.output_log,
          error: operation.error_log
        },
        artifact_hash: operation.artifact_hash,
        repeatable: false
      }
    end
  end
end
