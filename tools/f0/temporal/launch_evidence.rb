# frozen_string_literal: true

# Accept server-recorded completion, never a pre-crash handle file alone.
module LaunchEvidence
  def self.completed(events)
    scheduled = events.find do |event|
      event.event_type == :EVENT_TYPE_ACTIVITY_TASK_SCHEDULED &&
        event.activity_task_scheduled_event_attributes.activity_id == "g0-launch"
    end
    return unless scheduled

    events.find do |event|
      event.event_type == :EVENT_TYPE_ACTIVITY_TASK_COMPLETED &&
        event.activity_task_completed_event_attributes.scheduled_event_id == scheduled.event_id
    end
  end

  def self.verify!(completion, saved, probe, retry_required:)
    raise "launch Activity has not completed in Temporal" unless completion
    values = TemporalService.data_converter.from_payloads(
      completion.activity_task_completed_event_attributes.result)
    raise "Temporal launch result differs from original handle" unless values == [ saved ]
    return unless retry_required

    retried = probe.read("launch-attempt-2.json")
    raise "missing SDK launch retry attempt" unless retried && retried["attempt"] == 2
    raise "retry did not recover original saved handle" unless retried["saved_handle"] == saved
  end
end
