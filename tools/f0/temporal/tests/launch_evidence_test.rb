# frozen_string_literal: true

# Unit assertions over SDK protobufs. Does NOT start Temporal or prove integration.
require_relative "../boot"
require_relative "../launch_evidence"
require "tmpdir"

require_relative "assertions"

def rejects(message)
  begin
    yield
  rescue RuntimeError => e
    raise unless e.message == message
    return
  end
  raise "assertion accepted invalid evidence: #{message}"
end

history = Temporalio::Api::History::V1
scheduled = history::HistoryEvent.new(event_id: 10,
  event_type: :EVENT_TYPE_ACTIVITY_TASK_SCHEDULED,
  activity_task_scheduled_event_attributes: history::ActivityTaskScheduledEventAttributes.new(
    activity_id: "g0-launch"))

artifacts = File.expand_path("../artifacts", __dir__)
FileUtils.mkdir_p(artifacts)
Dir.mktmpdir("g0-evidence-", artifacts) do |root|
  probe = ProcessProbe.new(root, "g0-#{SecureRandom.hex(16)}")
  begin
    saved = probe.launch("normal")
    # Regression: an old handle AND live process cannot substitute for completion.
    assert(probe.read("handle.json") == saved && probe.observe == saved, "fixture unavailable")
    assert_nil(LaunchEvidence.completed([ scheduled ]), "pending launch accepted")
    rejects("launch Activity has not completed in Temporal") do
      LaunchEvidence.verify!(nil, saved, probe, retry_required: true)
    end

    completion = history::HistoryEvent.new(event_id: 14,
      event_type: :EVENT_TYPE_ACTIVITY_TASK_COMPLETED,
      activity_task_completed_event_attributes: history::ActivityTaskCompletedEventAttributes.new(
        scheduled_event_id: 10, result: TemporalService.data_converter.to_payloads([ saved ])))
    assert_equal(LaunchEvidence.completed([ scheduled, completion ]), completion, "completion not linked")
    rejects("missing SDK launch retry attempt") do
      LaunchEvidence.verify!(completion, saved, probe, retry_required: true)
    end
    probe.write("launch-attempt-2.json", { "attempt" => 2, "saved_handle" => saved })
    LaunchEvidence.verify!(completion, saved, probe, retry_required: true)
    rejects("Temporal launch result differs from original handle") do
      LaunchEvidence.verify!(completion, saved.merge("ticks" => "changed"), probe, retry_required: true)
    end
    probe.write("launch-attempt-2.json", { "attempt" => 2, "saved_handle" => nil })
    rejects("retry did not recover original saved handle") do
      LaunchEvidence.verify!(completion, saved, probe, retry_required: true)
    end
    completion.activity_task_completed_event_attributes.scheduled_event_id = 99
    assert_nil(LaunchEvidence.completed([ scheduled, completion ]), "unrelated Activity completion accepted")
  ensure
    probe.stop
  end
end
puts "PASS: unit launch evidence assertions only; real Temporal NOT exercised"
