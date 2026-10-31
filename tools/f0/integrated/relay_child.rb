# frozen_string_literal: true

require_relative "boot"
schema, admission_id, mode = ARGV
IntegratedLab.assert!(%w[die healthy retry].include?(mode), "invalid relay mode")
IntegratedLab.attach!(schema)
client = IntegratedLab.connection!
TemporalService.connection = ->(&block) { block.call(client) }

# Observation only: every call delegates to the SDK; exceptions are re-raised
# into the real TemporalService rescue. No replacement return value/transport.
module IntegratedStartObservation
  def start_workflow(*args, **options)
    IntegratedLab.append(event: "sdk_call", workflow_id: options.fetch(:id),
      reject_duplicate: options[:id_reuse_policy] == Temporalio::WorkflowIDReusePolicy::REJECT_DUPLICATE)
    handle = super
    IntegratedLab.append(event: "sdk_response", run_id: handle.result_run_id)
    handle
  rescue Temporalio::Error::WorkflowAlreadyStartedError => e
    IntegratedLab.append(event: "sdk_already_started", run_id: e.run_id)
    raise
  end
end
Temporalio::Client.prepend(IntegratedStartObservation)

module IntegratedAckDeath
  def start_workflow(*args, **options)
    result = super
    IntegratedLab.assert!(result[:ok] && result[:run_id].present? && result[:handle], "real SDK start receipt required before death")
    IntegratedLab.append(event: "death_after_service_response", run_id: result[:run_id])
    Process.exit!(86) # Physical death, before the relay's acknowledgement transaction.
  end
end
TemporalService.singleton_class.prepend(IntegratedAckDeath) if mode == "die"
IntegratedLab.append(event: "dispatch", mode: mode)
SessionLaunchRelay.dispatch(SessionAdmission.find(Integer(admission_id)))
IntegratedLab.append(event: "dispatch_returned", mode: mode)
