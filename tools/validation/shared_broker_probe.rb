# frozen_string_literal: true

# Run only in the disposable Docker laboratory after loading its schema:
# DATABASE_URL=postgresql://.../ac_broker_probe_test \
# AC_BROKER_PROBE_CERT=/private/server.pem AC_BROKER_PROBE_KEY=/private/server.key \
# SSL_CERT_FILE=/private/ca.pem SKIP_COVERAGE=1 ruby -Itest tools/validation/shared_broker_probe.rb

require "uri"
require "openssl"
require "json"
require "net/http"
require "securerandom"
require "tmpdir"
require "fileutils"
require "rbconfig"
require "timeout"
require "socket"

database_url = ENV.fetch("DATABASE_URL", "")
begin
  database_uri = URI.parse(database_url)
rescue URI::InvalidURIError
  abort "Probe requires the explicitly named disposable database"
end
unless %w[postgres postgresql].include?(database_uri.scheme) && database_uri.path == "/ac_broker_probe_test" &&
       database_uri.query.nil? && database_uri.fragment.nil?
  abort "Probe requires DATABASE_URL ending in /ac_broker_probe_test without query parameters"
end

%w[AC_BROKER_PROBE_CERT AC_BROKER_PROBE_KEY SSL_CERT_FILE].each do |name|
  path = ENV[name].to_s
  abort "Probe requires readable laboratory TLS files" unless path.start_with?("/") && File.file?(path) && File.readable?(path)
end
key_stat = File.stat(ENV.fetch("AC_BROKER_PROBE_KEY"))
abort "Probe TLS key must be private" unless (key_stat.mode & 0o077).zero?
ENV["RAILS_ENV"] = "test"
ENV["SKIP_COVERAGE"] = "1"
ENV["PARALLEL_WORKERS"] = "1"
%w[HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy].each { |key| ENV.delete(key) }

require "test_helper"
abort "Probe connected to an unexpected database" unless ActiveRecord::Base.connection_db_config.database == "ac_broker_probe_test"

