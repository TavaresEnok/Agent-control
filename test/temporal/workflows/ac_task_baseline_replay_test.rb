# frozen_string_literal: true

require "test_helper"
require "base64"

class AcTaskBaselineReplayTest < ActiveSupport::TestCase
  HISTORY = Rails.root.join("test/fixtures/files/temporal_histories/ac_task_execution_workflow/baseline_d9dbbef_reconcile_payload/d9dbbef-a1178e8a1e5b.json")

  test "actual d9dbbef task history without a patch marker replays" do
    assert File.file?(HISTORY), "Generate the pinned baseline with tools/temporal/record_ac_task_baseline.rb"
    events = JSON.parse(HISTORY.read).fetch("events")
    assert_not events.any? { |event| event["eventType"] == "EVENT_TYPE_MARKER_RECORDED" }
    scheduled = events.filter_map { |event| event["activityTaskScheduledEventAttributes"] }
    names = scheduled.map { |event| event.dig("activityType", "name") }
    assert_equal %w[ac_admit_task_activity ac_acquire_worktree_activity ac_dispatch_execution_activity
      ac_reconcile_execution_activity ac_release_capacity_activity ac_release_capacity_activity], names
    reconcile = scheduled.find { |event| event.dig("activityType", "name") == "ac_reconcile_execution_activity" }
    args = JSON.parse(Base64.strict_decode64(reconcile.dig("input", "payloads", 0, "data")))
    assert_equal 73, args.fetch("exit_code")
    assert_equal({ "fixture" => "caller-output" }, args.fetch("output"))
    assert_equal({ "fixture" => "caller-error" }, args.fetch("error"))
    result = TemporalHistories.replay([ HISTORY ]).first.last
    assert_nil result.replay_failure, result.replay_failure&.message
  end
end
