# frozen_string_literal: true

require "test_helper"

class AcPilotContextServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
  end

  test "prepares a draft without claiming integration or authority transfer" do
    pilot = AcPilotContextService.initialize_pilot!(company: @company, project: @project,
      external_context_id: SecureRandom.uuid, branch_name: "pilot/isolated")
    assert pilot[:plan].draft?
    refute_predicate pilot[:plan], :published?
    assert_equal "pilot/isolated", pilot[:task].metadata["target_branch"]
    assert_raises(AcPilotContextService::UnverifiedPilotError) do
      AcPilotContextService.complete_pilot_cycle!(task: pilot[:task], approved_commit_sha: "invented", artifact_hash: "invented")
    end
    assert pilot[:task].reload.pending?
    result = AcPilotContextService.rollback_pilot!(work_context: pilot[:work_context])
    assert_equal "pilot_draft_archived", result[:status]
    refute result[:authority_transferred]
    assert pilot[:work_context].reload.archived?
  end

  test "rejects a foreign project or a production branch" do
    other = create(:company)
    assert_raises(ArgumentError) do
      AcPilotContextService.initialize_pilot!(company: other, project: @project, external_context_id: "wrong")
    end
    assert_raises(ArgumentError) do
      AcPilotContextService.initialize_pilot!(company: @company, project: @project, external_context_id: "wrong", branch_name: "main")
    end
  end

  test "cannot discard a pilot with an uncertain writer" do
    pilot = AcPilotContextService.initialize_pilot!(company: @company, project: @project, external_context_id: SecureRandom.uuid)
    AcExecution.create!(company: @company, ac_task: pilot[:task], ac_work_context: pilot[:work_context],
      operation_id: SecureRandom.uuid, epoch: "1", state: :uncertain)
    assert_raises(AcPilotContextService::UnverifiedPilotError) do
      AcPilotContextService.rollback_pilot!(work_context: pilot[:work_context])
    end
    assert pilot[:work_context].reload.active?
  end
end
