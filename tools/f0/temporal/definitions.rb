# frozen_string_literal: true

class G0ProbeActivity < Temporalio::Activity::Definition
  activity_name "g0_probe_activity"
  def execute(input)
    probe = ProcessProbe.new(input.fetch("root"), input.fetch("operation"))
    if input.fetch("action") == "launch"
      attempt = Temporalio::Activity::Context.current.info.attempt
      probe.write("launch-attempt-#{attempt}.json", { "attempt" => attempt,
        "saved_handle" => probe.read("handle.json") })
      probe.launch(input.fetch("scenario"))
    else
      probe.stop
    end
  rescue ProcessProbe::Uncertain => e
    raise Temporalio::Error::ApplicationError.new(e.message, non_retryable: true)
  end
end

module Workflows
  class G0ProbeWorkflow < Base
    def run(input)
      options = { start_to_close_timeout: 5,
        retry_policy: Temporalio::RetryPolicy.new(max_attempts: 3, initial_interval: 1) }
      Temporalio::Workflow.execute_activity("g0_probe_activity", input.to_h.merge("action" => "launch"),
        activity_id: "g0-launch", **options)
      Temporalio::Workflow.wait_condition { false }
    ensure
      # Cancellation is acknowledged only after the external process is stopped.
      Temporalio::Workflow.execute_activity("g0_probe_activity", input.to_h.merge("action" => "stop"),
        start_to_close_timeout: 5, cancellation: Temporalio::Cancellation.new,
        retry_policy: Temporalio::RetryPolicy.new(max_attempts: 3, initial_interval: 1))
    end
  end
end
