# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para reconciliação terminal de operação remota (§14.3)
    class AcReconcileRemoteOperationActivity < Activities::Base
      activity_name "ac_reconcile_remote_operation_activity"

      def run(input)
        operation = AcRemoteOperation.find_by!(operation_id: input.operation_id)
        exit_code = input.exit_code || 0
        output = input.output
        error = input.error

        reconciled = AcRemoteGatewayService.reconcile_completion!(
          operation: operation,
          exit_code: exit_code,
          output: output,
          error: error
        )

        {
          "operation_id" => reconciled.operation_id,
          "state" => reconciled.state,
          "exit_code" => reconciled.exit_code,
          "terminal" => reconciled.terminal?
        }
      end
    end
  end
end
