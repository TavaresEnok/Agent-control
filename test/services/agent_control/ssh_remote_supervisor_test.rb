# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "base64"
require "openssl"

class SshRemoteSupervisorTest < ActiveSupport::TestCase
  include AcTemporalFixture

  class SignedReplyRunner
    attr_reader :command, :input
    attr_accessor :tamper

    def initialize(secret)
      @secret = [ secret ].pack("H*")
    end

    def execute(_transport, command, input:)
      @command = command
      @input = JSON.parse(input)
      request = @input.fetch("payload")
      fields = %w[operation_id company_id environment_id task_id execution_id epoch intent_hash]
      receipt = request.slice(*fields).merge("state" => "running", "remote_job_id" => "fixture-unit")
      receipt["execution_id"] += 1 if tamper
      normalized = receipt.keys.sort.to_h { |key| [ key, receipt[key] ] }
      mac = OpenSSL::HMAC.hexdigest("SHA256", @secret, JSON.generate(normalized))
      JSON.generate("receipt" => receipt, "mac" => mac)
    end
  end

  setup do
    setup_ac_temporal_fixture
    @dir = Dir.mktmpdir("ac-ssh-supervisor-test-")
    @secret = "a" * 64
    key = File.join(@dir, "secret")
    File.write(key, @secret)
    File.chmod(0o600, key)
    identity = File.join(@dir, "identity")
    known_hosts = File.join(@dir, "known_hosts")
    File.write(identity, "synthetic")
    blob = Base64.strict_encode64("synthetic key")
    File.write(known_hosts, "f0-lab-pinned ssh-ed25519 #{blob}\n")
    fingerprint = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(blob))).delete_suffix('=')}"
    @environment = AcRemoteEnvironment.create!(company: @company, project: @project, name: "Fixture",
      environment_slug: "fixture", host: "127.0.0.1", user: "worker", port: 22, fingerprint: fingerprint,
      identity_key_path: identity, known_hosts_path: known_hosts, authorized_directories: [ "/srv/project" ])
    @execution = admit_ac_execution
    @operation = AcRemoteOperation.create!(company: @company, project: @project, ac_remote_environment: @environment,
      ac_task: @task, ac_execution: @execution, operation_id: SecureRandom.uuid, command: "printf '%s' 'quoted'",
      working_directory: "/srv/project", state: "pending", metadata: { "execution_epoch" => @execution.epoch })
    @runner = SignedReplyRunner.new(@secret)
    @adapter = AgentControl::SshRemoteSupervisor.new(environments: { @environment.id => {
      helper_path: "/opt/ac supervisor/supervisor.py", remote_config_path: "/etc/ac/config.json", secret_file: key
    } }, runner: @runner)
  end

  teardown do
    teardown_ac_temporal_fixture
    FileUtils.remove_entry(@dir) if @dir && Dir.exist?(@dir)
  end

  test "signs a bound request over stdin and verifies the supervisor response" do
    receipt = @adapter.dispatch_operation!(environment: @environment, operation_id: @operation.operation_id,
      command: @operation.command, working_directory: @operation.working_directory, artifact_hash: nil,
      task: @task, execution: @execution)
    assert @adapter.verify_operation_receipt!(operation: @operation, receipt: receipt)
    assert_equal "running", receipt["state"]
    assert_includes @runner.command, 'ac\\ supervisor'
    assert_not_includes @runner.command, @secret
    assert_equal @operation.command, @runner.input.fetch("payload").fetch("command")
  end

  test "rejects even a signed response bound to a different execution" do
    @runner.tamper = true
    assert_raises(AgentControl::SshRemoteSupervisor::Error) do
      @adapter.dispatch_operation!(environment: @environment, operation_id: @operation.operation_id,
        command: @operation.command, working_directory: @operation.working_directory, artifact_hash: nil,
        task: @task, execution: @execution)
    end
  end
end
