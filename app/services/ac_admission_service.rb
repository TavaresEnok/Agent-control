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

  class RecoveryModeActiveError < AdmissionError; end

  class << self
    def admit_execution!(task:, operation_id:, requested_by:, origin: "api", execution_profile: nil, epoch: "1", role: nil, manager_identity: nil, manager_epoch: nil)
      raise ArgumentError, "task é obrigatório" if task.blank?
      raise ArgumentError, "operation_id é obrigatório" if operation_id.blank?

      # 0. T30: Bloqueio estrito de novas admissões durante modo de recuperação
      if defined?(AcRecoveryService) && AcRecoveryService.recovery_mode_active?(company: task.company)
        raise RecoveryModeActiveError, "Sistema em modo de recuperação: novas admissões estão suspensas até reconciliação (T30)"
      end

      ensure_task_authorized!(task)
      validate_manager!(plan: task.ac_plan, identity: manager_identity, epoch: manager_epoch, required: origin.to_s == "temporal")

      # 1. Idempotência estrita: se já existir execução com o mesmo operation_id, retorna a existente (§11.3)
      existing_execution = AcExecution.find_by(company: task.company, operation_id: operation_id)
      if existing_execution.present?
        unless existing_execution.ac_task_id == task.id && existing_execution.epoch.to_s == epoch.to_s &&
               existing_execution.metadata["manager_identity"] == manager_identity && existing_execution.metadata["manager_epoch"].to_s == manager_epoch.to_s
          raise UnauthorizedExecutionBypassError, "Operação reutilizada para outra tarefa ou época"
        end
        AcSharedCapacityAuthorityService.bind!(existing_execution.ac_capacity_grant)
        return {
          execution: existing_execution,
          grant: existing_execution.ac_capacity_grant,
          reused: true
        }
      end

      # 2. Verifica elegibilidade da tarefa
      unless %w[pending queued needs_changes review].include?(task.state.to_s)
        raise TaskNotEligibleForAdmissionError, "Tarefa em estado '#{task.state}' não pode ser admitida para execução"
      end

      ensure_task_authorized!(task)
      requested_role = (role || task.assigned_role).to_s
      unless requested_role == task.assigned_role.to_s || (%w[reviewer qa].include?(requested_role) && task.state.to_s == "review")
        raise ProfileNotEligibleError, "Papel não permitido nesta etapa"
      end
      configured = requested_role == task.assigned_role.to_s ? task.metadata&.dig("execution_profile_id") : nil
      profile = execution_profile || (configured.present? ? AcExecutionProfile.find_by(id: configured) : nil) || select_profile_for_task(task, requested_role)
      validate_profile_eligibility!(profile, task, requested_role)

      if AcSharedCapacityAuthorityService.shared?(profile.agent_credential)
        AcSharedCapacityAuthorityService.prepare!(task: task, profile: profile, operation_id: operation_id, epoch: epoch)
      end

      # 4. Aloca concessão de capacidade atomicamente na mesma transação (§11.3)
      result = AcExecution.transaction do
        task.ac_plan.ac_work_context.lock!
        task.ac_plan.lock!
        task.lock!
        ensure_task_authorized!(task)
        validate_manager!(plan: task.ac_plan, identity: manager_identity, epoch: manager_epoch, required: origin.to_s == "temporal")
        concurrent = AcExecution.find_by(operation_id: operation_id)
        if concurrent
          unless concurrent.company_id == task.company_id && concurrent.ac_task_id == task.id && concurrent.epoch.to_s == epoch.to_s &&
                 concurrent.metadata["manager_identity"] == manager_identity && concurrent.metadata["manager_epoch"].to_s == manager_epoch.to_s
            raise UnauthorizedExecutionBypassError, "Identidade da operação divergente"
          end
          next { execution: concurrent, grant: concurrent.ac_capacity_grant, reused: true }
        end
        eligible_states = requested_role == "programmer" ? %w[pending queued needs_changes] : %w[review]
        unless eligible_states.include?(task.state.to_s)
          raise TaskNotEligibleForAdmissionError, "Etapa mudou durante a admissão"
        end
        live = task.ac_executions.where.not(state: %w[completed failed cancelled])
        raise TaskNotEligibleForAdmissionError, "Tentativa anterior ainda ocupa a tarefa" if live.exists?
        validate_profile_eligibility!(profile, task, requested_role)
        raise TaskNotEligibleForAdmissionError, "Limite de tentativas atingido" if requested_role == "programmer" && task.attempt_limit_reached?
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

        source_artifact = {}
        if %w[reviewer qa].include?(requested_role)
          implementation = task.ac_executions.joins(:ac_execution_profile).where(state: "completed", ac_execution_profiles: { role: "programmer" }).order(:id).last
          source_artifact = implementation&.output_payload || {}
          unless source_artifact.values_at("artifact_hash", "commit_sha", "base_commit_sha").all?(&:present?)
            raise ProfileNotEligibleError, "Artefato de implementação não comprovado"
          end
        end
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
            "manager_identity" => manager_identity,
            "manager_epoch" => manager_epoch,
            "source_artifact" => source_artifact,
            "source_repository" => implementation&.worktree_path,
            "origin" => origin.to_s,
            "requested_by" => requested_by.to_s,
            "admitted_at" => Time.current.iso8601
          }
        )

        phase_generations = task.metadata.fetch("phase_generations", {}).dup
        phase_generations[requested_role] = phase_generations.fetch(requested_role, 0).to_i + 1
        task.update!(metadata: task.metadata.merge("phase_generations" => phase_generations))
        if profile.role.to_s == "programmer"
          task.update!(attempt_count: task.attempt_count + 1, state: :running,
            metadata: task.metadata.merge("execution_generation" => task.metadata.fetch("execution_generation", task.attempt_count).to_i + 1))
        end

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
      AcSharedCapacityAuthorityService.bind!(result[:grant])
      result
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

      ensure_task_authorized!(execution.ac_task)
      validate_manager!(plan: execution.ac_task.ac_plan, identity: execution.metadata["manager_identity"],
        epoch: execution.metadata["manager_epoch"])
      profile = execution.ac_execution_profile
      if profile.blank? || profile.ac_policy_revision.revoked?
        raise UnauthorizedExecutionBypassError, "Política revogada ou perfil ausente"
      end
      grant = execution.ac_capacity_grant
      unless grant.present? && %w[granted active].include?(grant.state) &&
             (grant.reconciliation_data["authority"] != "shared" || grant.reconciliation_data["broker_state"] == "bound") && (grant.expires_at.nil? || grant.expires_at > Time.current)
        raise UnauthorizedExecutionBypassError, "Concessão de capacidade inválida ou expirada: execução não admitida"
      end

      AcSharedCapacityAuthorityService.ensure_bound!(execution: execution)
      execution
    end

    private

    def select_profile_for_task(task, role)
      result = AcPolicyEngineService.select_profile_for_task(task: task, role: role)
      raise ProfileNotEligibleError, result.reason unless result.success?

      result.profile
    end

    def validate_profile_eligibility!(profile, task, requested_role)
      if profile.blank? || profile.company_id != task.company_id || profile.state.to_s != "active" || profile.ac_policy_revision.revoked?
        raise ProfileNotEligibleError, "Perfil #{profile&.id} não é elegível para execução da tarefa #{task.id}"
      end
      unless profile.ac_policy_revision_id == task.ac_plan.policy_revision_id
        raise ProfileNotEligibleError, "Perfil não pertence à política publicada do plano"
      end
      verdict = profile.eligibility_verdict
      raise ProfileNotEligibleError, verdict[:reasons].join("; ") unless verdict[:eligible]
      raise ProfileNotEligibleError, "Papel do perfil não corresponde à tarefa" unless profile.role.to_s == requested_role
      if requested_role == task.assigned_role.to_s && task.metadata&.dig("effort_level").present? && task.metadata["effort_level"] != profile.effort_level.to_s
        raise ProfileNotEligibleError, "Esforço não corresponde ao contrato da tarefa"
      end
      observation = AcQuotaObservation.latest_for(agent_credential: profile.agent_credential, cli_adapter: profile.cli_adapter, model_scope: profile.model_id)
      unless observation&.available? && observation.confidence_level.to_s == "high" && observation.valid_until.present? && observation.valid_until > Time.current
        raise ProfileNotEligibleError, "Aguardar observação positiva de cota da conta/modelo"
      end
    end

    public

    def validate_manager!(plan:, identity:, epoch:, required: false, allow_paused: false)
      plan.reload
      context = plan.ac_work_context.reload
      binding = plan.metadata || {}
      unbound = context.active_manager_identity.blank? && binding["manager_identity"].blank?
      return true if unbound && !required && identity.blank? && epoch.nil?

      if allow_paused && context.paused?
        unless identity.present? && epoch.present? && context.active_manager_identity == identity.to_s &&
               context.metadata["manager_epoch"].to_s == epoch.to_s
          raise ActiveRecord::StaleObjectError, "Gerente sem autoridade vigente"
        end
      else
        context.authorize_manager!(identity: identity, epoch: epoch)
      end
      unless context.metadata["manager_plan_id"].to_s == plan.id.to_s &&
             binding["manager_identity"] == identity.to_s && binding["manager_epoch"].to_s == epoch.to_s
        raise UnauthorizedExecutionBypassError, "Gerente não corresponde ao plano"
      end
      true
    end

    def ensure_plan_authorized!(plan)
      AcAuditDatabaseGuard.enforce!
      unless plan.published? && plan.active? && !plan.paused? && plan.ac_work_context.active?
        raise TaskNotEligibleForAdmissionError, "Plano não publicado ou contexto pausado/inativo"
      end
      policy = plan.policy_revision
      unless policy && policy.company_id == plan.company_id && policy.published_at.present? &&
             %w[published superseded].include?(policy.state.to_s)
        raise TaskNotEligibleForAdmissionError, "Política publicada válida é obrigatória"
      end
    end

    def ensure_task_authorized!(task)
      plan = task.ac_plan
      ensure_plan_authorized!(plan)
      unless !task.cancelled?
        raise TaskNotEligibleForAdmissionError, "Plano/contexto não autoriza nova operação"
      end
      policy = plan.policy_revision
      raise TaskNotEligibleForAdmissionError, "Política revogada" if policy&.revoked?
    end
  end
end
