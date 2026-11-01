# frozen_string_literal: true

module Activities
  module AgentControl
    class AcReleaseCapacityActivity < Activities::Base
      activity_name "ac_release_capacity_activity"

      def run(input)
        execution = AcExecution.find(input.execution_id)
        shared_grant = nil
        result = execution.with_lock do
          execution.assert_no_unsettled_remote_operations!
          grant = execution.ac_capacity_grant
          if grant && (grant.granted? || grant.active?)
            grant.lock!
            grant.update!(reconciliation_data: grant.reconciliation_data.merge("remote_release_claimed" => true))
          end
          if execution.worktree_lease_token.present? || grant&.granted? || grant&.active?
            receipt = AcRuntimeSupervisorService.status!(execution: execution)
            unless %w[completed failed not_started].include?(receipt["state"])
              raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Escritor ainda não terminou"
            end
            AcWorktreeManagerService.release_lease!(execution: execution)
            if grant&.granted? || grant&.active?
              if grant.reconciliation_data["authority"] == "shared"
                shared_grant = grant
              else
                grant.release!
              end
            end
          end
          { "execution_id" => execution.id, "grant_released" => grant&.released?,
            "lease_released" => execution.worktree_lease_token.nil? }
        end
        if shared_grant
          shared_grant.release!
          result["grant_released"] = shared_grant.reload.released?
        end
        result
      end
    end
  end
end
