# frozen_string_literal: true

module Workflows
  # AcTaskExecutionWorkflow — Orquestração durável de execução de tarefa via Temporal (F2, G2)
  #
  # Ciclo de vida completo (§10, §11, §12):
  # 1. Admissão unificada e concessão atômica de capacidade (§10.2.1, §11.3)
  # 2. Isolamento de worktree com escritor único (§11.3.2)
  # 3. Despacho idempotente de processo com handle estável de supervisor (§11.3.1)
  # 4. Observação e tratamento de sinais de pause/resume/cancel
  # 5. Reconciliação do processo com validação estrita de época (§11.3)
  # 6. Liberação garantida de capacidade e neutralização de lease
  class AcTaskExecutionWorkflow < Workflows::Base
    workflow_name "ac_task_execution_workflow"

    def init
      @cancelled = false
      @cancellation_reason = nil
      @paused = false
      @step_decisions = {}
    end

    # Sinais suportados (§10.2, §11.4)
    workflow_signal
    def cancel_execution(reason = "Cancelamento solicitado via sinal")
      @cancelled = true
      @cancellation_reason = reason
    end

    workflow_signal
    def pause_execution
      @paused = true
    end

    workflow_signal
    def resume_execution
      @paused = false
    end

    # Query de status em tempo real
    workflow_query
    def execution_status
      {
        cancelled: @cancelled,
        paused: @paused,
        cancellation_reason: @cancellation_reason
      }
    end

    def run(input)
      init
      task_id = input.task_id
      operation_id = input.operation_id
      epoch = (input.epoch || "1").to_s
      requested_by = input.requested_by || "temporal"
      origin = input.origin || "temporal"
      profile_id = input.execution_profile_id
      nil
      input.output || {}
      input.error || {}

      execution_id = nil

      begin
        # Etapa 1: Admissão unificada e concessão atômica de capacidade (§10.2.1, §11.3)
        admit_result = execute_activity(
          activities.ac_admit_task_activity,
          {
            task_id: task_id,
            operation_id: operation_id,
            requested_by: requested_by,
            origin: origin,
            epoch: epoch,
            execution_profile_id: profile_id
          }
        )

        execution_id = admit_result["execution_id"]
        reused = admit_result["reused"]

        # Se a execução já estiver em estado terminal prévio, retorna imediatamente (§11.3)
        if reused && %w[completed failed cancelled].include?(admit_result["state"].to_s)
          return {
            "status" => admit_result["state"],
            "execution_id" => execution_id,
            "operation_id" => operation_id,
            "epoch" => epoch,
            "reused" => true
          }
        end

        # Se cancelamento chegou antes do início
        if @cancelled
          handle_early_cancellation(execution_id)
          return early_cancellation_response(execution_id, operation_id)
        end

        # Etapa 2: Isolamento de worktree e alocação de escritor único (§11.3.2)
        wt_result = execute_activity(
          activities.ac_acquire_worktree_activity,
          { execution_id: execution_id }
        )

        if @cancelled
          handle_early_cancellation(execution_id)
          return early_cancellation_response(execution_id, operation_id)
        end

        # Etapa 3: Despacho idempotente do processo e registro de supervisor (§11.3.1)
        disp_result = execute_activity(
          activities.ac_dispatch_execution_activity,
          { execution_id: execution_id, epoch: epoch }
        )

        # Espera se estiver pausado
        Temporalio::Workflow.wait_condition { !@paused || @cancelled } if @paused

        if @cancelled
          handle_early_cancellation(execution_id)
          return early_cancellation_response(execution_id, operation_id)
        end

        # Etapa 4: Reconciliação do término de processo com validação de época (§11.3)
        loop do
          Temporalio::Workflow.wait_condition { !@paused || @cancelled } if @paused
          if @cancelled
            handle_early_cancellation(execution_id)
            return early_cancellation_response(execution_id, operation_id)
          end
          rec_result = execute_activity(
            activities.ac_reconcile_execution_activity,
            { execution_id: execution_id, epoch: epoch }
          )
          break if %w[completed failed cancelled].include?(rec_result["state"])

          Temporalio::Workflow.sleep(5)
        end

        # Etapa 5: Liberação segura de capacidade e worktree lease (RF-47)
        execute_activity(
          activities.ac_release_capacity_activity,
          { execution_id: execution_id }
        )

        {
          "status" => rec_result["state"],
          "execution_id" => execution_id,
          "operation_id" => operation_id,
          "epoch" => epoch,
          "process_handle" => disp_result["process_handle"],
          "worktree_path" => wt_result["worktree_path"],
          "exit_code" => rec_result["exit_code"],
          "reused" => reused
        }
      ensure
        # Garantia de liberação em caso de erro não tratado no workflow
        if execution_id.present?
          begin
            execute_activity(
              activities.ac_release_capacity_activity,
              { execution_id: execution_id }
            )
          rescue StandardError
            # Em caso de falha na atividade de release durante ensure, não mascarar o erro original
          end
        end
      end
    end

    private

    def handle_early_cancellation(execution_id)
      execute_activity(
        activities.ac_release_capacity_activity,
        { execution_id: execution_id }
      )
    end

    def early_cancellation_response(execution_id, operation_id)
      {
        "status" => "cancelled",
        "execution_id" => execution_id,
        "operation_id" => operation_id,
        "reason" => @cancellation_reason
      }
    end
  end
end
