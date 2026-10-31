# frozen_string_literal: true

require "socket"
require "websocket/driver"

module F0Access
  # Real RFC6455 client. Driver validates upgrade; no mocked Cable connection.
  class WebSocket
    attr_reader :url, :messages

    def initialize(url, cookie: nil, protocol: "actioncable-v1-json")
      @url = url
      uri = URI(url)
      @socket = TCPSocket.new(uri.host, uri.port)
      @messages = []
      @driver = ::WebSocket::Driver.client(self, protocols: [protocol])
      @driver.set_header("Origin", "http://web:4000")
      @driver.set_header("Cookie", cookie) if cookie
      @driver.on(:open) { @open = true }
      @driver.on(:message) { |event| @messages << event.data }
      @driver.on(:close) { @closed = true }
      @driver.on(:error) { @closed = true }
      @driver.start
    end

    def write(bytes) = @socket.write(bytes)
    def send_json(value) = @driver.text(JSON.generate(value))

    def wait(seconds: 3)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + seconds
      loop do
        return true if yield(self)
        remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        return false if remaining <= 0 || @closed
        next unless IO.select([@socket], nil, nil, remaining)
        @driver.parse(@socket.readpartial(65_536))
      end
    rescue EOFError, Errno::ECONNRESET
      @closed = true
      yield(self)
    end

    def event?(type)
      @messages.any? { |message| JSON.parse(message)["type"] == type }
    end

    def closed? = @closed
    def opened? = @open
    def close = @socket.close
  end
end
