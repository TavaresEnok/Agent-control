# frozen_string_literal: true

require_relative "ac_remote_operation_binding"

module Activities
  module AgentControl
    class AcQueryRemoteOperationV2Activity < Activities::Base
      include AcRemoteOperationBinding
      activity_name "ac_query_remote_operation_v2_activity"

      def run(input)
        operation, = bound_operation!(input)
        remote_status_result(AcRemoteGatewayService.query_operation_status!(operation: operation))
      end
    end
  end
end
