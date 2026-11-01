# frozen_string_literal: true

require "test_helper"

class AcReviewServiceTest < ActiveSupport::TestCase
  include AcTemporalFixture
  setup { setup_ac_temporal_fixture }
  teardown { teardown_ac_temporal_fixture }

  test "a self-declared reviewer cannot approve without an independent execution" do
    @task.update!(state: "review")
    assert_raises(AcReviewService::InvalidVerdictError) do
      AcReviewService.submit_verdict!(task: @task, artifact_hash: "self-declared", verdict: "approved",
        reviewer_role: "reviewer", evaluator_identity: "reviewer-name", candidate_commit_sha: "invented")
    end
    assert_empty @task.ac_review_verdicts
    assert @task.reload.review?
  end

  test "a caller cannot waive QA with a self-declared executor" do
    @task.update!(state: "review")
    assert_raises(AcReviewService::InvalidVerdictError) do
      AcReviewService.submit_verdict!(task: @task, artifact_hash: "self-declared", verdict: "waived",
        reviewer_role: "qa", evaluator_identity: "qa-name")
    end
    assert_empty @task.ac_review_verdicts
    assert @task.reload.review?
  end

  test "an implementation execution cannot stand in for an independent reviewer" do
    execution = admit_ac_execution
    execution.update!(state: :completed, exit_code: 0, process_handle: "implementer")
    @task.update!(state: "review")
    assert_raises(AcReviewService::InvalidVerdictError) do
      AcReviewService.submit_verdict!(task: @task, execution: execution, artifact_hash: "artifact",
        verdict: "approved", reviewer_role: "reviewer", evaluator_identity: "implementer")
    end
    assert_empty @task.ac_review_verdicts
  end
end
