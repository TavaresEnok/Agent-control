# frozen_string_literal: true

# Run with RAILS_ENV=test bin/rails runner tools/temporal/record_ac_plan_baseline.rb.
# It records the actual committed d9dbbef workflow in a disposable Temporal test
# environment; its activities are scripted and never run application effects.
require "digest"
require "open3"
require Rails.root.join("test/support/temporal_histories")

revision = "d9dbbef"
source_path = "app/temporal/workflows/ac_plan_execution_workflow.rb"
expected_sha256 = "88516076561852f182f9081e5b22f34291f9d0cf800c11e907f20a034f83cd15"
if ENV["AC_BASELINE_SOURCE_FILE"].present?
  source = File.read(ENV.fetch("AC_BASELINE_SOURCE_FILE"))
else
  source, error, status = Open3.capture3("git", "show", "#{revision}:#{source_path}", chdir: Rails.root.to_s)
  raise "Cannot load pinned baseline: #{error}" unless status.success?
end
raise "Baseline source digest mismatch" unless Digest::SHA256.hexdigest(source) == expected_sha256

original = "class AcPlanExecutionWorkflow < Workflows::Base"
replacement = "class HistoricalAcPlanExecutionWorkflowD9dbbef < Workflows::Base"
raise "Unexpected baseline class" unless source.scan(original).size == 1

Workflows::Base.name # Eager-load the base before evaluating the pinned class.
TOPLEVEL_BINDING.eval(source.sub(original, replacement), "#{revision}:#{source_path}", 1)
workflow = Workflows::HistoricalAcPlanExecutionWorkflowD9dbbef
scenario = TemporalHistories::Scenario.new(
  name: "baseline_d9dbbef_guided_review",
  workflow: workflow,
  input: { plan_id: 77, trigger_review_for_task_id: 42, review_artifact_hash: "fixture-artifact",
    expected_base_commit: "fixture-base", candidate_commit: "fixture-candidate" },
  activities: {
    "ac_advance_plan_dag_activity" => lambda { |_input, call|
      call.zero? ? { "all_completed" => false, "ready_task_details" => [ { "id" => 42 } ] } : { "all_completed" => true }
    },
    "ac_review_task_activity" => ->(_input, _call) { { "state" => "recorded" } },
    "ac_integrate_task_activity" => ->(_input, _call) { { "integrated" => true } }
  }
)
path = TemporalHistories.record(scenario, label: "d9dbbef-885160765618")
events = JSON.parse(File.read(path)).fetch("events")
raise "Baseline history unexpectedly includes a marker" if events.any? { |event| event["eventType"] == "EVENT_TYPE_MARKER_RECORDED" }
activities = events.filter_map { |event| event.dig("activityTaskScheduledEventAttributes", "activityType", "name") }
expected_activities = %w[ac_advance_plan_dag_activity ac_review_task_activity ac_integrate_task_activity ac_advance_plan_dag_activity]
raise "Baseline activity sequence differs: #{activities.inspect}" unless activities == expected_activities
puts "Recorded #{path.relative_path_from(Rails.root)} from #{revision} sha256=#{expected_sha256}"
