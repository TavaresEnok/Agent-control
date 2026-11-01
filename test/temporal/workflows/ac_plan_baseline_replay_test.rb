# frozen_string_literal: true

require "test_helper"

class AcPlanBaselineReplayTest < ActiveSupport::TestCase
  HISTORY = Rails.root.join("test/fixtures/files/temporal_histories/ac_plan_execution_workflow/baseline_d9dbbef_guided_review/d9dbbef-885160765618.json")

  test "actual d9dbbef history without a patch marker replays on the deployed wrapper" do
    assert File.file?(HISTORY), "Generate the pinned baseline with tools/temporal/record_ac_plan_baseline.rb"
    events = JSON.parse(HISTORY.read).fetch("events")
    assert_not events.any? { |event| event["eventType"] == "EVENT_TYPE_MARKER_RECORDED" }
    activities = events.filter_map { |event| event.dig("activityTaskScheduledEventAttributes", "activityType", "name") }
    assert_equal %w[ac_advance_plan_dag_activity ac_review_task_activity ac_integrate_task_activity ac_advance_plan_dag_activity], activities
    result = TemporalHistories.replay([ HISTORY ]).first.last
    assert_nil result.replay_failure, result.replay_failure&.message
  end
end
