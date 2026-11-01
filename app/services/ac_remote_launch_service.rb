# frozen_string_literal: true

class AcRemoteLaunchService
  EVENT_TYPE = "agent_control.remote.start"

  def self.record!(company:, actor:, command_record:, payload:)
    unless command_record&.persisted? && command_record.company_id == company.id &&
           command_record.user_id == actor&.id && command_record.command_type == "execute_remote_operation"
      raise Pundit::NotAuthorizedError, "Intenção de comando inválida"
    end
    execution = AcExecution.where(company: company).find(payload.fetch("execution_id"))
    task = execution.ac_task
    environment = AcRemoteEnvironment.where(company: company, project_id: task.project_id).find(payload.fetch("environment_id"))
    unless task.project.accessible_by?(actor) && (actor == task.project.owner ||
      actor.company_memberships.active.where(company: company, role: "admin").exists?)
      raise Pundit::NotAuthorizedError, "Sem autorização para executar operação remota"
    end
    command = payload.fetch("command").to_s
    directory = payload.fetch("working_directory").to_s
    raise ArgumentError, "Comando remoto inválido" if command.blank? || command.bytesize > 65_536 || command.include?("\0")
    raise ArgumentError, "Diretório remoto inválido" unless directory.start_with?("/") && environment.directory_authorized?(directory)

    AcExecutionFence.synchronize(execution, validate: false) do
      unless %w[granted preparing running].include?(execution.state)
        raise AcAdmissionService::UnauthorizedExecutionBypassError, "Execução não aceita novo trabalho remoto"
      end
      grant = execution.ac_capacity_grant
      raise AcAdmissionService::UnauthorizedExecutionBypassError, "Concessão ausente" unless grant

      grant.lock!
      environment.lock!
      if payload["artifact_hash"].present? && payload["artifact_hash"] != execution.output_payload["artifact_hash"]
        raise ArgumentError, "Artefato não corresponde à execução"
      end
      AcAdmissionService.validate_execution_authority!(execution_id: execution.id,
        operation_id: execution.operation_id, reported_epoch: execution.epoch)
      AcAdmissionService.validate_manager!(plan: task.ac_plan, identity: execution.metadata["manager_identity"],
        epoch: execution.metadata["manager_epoch"], required: true)
      raise ArgumentError, "Ambiente remoto inativo" unless environment.active?
      raise ArgumentError, "Diretório remoto inválido" unless environment.directory_authorized?(directory)
      if grant.reconciliation_data["remote_release_claimed"] || AcRemoteOperation.where(ac_execution_id: execution.id,
        state: %w[pending running uncertain]).exists?
        raise AcAdmissionService::UnauthorizedExecutionBypassError, "Execução já está liberando capacidade ou tem operação remota pendente"
      end
      operation_id = "ac-remote-#{company.id}-#{command_record.id}"
      operation = AcRemoteOperation.create!(company: company, project: task.project, ac_remote_environment: environment,
        ac_task: task, ac_execution: execution, operation_id: operation_id, command: command, working_directory: directory,
        artifact_hash: payload["artifact_hash"], state: "pending",
        metadata: { "execution_epoch" => execution.epoch.to_s, "dispatch_claimed" => false })
      TriggerEvent.create!(company: company, project: task.project, actor: actor, source: EVENT_TYPE, event_type: EVENT_TYPE,
        relay_state: "pending", occurred_at: Time.current, dedup_key: "agent-control:remote:#{company.id}:#{command_record.id}",
        data: { "operation_id" => operation.operation_id, "execution_id" => execution.id, "task_id" => task.id,
          "environment_id" => environment.id, "epoch" => execution.epoch.to_s,
          "manager_identity" => execution.metadata["manager_identity"], "manager_epoch" => execution.metadata["manager_epoch"] })
    end
  end

  def self.dispatch_event(event)
    operation = AcRemoteOperation.where(company_id: event.company_id, project_id: event.project_id)
      .find_by!(operation_id: event.data.fetch("operation_id"))
    execution = operation.ac_execution
    unless execution && operation.ac_task_id == event.data["task_id"] && execution.id == event.data["execution_id"] &&
           operation.ac_remote_environment_id == event.data["environment_id"] &&
           operation.metadata["execution_epoch"].to_s == event.data["epoch"].to_s &&
           execution.metadata["manager_identity"] == event.data["manager_identity"] &&
           execution.metadata["manager_epoch"].to_s == event.data["manager_epoch"].to_s
      raise ArgumentError, "Contrato da operação remota mudou"
    end
    return [] if operation.state == "cancelled" && operation.metadata["dispatch_claimed"] == false

    begin
      actor = event.actor
      unless actor&.authenticatable? && operation.project.accessible_by?(actor) &&
             (actor == operation.project.owner || actor.company_memberships.active.where(company_id: event.company_id, role: "admin").exists?)
        raise Pundit::NotAuthorizedError, "Solicitante não tem autorização vigente"
      end
      unless %w[granted preparing running].include?(execution.reload.state)
      raise AcAdmissionService::UnauthorizedExecutionBypassError, "Execução não aceita novo trabalho remoto"
      end
    AcAdmissionService.validate_execution_authority!(execution_id: execution.id, operation_id: execution.operation_id,
        reported_epoch: event.data.fetch("epoch"))
      AcAdmissionService.validate_manager!(plan: execution.ac_task.ac_plan, identity: event.data.fetch("manager_identity"),
        epoch: event.data.fetch("manager_epoch"), required: true)
    rescue Pundit::NotAuthorizedError, AcAdmissionService::AdmissionError, ActiveRecord::StaleObjectError
      operation.with_lock do
        if operation.state == "pending" && operation.metadata["dispatch_claimed"] == false
          operation.mark_cancelled!(reason: "Autorização retirada antes do despacho")
        end
      end
      raise
    end
    data = event.data.merge("company_id" => event.company_id, "command" => operation.command,
      "working_directory" => operation.working_directory, "artifact_hash" => operation.artifact_hash)
    result = TemporalService.start_workflow(TemporalWorkflowRegistry.ac_remote_operation_workflow_v2, data,
      id: operation.operation_id, reject_duplicate: true)
    raise result[:error].to_s unless result[:ok]

    []
  end
end
