# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para despacho de operações remotas via OpenSSH centralizado (§14.1, §14.2)
    class AcDispatchRemoteOperationActivity < Activities::Base
      activity_name "ac_dispatch_remote_operation_activity"

      def run(input)
        environment = AcRemoteEnvironment.find(input.environment_id)
        task = input.task_id.present? ? AcTask.find_by(id: input.task_id) : nil
        execution = input.execution_id.present? ? AcExecution.find_by(id: input.execution_id) : nil

        operation = AcRemoteGatewayService.dispatch_operation!(
          environment: environment,
          operation_id: input.operation_id,
          command: input.command,
          working_directory: input.working_directory,
          artifact_hash: input.artifact_hash,
          task: task,
          execution: execution,
          metadata: (input.metadata || {}).to_h
        )

        {
          "operation_id" => operation.operation_id,
          "remote_job_id" => operation.remote_job_id,
          "state" => operation.state,
          "exit_code" => operation.exit_code,
          "started_at" => operation.started_at&.iso8601,
          "working_directory" => operation.working_directory
        }
      end
    end
  end
end
