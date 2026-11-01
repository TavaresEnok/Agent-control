# frozen_string_literal: true

require "minitest/autorun"
require "minitest/mock"
require_relative "../readiness"

class ReadinessTest < Minitest::Test
  Response = Struct.new(:code, :body)

  def setup
    @now = 0.0
    @budgets = []
    @waits = []
    @uri = URI("http://gateway:8080/t/secret/tty/")
  end

  def probe(client, seconds: 2)
    helper = F0Access::Readiness.new(
      clock: -> { @now },
      wait: ->(delay) { @waits << delay; @now += delay },
      client: ->(uri, headers, budget) {
        assert_equal @uri, uri
        assert_equal({ "Cookie" => "secret-cookie" }, headers)
        @budgets << budget
        client.call
      })
    helper.call(phase: :gateway, uri: @uri, headers: { "Cookie" => "secret-cookie" }, seconds: seconds) do |r|
      r.code == "200" && r.body == "correct-service"
    end
  end

  def test_initial_open_timeout_then_positive_service
    calls = 0
    row = probe(-> {
      calls += 1
      raise Net::OpenTimeout, "secret-cookie" if calls == 1
      Response.new("200", "correct-service")
    })
    assert_equal "PASS", row[:status]
    assert_equal 2, row[:attempts]
    assert_equal "Net::OpenTimeout", row[:last_error_class]
    assert_equal [ 2.0, 1.5 ], @budgets
    refute_includes row.to_s, "secret"
  end

  def test_persistent_transport_failure_stops_at_monotonic_deadline
    row = probe(-> { raise SocketError, "private DNS name" }, seconds: 1.2)
    assert_equal "NOTRUN", row[:status]
    assert_equal "startup_deadline", row[:reason]
    assert_equal "SocketError", row[:last_error_class]
    assert_equal 3, row[:attempts]
    assert_in_delta 1.2, @now
    assert_in_delta 0.2, @waits.last
    refute_includes row.to_s, "private"
  end

  def test_transient_transport_allowlist
    [ Net::ReadTimeout, Errno::ECONNREFUSED, Errno::EHOSTUNREACH ].each do |error|
      @now = 0
      row = probe(-> { @now += 2; raise error })
      assert_equal "NOTRUN", row[:status]
      assert_equal error.name, row[:last_error_class]
      assert_equal 1, row[:attempts]
    end
  end

  def test_http_error_or_wrong_service_is_immediate_fail_without_retry
    [ Response.new("404", "correct-service"), Response.new("200", "wrong-listener"),
     Response.new("503", "not-ready") ].each do |response|
      row = probe(-> { response })
      assert_equal "FAIL", row[:status]
      assert_equal "unexpected_service_or_state", row[:reason]
      assert_equal 1, row[:attempts]
    end
    assert_empty @waits
  end

  def test_late_positive_response_is_never_pass
    row = probe(-> { @now += 3; Response.new("200", "correct-service") })
    assert_equal "NOTRUN", row[:status]
    assert_equal 1, row[:attempts]
    assert_empty @waits
  end

  def test_non_transport_errors_are_not_retried
    row = probe(-> { raise ArgumentError, "bad configuration" })
    assert_equal "NOTRUN", row[:status]
    assert_equal "non_transient_error", row[:reason]
    assert_equal "ArgumentError", row[:last_error_class]
    assert_equal 1, @budgets.length
    assert_empty @waits
  end

  def test_real_client_uses_only_get_without_proxy_and_caps_both_timeouts
    http = Object.new
    requests = []
    http.define_singleton_method(:request) do |request|
      requests << request
      Response.new("200", "healthy")
    end
    start = ->(*args, **options, &block) {
      assert_equal [ "gateway", 8080, nil, nil, nil, nil ], args
      assert_in_delta(0.25, options[:open_timeout])
      assert_in_delta(0.25, options[:read_timeout])
      block.call(http)
    }
    budget = ->(seconds, error, &block) {
      assert_in_delta(0.25, seconds)
      assert_equal Net::ReadTimeout, error
      block.call
    }
    helper = F0Access::Readiness.new(clock: -> { 0 })
    Timeout.stub(:timeout, budget) do
      Net::HTTP.stub(:start, start) do
        row = helper.call(phase: :backend, uri: @uri, seconds: 0.25) { |r| r.code == "200" }
        assert_equal "PASS", row[:status]
      end
    end
    assert_equal [ "GET" ], requests.map(&:method)
  end
end
