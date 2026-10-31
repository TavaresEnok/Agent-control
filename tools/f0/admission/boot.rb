# frozen_string_literal: true

require_relative "guard"
AdmissionLab.config! # Before Bundler, imports or any SQL.
raise "Ruby 4.0.9 required" unless RUBY_VERSION == "4.0.9"
require "bundler/setup"
require "active_record"
require "active_support/core_ext"
require "logger"
require "ostruct"
require "hashie"
require "securerandom"
require "timeout"
require "temporalio/client"
require "temporalio/activity"

module AdmissionLab
  ROOT = File.expand_path("../../..", __dir__)
  SCHEMA = "f0_admission_#{SecureRandom.hex(8)}"
  IMPORTS = %w[
    app/models/application_record.rb
    app/models/concerns/tenant_columns.rb
    app/models/session_concurrency_limit.rb
    app/models/session_admission_policy.rb
    app/models/session_admission_pool.rb
    app/models/session_admission.rb
    app/models/session_runtime_operation.rb
    app/services/billing/effective_capacity.rb
    app/services/session_admission_budget.rb
    app/services/session_admission_service.rb
    app/services/session_launch_relay.rb
    app/services/session_admission_reconciler.rb
    app/temporal/temporal_input.rb
    app/temporal/activities/base.rb
    app/temporal/activities/container/admitted_phase_activity.rb
  ].freeze
  MIGRATIONS = %w[
    20260905120000_create_session_admissions
    20260917180000_drop_installation_limit_from_session_admission_policies
    20260918090000_add_absent_since_to_session_runtime_operations
    20260923140200_add_launch_attempts_to_session_admissions
    20260925140000_always_enable_session_admission
  ].freeze

  def self.cleanup!
    return unless @created
    ActiveRecord::Base.connection.execute("DROP SCHEMA #{SCHEMA} CASCADE")
    ActiveRecord::Base.connection_pool.disconnect!
    @created = false
  end

  def self.prepare!
    ActiveRecord::Base.establish_connection(config!)
    c = ActiveRecord::Base.connection
    verify!(c)
    c.execute("CREATE SCHEMA #{SCHEMA}")
    @created = true
    # New connections (including competing drain threads) use the same schema.
    ActiveRecord::Base.establish_connection(config!.merge(schema_search_path: SCHEMA))
    ActiveRecord::Migration.verbose = false
    ActiveRecord::Schema.define do
      create_table(:companies) { |t| t.string :billing_state }
      create_table(:projects) { |t| t.bigint :company_id }
      create_table(:terminal_sessions) do |t|
        t.bigint :user_id
        t.bigint :project_id
        t.string :state, default: "not_started"
        t.string :temporal_workflow_id
        t.string :temporal_run_id
        t.string :container_id
        t.text :error_message
        t.datetime :started_at
        t.datetime :finished_at
        t.datetime :finishing_at
        t.datetime :ready_at
        t.timestamps
      end
      create_table(:workflow_runs) { |t| t.string :state }
      create_table(:step_runs) do |t|
        t.bigint :workflow_run_id
        t.bigint :terminal_session_id
        t.string :state
      end
    end
    MIGRATIONS.each do |name|
      require File.join(ROOT, "db/migrate", name)
      name.sub(/\A\d+_/, "").camelize.constantize.new.migrate(:up)
    end
  end
end

require File.join(AdmissionLab::ROOT, "app/models/application_record")
require_relative "boundaries"
module Activities; end
AdmissionLab::IMPORTS.drop(1).each { |path| require File.join(AdmissionLab::ROOT, path) }
