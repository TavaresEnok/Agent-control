# frozen_string_literal: true

require "net/http"
require "timeout"

module F0Access
  # Only safe startup GETs belong here. Never wrap a session or mutation retry.
  class Readiness
    TRANSIENT = [ Net::OpenTimeout, Net::ReadTimeout, Errno::ECONNREFUSED,
                 SocketError, Errno::EHOSTUNREACH ].freeze
    ENDPOINTS = { backend: "backend/up", gateway: "gateway/terminal/tty" }.freeze

    def initialize(clock: -> { Process.clock_gettime(Process::CLOCK_MONOTONIC) },
                   wait: ->(seconds) { sleep seconds }, client: nil)
      @clock, @wait = clock, wait
      @client = client || method(:get)
    end

    def call(phase:, uri:, headers: {}, seconds: 40, &expected)
      endpoint = ENDPOINTS.fetch(phase)
      deadline = @clock.call + seconds
      attempts = 0
      last_error = nil
      loop do
        remaining = deadline - @clock.call
        break if remaining <= 0
        attempts += 1
        begin
          response = @client.call(uri, headers, remaining)
          break if @clock.call >= deadline
          valid = expected.call(response)
          return { name: "readiness/#{phase}", status: valid ? "PASS" : "FAIL",
                   phase: phase, endpoint: endpoint, attempts: attempts,
                   http: response.code.to_i, reason: valid ? "expected_service" : "unexpected_service_or_state",
                   last_error_class: last_error }
        rescue *TRANSIENT => error
          last_error = error.class.name
        rescue StandardError => error
          return { name: "readiness/#{phase}", status: "NOTRUN", phase: phase,
                   endpoint: endpoint, attempts: attempts, reason: "non_transient_error",
                   last_error_class: error.class.name }
        end
        remaining = deadline - @clock.call
        break if remaining <= 0
        @wait.call([ 0.5, remaining ].min)
      end
      { name: "readiness/#{phase}", status: "NOTRUN", phase: phase,
        endpoint: endpoint, attempts: attempts, reason: "startup_deadline",
        last_error_class: last_error }
    end

    private

    def get(uri, headers, remaining)
      # Net::HTTP read_timeout is per read, not an overall budget. Bound DNS,
      # connection and the whole response too; no redirects or proxy fallback.
      Timeout.timeout(remaining, Net::ReadTimeout) do
        Net::HTTP.start(uri.host, uri.port, nil, nil, nil, nil,
                        open_timeout: [ 2, remaining ].min,
                        read_timeout: [ 2, remaining ].min) do |http|
          http.request(Net::HTTP::Get.new(uri, headers))
        end
      end
    end
  end
end
