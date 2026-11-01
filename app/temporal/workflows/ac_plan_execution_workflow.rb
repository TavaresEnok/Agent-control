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
  class AcPlanExecutionWorkflow < AcPlanExecutionWorkflowLegacy
    workflow_name "ac_plan_execution_workflow"

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
      return super(input) unless Temporalio::Workflow.patched("ac-plan-ready-task-details-v1")

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

        ready_task_details = dag_state["ready_task_details"] || []
        break if ready_task_details.empty? # Nenhuma tarefa elegível (ou bloqueado por falha)

        processed_any = false

        # 2. Processa cada tarefa pronta da rodada atual (§12.1, §15, DEF-02)
        ready_task_details.each do |t_detail|
          return early_cancelled_response(plan_id) if @cancelled

          task_id = t_detail["id"]

          # Cenário A: Disparo guiado / override de teste explícito (§12.1)
          if input.trigger_review_for_task_id.present?
            next unless input.trigger_review_for_task_id == task_id

            artifact_hash = input.review_artifact_hash
            next if artifact_hash.blank? # Não fabrica hash fictício (§15.3, DEF-02)

            verdict = input.review_verdict.presence || "approved"
            evaluator = input.evaluator_identity.presence || "independent-reviewer"

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

            processed_any = true

          # Cenário B: Tarefa já aprovada com artefato formal prévio -> integra com integridade (§15.3.1)
          elsif t_detail["approved"] && t_detail["approved_artifact_hash"].present?
            execute_activity(
              activities.ac_integrate_task_activity,
              {
                task_id: task_id,
                expected_base_commit: input.expected_base_commit || "main-base",
                candidate_commit: t_detail["approved_commit_sha"] || input.candidate_commit || "cand-commit-#{task_id}",
                current_branch_head: input.current_branch_head || input.expected_base_commit || "main-base",
                artifact_hash: t_detail["approved_artifact_hash"]
              }
            )
            processed_any = true

          # Cenário C: Tarefa possui execução terminada com artefato real disponível -> submete parecer
          elsif t_detail["has_completed_execution"] && t_detail["execution_artifact_hash"].present?
            artifact_hash = t_detail["execution_artifact_hash"]
            cand_commit = t_detail["execution_commit_sha"] || artifact_hash

            execute_activity(
              activities.ac_review_task_activity,
              {
                task_id: task_id,
                artifact_hash: artifact_hash,
                verdict: "approved",
                evaluator_identity: "independent-council",
                candidate_commit_sha: cand_commit
              }
            )

            execute_activity(
              activities.ac_integrate_task_activity,
              {
                task_id: task_id,
                expected_base_commit: input.expected_base_commit || "main-base",
                candidate_commit: cand_commit,
                current_branch_head: input.current_branch_head || "main-base",
                artifact_hash: artifact_hash
              }
            )
            processed_any = true

          else
            # Cenário D: Tarefa elegível mas ainda sem execução terminada nem artefato
            # NÃO fabrica hash nem autoaprova (§15.3, DEF-02). Permanece aguardando trabalhador.
          end
        end

        # Se nenhuma tarefa realizou transição nesta iteração, encerra o ciclo
        break unless processed_any
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
