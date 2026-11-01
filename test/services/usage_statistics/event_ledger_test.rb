# frozen_string_literal: true

require "test_helper"

module UsageStatistics
  class EventLedgerTest < ActiveSupport::TestCase
    setup do
      @session = create(:terminal_session, user: create(:user))
    end

    test "fragmented and reordered observations are claimed once with stable IDs" do
      first = log("one", 7)
      second = log("two", 9)
      assert_equal 2, records(filter([ first, second ])).size
      assert_empty records(filter([ second ]))
      assert_empty records(filter([ second, first ]))
      assert_equal 2, UsageStatisticsEventReceipt.where(terminal_session: @session).count
    end

    test "identical anonymous observations remain distinct" do
      anonymous = log(nil, 7)
      assert_equal 2, records(filter([ anonymous, anonymous ])).size
      assert_equal 1, records(filter([ anonymous ])).size
      assert_equal 0, UsageStatisticsEventReceipt.where(terminal_session: @session).count
    end

    test "changing data under the same identity rejects and rolls back all new claims" do
      filter([ log("one", 7) ])
      assert_raises(ArgumentError) do
        UsageStatisticsEventReceipt.transaction { filter([ log("two", 9), log("one", 10) ]) }
      end
      assert_equal 1, UsageStatisticsEventReceipt.where(terminal_session: @session).count
    end

    test "metric sampling identity is independent of fragmentation and attribute order" do
      attrs = [ { "key" => "model", "value" => { "stringValue" => "model" } }, { "key" => "type", "value" => { "stringValue" => "input" } } ]
      point = { "attributes" => attrs, "startTimeUnixNano" => "1", "timeUnixNano" => "2", "asInt" => "5" }
      payload = { "resourceMetrics" => [ { "resource" => resource, "scopeMetrics" => [ { "metrics" => [ { "name" => "usage", "sum" => { "dataPoints" => [ point ] } } ] } ] } ] }
      first = EventLedger.filter!(payload: payload, terminal_session: @session)
      assert_equal 1, first.dig("resourceMetrics", 0, "scopeMetrics", 0, "metrics", 0, "sum", "dataPoints").size
      point["attributes"] = attrs.reverse
      second = EventLedger.filter!(payload: payload, terminal_session: @session)
      assert_empty second.dig("resourceMetrics", 0, "scopeMetrics", 0, "metrics", 0, "sum", "dataPoints")
    end

    private

    def log(id, amount)
      attrs = [ { "key" => "usage", "value" => { "intValue" => amount.to_s } } ]
      attrs << { "key" => "event.id", "value" => { "stringValue" => id } } if id
      { "attributes" => attrs }
    end

    def resource
      { "attributes" => [ { "key" => "terminal_session_token", "value" => { "stringValue" => @session.route_token } } ] }
    end

    def filter(logs)
      EventLedger.filter!(payload: { "resourceLogs" => [ { "resource" => resource, "scopeLogs" => [ { "logRecords" => logs } ] } ] }, terminal_session: @session)
    end

    def records(payload)
      payload.dig("resourceLogs", 0, "scopeLogs", 0, "logRecords")
    end
  end
end
