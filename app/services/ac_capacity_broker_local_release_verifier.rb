# frozen_string_literal: true

class AcCapacityBrokerLocalReleaseVerifier
  def self.verify!(reservation:, proof:)
    execution = AcExecution.find_by(id: proof["execution_id"], operation_id: reservation.operation_id)
    return false unless execution

    AcExecutionFence.synchronize(execution, validate: false) do
      grant = execution.ac_capacity_grant
      next false unless grant
      grant.lock!
      valid = execution.epoch.to_s == proof["epoch"].to_s && execution.epoch.to_s == reservation.epoch &&
        grant.operation_id == reservation.operation_id && grant.reconciliation_data["account_key"] == reservation.account_key &&
        grant.reconciliation_data["authority_id"] == reservation.authority_id &&
        grant.reconciliation_data["broker_grant_id"] == reservation.grant_id && proof["grant_id"] == reservation.grant_id &&
        grant.reconciliation_data["authority"] == "shared" && %w[reserved bound releasing].include?(grant.reconciliation_data["broker_state"])
      next false unless valid

      execution.assert_no_unsettled_remote_operations!
      receipt = AcRuntimeSupervisorService.status!(execution: execution)
      verified = %w[completed failed not_started].include?(receipt["state"]) && receipt["runtime_id"] == proof["runtime_id"] &&
        (receipt["state"] == "not_started" || receipt["runtime_id"].present?)
      next false unless verified

      grant.update!(reconciliation_data: grant.reconciliation_data.merge("broker_state" => "releasing", "remote_release_claimed" => true))
      true
    end
  rescue AcRuntimeSupervisorService::UnavailableError, AcRuntimeSupervisorService::UnverifiedReceiptError
    false
  end
end
