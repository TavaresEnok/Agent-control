# frozen_string_literal: true

class AcSafetySupervisorFake
  attr_reader :receipts
  attr_accessor :on_status

  def initialize
    @receipts = {}
  end

  def dispatch!(execution:, **)
    on_status&.call
    receipts.fetch(execution.id).deep_dup
  end

  alias status! dispatch!

  def verify_receipt!(execution:, receipt:)
    receipt == receipts[execution.id]
  end
end

module AcSafetyFixtures
  extend ActiveSupport::Concern
  included do
  setup do
    @previous_supervisor = Rails.application.config.try(:ac_runtime_supervisor)
    @previous_accounts = Rails.application.config.try(:ac_local_capacity_accounts)
    @previous_identities = Rails.application.config.try(:ac_capacity_account_identities)
    @previous_authority_id = Rails.application.config.try(:ac_capacity_authority_id)
    @supervisor = AcSafetySupervisorFake.new
    Rails.application.config.ac_runtime_supervisor = @supervisor
    @company = create(:company, name: "Safety #{SecureRandom.uuid}", email_domain: "#{SecureRandom.hex(8)}.example")
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(company: @company, project: @project, external_id: SecureRandom.uuid, title: "Safety")
    @plan = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Safety", version: 1, state: :draft)
    @task = AcTask.create!(company: @company, project: @project, ac_plan: @plan,
      task_key: "implementation", title: "Safety", scope: "Safe change", risk_class: :low)
    @credential = create(:agent_credential, company: @company, user: @user, agent_type: "claude_code")
    @policy = AcPolicyRevision.create!(company: @company, revision_number: 1, content_hash: SecureRandom.hex(32),
      state: :draft, content: { "model_chain" => [ "claude-test" ], "active_accounts" => [], "chain_rules" => [], "effort_limits" => {} })
    @profiles = %w[programmer reviewer qa].index_with do |role|
      AcExecutionProfile.create!(company: @company, ac_policy_revision: @policy, profile_key: role,
        role: role, cli_adapter: :claude_code, model_id: "claude-test", agent_credential: @credential,
        effort_level: :medium, chain_position: 1, selection_criteria: { "eligibility" => {
          "status" => "documented_supported", "model_id" => "claude-test", "cli_adapter" => "claude_code",
          "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 } })
    end
    raise "Safety policy publication failed: #{@policy.errors.full_messages}" unless @policy.publish!(by_user: @user)
    raise "Safety plan publication failed: #{@plan.errors.full_messages}" unless @plan.publish!(policy_revision: @policy)
    Rails.application.config.ac_capacity_authority_id = "test-authority"
    Rails.application.config.ac_capacity_account_identities = {
      @credential.id => { "account_key" => "sha256:#{Digest::SHA256.hexdigest("fixture-#{@credential.id}")}",
        "authority_id" => "test-authority", "ownership" => "exclusive_local" }
    }
    Rails.application.config.ac_local_capacity_accounts = {
      AcLocalCapacityAuthorityService.account_key(@credential) => { "mode" => "local", "limit" => 10 }
    }
    AcQuotaObservation.create!(company: @company, agent_credential: @credential, cli_adapter: "claude_code",
      model_scope: "claude-test", quota_state: :available, confidence_level: :high, origin: :api_header,
      observed_at: Time.current, valid_until: 1.hour.from_now)
  end

  teardown do
    Rails.application.config.ac_runtime_supervisor = @previous_supervisor
    Rails.application.config.ac_local_capacity_accounts = @previous_accounts
    Rails.application.config.ac_capacity_account_identities = @previous_identities
    Rails.application.config.ac_capacity_authority_id = @previous_authority_id
  end
  end
end
