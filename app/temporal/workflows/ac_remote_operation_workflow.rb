# frozen_string_literal: true

module Workflows
  # AcRemoteOperationWorkflow — Orquestração durável de operações remotas via SSH persistente (F4, Gate G4)
  #
  # Ciclo de vida (§11.2, §14.1, §14.2, §14.3):
  # 1. Despacha o comando no ambiente remoto autorizado com chave isolada (sem IA no destino);
  # 2. Registra o remote_job_id persistente;
  # 3. Observa o estado durável mesmo em caso de desconexão;
  # 4. Caso o status do job remoto seja indemonstrável, estabelece estado uncertain (§14.3) e interrompe sem avanço cego;
  # 5. Reconcilia o resultado terminal com exit code e evidências.
  class AcRemoteOperationWorkflow < Workflows::Base
    workflow_name "ac_remote_operation_workflow"

    def init
      @cancelled = false
      @cancellation_reason = nil
      @paused = false
    end

    workflow_signal
    def cancel_operation(reason = "Cancelamento da operação remota solicitado")
      @cancelled = true
      @cancellation_reason = reason
    end

    workflow_signal
    def pause_operation
      @paused = true
    end

    workflow_signal
    def resume_operation
      @paused = false
    end

    workflow_query
    def operation_status
      {
        cancelled: @cancelled,
        paused: @paused,
        cancellation_reason: @cancellation_reason
      }
    end

    def run(input)
      init
      operation_id = input.operation_id
      environment_id = input.environment_id
      command = input.command
      working_directory = input.working_directory
      artifact_hash = input.artifact_hash

      # Trata cancelamento prévio
      return early_cancelled_response(operation_id) if @cancelled

      # 1. Despacho inicial com chave isolada (§14.1, §14.2)
      dispatch_result = execute_activity(
        activities.ac_dispatch_remote_operation_activity,
        {
          environment_id: environment_id,
          operation_id: operation_id,
          command: command,
          working_directory: working_directory,
          artifact_hash: artifact_hash,
          task_id: input.task_id,
          execution_id: input.execution_id,
          metadata: (input.metadata || {}).to_h
        }
      )

      # 2. Se já terminou no despacho inicial (síncrono), retorna
      if %w[completed failed].include?(dispatch_result["state"])
        return {
          "status" => dispatch_result["state"],
          "operation_id" => operation_id,
          "remote_job_id" => dispatch_result["remote_job_id"],
          "exit_code" => dispatch_result["exit_code"]
        }
      end

      # 3. Se ainda estiver rodando (ou persistente), consulta status (§14.3)
      query_result = execute_activity(
        activities.ac_query_remote_operation_activity,
        { operation_id: operation_id }
      )

      # Se o estado estiver incerto após tentativa de reconciliação, encerra como incerto
      if query_result["state"] == "uncertain"
        return {
          "status" => "uncertain",
          "operation_id" => operation_id,
          "remote_job_id" => query_result["remote_job_id"],
          "uncertain" => true,
          "reason" => query_result.dig("result", "error") || "Estado do job remoto indemonstrável"
        }
      end

      {
        "status" => query_result["state"],
        "operation_id" => operation_id,
        "remote_job_id" => query_result["remote_job_id"],
        "exit_code" => query_result.dig("result", "exit_code")
      }
    end

    private

    def early_cancelled_response(operation_id)
      {
        "status" => "cancelled",
        "operation_id" => operation_id,
        "reason" => @cancellation_reason
      }
    end
  end
end
