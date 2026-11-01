# frozen_string_literal: true

require "test_helper"

class AcCutoverManagerServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @owner = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @owner)

    # Pré-condição: projeto com migração prévia de autoridade
    @project.settings ||= {}
    @project.settings["authority_mode"] = "agent_control_exclusive"
    @project.save!
  end

  # Prova G7-E4: Cutover final com autorização explícita e atualização de links de rastreabilidade (Gate G7)
  test "G7-E4: executes cutover with formal approval and redirects traceability links" do
    redirect_map = {
      "dashboard" => "https://app.agentcontrol.internal/projects/#{@project.id}/graph",
      "webhooks" => "https://app.agentcontrol.internal/api/v1/agent_control/client_commands",
      "status_board" => "https://app.agentcontrol.internal/agent_control/wizard"
    }

    result = AcCutoverManagerService.execute_cutover!(
      project: @project,
      approved_by: "proprietario-autorizado@nexoisp.internal",
      cutoff_ticket: "MIG-CUTOVER-20261101",
      redirect_links: redirect_map
    )

    assert_equal "cutover_completed", result[:status]
    assert_equal "proprietario-autorizado@nexoisp.internal", result[:approved_by]
    assert_equal "MIG-CUTOVER-20261101", result[:cutoff_ticket]
    assert_equal redirect_map, result[:redirect_links]

    # Verifica persistência e status
    status = AcCutoverManagerService.cutover_status(project: @project)
    assert_equal true, status[:cutover_completed]
    assert_equal "agent_control_exclusive", status[:authority_mode]
    assert_equal redirect_map["dashboard"], status[:redirect_links]["dashboard"]

    # Verifica gravação do evento formal de auditoria ([BUG-P1-05])
    audit = AcDecisionAuditEvent.find_by(project: @project, event_type: "human_intervention")
    assert_not_nil audit, "Evento de auditoria formal deve ser persistido"
    assert_equal "cutover_completed", audit.decision_details["action"]
  end

  test "G7-E4: rejects cutover when approval identifier is blank (strict authorization)" do
    assert_raises(AcCutoverManagerService::UnauthorizedCutoverError) do
      AcCutoverManagerService.execute_cutover!(
        project: @project,
        approved_by: ""
      )
    end
  end

  test "G7-E4: rejects cutover if project authority was not migrated first" do
    unmigrated_project = create(:project, company: @company, owner: @owner)

    assert_raises(AcCutoverManagerService::ProjectNotMigratedError) do
      AcCutoverManagerService.execute_cutover!(
        project: unmigrated_project,
        approved_by: "admin@aixle.test"
      )
    end
  end

  # Prova G7-E5: Reversão limpa do cutover para coexistência segura em caso de contingência
  test "G7-E5: safely reverts cutover to coexistence read-only on contingency" do
    AcCutoverManagerService.execute_cutover!(
      project: @project,
      approved_by: "lead-engineer@aixle.test"
    )

    reversion = AcCutoverManagerService.revert_cutover!(
      project: @project,
      reason: "Contingência temporária para validação externa",
      reverted_by: "sysadmin-incident-response"
    )

    assert_equal "cutover_reverted", reversion[:status]
    assert_equal "sysadmin-incident-response", reversion[:reverted_by]

    status = AcCutoverManagerService.cutover_status(project: @project)
    assert_equal false, status[:cutover_completed]
    assert_equal "coexistence_read_only", status[:authority_mode]
  end
end
