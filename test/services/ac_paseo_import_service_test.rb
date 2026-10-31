# frozen_string_literal: true

require "test_helper"

class AcPaseoImportServiceTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
  end

  test "imports legacy paseo in read-only mode (RF-33, E03)" do
    tasks = [
      {
        task_key: "task-boot-f0",
        title: "Boot F0 environment",
        description: "Validar boot isolado do laboratório",
        state: :integrated,
        risk_class: :medium,
        assigned_role: :programmer
      },
      {
        task_key: "task-ssh-f0",
        title: "SSH physical access",
        description: "Validar acesso físico SSH com chave fixada",
        state: :integrated,
        risk_class: :high,
        assigned_role: :programmer
      }
    ]

    result = AcPaseoImportService.import_paseo!(
      company: @company,
      project: @project,
      paseo_number: 10,
      title: "SSH e Gateway F0",
      objective: "Consolidar evidências e ambiente de laboratório F0",
      tasks_data: tasks,
      metadata: { "source_sha" => "c7455f7f0c4d" }
    )

    assert result.success?, result.error
    assert_equal 2, result.tasks_count

    # Contexto importado arquivado
    ctx = result.work_context
    assert ctx.archived?
    assert ctx.origin.paseo_import?
    assert ctx.metadata["imported_readonly"]

    # Plano completado com hash de conteúdo
    plan = result.plan
    assert plan.completed?
    assert plan.created_by_type.import?
    assert_not_nil plan.content_hash
    assert plan.metadata["imported_readonly"]

    # Tarefas criadas
    task_keys = plan.ac_tasks.pluck(:task_key)
    assert_includes task_keys, "task-boot-f0"
    assert_includes task_keys, "task-ssh-f0"
    assert plan.ac_tasks.all? { |t| t.metadata["imported_readonly"] }

    # Auditoria registrada
    audit = AcDecisionAuditEvent.where(ac_work_context: ctx, event_type: "policy_published").last
    assert_not_nil audit
    assert_equal "system", audit.actor_type
    assert audit.decision_details["read_only"]
  end
end
