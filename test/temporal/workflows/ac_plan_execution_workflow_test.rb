# frozen_string_literal: true

require "test_helper"

module Workflows
  class AcPlanExecutionWorkflowTest < ActiveSupport::TestCase
    TASK_QUEUE = "ac-plan-execution-test"

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
        depends_on: ["task-a"],
        state: :pending
      )

      # Mapeia activities do workflow para a fila de teste
      proxy = Object.new
      proxy.define_singleton_method(:ac_advance_plan_dag_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_advance_plan_dag_activity", TASK_QUEUE)
      end
      proxy.define_singleton_method(:ac_review_task_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_review_task_activity", TASK_QUEUE)
      end
      proxy.define_singleton_method(:ac_integrate_task_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_integrate_task_activity", TASK_QUEUE)
      end

      AcPlanExecutionWorkflow.stubs(:_preloaded_activities).returns(proxy)

      @registered_activities = [
        Activities::AgentControl::AcAdvancePlanDagActivity.new,
        Activities::AgentControl::AcReviewTaskActivity.new,
        Activities::AgentControl::AcIntegrateTaskActivity.new
      ]
    end

    # Prova G3-E3: DAG de dependências — Tarefa B fica em espera e desbloqueia após A
    test "G3-E3: DAG dependency resolution serializes dependent tasks correctly (§12.1)" do
      # Inicialmente, avança o DAG: task-a fica ready/pending, task-b fica waiting_dependencies
      ready = @plan.advance_dag!
      assert_equal ["task-a"], ready.map(&:task_key)
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

      # Reatribuição do gerente único
      @context.assign_active_manager!(identity: "manager-agent-beta")
      assert_equal "manager-agent-beta", @context.active_manager_identity

      assert_raises(ArgumentError) do
        @context.assign_active_manager!(identity: "")
      end
    end

    # Prova G3-E6: Execução durável do AcPlanExecutionWorkflow no Temporal
    test "G3-E6: AcPlanExecutionWorkflow executes DAG rounds end to end via Temporal" do
      result = run_workflow(
        AcPlanExecutionWorkflow,
        {
          plan_id: @plan.id,
          trigger_review_for_task_id: @task_a.id,
          review_artifact_hash: "hash-task-a-approved",
          review_verdict: "approved",
          expected_base_commit: "base-0",
          candidate_commit: "commit-a",
          current_branch_head: "base-0"
        },
        activities: @registered_activities,
        task_queue: TASK_QUEUE
      )

      assert_equal "in_progress", result["status"]
      @task_a.reload
      assert_equal "integrated", @task_a.state
      assert_equal "commit-a", @task_a.approved_commit_sha

      # Verifica se task-b foi desbloqueada pelo ciclo do workflow
      @task_b.reload
      assert_equal "pending", @task_b.state
    end
  end
end
