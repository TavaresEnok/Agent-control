# frozen_string_literal: true

# AcPaseoImportService — Importação Somente de Leitura dos Paseos (F1-E, E03, RF-33)
#
# Preserva o histórico, planos e evidências dos Paseos anteriores em modo
# estritamente read-only (RF-33). Os registros importados são arquivados
# e marcados como origin: :paseo_import, garantindo a rastreabilidade
# sem poluir os contextos operacionais ativos.
class AcPaseoImportService
  Result = Struct.new(:success?, :work_context, :plan, :tasks_count, :error, keyword_init: true)

  def self.import_paseo!(company:, project:, paseo_number:, title:, objective:, tasks_data: [], metadata: {})
    new(company: company, project: project).import_paseo(
      paseo_number: paseo_number,
      title: title,
      objective: objective,
      tasks_data: tasks_data,
      metadata: metadata
    )
  end

  def initialize(company:, project:)
    @company = company
    @project = project
  end

  def import_paseo(paseo_number:, title:, objective:, tasks_data: [], metadata: {})
    external_id = "paseo-#{paseo_number.to_s.downcase.gsub(/[^a-z0-9]/, '-')}"
    plan_key = "plan-paseo-#{paseo_number}"

    ApplicationRecord.transaction do
      # 1. Contexto de trabalho arquivado (read-only)
      work_context = AcWorkContext.create!(
        company: @company,
        project: @project,
        external_id: external_id,
        title: "Paseo #{paseo_number}: #{title}",
        state: :archived,
        origin: :paseo_import,
        metadata: metadata.merge(imported_readonly: true, imported_at: Time.current.iso8601)
      )

      # 2. Plano versionado e completado
      plan = AcPlan.create!(
        company: @company,
        project: @project,
        ac_work_context: work_context,
        plan_key: plan_key,
        version: 1,
        title: "Plano Paseo #{paseo_number}: #{title}",
        objective: objective,
        state: :draft,
        created_by_type: :import,
        metadata: { imported_readonly: true, paseo_number: paseo_number }
      )

      # 3. Tarefas importadas
      tasks_count = 0
      tasks_data.each_with_index do |task_data, idx|
        key = task_data[:task_key] || "task-#{idx + 1}"
        AcTask.create!(
          company: @company,
          project: @project,
          ac_plan: plan,
          task_key: key,
          title: task_data[:title] || key,
          scope: task_data[:description],
          position: idx + 1,
          state: (task_data[:state] || :integrated).to_sym,
          risk_class: (task_data[:risk_class] || :medium).to_sym,
          assigned_role: (task_data[:assigned_role] || :programmer).to_sym,
          metadata: { imported_readonly: true, original_data: task_data }
        )
        tasks_count += 1
      end

      raise ArgumentError, plan.errors.full_messages.to_sentence unless plan.publish!
      plan.update!(state: :completed)

      # 4. Auditoria do evento de importação
      AcDecisionAuditEvent.create!(
        company: @company,
        project: @project,
        ac_work_context: work_context,
        ac_plan: plan,
        event_type: "policy_published",
        actor_type: "system",
        occurred_at: Time.current,
        reason: "Importação read-only do Paseo #{paseo_number} preservada conforme RF-33",
        decision_details: {
          paseo_number: paseo_number,
          tasks_imported: tasks_count,
          read_only: true
        }
      )

      Result.new(
        success?: true,
        work_context: work_context,
        plan: plan,
        tasks_count: tasks_count,
        error: nil
      )
    end
  rescue StandardError => e
    Result.new(
      success?: false,
      work_context: nil,
      plan: nil,
      tasks_count: 0,
      error: e.message
    )
  end
end
