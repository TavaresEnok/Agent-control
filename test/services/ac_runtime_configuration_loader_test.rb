# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "json"

class AcRuntimeConfigurationLoaderTest < ActiveSupport::TestCase
  setup do
    @directory = Dir.mktmpdir("ac-runtime-config-")
    @auth = File.join(@directory, "auth.json")
    File.write(@auth, "synthetic-secret")
    File.chmod(0o600, @auth)
    @uid = Process.euid.zero? ? 1000 : Process.euid
    @gid = Process.egid.zero? ? 1000 : Process.egid
    File.chown(@uid, @gid, @auth) if Process.euid.zero?
    @config_path = File.join(@directory, "runtime.json")
    @account = {
      "image" => "sha256:#{'a' * 64}", "argv" => [ "claude", "--model", "{model}", "--effort", "{effort}", "{prompt}" ],
      "auth_files" => { @auth => "/home/agent/.claude.json" }, "uid" => "#{@uid}:#{@gid}", "network" => "none",
      "cli_adapter" => "claude_code", "agent_type" => "claude_code", "auth_mode" => "subscription",
      "attestation" => { "status" => "documented_supported", "mode" => "subscription", "cli_adapter" => "claude_code",
        "credential_id" => "123", "source" => "https://example.invalid/evidence", "observed_at" => 1.minute.ago.iso8601,
        "valid_until" => 1.hour.from_now.iso8601 }
    }
  end

  teardown { FileUtils.remove_entry(@directory) if @directory && File.directory?(@directory) }

  test "loads only private pinned and explicitly attested accounts" do
    write_configuration
    result = AcRuntimeConfigurationLoader.load!(@config_path)
    assert_equal [ "123" ], result[:accounts].keys
    assert_empty result[:networks]
    File.chmod(0o644, @config_path)
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.load!(@config_path) }
  end

  test "rejects configuration owned by a different user" do
    skip "Changing file ownership requires root" unless Process.euid.zero?
    write_configuration
    File.chown(1, 1, @config_path)
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.load!(@config_path) }
  end

  test "rejects symlinks and unsafe authentication file permissions" do
    write_configuration
    link = File.join(@directory, "runtime-link.json")
    File.symlink(@config_path, link)
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.load!(link) }
    File.chmod(0o644, @auth)
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.load!(@config_path) }
  end

  test "refuses missing expired or mismatched attestation and unsafe runtime choices" do
    %w[status valid_until credential_id source observed_at].each do |field|
      candidate = @account.deep_dup
      candidate["attestation"].delete(field)
      assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) do
        AcRuntimeConfigurationLoader.validate_account!("123", candidate, networks: [])
      end
    end
    candidate = @account.deep_dup
    candidate["attestation"]["status"] = "unknown"
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.validate_account!("123", candidate, networks: []) }
    candidate = @account.deep_dup
    candidate["attestation"]["valid_until"] = 1.minute.ago.iso8601
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.validate_account!("123", candidate, networks: []) }
    candidate = @account.deep_dup
    candidate["image"] = "latest"
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.validate_account!("123", candidate, networks: []) }
    candidate = @account.deep_dup
    candidate["argv"] += [ "--model", "different" ]
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.validate_account!("123", candidate, networks: []) }
    candidate = @account.deep_dup
    candidate["network"] = "host"
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.validate_account!("123", candidate, networks: [ "host" ]) }
  end

  test "rejects reusing an authentication inode across accounts" do
    second = @account.deep_dup
    linked_auth = File.join(@directory, "linked-auth.json")
    File.link(@auth, linked_auth)
    second["auth_files"] = { linked_auth => "/home/agent/.claude.json" }
    second["attestation"]["credential_id"] = "456"
    File.write(@config_path, JSON.generate("version" => 1, "accounts" => { "123" => @account, "456" => second }, "allowed_networks" => []))
    File.chmod(0o600, @config_path)
    assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.load!(@config_path) }
  end

  test "enforces size and exposes no account material in error messages" do
    File.write(@config_path, "x" * (AcRuntimeConfigurationLoader::MAX_BYTES + 1))
    File.chmod(0o600, @config_path)
    error = assert_raises(AcRuntimeConfigurationLoader::InvalidConfiguration) { AcRuntimeConfigurationLoader.load!(@config_path) }
    assert_not_includes error.message, "synthetic-secret"
    assert_not_includes error.message, @directory
  end

  private

  def write_configuration
    File.write(@config_path, JSON.generate("version" => 1, "accounts" => { "123" => @account }, "allowed_networks" => []))
    File.chmod(0o600, @config_path)
  end
end
