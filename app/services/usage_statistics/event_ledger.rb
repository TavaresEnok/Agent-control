# frozen_string_literal: true

require "digest"

module UsageStatistics
  # Claim individual OTLP observations in the SAME transaction as the accumulator.
  # Identity comes from the producer or the metric stream/timestamp, never usage
  # values. Anonymous logs/points remain additive, including identical events.
  class EventLedger
    EVENT_ID_KEYS = %w[event.id event_id log.record.uid].freeze

    def self.filter!(payload:, terminal_session:)
      new(terminal_session).filter!(payload.deep_dup)
    end

    def initialize(session)
      @session = session
    end

    def filter!(payload)
      { "resourceLogs" => [ "scopeLogs", "logRecords" ], "resourceMetrics" => [ "scopeMetrics", "metrics" ] }.each do |root, (scopes, records)|
        Array(payload[root]).each do |resource|
          resource_attrs = Array(resource.dig("resource", "attributes"))
          Array(resource[scopes]).each do |scope|
            namespace = [ root, canonical(resource["resource"]), canonical(scope["scope"]) ]
            if root == "resourceLogs"
              scope[records] = Array(scope[records]).select do |record|
                keep?(record, resource_attrs, namespace, metric: nil)
              end
            else
              Array(scope[records]).each do |metric|
                %w[sum gauge histogram exponentialHistogram summary].each do |kind|
                  next unless metric[kind].is_a?(Hash)
                  metric[kind]["dataPoints"] = Array(metric[kind]["dataPoints"]).select do |point|
                    keep?(point, resource_attrs, namespace, metric: [ metric.except(*%w[sum gauge histogram exponentialHistogram summary]), kind ])
                  end
                end
              end
            end
          end
        end
      end
      payload
    end

    private

    def keep?(record, resource_attrs, namespace, metric:)
      attrs = Array(record["attributes"])
      token = attribute(attrs, "terminal_session_token") || attribute(resource_attrs, "terminal_session_token")
      return false unless token == @session.route_token

      explicit = EVENT_ID_KEYS.filter_map { |key| attribute(attrs, key).presence }.first || record["eventId"].presence
      identity = if explicit
        [ namespace, metric, "producer", explicit, (canonical({ "attributes" => attrs })["attributes"] if metric) ]
      elsif metric && record["timeUnixNano"].to_s.match?(/\A[1-9][0-9]*\z/)
        [ namespace, metric, "sample", canonical({ "attributes" => attrs })["attributes"], record["startTimeUnixNano"], record["timeUnixNano"] ]
      end
      return true unless identity

      key = digest(identity)
      payload_digest = digest(record)
      result = UsageStatisticsEventReceipt.insert_all(
        [ { terminal_session_id: @session.id, event_key: key, payload_digest: payload_digest, created_at: Time.current, updated_at: Time.current } ],
        unique_by: :index_usage_event_receipts_on_session_and_key)
      return true if result.rows.any?

      existing = UsageStatisticsEventReceipt.find_by!(terminal_session_id: @session.id, event_key: key)
      raise ArgumentError, "Event identity reused with different data" unless existing.payload_digest == payload_digest

      false
    end

    def attribute(attrs, key)
      value = Array(attrs).find { |item| item["key"] == key }&.fetch("value", {})
      value && (value["stringValue"] || value["intValue"]).to_s
    end

    def digest(value)
      Digest::SHA256.hexdigest(JSON.generate(canonical(value)))
    end

    def canonical(value)
      case value
      when Hash
        value.except("terminal_session_key").keys.sort.to_h do |key|
          item = value[key]
          item = item.reject { |attr| attr["key"] == "terminal_session_key" }.sort_by { |attr| attr["key"].to_s } if key == "attributes" && item.is_a?(Array)
          [ key, canonical(item) ]
        end
      when Array then value.map { |item| canonical(item) }
      else value
      end
    end
  end
end
