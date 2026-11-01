# frozen_string_literal: true

module AcTemporalFixture
  include AcCapacityIdentityFixture

  def setup_ac_temporal_fixture
    @previous_runtime_supervisor = Rails.application.config.try(:ac_runtime_supervisor)
    Rails.application.config.ac_runtime_supervisor = FakeAcRuntimeSupervisor.new
    @company = create(:company, name: "Temporal #{SecureRandom.uuid}", email_domain: "#{SecureRandom.hex(8)}.example")
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(company: @company, project: @project, title: "Context",
      external_id: SecureRandom.uuid)
    @plan = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Plan", objective: "Controlled test", version: 1)
    @task = AcTask.create!(company: @company, project: @project, ac_plan: @plan,
      task_key: SecureRandom.uuid, title: "Task", scope: "Controlled test", assigned_role: "programmer")
    @credential = create(:agent_credential, user: @user, company: @company, agent_type: "codex")
    configure_capacity_identity(@credential)
    @policy = AcPolicyRevision.create!(company: @company, revision_number: 1,
      content_hash: SecureRandom.hex(32), state: "draft",
      content: { "model_chain" => [ "gpt-5.2" ], "effort_limits" => { "max" => "high" },
        "active_accounts" => [], "chain_rules" => [] })
    @profile = AcExecutionProfile.create!(company: @company, ac_policy_revision: @policy,
      profile_key: "programmer", role: "programmer", cli_adapter: "codex_cli", model_id: "gpt-5.2",
      effort_level: "medium", agent_credential: @credential, chain_position: 1,
      selection_criteria: { "eligibility" => { "status" => "documented_supported", "model_id" => "gpt-5.2",
        "cli_adapter" => "codex_cli", "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 } })
    raise "Policy publication failed" unless @policy.publish!(by_user: @user)
    raise "Plan publication failed: #{@plan.errors.full_messages.join(', ')}" unless @plan.publish!(policy_revision: @policy)
    AcQuotaObservation.create!(company: @company, agent_credential: @credential, cli_adapter: "codex_cli",
      model_scope: "gpt-5.2", quota_state: "available", confidence_level: "high", origin: "api_header",
      observed_at: Time.current, valid_until: 1.hour.from_now)
  end

  def teardown_ac_temporal_fixture
    Rails.application.config.ac_runtime_supervisor = @previous_runtime_supervisor
    restore_capacity_identity
  end

  def admit_ac_execution(epoch: "1", operation_id: SecureRandom.uuid)
    AcAdmissionService.admit_execution!(task: @task, operation_id: operation_id,
      requested_by: "test", execution_profile: @profile, epoch: epoch)[:execution]
  end
end
