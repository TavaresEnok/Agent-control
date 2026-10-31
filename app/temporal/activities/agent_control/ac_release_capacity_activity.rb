# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para liberação segura de capacidade e lease de worktree
    class AcReleaseCapacityActivity < Activities::Base
      activity_name "ac_release_capacity_activity"

      def run(input)
        execution_id = input.execution_id
        execution = AcExecution.find(execution_id)

        # 1. Libera lease de worktree
        AcWorktreeManagerService.release_lease!(execution: execution)

        # 2. Libera concessão atômica de capacidade
        grant = execution.ac_capacity_grant
        grant&.release! if grant&.granted? || grant&.active?

        {
          "execution_id" => execution.id,
          "grant_released" => grant&.released?,
          "lease_released" => execution.worktree_lease_token.nil?
        }
      end
    end
  end
end
