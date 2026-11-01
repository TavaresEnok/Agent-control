# frozen_string_literal: true

require "test_helper"

class AgentControlActivitiesTest < ActiveSupport::TestCase
  include AcTemporalFixture
  setup { setup_ac_temporal_fixture }
  teardown { teardown_ac_temporal_fixture }

  test "admission activity creates a grant for a published plan and observed account" do
    event = AcPlanLaunchService.record!(plan: @plan, actor: @user)
    result = Activities::AgentControl::AcAdmitTaskActivity.new.execute(
      task_id: @task.id, operation_id: SecureRandom.uuid, execution_profile_id: @profile.id, epoch: "1",
      manager_identity: event.data["manager_identity"], manager_epoch: event.data["manager_epoch"])
    assert result["execution_id"].present?
    assert AcCapacityGrant.find(result["grant_id"]).granted?
  end

  test "verified runtime evidence controls completion and release" do
    execution = admit_ac_execution
    supervisor = Rails.application.config.ac_runtime_supervisor
    supervisor.receipts[execution.id] = {
      "state" => "running", "operation_id" => execution.operation_id,
      "epoch" => execution.epoch, "process_handle" => "fake-runtime-handle"
    }
    result = Activities::AgentControl::AcDispatchExecutionActivity.new.execute(execution_id: execution.id, epoch: "1")
    assert_equal "running", result["state"]
    supervisor.receipts[execution.id] = {
      "state" => "completed", "operation_id" => execution.operation_id,
      "epoch" => execution.epoch, "process_handle" => "fake-runtime-handle", "exit_code" => 0,
      "output" => { "artifact_hash" => "artifact-fixture", "commit_sha" => "commit-fixture", "base_commit_sha" => "base-fixture" }
    }
    result = Activities::AgentControl::AcReconcileExecutionActivity.new.execute(execution_id: execution.id, epoch: "1", exit_code: 42)
    assert_equal "completed", result["state"]
    assert_equal 0, result["exit_code"]
    assert_equal "review", @task.reload.state
    result = Activities::AgentControl::AcReleaseCapacityActivity.new.execute(execution_id: execution.id)
    assert result["grant_released"]
  end

  test "dispatch rejects an unverifiable runtime response" do
    execution = admit_ac_execution
    assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) do
      Activities::AgentControl::AcDispatchExecutionActivity.new.execute(execution_id: execution.id, epoch: "1")
    end
    assert_nil execution.reload.process_handle
    assert execution.ac_capacity_grant.reload.granted?
  end

  test "release refuses without a receipt proving the writer stopped" do
    execution = admit_ac_execution
    assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) do
      Activities::AgentControl::AcReleaseCapacityActivity.new.execute(execution_id: execution.id)
    end
    assert execution.ac_capacity_grant.reload.granted?
  end
end
