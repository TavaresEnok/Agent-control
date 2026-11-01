# frozen_string_literal: true

module Activities
  module AgentControl
    class AcReleaseCapacityActivity < Activities::Base
      activity_name "ac_release_capacity_activity"

      def run(input)
        execution = AcExecution.find(input.execution_id)
        execution.with_lock do
          grant = execution.ac_capacity_grant
          if execution.worktree_lease_token.present? || grant&.granted? || grant&.active?
            receipt = AcRuntimeSupervisorService.status!(execution: execution)
            unless %w[completed failed not_started].include?(receipt["state"])
              raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Escritor ainda não terminou"
            end
            AcWorktreeManagerService.release_lease!(execution: execution)
            grant&.release! if grant&.granted? || grant&.active?
          end
          { "execution_id" => execution.id, "grant_released" => grant&.released?,
            "lease_released" => execution.worktree_lease_token.nil? }
        end
      end
    end
  end
end
