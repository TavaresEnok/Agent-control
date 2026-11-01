# frozen_string_literal: true

module Workflows
  class AcRemoteOperationWorkflowV2 < Workflows::Base
    workflow_name "ac_remote_operation_workflow_v2"
    POLL_SECONDS = 5

    def init
      @cancel_requested = false if @cancel_requested.nil?
      @paused = false if @paused.nil?
      @cancel_reason = nil unless defined?(@cancel_reason)
    end

    workflow_signal
    def cancel_operation(reason = "Cancelamento solicitado")
      @cancel_requested = true
      @cancel_reason = reason
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
      { cancel_requested: @cancel_requested, paused: @paused, cancellation_reason: @cancel_reason }
    end

    def run(input)
      init
      binding = { company_id: input.company_id, task_id: input.task_id, execution_id: input.execution_id,
        environment_id: input.environment_id, operation_id: input.operation_id, epoch: input.epoch,
        manager_identity: input.manager_identity, manager_epoch: input.manager_epoch }
      result = if @cancel_requested
        execute_activity(activities.ac_cancel_remote_operation_v2_activity, binding.merge(reason: @cancel_reason))
      else
        execute_activity(activities.ac_dispatch_remote_operation_v2_activity,
          binding.merge(command: input.command, working_directory: input.working_directory,
            artifact_hash: input.artifact_hash, metadata: (input.metadata || {}).to_h))
      end
      cancel_sent = @cancel_requested
      loop do
        state = result["state"].to_s
        if %w[completed failed cancelled].include?(state)
          return { "status" => state, "operation_id" => input.operation_id,
            "remote_job_id" => result["remote_job_id"], "exit_code" => result.dig("result", "exit_code"),
            "cancel_requested" => @cancel_requested }
        end

        if @cancel_requested && (!cancel_sent || state == "running")
          Temporalio::Workflow.sleep(POLL_SECONDS) if cancel_sent
          cancel_sent = true
          result = execute_activity(activities.ac_cancel_remote_operation_v2_activity, binding.merge(reason: @cancel_reason))
          next
        end
        Temporalio::Workflow.wait_condition { !@paused || @cancel_requested } if @paused
        Temporalio::Workflow.sleep(POLL_SECONDS)
        result = execute_activity(activities.ac_query_remote_operation_v2_activity, binding)
      end
    end
  end
end
