# frozen_string_literal: true

require_relative "ac_remote_operation_binding"

module Activities
  module AgentControl
    class AcDispatchRemoteOperationV2Activity < Activities::Base
      include AcRemoteOperationBinding
      activity_name "ac_dispatch_remote_operation_v2_activity"

      def run(input)
        execution, environment = bound_execution!(input)
        AcAdmissionService.validate_execution_authority!(execution_id: execution.id,
          operation_id: execution.operation_id, reported_epoch: input.epoch)
        operation = AcRemoteGatewayService.dispatch_operation!(environment: environment, task: execution.ac_task,
          execution: execution, operation_id: input.operation_id, command: input.command,
          working_directory: input.working_directory, artifact_hash: input.artifact_hash,
          metadata: (input.metadata || {}).to_h)
        { "operation_id" => operation.operation_id, "remote_job_id" => operation.remote_job_id,
          "state" => operation.state, "result" => { "exit_code" => operation.exit_code } }
      end
    end
  end
end
