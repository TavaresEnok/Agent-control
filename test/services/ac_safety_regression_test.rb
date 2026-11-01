# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "open3"

class AcSafetyRegressionTest < ActiveSupport::TestCase
  include AcSafetyFixtures

  test "normal admission selects the real policy API and counts the attempt once" do
    op = SecureRandom.uuid
    first = AcAdmissionService.admit_execution!(task: @task, operation_id: op, requested_by: "test")
    second = AcAdmissionService.admit_execution!(task: @task, operation_id: op, requested_by: "test")
    assert_equal first[:execution].id, second[:execution].id
    assert_equal 1, @task.reload.attempt_count
    assert_equal 1, @task.ac_capacity_grants.count
  end

  test "an expired negative observation cannot resurrect an older positive balance" do
    AcQuotaObservation.where(agent_credential: @credential).update_all(observed_at: 1.hour.ago)
    AcQuotaObservation.create!(company: @company, agent_credential: @credential, cli_adapter: "claude_code",
      model_scope: "claude-test", quota_state: :exhausted, confidence_level: :high, origin: :api_header,
      observed_at: 10.minutes.ago, valid_until: 1.minute.ago)
    assert_raises(AcAdmissionService::ProfileNotEligibleError) do
      AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test")
    end
  end

  test "a second operation cannot occupy the running task" do
    AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test")
    assert_raises(AcAdmissionService::TaskNotEligibleForAdmissionError) do
      AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test")
    end
    assert_equal 1, @task.ac_executions.count
  end

  test "paused plans cannot admit even an explicit active profile" do
    @plan.pause!(reason: "Human hold")
    assert_empty @plan.ready_tasks
    assert_raises(AcAdmissionService::TaskNotEligibleForAdmissionError) do
      AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test", execution_profile: @profiles["programmer"])
    end
    assert_empty @task.ac_executions
  end

  test "revocation persists without falsely freeing live resources" do
    admitted = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "test")
    assert @policy.revoke!(by_user: @user, reason: "Emergency")
    assert @policy.reload.revoked?
    assert admitted[:grant].reload.granted?
    assert admitted[:execution].reload.state_uncertain?
    assert_raises(AcAdmissionService::TaskNotEligibleForAdmissionError) do
      AcAdmissionService.validate_execution_authority!(execution_id: admitted[:execution].id,
        operation_id: admitted[:execution].operation_id, reported_epoch: admitted[:execution].epoch)
    end
  end

  test "a plain approval payload cannot fabricate independent review" do
    assert_raises(AcReviewService::InvalidVerdictError) do
      AcReviewService.submit_verdict!(task: @task, artifact_hash: "not-evidence", verdict: "approved", evaluator_identity: "independent-council")
    end
    assert_empty @task.ac_review_verdicts
    assert_not @task.reload.approved?
  end

  test "QA waiver is not accepted as a worker verdict" do
    assert_raises(AcReviewService::InvalidVerdictError) do
      AcReviewService.submit_verdict!(task: @task, artifact_hash: "a", verdict: "waived", reviewer_role: :qa, evaluator_identity: "qa")
    end
  end

  test "approved dependencies do not unblock another task or complete the plan" do
    plan = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Dependency plan", version: 1, state: :draft)
    parent = AcTask.create!(company: @company, project: @project, ac_plan: plan, task_key: "parent", title: "Parent")
    child = AcTask.create!(company: @company, project: @project, ac_plan: plan, task_key: "child", title: "Child", depends_on: [ "parent" ])
    assert plan.publish!(policy_revision: @policy)
    parent.update!(state: :approved, approved_artifact_hash: "a", approved_commit_sha: "b")
    assert_not_includes plan.ready_tasks, child
    assert_not plan.all_tasks_completed?
    parent.update!(state: :integrated)
    assert_includes plan.ready_tasks, child
  end

  test "published plan and task contracts cannot be edited in place" do
    assert_not @plan.update(objective: "Changed without a version")
    assert_not @task.update(scope: "Changed without a version")
  end

  test "manager reassignment requires the current epoch" do
    epoch = @context.assign_active_manager!(identity: "manager-a")
    assert_raises(ActiveRecord::StaleObjectError) { @context.assign_active_manager!(identity: "manager-b") }
    assert_raises(ActiveRecord::StaleObjectError) { @context.assign_active_manager!(identity: "manager-b", expected_epoch: epoch) }
    assert @context.authorize_manager!(identity: "manager-a", epoch: epoch)
  end
end
