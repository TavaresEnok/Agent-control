# frozen_string_literal: true

require "test_helper"

class AgentControlReconciliationFailuresTest < ActiveSupport::TestCase
  include AcSafetyFixtures

  test "rate limiting is recorded once without consuming a quality attempt" do
    execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test")[:execution]
    @supervisor.receipts[execution.id] = {
      "state" => "failed", "exit_code" => 1, "operation_id" => execution.operation_id,
      "epoch" => execution.epoch.to_s, "process_handle" => "process-1", "error" => { "stderr" => "HTTP 429" }
    }
    assert_equal 1, @task.reload.attempt_count
    2.times { run_activity(Activities::AgentControl::AcReconcileExecutionActivity, { execution_id: execution.id, epoch: execution.epoch }) }
    assert_equal 0, @task.reload.attempt_count
    assert_equal "queued", @task.state
    assert_equal "rate_limited", @task.metadata["waiting_reason"]
    assert_equal 1, AcQuotaObservation.where(ac_task: @task, quota_state: "rate_limited").count
    assert_raises(AcAdmissionService::ProfileNotEligibleError) do
      AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test", execution_profile: @profiles["programmer"])
    end
  end

  test "network failure does not consume a quality attempt" do
    execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test")[:execution]
    @supervisor.receipts[execution.id] = {
      "state" => "failed", "exit_code" => 1, "operation_id" => execution.operation_id,
      "epoch" => execution.epoch.to_s, "process_handle" => "process-network", "error" => { "stderr" => "connection refused" }
    }
    run_activity(Activities::AgentControl::AcReconcileExecutionActivity, { execution_id: execution.id, epoch: execution.epoch })
    assert_equal 0, @task.reload.attempt_count
    assert_equal "queued", @task.state
    assert_equal "network_error", @task.metadata["waiting_reason"]
    assert_equal 1, AcQuotaObservation.where(ac_task: @task, quota_state: "network_error").count
  end

  test "review quota failure retains the review stage and explains the wait" do
    @task.update!(state: :review, attempt_count: 1)
    AcExecution.create!(company: @company, ac_task: @task, ac_work_context: @context,
      ac_execution_profile: @profiles["programmer"], operation_id: SecureRandom.uuid, epoch: "1", state: :completed,
      output_payload: { "artifact_hash" => "artifact", "commit_sha" => "commit", "base_commit_sha" => "base" })
    execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid,
      requested_by: "test", role: "reviewer", execution_profile: @profiles["reviewer"])[:execution]
    @supervisor.receipts[execution.id] = {
      "state" => "failed", "exit_code" => 1, "operation_id" => execution.operation_id,
      "epoch" => execution.epoch.to_s, "process_handle" => "process-review", "error" => { "stderr" => "HTTP 429" }
    }
    run_activity(Activities::AgentControl::AcReconcileExecutionActivity, { execution_id: execution.id, epoch: execution.epoch })
    assert_equal "review", @task.reload.state
    assert_equal 1, @task.attempt_count
    assert_equal "rate_limited", @task.metadata["waiting_reason"]
    assert_equal "reviewer", @task.metadata["waiting_role"]
  end

  test "a quality failure still consumes the attempt" do
    execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test")[:execution]
    @supervisor.receipts[execution.id] = {
      "state" => "failed", "exit_code" => 1, "operation_id" => execution.operation_id,
      "epoch" => execution.epoch.to_s, "process_handle" => "process-2", "error" => { "stderr" => "Tests failed" }
    }
    run_activity(Activities::AgentControl::AcReconcileExecutionActivity, { execution_id: execution.id, epoch: execution.epoch })
    assert_equal 1, @task.reload.attempt_count
    assert_equal "needs_changes", @task.state
  end
end
