# frozen_string_literal: true
require_relative "../../../tools/f0/ssh/boot"
require "minitest/autorun"
require "tmpdir"
require "base64"
require "digest"

class OpenSshTransportTest < Minitest::Test
  def setup
    @dir = Dir.mktmpdir("ssh quoted ' path ")
    @identity = File.join(@dir, "identity")
    @known = File.join(@dir, "known hosts")
    File.write(@identity, "synthetic, not a private key")
    key = Base64.strict_encode64("synthetic public key blob")
    File.write(@known, "f0-lab-pinned ssh-ed25519 #{key}\n")
    @config = { host: "target", user: "lab", identity_file: @identity,
      known_hosts_file: @known, fingerprint: "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(key))).delete_suffix('=')}", lab_opt_in: true }
  end

  def teardown
    FileUtils.remove_entry(@dir)
  end

  def transport(**overrides)
    AgentControl::OpenSshTransport.new(**@config.merge(overrides))
  end

  def test_requires_opt_in_and_valid_explicit_destination
    [ { lab_opt_in: false }, { host: "-oProxyCommand=evil" }, { user: "lab;echo evil" }, { port: 0 }, { known_hosts_file: "relative" } ].each do |bad|
      assert_raises(ArgumentError) { transport(**bad) }
    end
  end

  def test_rejects_environment_expansion_paths_before_transport_can_spawn
    literal_dir = File.join(@dir, '${LANG}')
    FileUtils.mkdir_p(literal_dir)
    { identity_file: @identity, known_hosts_file: @known }.each do |field, source|
      literal_path = File.join(literal_dir, File.basename(source))
      FileUtils.cp(source, literal_path)
      assert File.file?(literal_path), "literal file must exist to exercise expansion rejection"
      error = assert_raises(ArgumentError) { transport(**{ field => literal_path }) }
      assert_equal "explicit absolute file required", error.message
    end
  end

  def test_pin_mismatch_or_changed_pin_fails_before_returning_argv
    assert_raises(ArgumentError) { transport(fingerprint: "SHA256:wrong") }
    t = transport
    File.write(@known, "@cert-authority * ssh-ed25519 abc\n")
    assert_raises(ArgumentError) { t.argv("touch forbidden") }
  end

  def test_structured_argv_preserves_command_and_identity_spaces
    command = %q(printf '%s' 'space " and quotes')
    argv = transport.argv(command)
    assert_equal ["/usr/bin/ssh", "-F", "/dev/null", "-T"], argv.take(4)
    assert_equal @identity, argv[argv.index("-i") + 1]
    assert_equal ["--", "lab@target", command], argv.last(3)
    %w[BatchMode=yes IdentitiesOnly=yes IdentityAgent=none StrictHostKeyChecking=yes ForwardAgent=no ClearAllForwardings=yes SendEnv=-* ControlPath=none ProxyCommand=none].each { |option| assert_includes argv, option }
    assert_includes argv, %(UserKnownHostsFile="#{@known}")
    refute argv.any? { |arg| arg.include?("accept-new") }
  end

  def test_no_inherited_environment_and_no_job_env_forwarding
    t = transport
    assert_equal({ unsetenv_others: true }, t.spawn_options)
    out, err, status = Open3.capture3(t.environment, "/usr/bin/env", **t.spawn_options)
    assert status.success?, err
    assert_equal t.environment.sort, out.lines.map { |line| line.strip.split("=", 2) }.sort.to_h.sort
    assert_raises(ArgumentError) { t.validate_job_env!("OPENAI_API_KEY" => "synthetic") }
    t.validate_job_env!({})
  end

  def test_openssh_parses_explicit_configuration_with_spaces_without_connecting
    t = transport
    argv = t.argv("true")
    argv.insert(1, "-G")
    out, err, status = Open3.capture3(t.environment, *argv, **t.spawn_options)
    assert status.success?, err
    assert_includes out, "stricthostkeychecking true"
    assert_includes out, "forwardagent no"
    assert_includes out, "userknownhostsfile #{@known}"
  end
end
