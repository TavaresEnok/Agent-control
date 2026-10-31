# frozen_string_literal: true

require "test_helper"

class AcExecutionTest < ActiveSupport::TestCase
  setup do
    @company = create(:company, email_domain: "org-#{SecureRandom.hex(4)}.com")
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @work_context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context F2 Test",
      external_id: "context-f2-test-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @work_context,
      plan_key: "f2-plan-#{SecureRandom.hex(4)}",
      title: "Plan F2 Test",
      objective: "Testing F2 executions",
      version: 1
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-f2-#{SecureRandom.hex(4)}",
      title: "Task F2 Test",
      scope: "Testing F2 task execution",
      position: 1,
      risk_class: :low
    )
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_rev_1",
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
      profile_key: "prof-codex-f2",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :medium,
      agent_credential: @credential,
      chain_position: 1,
      state: :active
    )
  end

  test "creates valid execution with required attributes" do
    execution = AcExecution.create!(
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      ac_execution_profile: @profile,
      operation_id: "op-#{SecureRandom.hex(6)}",
      epoch: "1"
    )

    assert execution.persisted?
    assert_equal "pending", execution.state
  end

  test "idempotent_find_or_create! returns existing execution on duplicate operation_id" do
    op_id = "op-idempotency-test-#{SecureRandom.hex(4)}"
    first = AcExecution.idempotent_find_or_create!(
      operation_id: op_id,
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      ac_execution_profile: @profile,
      epoch: "1"
    )

    assert first.persisted?

    second = AcExecution.idempotent_find_or_create!(
      operation_id: op_id,
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      ac_execution_profile: @profile,
      epoch: "1"
    )

    assert_equal first.id, second.id
    assert_equal 1, AcExecution.where(operation_id: op_id).count
  end

  test "acquire_worktree_lease! sets exclusive writer token" do
    execution = AcExecution.create!(
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      operation_id: "op-wt-#{SecureRandom.hex(4)}",
      epoch: "1"
    )

    token = execution.acquire_worktree_lease!
    assert token.present?
    assert_equal token, execution.worktree_lease_token
    assert_equal "preparing", execution.state

    execution.revoke_worktree_lease!
    assert_nil execution.worktree_lease_token
  end

  test "mark_running! records process_handle and start time" do
    execution = AcExecution.create!(
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      operation_id: "op-run-#{SecureRandom.hex(4)}",
      epoch: "1"
    )

    execution.mark_running!(handle: "proc-container-99281")
    assert_equal "running", execution.state
    assert_equal "proc-container-99281", execution.process_handle
    assert execution.started_at.present?
  end

  test "reconcile_outcome! succeeds when epoch matches" do
    execution = AcExecution.create!(
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      operation_id: "op-rec-#{SecureRandom.hex(4)}",
      epoch: "2",
      state: :running
    )

    execution.reconcile_outcome!(
      exit_code: 0,
      reported_epoch: "2",
      output: { "summary" => "Tests PASS" }
    )

    assert_equal "completed", execution.state
    assert_equal 0, execution.exit_code
    assert_equal "Tests PASS", execution.output_payload["summary"]
  end

  test "reconcile_outcome! rejects stale result when epoch mismatches (RF-45, §11.3)" do
    execution = AcExecution.create!(
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      operation_id: "op-stale-#{SecureRandom.hex(4)}",
      epoch: "3",
      state: :running
    )

    assert_raises(AcExecution::StaleEpochError) do
      execution.reconcile_outcome!(
        exit_code: 0,
        reported_epoch: "2", # Época antiga/stale!
        output: { "summary" => "Stale output" }
      )
    end

    execution.reload
    assert_equal "running", execution.state # Estado preservado, resultado rejeitado
  end

  test "mark_uncertain! preserves state without blind duplicate launch (§11.3.1)" do
    execution = AcExecution.create!(
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      operation_id: "op-unc-#{SecureRandom.hex(4)}",
      epoch: "1",
      state: :running
    )

    execution.mark_uncertain!(reason: "Timeout ao consultar supervisor de processos")
    assert_equal "uncertain", execution.state
    assert_includes execution.error_details["uncertain_reason"], "Timeout"
  end

  test "cancel! transitions execution to cancelled" do
    execution = AcExecution.create!(
      company: @company,
      ac_work_context: @work_context,
      ac_task: @task,
      operation_id: "op-canc-#{SecureRandom.hex(4)}",
      epoch: "1",
      state: :running
    )

    execution.cancel!(reason: "Abortado pelo operador")
    assert_equal "cancelled", execution.state
    assert_equal "Abortado pelo operador", execution.error_details["cancellation_reason"]
  end
end