class SharedBrokerProbe < ActiveSupport::TestCase
  self.use_transactional_tests = false
  include AcSafetyFixtures

  BROKER_PORT = 19_443
  STATUS_PORT = 19_444
  AUTHORITY = "probe-authority"

  test "two TLS clients compete and a fenced orphan releases its reservation" do
    assert_equal "ac_broker_probe_test", ActiveRecord::Base.connection_db_config.database
    assert_equal 0, AcCapacityBrokerReservation.count
    assert_equal 0, AcCapacityGrant.active_or_granted.count
    assert_equal 0, SessionAdmission.occupied.count

    [ BROKER_PORT, STATUS_PORT ].each do |port|
      begin
        probe = TCPServer.new("127.0.0.1", port)
        probe.close
      rescue Errno::EADDRINUSE, Errno::EACCES
        flunk "Required loopback port is unavailable"
      end
    end
    directory = Dir.mktmpdir("ac-broker-tls-probe-")
    children = []
    account = "sha256:#{SecureRandom.hex(32)}"
    credentials = %w[host-one host-two].to_h do |host|
      [ host, { "bearer" => SecureRandom.hex(32), "signing_key" => SecureRandom.hex(32),
        "status_bearer" => SecureRandom.hex(32), "status_key" => SecureRandom.hex(32),
        "status_url" => "https://localhost:#{STATUS_PORT}/v1/capacity/status", "accounts" => [ account ] } ]
    end
    broker_config = { "role" => "broker", "authority_id" => AUTHORITY, "hosts" => credentials, "accounts" => { account => 1 } }
    children << start_server(directory, "broker", BROKER_PORT, broker_config)
    wait_for_https(BROKER_PORT, children.last)
    assert_untrusted_ca_rejected(BROKER_PORT)

    clients = credentials.to_h do |host, entry|
      [ host, AcCapacityBrokerClient.new(endpoint: "https://localhost:#{BROKER_PORT}", bearer_token: entry.fetch("bearer"),
        signing_key: entry.fetch("signing_key"), host_id: host, authority_id: AUTHORITY) ]
    end
    operations = credentials.keys.to_h { |host| [ host, "probe-#{SecureRandom.uuid}" ] }
    gate = Queue.new
    threads = clients.map do |host, client|
      Thread.new do
        gate.pop
        [ host, client.reserve!(operation_id: operations.fetch(host), account_key: account, quantity: 1, epoch: "1") ]
      end
    end
    2.times { gate << true }
    results = Timeout.timeout(30) { threads.map(&:value).to_h }
    winner = results.find { |_host, result| result["state"] == "reserved" }&.first
    loser = results.find { |_host, result| result["state"] == "denied" }&.first
    assert winner && loser, "Exactly one client must receive the final slot"
    assert_equal 1, AcCapacityBrokerReservation.where(account_key: account, state: "reserved").sum(:quantity)

    winner_secret = credentials.fetch(winner)
    status_config = { "role" => "status", "host_id" => winner, "authority_id" => AUTHORITY,
      "bearer" => winner_secret.fetch("status_bearer"), "signing_key" => winner_secret.fetch("status_key") }
    children << start_server(directory, "status", STATUS_PORT, status_config)
    wait_for_https(STATUS_PORT, children.last)

    operation = operations.fetch(winner)
    grant_id = "#{winner}:#{Digest::SHA256.hexdigest(operation)}"
    AcSharedCapacityIntent.create!(company: @company, ac_task: @task, ac_execution_profile: @profiles.fetch("programmer"),
      agent_credential: @credential, operation_id: operation, account_key: account, host_id: winner,
      authority_id: AUTHORITY, epoch: "1", quantity: 1, broker_grant_id: grant_id, state: "reserved")
    client_a = clients.fetch(winner)
    client_b = clients.fetch(loser)
    assert_equal "bound", client_a.bind!(operation_id: operation, account_key: account, grant_id: grant_id)["state"]
    assert_equal "bound", client_a.get!(operation_id: operation, account_key: account)["state"]
    assert_equal "bound", client_a.reserve!(operation_id: operation, account_key: account, quantity: 1, epoch: "1")["state"]
    assert_request_auth_and_nonce(winner, winner_secret, operation, account)

    proof = { "execution_id" => nil, "runtime_id" => nil, "epoch" => "1", "grant_id" => grant_id }
    assert_equal "released", client_a.release!(operation_id: operation, account_key: account, release_proof: proof)["state"]
    assert_equal "fenced", AcSharedCapacityIntent.find_by!(operation_id: operation).state
    assert_equal "reserved", client_b.reserve!(operation_id: operations.fetch(loser), account_key: account, quantity: 1, epoch: "1")["state"]
    assert_equal 1, AcCapacityBrokerReservation.where(account_key: account, state: %w[reserved bound]).sum(:quantity)
  ensure
    threads&.each { |thread| thread.kill if thread.alive? }
    children&.reverse_each { |pid| stop_server(pid) }
    FileUtils.remove_entry(directory) if directory && File.directory?(directory)
  end

  private

  def start_server(directory, name, port, configuration)
    config_path = File.join(directory, "#{name}.json")
    File.open(config_path, File::WRONLY | File::CREAT | File::EXCL, 0o600) { |file| file.write(JSON.generate(configuration)) }
    rackup = File.join(directory, "#{name}.ru")
    File.write(rackup, <<~RACK)
      require "json"
      require File.join(ENV.fetch("AC_BROKER_PROBE_ROOT"), "config/environment")
      path = ENV.fetch("AC_BROKER_PROBE_CONFIG_FILE")
      raise "unsafe probe config" unless File.stat(path).file? && (File.stat(path).mode & 0o077).zero?
      data = JSON.parse(File.read(path))
      Rails.application.config.ac_capacity_broker_authority_id = data.fetch("authority_id")
      if data.fetch("role") == "broker"
        Rails.application.config.ac_capacity_broker_hosts = data.fetch("hosts")
        Rails.application.config.ac_capacity_broker_accounts = data.fetch("accounts")
      else
        Rails.application.config.ac_capacity_broker_status = data.slice("host_id", "authority_id", "bearer", "signing_key")
      end
      run Rails.application
    RACK
    puma_config = File.join(directory, "#{name}-puma.rb")
    tls_query = URI.encode_www_form("cert" => ENV.fetch("AC_BROKER_PROBE_CERT"), "key" => ENV.fetch("AC_BROKER_PROBE_KEY"), "verify_mode" => "none")
    File.write(puma_config, "threads 1, 4\nbind #{"ssl://127.0.0.1:#{port}?#{tls_query}".inspect}\nenvironment 'test'\n")
    child_env = { "AC_BROKER_PROBE_ROOT" => Rails.root.to_s, "AC_BROKER_PROBE_CONFIG_FILE" => config_path,
      "RAILS_ENV" => "test", "SOLID_QUEUE_IN_PUMA" => "false", "SKIP_COVERAGE" => "1",
      "AC_RUNTIME_ACCOUNTS_FILE" => nil, "AC_CAPACITY_BROKER_ENDPOINT" => nil,
      "AC_CAPACITY_BROKER_HOSTS" => nil, "AC_CAPACITY_BROKER_ACCOUNT_LIMITS" => nil,
      "AC_CAPACITY_ACCOUNT_IDENTITIES" => nil, "AC_CAPACITY_BROKER_CLIENT_BEARER_TOKEN" => nil,
      "AC_CAPACITY_BROKER_CLIENT_SIGNING_KEY" => nil, "AC_CAPACITY_STATUS_BEARER_TOKEN" => nil,
      "AC_CAPACITY_STATUS_SIGNING_KEY" => nil }
    Process.spawn(child_env, RbConfig.ruby, Gem.bin_path("puma", "puma"), "-C", puma_config, rackup,
      chdir: Rails.root.to_s, out: File::NULL, err: File::NULL)
  end

  def wait_for_https(port, pid)
    Timeout.timeout(45) do
      loop do
        raise "Probe server exited before readiness" if Process.waitpid(pid, Process::WNOHANG)
        begin
          response = https_request(port, Net::HTTP::Get.new("/up"))
          return if response.code == "200"
        rescue Errno::ECONNREFUSED, Errno::ECONNRESET, EOFError, OpenSSL::SSL::SSLError
          # The process may not have finished booting.
        end
        sleep 0.1
      end
    end
  end

  def assert_untrusted_ca_rejected(port)
    http = Net::HTTP.new("localhost", port, nil)
    http.use_ssl = true
    http.verify_mode = OpenSSL::SSL::VERIFY_PEER
    http.cert_store = OpenSSL::X509::Store.new
    assert_raises(OpenSSL::SSL::SSLError) { http.start { |connection| connection.request(Net::HTTP::Get.new("/up")) } }
  end

  def assert_request_auth_and_nonce(host, secrets, operation, account)
    payload = { "action" => "get", "operation_id" => operation, "account_key" => account,
      "host_id" => host, "authority_id" => AUTHORITY, "nonce" => SecureRandom.hex(16) }
    body = JSON.generate(payload)
    request = lambda do |signature|
      result = Net::HTTP::Post.new("/v1/reservations/get")
      result["Content-Type"] = "application/json"
      result["Authorization"] = "Bearer #{secrets.fetch('bearer')}"
      result["X-AC-Signature"] = signature
      result.body = body
      result
    end
    signature = OpenSSL::HMAC.hexdigest("SHA256", secrets.fetch("signing_key"), body)
    assert_equal "401", https_request(BROKER_PORT, request.call("invalid")).code
    response = https_request(BROKER_PORT, request.call(signature))
    assert_equal "200", response.code
    expected = OpenSSL::HMAC.hexdigest("SHA256", secrets.fetch("signing_key"), response.body)
    received = response["X-AC-Signature"].to_s
    assert received.bytesize == expected.bytesize && ActiveSupport::SecurityUtils.secure_compare(received, expected), "Broker response signature invalid"
    assert_equal "400", https_request(BROKER_PORT, request.call(signature)).code
  end

  def https_request(port, request)
    http = Net::HTTP.new("localhost", port, nil)
    http.use_ssl = true
    http.verify_mode = OpenSSL::SSL::VERIFY_PEER
    http.open_timeout = 2
    http.read_timeout = 5
    http.start { |connection| connection.request(request) }
  end

  def stop_server(pid)
    return if Process.waitpid(pid, Process::WNOHANG)

    Process.kill("TERM", pid)
    Timeout.timeout(5) { Process.waitpid(pid) }
  rescue Timeout::Error
    Process.kill("KILL", pid)
    Process.waitpid(pid)
  rescue Errno::ESRCH, Errno::ECHILD
    nil
  end
end
