# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para consulta persistente de estado do job remoto (§14.3)
    class AcQueryRemoteOperationActivity < Activities::Base
      activity_name "ac_query_remote_operation_activity"

      def run(input)
        operation = AcRemoteOperation.find_by!(operation_id: input.operation_id)
        status = AcRemoteGatewayService.query_operation_status!(operation: operation)

        {
          "operation_id" => status[:operation_id],
          "remote_job_id" => status[:remote_job_id],
          "state" => status[:state],
          "started" => status[:started],
          "running" => status[:running],
          "result" => (status[:result] || {}).transform_keys(&:to_s),
          "artifact_hash" => status[:artifact_hash],
          "repeatable" => status[:repeatable]
        }
      end
    end
  end
end
