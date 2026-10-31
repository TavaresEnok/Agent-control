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
  GENERIC_ERROR_MESSAGES = [LAUNCH_ABANDONED_ERROR].freeze
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
