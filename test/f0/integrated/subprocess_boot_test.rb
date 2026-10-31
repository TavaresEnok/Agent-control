# frozen_string_literal: true

# Run in the prepared Ruby image. No PG/Temporal server is started or contacted.
require "bundler/setup"
require "minitest/autorun"
require "open3"
require "rbconfig"
require_relative "../../../tools/f0/integrated/subprocess_environment"

class IntegratedSubprocessBootTest < Minitest::Test
  ROOT = File.expand_path("../../..", __dir__)
  LAB = File.join(ROOT, "tools/f0/integrated")

  def environment
    IntegratedSubprocessEnvironment.build(ENV.to_h.merge(
      "BUNDLE_GEMFILE" => File.join(LAB, "Gemfile"), "BUNDLE_FROZEN" => "true",
      "F0_ADMISSION_LAB" => "agent-control:F0-G0:admission-sql:disposable:v1",
      "F0_ADMISSION_SOCKET" => "/lab-pg",
      "UNRELATED_SECRET" => "must-not-be-inherited"))
  end

  def test_filtered_environment_reaches_a_real_child
    script = 'abort unless ENV.fetch("BUNDLE_FROZEN") == "true" && !ENV.key?("UNRELATED_SECRET"); print "filtered"'
    out, err, status = Open3.capture3(environment, RbConfig.ruby, "-e", script, unsetenv_others: true)
    assert status.success?, err
    assert_equal "filtered", out
  end

  def test_filter_does_not_manufacture_frozen_authorization
    refute IntegratedSubprocessEnvironment.build({}).key?("BUNDLE_FROZEN")
    assert_equal "false", IntegratedSubprocessEnvironment.build("BUNDLE_FROZEN" => "false")["BUNDLE_FROZEN"]
  end

  def test_both_real_entrypoints_complete_boot_before_any_service_operation
    %w[worker.rb relay_child.rb].each do |entrypoint|
      path = File.join(LAB, entrypoint)
      # Stop at the first entrypoint line AFTER require_relative "boot" returns.
      # Any boot exception exits nonzero before this marker. The real boot loads
      # its locked dependencies and implementation guards, without connecting.
      script = <<~'RUBY'
        entrypoint = File.realpath(ARGV.fetch(0))
        TracePoint.new(:line) do |trace|
          if trace.path == entrypoint && trace.lineno > 3
            abort "boot did not load" unless defined?(IntegratedLab) && defined?(Workflows::IntegratedIdleWorkflow)
            puts "real-entrypoint-booted"
            exit 0
          end
        end.enable
        load entrypoint
      RUBY
      out, err, status = Open3.capture3(environment, RbConfig.ruby, "-e", script, path, unsetenv_others: true)
      assert status.success?, "#{entrypoint}: #{err}#{out}"
      assert_includes out, "real-entrypoint-booted", entrypoint
    end
  end

  def test_entrypoints_still_refuse_unfrozen_boot
    %w[worker.rb relay_child.rb].each do |entrypoint|
      out, err, status = Open3.capture3(environment.merge("BUNDLE_FROZEN" => "false"),
        RbConfig.ruby, File.join(LAB, entrypoint), unsetenv_others: true)
      refute status.success?, entrypoint
      assert_includes err + out, "Frozen integrated Gemfile required", entrypoint
    end
  end
end
