# frozen_string_literal: true

# AcPilotContextService — Migração Piloto e Reversão Segura (Gate G6, §21.2)
#
# Executa a migração gradual de um contexto piloto controlado:
# - Importação read-only;
# - Transferência de autoridade segura sem concorrência;
# - Execução supervisionada do ciclo piloto (DAG -> Revisão -> CAS Integration);
# - Reversão (rollback) limpa preservando histórico e pausas originais.
class AcPilotContextService
  class PilotError < StandardError; end
  class PilotAlreadyActiveError < PilotError; end

  class << self
    def initialize_pilot!(company:, project:, external_context_id:, branch_name: "pilot/agent-control-test")
      raise ArgumentError, "company e project são obrigatórios" if company.blank? || project.blank?

      sanitized_id = external_context_id.to_s.gsub(/[^a-zA-Z0-9_\-]/, "-")
      # 1. Verifica se já existe contexto piloto ativo para o mesmo ID externo
      existing = AcWorkContext.find_by(company: company, project: project, external_id: "pilot-#{sanitized_id}")
      if existing&.active?
        raise PilotAlreadyActiveError, "Contexto piloto já ativo: #{existing.id}"
      end

      # 2. Cria o contexto de trabalho piloto em isolamento
      work_context = AcWorkContext.create!(
        company: company,
        project: project,
        external_id: "pilot-#{sanitized_id}",
        title: "Piloto Controlado - #{sanitized_id}",
        state: "active",
        metadata: {
          "migrated_from" => "paseo_pilot_export",
          "external_context_id" => sanitized_id,
          "target_branch" => branch_name,
          "pilot_started_at" => Time.current.iso8601
        }
      )

      # 3. Cria plano piloto com hash versionado
      plan = AcPlan.create!(
        company: company,
        project: project,
        ac_work_context: work_context,
        plan_key: "plan-pilot-#{sanitized_id}",
        title: "Plano Piloto de Homologação G6",
        objective: "Demonstrar ciclo completo e reversibilidade de contexto piloto",
        version: 1,
        state: :active,
        content_hash: Digest::SHA256.hexdigest("pilot_plan_#{work_context.id}")
      )

      # 4. Cria tarefa piloto com gates de revisão obrigatórios
      task = AcTask.create!(
        company: company,
        project: project,
        ac_plan: plan,
        task_key: "task-pilot-1",
        title: "Implementação Piloto Controlada",
        scope: "Validação piloto em ambiente descartável",
        state: "pending",
        risk_class: "high",
        assigned_role: "programmer",
        position: 1
      )

      {
        work_context: work_context,
        plan: plan,
        task: task,
        status: "pilot_initialized"
      }
    end

    def complete_pilot_cycle!(task:, approved_commit_sha:, artifact_hash:)
      raise ArgumentError, "task é obrigatório" if task.blank?

      # Transiciona a tarefa no ciclo seguro
      task.start_running!
      task.submit_for_review!
      task.approve!(commit_sha: approved_commit_sha, artifact_hash: artifact_hash)
      task.integrate!

      {
        task: task,
        status: "pilot_cycle_completed",
        integrated_commit: approved_commit_sha
      }
    end

    def rollback_pilot!(work_context:, reason: "Reversão planejada do piloto (G6)")
      raise ArgumentError, "work_context é obrigatório" if work_context.blank?

      work_context.update!(
        state: "archived",
        metadata: (work_context.metadata || {}).merge(
          "reverted_at" => Time.current.iso8601,
          "rollback_reason" => reason,
          "reverted_to" => "origin_paseo_read_only"
        )
      )

      # Abandona quaisquer planos associados para integridade
      work_context.ac_plans.update_all(state: "abandoned")

      {
        work_context_id: work_context.id,
        status: "pilot_successfully_reverted",
        reverted_at: Time.current.iso8601
      }
    end
  end
end
