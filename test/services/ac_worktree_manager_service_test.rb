# frozen_string_literal: true

require "test_helper"

class AcWorktreeManagerServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context Worktree",
      external_id: "ctx-wt-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "wt-plan-#{SecureRandom.hex(4)}",
      title: "Plan WT",
      objective: "Worktree isolation test",
      version: 1
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-wt-#{SecureRandom.hex(4)}",
      title: "Task WT",
      scope: "WT scope",
      position: 1,
      risk_class: :low
    )
    @execution = AcExecution.create!(
      company: @company,
      ac_work_context: @context,
      ac_task: @task,
      operation_id: "op-wt-1-#{SecureRandom.hex(4)}",
      epoch: "1"
    )
  end

  test "acquires lease for solitary execution" do
    token = AcWorktreeManagerService.acquire_lease!(execution: @execution)

    assert token.present?
    @execution.reload
    assert_equal token, @execution.worktree_lease_token
    assert_equal "preparing", @execution.state
  end

  test "neutralizes inactive/cancelled previous writer (§11.3.2)" do
    # Escritor antigo cancelado segurando token
    old_execution = AcExecution.create!(
      company: @company,
      ac_work_context: @context,
      ac_task: @task,
      operation_id: "op-old-writer-#{SecureRandom.hex(4)}",
      epoch: "1",
      state: :cancelled,
      worktree_lease_token: "old-lease-token"
    )

    new_token = AcWorktreeManagerService.acquire_lease!(execution: @execution)

    old_execution.reload
    assert_nil old_execution.worktree_lease_token, "Escritor anterior deve ter sua lease neutralizada"
    assert_equal new_token, @execution.reload.worktree_lease_token
  end

  test "quarantines worktree when active writer cannot be neutralized (§11.3.2)" do
    # Escritor anterior ativo com heartbeat recente
    active_execution = AcExecution.create!(
      company: @company,
      ac_work_context: @context,
      ac_task: @task,
      operation_id: "op-active-writer-#{SecureRandom.hex(4)}",
      epoch: "1",
      state: :running,
      worktree_path: "/tmp/ac_worktrees/#{@task.id}/main",
      worktree_lease_token: "active-lease-token",
      heartbeat_at: 1.minute.ago
    )

    token = AcWorktreeManagerService.acquire_lease!(execution: @execution)

    assert token.present?
    @execution.reload
    assert_includes @execution.worktree_path, "quarantine"
    assert_equal "active-lease-token", active_execution.reload.worktree_lease_token
  end

  test "releases lease safely" do
    token = AcWorktreeManagerService.acquire_lease!(execution: @execution)
    assert @execution.reload.worktree_lease_token.present?

    AcWorktreeManagerService.release_lease!(execution: @execution)
    assert_nil @execution.reload.worktree_lease_token
  end
end
