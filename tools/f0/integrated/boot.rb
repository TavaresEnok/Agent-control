# frozen_string_literal: true

raise "Frozen integrated Gemfile required" unless ENV["BUNDLE_FROZEN"] == "true" &&
  File.realpath(ENV.fetch("BUNDLE_GEMFILE")) == File.join(__dir__, "Gemfile")
raise "Integrated lock differs from physical SQL receipt" unless
  File.binread(File.join(__dir__, "Gemfile.lock")) == File.binread(File.expand_path("../../../docs/validation/artifacts/admission-lote2-host-20261031/Gemfile.lock.txt", __dir__))

module AdmissionLab
  REAL_TEMPORAL = true
end
require_relative "../admission/boot"
require "json"
require "digest"
require "fileutils"
require "temporalio/worker"

module IntegratedLab
  def self.assert!(value, message)
    raise "Integrated assertion: #{message}" unless value
  end

  def self.write(path, value)
    File.open(path, "w", 0o600) do |file|
      file.write(JSON.pretty_generate(value) + "\n")
      file.flush
      file.fsync
    end
  end

  def self.append(value)
    File.open(ENV.fetch("F0_INTEGRATED_CALLS"), "a", 0o600) do |file|
      file.write(JSON.generate(value.merge(pid: Process.pid)) + "\n")
      file.flush
      file.fsync
    end
  end

  def self.connection!
    address = ENV.fetch("F0_INTEGRATED_ADDRESS")
    assert!(/\A127\.0\.0\.1:[1-9]\d{0,4}\z/.match?(address) && address.split(":").last.to_i <= 65_535, "loopback address required")
    namespace = ENV.fetch("F0_INTEGRATED_NAMESPACE")
    assert!(/\Af0-integrated-[a-f0-9]{32}\z/.match?(namespace), "exclusive namespace required")
    Temporalio::Client.connect(address, namespace, data_converter: TemporalService.data_converter)
  end

  def self.attach!(schema)
    assert!(/\Af0_admission_[a-f0-9]{16}\z/.match?(schema), "invalid fixture schema")
    ActiveRecord::Base.establish_connection(AdmissionLab.config!.merge(schema_search_path: schema))
    c = ActiveRecord::Base.connection
    AdmissionLab.verify!(c)
    assert!(c.select_value("SELECT current_schema()") == schema, "fixture schema missing")
  end

  def self.verify_implementations!
    { [ TemporalService, :start_workflow ] => "app/services/temporal_service.rb",
      [ SessionLaunchRelay, :dispatch ] => "app/services/session_launch_relay.rb",
      [ SessionAdmissionService, :drain! ] => "app/services/session_admission_service.rb" }.each do |(owner, method), path|
      assert!(owner.method(method).source_location&.first == File.join(AdmissionLab::ROOT, path), "substituted #{owner}.#{method} refused")
    end
    sdk_path = Temporalio::Client.instance_method(:start_workflow).source_location&.first
    assert!(sdk_path && File.realpath(sdk_path).start_with?(File.realpath(Gem.loaded_specs.fetch("temporalio").full_gem_path) + "/"), "fake SDK transport refused")
  end
end

IntegratedLab.verify_implementations! # Before adding observation wrappers.

module IntegratedPGVersion
  def verify!(connection)
    super
    IntegratedLab.assert!(connection.select_value("SHOW server_version_num").to_i == 150_003, "PostgreSQL 15.3 required")
    true
  end
end
AdmissionLab.singleton_class.prepend(IntegratedPGVersion)

module Settings
  def self.temporal = OpenStruct.new(enabled: true)
end

# Synthetic authorization, session model, manifest and registry. There is no
# container, tenant or agent launch in this slice. Admission/relay are unmodified.
class SessionService
  def self.revalidate_admission!(session, refresh_tokens:)
    IntegratedLab.assert!(session.is_a?(TerminalSession) && refresh_tokens, "lab authorization boundary")
    true
  end
end
class TerminalSession
  def workflow_id = "#{ENV.fetch('F0_INTEGRATED_NAMESPACE')}-session-#{id}"
end
class TemporalWorkflowRegistry
  def self.container_workflow_v2
    Struct.new(:name, :owner).new("integrated_idle_workflow", ENV.fetch("F0_INTEGRATED_NAMESPACE"))
  end
end
module Workflows; end
require File.join(AdmissionLab::ROOT, "app/temporal/workflows/base")
module Workflows
  class IntegratedIdleWorkflow < Base
    def run(input)
      raise "missing lab permit" unless input.permit_token && input.admission_id && input.manifest.lab
      Temporalio::Workflow.wait_condition { false }
    end
  end
end
