# frozen_string_literal: true
require_relative "../../../tools/f0/ssh/boot"
require "minitest/autorun"
require "tmpdir"

# Directed default-Coder regression with a labelled CLI shim, no Coder server,
# SQL integration, authentication, or RepoBootstrap claim.
class SshRunnerTransportTest < Minitest::Test
  Object.const_set(:SafeHttp, Module.new) unless defined?(::SafeHttp)
  Object.const_set(:UrlSafetyValidator, Module.new) unless defined?(::UrlSafetyValidator)

  def test_default_coder_argv_env_and_redaction_are_preserved
    Dir.mktmpdir("coder-shim") do |dir|
      File.write(File.join(dir, "coder"), <<~SH)
        #!/bin/sh
        test "$CODER_URL" = 'https://fixture.invalid' || exit 80
        test "$CODER_SESSION_TOKEN" = 'synthetic-coder-token' || exit 81
        printf '%s\n' "$1" "$2" "$3" "$4" "$CODER_SESSION_TOKEN"
      SH
      File.chmod(0o755, File.join(dir, "coder"))
      previous = ENV["PATH"]
      previous_vet = SafeHttp.method(:vetted_address) if SafeHttp.respond_to?(:vetted_address)
      previous_hosts = UrlSafetyValidator.method(:configured_trusted_hosts) if UrlSafetyValidator.respond_to?(:configured_trusted_hosts)
      SafeHttp.define_singleton_method(:vetted_address) { |*| true }
      UrlSafetyValidator.define_singleton_method(:configured_trusted_hosts) { [] }
      ENV["PATH"] = "#{dir}:/usr/bin:/bin"
      begin
        integration = Struct.new(:coder_url, :credentials_data).new("https://fixture.invalid", { "session_token" => "synthetic-coder-token" })
        result = Coder::SshRunner.new(integration).exec(workspace_name: "ws spaces", command: %q(printf '%s' "a b"))
        assert_equal 0, result[:exit_code]
        assert_equal ["ssh", "ws spaces", "--", Coder::SshRunner::HOME_PREFIX + %q(printf '%s' "a b"), "[REDACTED]"], result[:stdout].lines.map(&:chomp)
      ensure
        ENV["PATH"] = previous
        SafeHttp.singleton_class.remove_method(:vetted_address)
        UrlSafetyValidator.singleton_class.remove_method(:configured_trusted_hosts)
        SafeHttp.define_singleton_method(:vetted_address, previous_vet) if previous_vet
        UrlSafetyValidator.define_singleton_method(:configured_trusted_hosts, previous_hosts) if previous_hosts
      end
    end
  end

  # A local test transport only; journal/parse/timeout/limits remain real runner.
  class LocalTransport
    def initialize(dir) = @dir = dir
    def environment = { "PATH" => "/usr/bin:/bin", "AIXLE_JOB_DIR" => @dir }
    def spawn_options = { unsetenv_others: true }
    def argv(command) = ["/bin/sh", "-c", command]
    def validate_job_env!(env)
      raise ArgumentError unless env.empty?
    end
  end

  def test_optional_seam_uses_existing_detach_and_status_protocol
    Dir.mktmpdir("existing-journal") do |dir|
      make = -> { Coder::SshRunner.new(nil, transport: LocalTransport.new(dir)) }
      handle = make.call.exec_detached(workspace_name: "lab", command: "printf '\\n---aixle_job_result---\\nobserved_sha=synthetic\\n'", job_id: "seam_test")
      assert_equal "seam_test", handle[:job_id]
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      loop do
        status = make.call.job_status(workspace_name: "lab", job_id: handle[:job_id])
        if status[:state] == "exited"
          assert_equal 0, status[:exit_code]
          assert_equal "synthetic", status.dig(:result, "observed_sha")
          assert File.file?(File.join(dir, "seam_test.meta"))
          break
        end
        raise "journal deadline" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
        sleep 0.05
      end
      assert_raises(ArgumentError) { make.call.exec_detached(workspace_name: "lab", command: "true", env: { "SECRET" => "synthetic" }) }
      assert_raises(Coder::SshRunner::CommandError) { make.call.job_status(workspace_name: "lab", job_id: "../escape") }
      bounded = make.call.exec(workspace_name: "lab", command: "head -c 1000 /dev/zero", max_bytes: 128)
      assert bounded[:truncated]
      assert_operator bounded[:stdout].bytesize, :<=, 128
      timed = make.call.exec(workspace_name: "lab", command: "sleep 5", timeout: 1)
      assert_equal 124, timed[:exit_code]
    end
  end
end
