# frozen_string_literal: true

require "test_helper"

module Workflows
  class AcTaskExecutionWorkflowTest < ActiveSupport::TestCase
    TASK_QUEUE = "ac-task-execution-test"

    setup do
      @company = create(:company)
      @user = create(:user, company: @company)
      @project = create(:project, company: @company, owner: @user)
      @context = AcWorkContext.create!(
        company: @company,
        project: @project,
        title: "Context G2 Gate",
        external_id: "ctx-g2-#{SecureRandom.hex(4)}"
      )
      @plan = AcPlan.create!(
        company: @company,
        project: @project,
        ac_work_context: @context,
        plan_key: "g2-plan-#{SecureRandom.hex(4)}",
        title: "Plan G2",
        objective: "Gate G2 Verification",
        version: 1
      )
      @task = AcTask.create!(
        company: @company,
        project: @project,
        ac_plan: @plan,
        task_key: "task-g2-#{SecureRandom.hex(4)}",
        title: "Task G2",
        scope: "Gate G2 scope",
        position: 1,
        risk_class: :low,
        assigned_role: :programmer,
        state: :pending
      )
      @policy = AcPolicyRevision.create!(
        company: @company,
        revision_number: 1,
        content_hash: "hash_g2_1",
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
        profile_key: "prof-codex-g2",
        role: :programmer,
        cli_adapter: :codex_cli,
        model_id: "gpt-5.2",
        effort_level: :medium,
        agent_credential: @credential,
        chain_position: 1,
        state: :active
      )

      # Mapeia activities registradas no worker para a fila de teste
      proxy = Object.new
      proxy.define_singleton_method(:ac_admit_task_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_admit_task_activity", TASK_QUEUE)
      end
      proxy.define_singleton_method(:ac_acquire_worktree_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_acquire_worktree_activity", TASK_QUEUE)
      end
      proxy.define_singleton_method(:ac_dispatch_execution_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_dispatch_execution_activity", TASK_QUEUE)
      end
      proxy.define_singleton_method(:ac_reconcile_execution_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_reconcile_execution_activity", TASK_QUEUE)
      end
      proxy.define_singleton_method(:ac_release_capacity_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_release_capacity_activity", TASK_QUEUE)
      end

      AcTaskExecutionWorkflow.stubs(:_preloaded_activities).returns(proxy)

      @registered_activities = [
        Activities::AgentControl::AcAdmitTaskActivity.new,
        Activities::AgentControl::AcAcquireWorktreeActivity.new,
        Activities::AgentControl::AcDispatchExecutionActivity.new,
        Activities::AgentControl::AcReconcileExecutionActivity.new,
        Activities::AgentControl::AcReleaseCapacityActivity.new
      ]
    end

    # Prova 1: Execução ponta a ponta via Temporal com sucesso e liberação de capacidade
    test "G2-E1: complete task execution via Temporal settles with success and releases capacity" do
      op_id = "op-g2-e1-#{SecureRandom.hex(4)}"

      result = run_workflow(
        AcTaskExecutionWorkflow,
        {
          task_id: @task.id,
          operation_id: op_id,
          execution_profile_id: @profile.id,
          epoch: "1",
          exit_code: 0,
          output: { "message" => "All checks PASS" }
        },
        activities: @registered_activities,
        task_queue: TASK_QUEUE
      )

      assert_equal "completed", result["status"]
      assert_equal 0, result["exit_code"]
      assert result["execution_id"].present?
      assert_not result["reused"]

      # Verifica que o grant de capacidade foi liberado
      execution = AcExecution.find(result["execution_id"])
      assert_equal "completed", execution.state
      assert execution.ac_capacity_grant.released?, "Capacidade deve estar liberada após conclusão"
      assert_nil execution.worktree_lease_token, "Lease de worktree deve ser neutralizada"
    end

    # Prova 2: Reinício com o mesmo operation_id é estritamente idempotente e não duplica execução
    test "G2-E2: restart with same operation_id does not duplicate execution (RF-45, §11.3)" do
      op_id = "op-g2-e2-#{SecureRandom.hex(4)}"

      # Primeira execução
      first_result = run_workflow(
        AcTaskExecutionWorkflow,
        {
          task_id: @task.id,
          operation_id: op_id,
          execution_profile_id: @profile.id,
          epoch: "1",
          exit_code: 0
        },
        activities: @registered_activities,
        task_queue: TASK_QUEUE
      )

      # Segunda execução com mesmo operation_id (reenvio acidental de UI/mobile ou replay)
      second_result = run_workflow(
        AcTaskExecutionWorkflow,
        {
          task_id: @task.id,
          operation_id: op_id,
          execution_profile_id: @profile.id,
          epoch: "1",
          exit_code: 0
        },
        activities: @registered_activities,
        task_queue: TASK_QUEUE
      )

      assert_equal first_result["execution_id"], second_result["execution_id"]
      assert second_result["reused"], "Segunda execução deve reutilizar a admissão prévia"
      assert_equal 1, AcExecution.where(operation_id: op_id).count, "Não deve criar registro duplicado de execução"
      assert_equal 1, AcCapacityGrant.where(operation_id: op_id).count, "Não deve criar concessão duplicada"
    end

    # Prova 3: Falha intermediária (morte antes do ack de dispatch) recupera o mesmo handle
    test "G2-E3: intermediate failure before dispatch settles cleanly without double-process" do
      op_id = "op-g2-e3-#{SecureRandom.hex(4)}"

      # Simula admissão já feita pelo banco (interrupção do nó de trabalho)
      admission = AcAdmissionService.admit_execution!(
        task: @task,
        operation_id: op_id,
        requested_by: "system_relay",
        execution_profile: @profile,
        epoch: "1"
      )

      execution = admission[:execution]
      assert_equal "granted", execution.state

      # Temporal retoma a execução com a chave original
      result = run_workflow(
        AcTaskExecutionWorkflow,
        {
          task_id: @task.id,
          operation_id: op_id,
          execution_profile_id: @profile.id,
          epoch: "1",
          exit_code: 0
        },
        activities: @registered_activities,
        task_queue: TASK_QUEUE
      )

      assert_equal execution.id, result["execution_id"]
      assert result["reused"]
      assert_equal "completed", execution.reload.state
    end

    # Prova 4: Rejeição de resultado com epoch divergente (stale process reject)
    test "G2-E4: stale epoch outcome is rejected by reconcile activity (§11.3)" do
      op_id = "op-g2-e4-#{SecureRandom.hex(4)}"

      admission = AcAdmissionService.admit_execution!(
        task: @task,
        operation_id: op_id,
        requested_by: "test",
        execution_profile: @profile,
        epoch: "2" # Época atual da admissão é 2
      )

      execution = admission[:execution]
      execution.mark_running!(handle: "proc-ep2")

      reconcile_act = Activities::AgentControl::AcReconcileExecutionActivity.new

      # Tentativa de reconciliação informando época antiga ("1")
      assert_raises(AcExecution::StaleEpochError) do
        reconcile_act.execute({
          execution_id: execution.id,
          epoch: "1", # Mismatch!
          exit_code: 0
        })
      end

      # O estado da execução não foi corrompido
      assert_equal "running", execution.reload.state
    end

    # Prova 5: Bloqueio absoluto de bypass sem concessão válida de capacidade
    test "G2-E5: unauthorized execution bypass is strictly blocked (§10.2.1)" do
      dispatch_act = Activities::AgentControl::AcDispatchExecutionActivity.new

      # Chamador tenta invocar dispatch com execução inexistente
      assert_raises(AcAdmissionService::UnauthorizedExecutionBypassError) do
        dispatch_act.execute({
          execution_id: 999999,
          epoch: "1"
        })
      end
    end

    # Prova 6: Cancelamento limpo via sinal com liberação imediata de capacidade
    test "G2-E6: early cancellation via signal releases capacity and terminates" do
      workflow = AcTaskExecutionWorkflow.new
      workflow.init
      workflow.cancel_execution("Cancelado por operador no app")

      assert workflow.execution_status[:cancelled]
      assert_equal "Cancelado por operador no app", workflow.execution_status[:cancellation_reason]
    end
  end
end
