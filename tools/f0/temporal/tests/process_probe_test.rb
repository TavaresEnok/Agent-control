# frozen_string_literal: true

# Standalone fixture checks, intentionally do not boot Rails or fake Temporal.
require "tmpdir"
require "securerandom"
require_relative "../process_probe"

require_relative "assertions"

artifacts = File.expand_path("../artifacts", __dir__)
FileUtils.mkdir_p(artifacts)
Dir.mktmpdir("g0-probe-", artifacts) do |root|
  probe = ProcessProbe.new(root, "g0-#{SecureRandom.hex(16)}")
  begin
    first = probe.launch("normal")
    assert_equal(first, probe.launch("normal"), "duplicate local launch changed identity")
    assert_equal(first, probe.observe, "external identity not observed")
    probe.stop
    assert_nil(probe.observe, "child remains after stop")
    begin
      probe.launch("normal")
      raise "blind relaunch accepted"
    rescue ProcessProbe::Uncertain
      # A historical spawn attempt without external proof is not safe to retry.
    end
  ensure
    probe.stop
  end
  uncertain = ProcessProbe.new(root, "g0-#{SecureRandom.hex(16)}")
  uncertain.write("spawn-attempt.json", { "test" => true })
  begin
    uncertain.launch("normal")
    raise "missing process accepted"
  rescue ProcessProbe::Uncertain
    assert_nil(uncertain.observe, "uncertainty created process")
  end
  begin
    ProcessProbe.new(root, "../escape")
    raise "invalid ID accepted"
  rescue ArgumentError
    # expected
  end
end
puts "PASS: local process fixture only; no Temporal integration exercised"
