# frozen_string_literal: true

require "test_helper"

module Workflows
  class AcPlanExecutionWorkflowTest < ActiveSupport::TestCase
    setup do
      @company = create(:company)
      @user = create(:user, company: @company)
      @project = create(:project, company: @company, owner: @user)
      @context = AcWorkContext.create!(
        company: @company,
        project: @project,
        title: "Context DAG Plan Test",
        external_id: "ctx-plan-dag-#{SecureRandom.hex(4)}"
      )
      @plan = AcPlan.create!(
        company: @company,
        project: @project,
        ac_work_context: @context,
        plan_key: "dag-plan-#{SecureRandom.hex(4)}",
        title: "Plan DAG Test",
        objective: "Test DAG and Review in Temporal",
        version: 1
      )
      @task_a = AcTask.create!(
        company: @company,
        project: @project,
        ac_plan: @plan,
        task_key: "task-a",
        title: "Task A (Root)",
        position: 1,
        risk_class: :low,
        state: :pending
      )
      @task_b = AcTask.create!(
        company: @company,
        project: @project,
        ac_plan: @plan,
        task_key: "task-b",
        title: "Task B (Depends on A)",
        position: 2,
        risk_class: :low,
        depends_on: [ "task-a" ],
        state: :pending
      )

      @credential = create(:agent_credential, user: @user, company: @company, agent_type: "codex")
      @policy = AcPolicyRevision.create!(company: @company, revision_number: 1,
        content_hash: SecureRandom.hex(32), state: :draft,
        content: { "model_chain" => [ "gpt-5.2" ], "effort_limits" => { "max" => "high" },
          "active_accounts" => [], "chain_rules" => [] })
      AcExecutionProfile.create!(company: @company, ac_policy_revision: @policy, agent_credential: @credential,
        profile_key: "programmer", role: "programmer", cli_adapter: "codex_cli", model_id: "gpt-5.2",
        effort_level: "medium", chain_position: 1, selection_criteria: { "eligibility" => {
          "status" => "documented_supported", "model_id" => "gpt-5.2", "cli_adapter" => "codex_cli",
          "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 } })
      assert @policy.publish!(by_user: @user), @policy.errors.full_messages.to_sentence
      assert @plan.publish!(policy_revision: @policy), @plan.errors.full_messages.to_sentence
    end

    # Prova G3-E3: DAG de dependências — Tarefa B fica em espera e desbloqueia após A
    test "G3-E3: DAG dependency resolution serializes dependent tasks correctly (§12.1)" do
      # Inicialmente, avança o DAG: task-a fica ready/pending, task-b fica waiting_dependencies
      ready = @plan.advance_dag!
      assert_equal [ "task-a" ], ready.map(&:task_key)
      assert_equal "waiting_dependencies", @task_b.reload.state

      # Conclusão e integração de task-a
      @task_a.update!(state: :integrated)

      # Novo avanço do DAG desbloqueia task-b
      newly_ready = @plan.advance_dag!
      assert_includes newly_ready.map(&:task_key), "task-b"
      assert_equal "pending", @task_b.reload.state, "task-b deve transicionar para pending/ready"
    end

    # Prova G3-E5: Gerente único ativo por contexto de trabalho (RF-04)
    test "G3-E5: exactly one active manager is authorized per work context (RF-04)" do
      @context.assign_active_manager!(identity: "manager-agent-alpha")
      assert_equal "manager-agent-alpha", @context.active_manager_identity

      epoch = @context.metadata.fetch("manager_epoch")
      assert_equal epoch, @context.assign_active_manager!(identity: "manager-agent-alpha")
      assert_raises(ActiveRecord::StaleObjectError) do
        @context.assign_active_manager!(identity: "manager-agent-beta", expected_epoch: epoch)
      end
      assert_equal "manager-agent-alpha", @context.reload.active_manager_identity
      assert_equal epoch, @context.metadata.fetch("manager_epoch")
      assert @context.authorize_manager!(identity: "manager-agent-alpha", epoch: epoch)
      assert_raises(ActiveRecord::StaleObjectError) do
        @context.authorize_manager!(identity: "manager-agent-beta", epoch: epoch)
      end
      assert_raises(ArgumentError) { @context.assign_active_manager!(identity: "") }
    end

    # V1 histories are covered by replay tests; V2 covers the real execution cycle.
    # Invalid launch inputs are checked synchronously here, without Temporal's
    # activity retries or fabricated review/commit results.
    test "G3-E6: an unpublished plan is refused before a workflow RPC or outbox intent" do
      draft = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
        plan_key: SecureRandom.uuid, title: "Unpublished", version: 1)
      TemporalService.expects(:start_workflow).never
      assert_no_difference("TriggerEvent.count") do
        assert_raises(AcAdmissionService::TaskNotEligibleForAdmissionError) do
          AcPlanLaunchService.record!(plan: draft, actor: @user)
        end
      end
      assert_nil @context.reload.active_manager_identity
      assert draft.reload.draft?
    end

    test "G3-E6: a published plan without its manager binding cannot advance through the activity" do
      TemporalService.expects(:start_workflow).never
      AcRuntimeSupervisorService.expects(:dispatch!).never
      input = TemporalInput.wrap(plan_id: @plan.id)
      assert_raises(ActiveRecord::StaleObjectError) do
        Activities::AgentControl::AcAdvancePlanDagActivity.new.run(input)
      end
      assert_equal "pending", @task_a.reload.state
      assert_equal "pending", @task_b.reload.state
      assert_nil @context.reload.active_manager_identity
    end

    test "DEF-02: caller supplied approval claims without an independent execution are refused before runtime RPC" do
      AcRuntimeSupervisorService.expects(:status!).never
      TemporalService.expects(:start_workflow).never
      assert_no_difference("AcReviewVerdict.count") do
        assert_raises(AcReviewService::InvalidVerdictError) do
          AcReviewService.submit_verdict!(task: @task_a, execution: nil,
            artifact_hash: "a" * 64, candidate_commit_sha: "b" * 40, base_commit_hash: "c" * 40,
            verdict: "approved", evaluator_identity: "unverified-caller")
        end
      end
      assert_equal "pending", @task_a.reload.state
      assert_nil @task_a.approved_artifact_hash
      assert_nil @task_a.approved_commit_sha
      assert_empty AcExecution.where(ac_task_id: [ @task_a.id, @task_b.id ])
    end
  end
end
