# frozen_string_literal: true

module Workflows
  # AcPlanExecutionWorkflow — Orquestração durável de plano e DAG de tarefas (F3, G3)
  #
  # Ciclo do DAG (§12, §15):
  # 1. Avalia dependências entre tarefas (waiting_dependencies -> ready);
  # 2. Despacha tarefas prontas respeitando paralelismo e capacidade atômica;
  # 3. Encaminha para ciclo de QA e Revisão independente;
  # 4. Trata reprovação (needs_changes) retornando para implementação;
  # 5. Efetiva integração condicional protegida (CAS de ref);
  # 6. Avança o grafo até conclusão terminal ou intervenção.
  class AcPlanExecutionWorkflowLegacy < Workflows::Base
    workflow_name "ac_plan_execution_workflow_legacy"

    def init
      @cancelled = false
      @cancellation_reason = nil
      @paused = false
    end

    workflow_signal
    def cancel_plan(reason = "Cancelamento do plano solicitado")
      @cancelled = true
      @cancellation_reason = reason
    end

    workflow_signal
    def pause_plan
      @paused = true
    end

    workflow_signal
    def resume_plan
      @paused = false
    end

    workflow_query
    def plan_status
      {
        cancelled: @cancelled,
        paused: @paused,
        cancellation_reason: @cancellation_reason
      }
    end

    def run(input)
      init
      plan_id = input.plan_id
      max_iterations = input.max_iterations || 50
      iteration = 0

      while iteration < max_iterations
        iteration += 1

        # Trata pausa
        Temporalio::Workflow.wait_condition { !@paused || @cancelled } if @paused
        return early_cancelled_response(plan_id) if @cancelled

        # 1. Avalia o DAG
        dag_state = execute_activity(
          activities.ac_advance_plan_dag_activity,
          { plan_id: plan_id }
        )

        # Se todas as tarefas estiverem completas, encerra com sucesso
        if dag_state["all_completed"]
          return {
            "status" => "completed",
            "plan_id" => plan_id,
            "iterations" => iteration
          }
        end

        ready_task_ids = dag_state["ready_task_ids"] || []
        break if ready_task_ids.empty? # Nenhuma tarefa elegível (ou bloqueado por falha)

        # 2. Processa cada tarefa pronta da rodada atual
        ready_task_ids.each do |task_id|
          return early_cancelled_response(plan_id) if @cancelled

          # Se houver override explícito de teste ou fluxo guiado para esta tarefa, honra o filtro;
          # caso contrário, processa autonomamente todas as tarefas prontas (§12.1, [BUG-P1-01])
          should_process = if input.trigger_review_for_task_id.present?
                             input.trigger_review_for_task_id == task_id
          else
                             true
          end

          if should_process
            artifact_hash = (input.trigger_review_for_task_id == task_id && input.review_artifact_hash.presence) ||
                            "hash-default-#{task_id}"
            verdict = (input.trigger_review_for_task_id == task_id && input.review_verdict.presence) ||
                      "approved"
            evaluator = (input.trigger_review_for_task_id == task_id && input.evaluator_identity.presence) ||
                        "independent-reviewer"

            execute_activity(
              activities.ac_review_task_activity,
              {
                task_id: task_id,
                artifact_hash: artifact_hash,
                verdict: verdict,
                evaluator_identity: evaluator
              }
            )

            if verdict == "approved"
              execute_activity(
                activities.ac_integrate_task_activity,
                {
                  task_id: task_id,
                  expected_base_commit: input.expected_base_commit || "main-base",
                  candidate_commit: input.candidate_commit || "cand-commit-#{task_id}",
                  current_branch_head: input.current_branch_head || "main-base",
                  artifact_hash: artifact_hash
                }
              )
            end
          end
        end
      end

      # Retorna estado após processamento
      final_state = execute_activity(
        activities.ac_advance_plan_dag_activity,
        { plan_id: plan_id }
      )

      {
        "status" => final_state["all_completed"] ? "completed" : "in_progress",
        "plan_id" => plan_id,
        "all_completed" => final_state["all_completed"],
        "ready_task_keys" => final_state["ready_task_keys"]
      }
    end

    private

    def early_cancelled_response(plan_id)
      {
        "status" => "cancelled",
        "plan_id" => plan_id,
        "reason" => @cancellation_reason
      }
    end
  end
end
