# frozen_string_literal: true

# Records the pinned d9dbbef task workflow with scripted activities only.
require "base64"
require "digest"
require "open3"
require Rails.root.join("test/support/temporal_histories")

revision = "d9dbbef"
source_path = "app/temporal/workflows/ac_task_execution_workflow.rb"
expected_sha256 = "a1178e8a1e5b342728193ededc34639494e5d3a1b191d769ffdb1e9b02e837ba"
if ENV["AC_BASELINE_SOURCE_FILE"].present?
  source = File.read(ENV.fetch("AC_BASELINE_SOURCE_FILE"))
else
  source, error, status = Open3.capture3("git", "show", "#{revision}:#{source_path}", chdir: Rails.root.to_s)
  raise "Cannot load pinned baseline: #{error}" unless status.success?
end
raise "Baseline source digest mismatch" unless Digest::SHA256.hexdigest(source) == expected_sha256

original = "class AcTaskExecutionWorkflow < Workflows::Base"
replacement = "class HistoricalAcTaskExecutionWorkflowD9dbbef < Workflows::Base"
raise "Unexpected baseline class" unless source.scan(original).size == 1

Workflows::Base.name
TOPLEVEL_BINDING.eval(source.sub(original, replacement), "#{revision}:#{source_path}", 1)
scenario = TemporalHistories::Scenario.new(
  name: "baseline_d9dbbef_reconcile_payload",
  workflow: Workflows::HistoricalAcTaskExecutionWorkflowD9dbbef,
  input: { task_id: 42, operation_id: "fixture-op", epoch: "7", execution_profile_id: 8,
    exit_code: 73, output: { "fixture" => "caller-output" }, error: { "fixture" => "caller-error" } },
  activities: {
    "ac_admit_task_activity" => ->(_input, _call) { { "execution_id" => 91, "state" => "granted", "reused" => false } },
    "ac_acquire_worktree_activity" => ->(_input, _call) { { "worktree_path" => "/fixture/worktree" } },
    "ac_dispatch_execution_activity" => ->(_input, _call) { { "process_handle" => "fixture-process" } },
    "ac_reconcile_execution_activity" => ->(_input, _call) { { "state" => "completed", "exit_code" => 0 } },
    "ac_release_capacity_activity" => ->(_input, _call) { { "grant_released" => true } }
  }
)
path = TemporalHistories.record(scenario, label: "d9dbbef-a1178e8a1e5b")
events = JSON.parse(File.read(path)).fetch("events")
raise "Baseline history unexpectedly includes a marker" if events.any? { |event| event["eventType"] == "EVENT_TYPE_MARKER_RECORDED" }
scheduled = events.filter_map { |event| event["activityTaskScheduledEventAttributes"] }
activities = scheduled.map { |event| event.dig("activityType", "name") }
expected = %w[ac_admit_task_activity ac_acquire_worktree_activity ac_dispatch_execution_activity
  ac_reconcile_execution_activity ac_release_capacity_activity ac_release_capacity_activity]
raise "Baseline activity sequence differs: #{activities.inspect}" unless activities == expected
reconcile = scheduled.find { |event| event.dig("activityType", "name") == "ac_reconcile_execution_activity" }
arguments = JSON.parse(Base64.strict_decode64(reconcile.dig("input", "payloads", 0, "data")))
unless arguments["execution_id"] == 91 && arguments["epoch"] == "7" && arguments["exit_code"] == 73 &&
       arguments["output"] == { "fixture" => "caller-output" } && arguments["error"] == { "fixture" => "caller-error" }
  raise "Baseline reconciliation payload differs"
end
puts "Recorded #{path.relative_path_from(Rails.root)} from #{revision} sha256=#{expected_sha256}"
