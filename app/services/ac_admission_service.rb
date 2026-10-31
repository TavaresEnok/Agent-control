# frozen_string_literal: true

# F2 — Serviço de Admissão Unificada (AC Domain)
#
# §10.2.1: Cobertura de todos os pontos de entrada:
# - Toda execução administrada passa pelo mesmo contrato de tentativa, concessão e época:
#   UI, chat, API, MCP, agendamentos, retomada, fallback, recuperação e ferramentas.
# - O runtime recusa início/retomada de trabalho gerenciado sem autorização válida.
# - G2 cobre todos os caminhos habilitados e impede caminhos inferiores de contornar o contrato.
# - Comandos duplicados convergem na mesma intenção, tentativa e operação (§11.3).
class AcAdmissionService
  class AdmissionError < StandardError; end
  class TaskNotEligibleForAdmissionError < AdmissionError; end
  class ProfileNotEligibleError < AdmissionError; end
  class UnauthorizedExecutionBypassError < AdmissionError; end

  class << self
    def admit_execution!(task:, operation_id:, requested_by:, origin: "api", execution_profile: nil, epoch: "1")
      raise ArgumentError, "task é obrigatório" if task.blank?
      raise ArgumentError, "operation_id é obrigatório" if operation_id.blank?

      # 1. Idempotência estrita: se já existir execução com o mesmo operation_id, retorna a existente (§11.3)
      existing_execution = AcExecution.find_by(operation_id: operation_id)
      if existing_execution.present?
        return {
          execution: existing_execution,
          grant: existing_execution.ac_capacity_grant,
          reused: true
        }
      end

      # 2. Verifica elegibilidade da tarefa
      unless task.pending? || task.failed? || task.paused? || task.in_progress?
        raise TaskNotEligibleForAdmissionError, "Tarefa em estado '#{task.state}' não pode ser admitida para execução"
      end

      # 3. Seleciona perfil via política se não fornecido
      profile = execution_profile || select_profile_for_task(task)
      validate_profile_eligibility!(profile, task)

      # 4. Aloca concessão de capacidade atomicamente na mesma transação (§11.3)
      AcExecution.transaction do
        grant = AcCapacityGrant.grant_atomically!(
          company: task.company,
          ac_task: task,
          ac_execution_profile: profile,
          agent_credential: profile.agent_credential,
          operation_id: operation_id,
          epoch: epoch,
          policy_revision_id: profile.ac_policy_revision_id,
          policy_revision_number: profile.ac_policy_revision.revision_number
        )

        execution = AcExecution.create!(
          company: task.company,
          ac_task: task,
          ac_work_context: task.ac_plan.ac_work_context,
          ac_execution_profile: profile,
          ac_capacity_grant: grant,
          operation_id: operation_id,
          epoch: epoch,
          state: :granted,
          metadata: {
            "origin" => origin.to_s,
            "requested_by" => requested_by.to_s,
            "admitted_at" => Time.current.iso8601
          }
        )

        # 5. Registra auditoria imutável (§11.1, RF-18)
        AcDecisionAuditEvent.record_capacity_granted!(
          grant: grant,
          actor_type: "system",
          metadata: {
            "origin" => origin.to_s,
            "requested_by" => requested_by.to_s,
            "execution_id" => execution.id,
            "operation_id" => operation_id
          }
        )

        {
          execution: execution,
          grant: grant,
          reused: false
        }
      end
    end

    # §10.2.1: Validação de autoridade de execução — impede contorno do contrato
    def validate_execution_authority!(execution_id:, operation_id:, reported_epoch:)
      execution = AcExecution.find_by(id: execution_id, operation_id: operation_id)
      unless execution.present?
        raise UnauthorizedExecutionBypassError, "Execução não encontrada ou chave de operação divergente: bypass bloqueado"
      end

      if execution.epoch.to_s != reported_epoch.to_s
        raise UnauthorizedExecutionBypassError, "Época divergente (execução: #{execution.epoch}, informado: #{reported_epoch}): stale execution bloqueada"
      end

      grant = execution.ac_capacity_grant
      unless grant.present? && %w[granted active].include?(grant.state)
        raise UnauthorizedExecutionBypassError, "Concessão de capacidade inválida ou expirada: execução não admitida"
      end

      execution
    end

    private

    def select_profile_for_task(task)
      profile = AcPolicyEngineService.select_profile(
        role: task.assigned_role || :programmer,
        company: task.company
      )

      raise ProfileNotEligibleError, "Nenhum perfil elegível encontrado pela política para a tarefa #{task.id}" if profile.blank?

      profile
    end

    def validate_profile_eligibility!(profile, task)
      if profile.blank? || profile.company_id != task.company_id || profile.state.to_s != "active"
        raise ProfileNotEligibleError, "Perfil #{profile&.id} não é elegível para execução da tarefa #{task.id}"
      end
    end
  end
end
