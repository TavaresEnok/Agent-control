# frozen_string_literal: true

require "test_helper"

class AgentControlActivitiesTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context Activity",
      external_id: "ctx-act-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "act-plan-#{SecureRandom.hex(4)}",
      title: "Plan Activity",
      objective: "Activity tests",
      version: 1
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-act-#{SecureRandom.hex(4)}",
      title: "Task Activity",
      scope: "Activity scope",
      position: 1,
      risk_class: :low,
      assigned_role: :programmer,
      state: :pending
    )
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_act_1",
      content: {
        "model_chain" => ["gpt-5.2"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: { "valid" => true, "errors" => [] },
      state: :published,
      apply_mode: :next_attempts
    )
    @credential = create(:agent_credential, user: @user, company: @company, agent_type: "codex")
    @profile = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-codex-act",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :medium,
      agent_credential: @credential,
      chain_position: 1,
      state: :active
    )
  end

  test "AcAdmitTaskActivity admits task and returns IDs" do
    activity = Activities::AgentControl::AcAdmitTaskActivity.new
    op_id = "op-act-adm-#{SecureRandom.hex(4)}"

    input = {
      task_id: @task.id,
      operation_id: op_id,
      execution_profile_id: @profile.id,
      epoch: "1"
    }

    result = activity.execute(input)
    assert result["execution_id"].present?
    assert result["grant_id"].present?
    assert_not result["reused"]
  end

  test "AcAcquireWorktreeActivity alocates lease token" do
    op_id = "op-act-wt-#{SecureRandom.hex(4)}"
    admit_res = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: op_id,
      requested_by: "test",
      execution_profile: @profile,
      epoch: "1"
    )
    execution = admit_res[:execution]

    activity = Activities::AgentControl::AcAcquireWorktreeActivity.new
    result = activity.execute({ execution_id: execution.id })

    assert result["lease_token"].present?
    assert result["worktree_path"].present?
  end

  test "AcDispatchExecutionActivity starts execution and creates process handle" do
    op_id = "op-act-disp-#{SecureRandom.hex(4)}"
    admit_res = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: op_id,
      requested_by: "test",
      execution_profile: @profile,
      epoch: "1"
    )
    execution = admit_res[:execution]

    activity = Activities::AgentControl::AcDispatchExecutionActivity.new
    result = activity.execute({ execution_id: execution.id, epoch: "1" })

    assert_equal "running", result["state"]
    assert_includes result["process_handle"], "ac-proc-"
  end

  test "AcReconcileExecutionActivity reconciles exit code and updates task" do
    op_id = "op-act-rec-#{SecureRandom.hex(4)}"
    admit_res = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: op_id,
      requested_by: "test",
      execution_profile: @profile,
      epoch: "1"
    )
    execution = admit_res[:execution]
    execution.mark_running!(handle: "proc-123")

    activity = Activities::AgentControl::AcReconcileExecutionActivity.new
    result = activity.execute({
      execution_id: execution.id,
      epoch: "1",
      exit_code: 0,
      output: { "status" => "done" }
    })

    assert_equal "completed", result["state"]
    assert_equal 0, result["exit_code"]
  end

  test "AcReleaseCapacityActivity releases capacity grant and lease" do
    op_id = "op-act-rel-#{SecureRandom.hex(4)}"
    admit_res = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: op_id,
      requested_by: "test",
      execution_profile: @profile,
      epoch: "1"
    )
    execution = admit_res[:execution]
    execution.acquire_worktree_lease!

    activity = Activities::AgentControl::AcReleaseCapacityActivity.new
    result = activity.execute({ execution_id: execution.id })

    assert result["grant_released"]
    assert result["lease_released"]
  end
end
