# frozen_string_literal: true

require "test_helper"

class AcManagerBindingTest < ActiveSupport::TestCase
  include AcSafetyFixtures

  test "a context has one plan manager and launch replay keeps the original epoch" do
    event = AcPlanLaunchService.record!(plan: @plan, actor: @user)
    assert_equal event.id, AcPlanLaunchService.record!(plan: @plan, actor: @user).id
    assert_equal event.data["manager_identity"], @context.reload.active_manager_identity
    assert_equal event.data["manager_epoch"], @plan.reload.metadata["manager_epoch"]

    other = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Other", version: 1, state: :draft)
    AcTask.create!(company: @company, project: @project, ac_plan: other, task_key: "other", title: "Other")
    assert other.publish!(policy_revision: @policy)
    assert_raises(ActiveRecord::StaleObjectError) { AcPlanLaunchService.record!(plan: other, actor: @user) }
    assert_equal 1, TriggerEvent.where(company: @company, source: AcPlanLaunchService::EVENT_TYPE).count
  end

  test "unbound or stale workers cannot admit or reach physical worktree operations" do
    event = AcPlanLaunchService.record!(plan: @plan, actor: @user)
    assert_raises(ActiveRecord::StaleObjectError) do
      AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid, requested_by: "old", origin: "temporal")
    end
    execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid,
      requested_by: "new", origin: "temporal", manager_identity: event.data["manager_identity"], manager_epoch: event.data["manager_epoch"])[:execution]
    context_metadata = @context.reload.metadata.merge("manager_epoch" => event.data["manager_epoch"] + 1)
    @context.update_columns(metadata: context_metadata)
    assert_raises(ActiveRecord::StaleObjectError) do
      AcAdmissionService.validate_execution_authority!(execution_id: execution.id, operation_id: execution.operation_id, reported_epoch: execution.epoch)
    end
    assert_raises(ActiveRecord::StaleObjectError) { AcWorktreeManagerService.acquire_lease!(execution: execution, base_path: "/tmp/ac-stale-test", repo_path: "/tmp") }
    assert execution.ac_capacity_grant.reload.granted?
    assert_nil execution.reload.worktree_lease_token
  end

  test "terminal completion releases the claim, preserves its acknowledgment and admits another plan" do
    event = AcPlanLaunchService.record!(plan: @plan, actor: @user)
    binding = { plan_id: @plan.id, manager_identity: event.data["manager_identity"], manager_epoch: event.data["manager_epoch"] }
    @task.update!(state: :approved, approved_commit_sha: "commit", approved_artifact_hash: "hash")
    @task.integrate!
    result = run_activity(Activities::AgentControl::AcAdvancePlanDagActivity, binding)
    assert result["all_completed"]
    assert_nil @context.reload.active_manager_identity

    other = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Next", version: 1, state: :draft)
    AcTask.create!(company: @company, project: @project, ac_plan: other, task_key: "next", title: "Next")
    assert other.publish!(policy_revision: @policy)
    next_event = AcPlanLaunchService.record!(plan: other, actor: @user)
    assert_operator next_event.data["manager_epoch"], :>, event.data["manager_epoch"]
    assert run_activity(Activities::AgentControl::AcAdvancePlanDagActivity, binding)["all_completed"]
    assert_equal next_event.data["manager_identity"], @context.reload.active_manager_identity
  end

  test "cancellation retains manager until uncertain execution is reconciled" do
    event = AcPlanLaunchService.record!(plan: @plan, actor: @user)
    execution = AcExecution.create!(company: @company, ac_task: @task, ac_work_context: @context, ac_execution_profile: @profiles["programmer"],
      operation_id: SecureRandom.uuid, epoch: "1", state: :uncertain)
    binding = { plan_id: @plan.id, manager_identity: event.data["manager_identity"], manager_epoch: event.data["manager_epoch"] }
    result = run_activity(Activities::AgentControl::AcCancelPlanActivity, binding)
    assert result["release_pending"]
    assert_equal event.data["manager_identity"], @context.reload.active_manager_identity
    execution.update!(state: :completed)
    result = run_activity(Activities::AgentControl::AcCancelPlanActivity, binding)
    refute result["release_pending"]
    assert_nil @context.reload.active_manager_identity
    refute run_activity(Activities::AgentControl::AcCancelPlanActivity, binding)["release_pending"]
  end

  test "first claim refuses an unresolved legacy writer" do
    AcExecution.create!(company: @company, ac_task: @task, ac_work_context: @context, ac_execution_profile: @profiles["programmer"],
      operation_id: SecureRandom.uuid, epoch: "1", state: :uncertain)
    assert_raises(ActiveRecord::StaleObjectError) { AcPlanLaunchService.record!(plan: @plan, actor: @user) }
    assert_nil @context.reload.active_manager_identity
  end
end
