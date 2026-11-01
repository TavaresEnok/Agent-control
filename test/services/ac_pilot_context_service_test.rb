# frozen_string_literal: true

require "test_helper"

class AcPilotContextServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
  end

  # Prova G6-E4: Inicialização, ciclo completo de entrega e reversão segura de contexto piloto (§21.2)
  test "G6-E4: manages complete pilot context lifecycle with clean rollback" do
    external_id = "paseo_chat_#{SecureRandom.hex(4)}"

    # 1. Inicializa o piloto controlado
    pilot = AcPilotContextService.initialize_pilot!(
      company: @company,
      project: @project,
      external_context_id: external_id,
      branch_name: "pilot/nexo-webchat-fix"
    )

    work_context = pilot[:work_context]
    plan = pilot[:plan]
    task = pilot[:task]

    assert_equal "active", work_context.state
    assert_equal "active", plan.state
    assert_equal "pending", task.state
    assert_equal external_id, work_context.metadata["external_context_id"]

    # 2. Executa o ciclo de entrega da tarefa piloto
    cycle_result = AcPilotContextService.complete_pilot_cycle!(
      task: task,
      approved_commit_sha: "commit-sha-pilot-123",
      artifact_hash: "hash-pilot-123"
    )

    assert_equal "pilot_cycle_completed", cycle_result[:status]
    assert_equal "integrated", task.reload.state
    assert_equal "commit-sha-pilot-123", task.approved_commit_sha

    # 3. Executa a reversão planejada do piloto (rollback)
    rollback_result = AcPilotContextService.rollback_pilot!(
      work_context: work_context,
      reason: "Piloto G6 concluído com sucesso; revertendo autoridade para teste de reversão"
    )

    assert_equal "pilot_successfully_reverted", rollback_result[:status]
    assert_equal "archived", work_context.reload.state
    assert_equal "abandoned", plan.reload.state
    assert_equal "origin_paseo_read_only", work_context.metadata["reverted_to"]
  end
end
