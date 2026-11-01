# frozen_string_literal: true

require_relative "ac_remote_operation_binding"

module Activities
  module AgentControl
    class AcCancelRemoteOperationV2Activity < Activities::Base
      include AcRemoteOperationBinding
      activity_name "ac_cancel_remote_operation_v2_activity"

      def run(input)
        operation, execution = bound_operation!(input)
        status = AcExecutionFence.synchronize(execution, validate: false) do
          operation.lock!
          # Cleanup is bound to the immutable execution/manager history, even
          # after the plan or task was cancelled. It never authorizes new RPCs.
          bound_operation!(input)
          if operation.state == "pending" && operation.metadata["dispatch_claimed"] == false
            operation.mark_cancelled!(reason: input.reason.presence || "Cancelado antes do despacho")
            next { operation_id: operation.operation_id, remote_job_id: operation.remote_job_id,
              state: operation.state, result: { exit_code: operation.exit_code } }
          end
          if operation.state == "cancelled"
            next { operation_id: operation.operation_id, remote_job_id: operation.remote_job_id,
              state: operation.state, result: { exit_code: operation.exit_code } }
          end
          AcAdmissionService.validate_manager!(plan: execution.ac_task.ac_plan, identity: input.manager_identity,
            epoch: input.manager_epoch, required: true, allow_paused: true)
          AcRemoteGatewayService.cancel_operation!(operation: operation)
        end
        remote_status_result(status)
      end
    end
  end
end
