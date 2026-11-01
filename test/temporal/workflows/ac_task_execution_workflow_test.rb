# frozen_string_literal: true

require "test_helper"

module Workflows
  class AcTaskExecutionWorkflowTest < ActiveSupport::TestCase
    include AcTemporalFixture
    setup { setup_ac_temporal_fixture }
    teardown { teardown_ac_temporal_fixture }

    test "replayed admission returns the same execution and grant" do
      operation = SecureRandom.uuid
      first = admit_ac_execution(operation_id: operation)
      second = admit_ac_execution(operation_id: operation)
      assert_equal first.id, second.id
      assert_equal first.ac_capacity_grant_id, second.ac_capacity_grant_id
      assert_equal 1, AcExecution.where(operation_id: operation).count
    end

    test "missing execution cannot bypass admission" do
      assert_raises(AcAdmissionService::UnauthorizedExecutionBypassError) do
        Activities::AgentControl::AcDispatchExecutionActivity.new.execute(execution_id: -1, epoch: "1")
      end
    end

    test "cancellation signal records the request" do
      workflow = AcTaskExecutionWorkflow.new
      workflow.init
      workflow.cancel_execution("Operator requested cancellation")
      assert workflow.execution_status[:cancelled]
      assert_equal "Operator requested cancellation", workflow.execution_status[:cancellation_reason]
    end
  end
end
