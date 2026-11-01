# frozen_string_literal: true

require "test_helper"

class AcIntegrationServiceTest < ActiveSupport::TestCase
  include AcTemporalFixture
  setup { setup_ac_temporal_fixture }
  teardown { teardown_ac_temporal_fixture }

  test "a caller cannot integrate inside a transaction with self-reported evidence" do
    assert_raises(AcIntegrationService::IntegrationError) do
      AcIntegrationService.integrate_task!(task: @task, expected_base_commit: "claimed-base",
        candidate_commit: "claimed-commit", current_branch_head: "claimed-base", artifact_hash: "claimed-hash",
        verification_evidence: { executor_identity: "claimed-runner", exit_code: 0 })
    end
    assert_not @task.reload.integrated?
    assert_empty AcIntegrationOperation.where(ac_task: @task)
  end
end
