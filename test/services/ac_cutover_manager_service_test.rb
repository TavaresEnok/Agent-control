# frozen_string_literal: true

require "test_helper"

class AcCutoverManagerServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @owner = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @owner)
    AcMigrationService.migrate_project!(project: @project, company: @company, assigned_owner: @owner)
  end

  test "a fabricated approver is rejected without falling back to the owner" do
    assert_raises(AcCutoverManagerService::UnauthorizedCutoverError) do
      AcCutoverManagerService.execute_cutover!(project: @project, approved_by: "fictional@example.test")
    end
    assert_not AcDecisionAuditEvent.exists?(project: @project, event_type: "human_intervention")
  end

  test "an authorized approver cannot cut over without a verified authority adapter" do
    assert_raises(AcCutoverManagerService::AuthorityUnavailableError) do
      AcCutoverManagerService.execute_cutover!(project: @project, approved_by: @owner.id)
    end
    assert_not @project.reload.settings.key?("cutover_status")
  end

  test "metadata claiming authority is not evidence of a cutover" do
    @project.update!(settings: @project.settings.merge("cutover_status" => "completed", "authority_mode" => "agent_control_exclusive"))
    assert_not AcCutoverManagerService.cutover_status(project: @project)[:cutover_completed]
  end

  test "reversion cannot claim a remote authority change" do
    assert_raises(AcCutoverManagerService::AuthorityUnavailableError) do
      AcCutoverManagerService.revert_cutover!(project: @project, reason: "rollback", reverted_by: @owner.email)
    end
  end
end
