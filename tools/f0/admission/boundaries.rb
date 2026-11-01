# frozen_string_literal: true

# Explicit lab boundaries, NOT imported product models. All their rows are SQL.
# No admission, claim, ledger or reconciliation algorithm lives here.
module Rails
  def self.logger = @logger ||= Logger.new($stderr, level: Logger::WARN)
end

module Settings
  def self.session_admission
    OpenStruct.new(project_default: 2, pinned_release_enabled: true, pinned_release_confirmation_minutes: 5)
  end
end

module Deployment
  def self.saas? = false
end

class Project < ApplicationRecord; end
class Company < ApplicationRecord; end
class WorkflowRun < ApplicationRecord
  has_many :step_runs
end
class StepRun < ApplicationRecord
  belongs_to :workflow_run
end

class TerminalSession < ApplicationRecord
  TERMINAL_STATES = %w[finished failed cancelled].freeze
  WORKFLOW_TIMEOUT = 86_400
  LAUNCH_ABANDONED_ERROR = "Lab launch abandoned"
  GENERIC_ERROR_MESSAGES = [ LAUNCH_ABANDONED_ERROR ].freeze
  has_one :session_admission
  has_one :step_run
  def enqueue! = update!(state: "queued")
  def cancel! = update!(state: "cancelled")
  def fail! = update!(state: "failed")
  def workflow_id = "f0-admission-sql-session-#{id}"
  def strategy = OpenStruct.new(build_manifest: { lab: true })
  def finished? = state == "finished"
  def cancelled? = state == "cancelled"
  def failed? = state == "failed"
  def sync_usage; end
  def notify_workflow_execution_if_step_session; end
  def self.preferred_error_message(existing, incoming) = incoming.presence || existing
end

module Oauth
  class PreflightError < StandardError; end
end
module CloudAuth
  class PreflightError < StandardError; end
end
class AgentCredential
  class PreflightError < StandardError; end
end
# This SQL-only lab has no Agent Control accounts, grants or broker tables.
# Refuse the simulation if that isolation changes; it is not a capacity broker.
class AcLocalCapacityAuthorityService
  FORBIDDEN_TABLES = %w[agent_credentials ac_capacity_grants ac_shared_capacity_intents ac_capacity_broker_reservations].freeze

  def self.assert_isolated!
    connection = ActiveRecord::Base.connection
    isolated = connection.select_value("SELECT current_schema()") == AdmissionLab::SCHEMA
    isolated &&= connection.tables.none? { |table| table.start_with?("ac_") }
    absent = FORBIDDEN_TABLES.none? do |table|
      connection.select_value("SELECT to_regclass(#{connection.quote(table)})").present?
    end
    raise "Isolated capacity boundary violated" unless isolated && absent
  end

  def self.permit_legacy_session?(session)
    assert_isolated!
    raise "Invalid lab session" unless session.is_a?(TerminalSession) && session.persisted?

    true
  end
end

# The production budget queries AC grants. This deliberately narrow substitute
# represents zero AC fixtures, not an SQL test of grants or the shared broker.
class AcCapacityGrant
  def self.active_or_granted = EmptyGrantScope.new(:active)

  class EmptyGrantScope
    def initialize(stage) = @stage = stage

    def joins(value)
      raise ArgumentError, "Unexpected grant join" unless @stage == :active && value == :ac_task
      self.class.new(:joined)
    end

    def group(value)
      raise ArgumentError, "Unexpected grant group" unless @stage == :joined && value == "ac_tasks.project_id"
      self.class.new(:grouped)
    end

    def where(value)
      project_id = value.dig(:ac_tasks, :project_id) if value.is_a?(Hash) && value.keys == [ :ac_tasks ] && value[:ac_tasks].is_a?(Hash) && value[:ac_tasks].keys == [ :project_id ]
      raise ArgumentError, "Unexpected grant filter" unless @stage == :joined && project_id.is_a?(String) && project_id.match?(/\A[1-9]\d*\z/)
      self.class.new(:filtered)
    end

    def sum(value)
      raise ArgumentError, "Unexpected grant sum" unless %i[grouped filtered].include?(@stage) && value == :quantity
      AcLocalCapacityAuthorityService.assert_isolated!
      @stage == :grouped ? {} : 0
    end
  end
end

class SessionService
  class UnsafeMcpUrlError < StandardError; end
  def self.revalidate_admission!(*, **)
    raise "Transport boundary must be explicitly stubbed"
  end
end
if defined?(AdmissionLab::REAL_TEMPORAL) && AdmissionLab::REAL_TEMPORAL == true
  # Only the integrated entrypoint opts in before importing this file. The SQL
  # suite retains its closed transport and all nine original tests unchanged.
  require File.join(AdmissionLab::ROOT, "app/services/temporal_service")
else
  class TemporalService
    def self.start_workflow(*) = raise("Real Temporal transport is not configured by this SQL harness")
    def self.enabled? = raise("Explicit transport stub required")
    def self.client = raise("Explicit transport stub required")
    def self.cancel_workflow(*) = raise("Explicit transport stub required")
  end
end
class TemporalWorkflowRegistry
  def self.container_workflow_v2 = "LabContainerWorkflowV2"
end
module ContainerRuntime
  def self.build = raise("Explicit runtime observation stub required")
end
