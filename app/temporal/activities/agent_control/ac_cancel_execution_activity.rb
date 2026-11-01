# frozen_string_literal: true

module Activities
  module AgentControl
    class AcCancelExecutionActivity < Activities::Base
      activity_name "ac_cancel_execution_activity"

      def run(input)
        execution = AcExecution.find(input.execution_id)
        receipt = nil
        AcExecutionFence.synchronize(execution, validate: false) do
          AcAdmissionService.validate_manager!(plan: execution.ac_task.ac_plan, identity: execution.metadata["manager_identity"],
            epoch: execution.metadata["manager_epoch"], allow_paused: true)
          execution.ac_task.cancel! unless execution.ac_task.cancelled?
        end
        AcExecutionFence.synchronize(execution, validate: false) do
          AcAdmissionService.validate_manager!(plan: execution.ac_task.ac_plan, identity: execution.metadata["manager_identity"],
            epoch: execution.metadata["manager_epoch"], allow_paused: true)
          receipt = AcRuntimeSupervisorService.cancel!(execution: execution)
          execution.cancel!(reason: input.reason.presence || "Cancelado e confirmado pelo runtime")
        end
        { "state" => "cancelled", "execution_id" => execution.id, "exit_code" => receipt["exit_code"] }
      rescue AcRuntimeSupervisorService::UnavailableError, AcRuntimeSupervisorService::UnverifiedReceiptError => e
        if execution
          AcExecutionFence.synchronize(execution, validate: false) do
            execution.mark_uncertain!(reason: e.message) unless %w[completed failed cancelled].include?(execution.state.to_s)
          end
        end
        { "state" => "uncertain", "execution_id" => execution&.id, "reason" => e.message }
      end
    end
  end
end
