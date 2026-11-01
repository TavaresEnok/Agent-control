# frozen_string_literal: true

require "test_helper"

class AcSharedCapacityReconciliationTest < ActiveSupport::TestCase
  self.use_transactional_tests = false
  prepend IsolatedAcDatabase

  class LostResponseBroker
    attr_reader :reservations, :reserve_calls

    def initialize
      @reservations = {}
      @reserve_calls = 0
    end

    def get!(operation_id:, account_key:)
      reservations.fetch(operation_id, { "state" => "not_found" }).dup
    end

    def reserve!(operation_id:, account_key:, quantity:, epoch:)
      @reserve_calls += 1
      reservations[operation_id] = { "state" => "reserved", "quantity" => quantity, "epoch" => epoch.to_s }
      raise AcCapacityBrokerClient::UncertainError, "response lost"
    end
  end

  setup do
    @old_identities = Rails.application.config.try(:ac_capacity_account_identities)
    @old_settings = Rails.application.config.try(:ac_capacity_broker_client_settings)
    @old_client = Rails.application.config.try(:ac_capacity_broker_client)
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(company: @company, project: @project, external_id: SecureRandom.uuid, title: "Context")
    @plan = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Plan", version: 1, state: :draft)
    @task = AcTask.create!(company: @company, project: @project, ac_plan: @plan, task_key: "task", title: "Task")
    @credential = create(:agent_credential, company: @company, user: @user, agent_type: "claude_code")
    @policy = AcPolicyRevision.create!(company: @company, revision_number: 1, content_hash: SecureRandom.hex(32), state: :draft,
      content: { "model_chain" => [ "test-model" ], "effort_limits" => {}, "active_accounts" => [], "chain_rules" => [] })
    @profile = AcExecutionProfile.create!(company: @company, ac_policy_revision: @policy, agent_credential: @credential,
      profile_key: "test", role: :programmer, cli_adapter: :claude_code, model_id: "test-model", effort_level: :medium,
      chain_position: 1, selection_criteria: { "eligibility" => { "status" => "documented_supported", "model_id" => "test-model",
        "cli_adapter" => "claude_code", "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 } })
    raise "Policy publication failed" unless @policy.publish!(by_user: @user)
    AcQuotaObservation.create!(company: @company, agent_credential: @credential, cli_adapter: "claude_code", model_scope: "test-model",
      quota_state: :available, confidence_level: :high, origin: :manual_import, observed_at: Time.current, valid_until: 1.hour.from_now)
    key = "sha256:#{SecureRandom.hex(32)}"
    Rails.application.config.ac_capacity_account_identities = { @credential.id => { "ownership" => "shared", "account_key" => key, "authority_id" => "authority" } }
    settings = ActiveSupport::OrderedOptions.new
    settings.installation_id = "host"
    settings.authority_id = "authority"
    Rails.application.config.ac_capacity_broker_client_settings = settings
    @broker = LostResponseBroker.new
    Rails.application.config.ac_capacity_broker_client = @broker
  end

  teardown do
    Rails.application.config.ac_capacity_account_identities = @old_identities
    Rails.application.config.ac_capacity_broker_client_settings = @old_settings
    Rails.application.config.ac_capacity_broker_client = @old_client
  end

  test "a lost reserve response is reconciled with the same operation" do
    args = { task: @task, profile: @profile, operation_id: "lost-response", epoch: "1" }
    assert_raises(AcSharedCapacityAuthorityService::Uncertain) { AcSharedCapacityAuthorityService.prepare!(**args) }
    assert_equal "prepared", AcSharedCapacityIntent.find_by!(operation_id: "lost-response").state
    assert_equal "reserved", AcSharedCapacityAuthorityService.prepare!(**args).state
    assert_equal 1, @broker.reserve_calls
    assert_equal 1, AcSharedCapacityIntent.where(operation_id: "lost-response").count
  end
end
