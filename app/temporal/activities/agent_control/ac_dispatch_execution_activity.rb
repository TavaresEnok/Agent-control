# frozen_string_literal: true

module Activities
  module AgentControl
    class AcDispatchExecutionActivity < Activities::Base
      activity_name "ac_dispatch_execution_activity"

      def run(input)
        execution = AcAdmissionService.validate_execution_authority!(
          execution_id: input.execution_id,
          operation_id: AcExecution.find_by(id: input.execution_id)&.operation_id,
          reported_epoch: input.epoch
        )
        AcExecutionFence.synchronize(execution) do
          receipt = if execution.process_handle.present?
            AcRuntimeSupervisorService.status!(execution: execution)
          else
            AcRuntimeSupervisorService.dispatch!(execution: execution)
          end
          execution.mark_running!(handle: receipt.fetch("process_handle")) unless execution.state_running?
          {
            "execution_id" => execution.id,
            "process_handle" => execution.process_handle,
            "state" => execution.state,
            "started_at" => execution.started_at&.iso8601
          }
        end
      end
    end
  end
end
