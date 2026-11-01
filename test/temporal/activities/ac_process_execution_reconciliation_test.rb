# frozen_string_literal: true

require "test_helper"

module Activities
  module AgentControl
    class AcProcessExecutionReconciliationTest < ActiveSupport::TestCase
      include AcTemporalFixture
      setup { setup_ac_temporal_fixture }
      teardown { teardown_ac_temporal_fixture }

      test "caller supplied success does not replace a verified process receipt" do
        execution = admit_ac_execution
        execution.mark_running!(handle: "process-fixture")
        assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) do
          AcReconcileExecutionActivity.new.execute(execution_id: execution.id, epoch: "1", exit_code: 0,
            output: { "artifact_hash" => "fake" })
        end
        assert_equal "uncertain", execution.reload.state
        assert_nil execution.exit_code
        assert execution.ac_capacity_grant.reload.granted?
      end

      test "a stale epoch cannot reconcile a process" do
        execution = admit_ac_execution(epoch: "2")
        execution.mark_running!(handle: "process-fixture")
        assert_raises(AcExecution::StaleEpochError) do
          AcReconcileExecutionActivity.new.execute(execution_id: execution.id, epoch: "1", exit_code: 0)
        end
        assert_equal "running", execution.reload.state
      end
    end
  end
end
