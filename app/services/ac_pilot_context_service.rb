# frozen_string_literal: true

class AcPilotContextService
  class PilotError < StandardError; end
  class PilotAlreadyActiveError < PilotError; end
  class UnverifiedPilotError < PilotError; end

  class << self
    def initialize_pilot!(company:, project:, external_context_id:, branch_name: "pilot/agent-control-test")
      unless company && project && project.company_id == company.id && external_context_id.to_s.present?
        raise ArgumentError, "Empresa, projeto e contexto piloto devem corresponder"
      end
      unless branch_name.to_s.match?(/\Apilot\/[A-Za-z0-9][A-Za-z0-9._\/-]*\z/) &&
             !branch_name.include?("..") && !branch_name.include?("//") && !branch_name.include?("/.") &&
             !branch_name.end_with?("/", ".", ".lock")
        raise ArgumentError, "Branch piloto deve ficar no namespace pilot/"
      end
      sanitized_id = external_context_id.to_s.gsub(/[^a-zA-Z0-9_\-]/, "-")
      project.with_lock do
        existing = AcWorkContext.find_by(company: company, project: project, external_id: "pilot-#{sanitized_id}")
        raise PilotAlreadyActiveError, "Contexto piloto já existe" if existing

        work_context = AcWorkContext.create!(company: company, project: project,
          external_id: "pilot-#{sanitized_id}", title: "Piloto Controlado - #{sanitized_id}", state: :active,
          metadata: { "external_context_id" => sanitized_id, "target_branch" => branch_name,
                      "pilot_prepared_at" => Time.current.iso8601, "authority_transferred" => false })
        plan = AcPlan.create!(company: company, project: project, ac_work_context: work_context,
          plan_key: "plan-pilot-#{sanitized_id}", title: "Plano Piloto de Homologação G6",
          objective: "Validar ciclo completo em ambiente isolado", version: 1, state: :draft)
        task = AcTask.create!(company: company, project: project, ac_plan: plan, task_key: "task-pilot-1",
          title: "Implementação Piloto Controlada", scope: "Validação piloto em ambiente descartável",
          state: :pending, risk_class: :high, assigned_role: :programmer, position: 1,
          metadata: { "target_branch" => branch_name })
        { work_context: work_context, plan: plan, task: task, status: "pilot_prepared" }
      end
    end

    def complete_pilot_cycle!(task:, approved_commit_sha:, artifact_hash:)
      raise ArgumentError, "task é obrigatório" unless task

      task.reload
      operation = task.integrated? && AcIntegrationOperation.find_by(ac_task: task, state: "completed",
        candidate_commit: approved_commit_sha, artifact_hash: artifact_hash)
      unless operation && task.approved_commit_sha == approved_commit_sha && task.approved_artifact_hash == artifact_hash
        raise UnverifiedPilotError, "Piloto precisa de integração Git verificada; rótulos não concluem o ciclo"
      end
      { task: task, status: "pilot_cycle_completed", integrated_commit: operation.candidate_commit,
        integration_operation_id: operation.id }
    end

    def rollback_pilot!(work_context:, reason: "Descartar rascunho de piloto")
      raise ArgumentError, "work_context é obrigatório" unless work_context

      work_context.with_lock do
        plans = work_context.ac_plans.lock.to_a
        executions = AcExecution.where(ac_work_context: work_context)
        launched = TriggerEvent.where(company: work_context.company, source: AcPlanLaunchService::EVENT_TYPE)
          .where("data ->> 'plan_id' IN (?)", plans.map { |plan| plan.id.to_s }).exists? if plans.any?
        if launched || executions.exists? || plans.any?(&:published?) ||
           AcCapacityGrant.joins(:ac_task).where(ac_tasks: { ac_plan_id: plans.map(&:id) }).exists?
          raise UnverifiedPilotError, "Reversão de piloto executado exige reconciliação e autoridade externas"
        end
        plans.each { |plan| plan.cancel!(reason: reason) }
        work_context.update!(state: :archived, metadata: work_context.metadata.merge(
          "pilot_discarded_at" => Time.current.iso8601, "discard_reason" => reason, "authority_transferred" => false))
        { work_context_id: work_context.id, status: "pilot_draft_archived", authority_transferred: false }
      end
    end
  end
end
