# frozen_string_literal: true

require "test_helper"

class AcPolicyEngineServiceTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @cred1 = create(:agent_credential, company: @company, user: @user, agent_type: "claude_code")
    @cred2 = create(:agent_credential, company: @company, user: @user, agent_type: "codex")
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-engine-test",
      title: "Engine context",
      state: :active,
      origin: :new
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "engine-plan",
      version: 1,
      title: "Engine Plan",
      objective: "Test policy engine",
      state: :draft
    )
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_engine_pol",
      content: {
        "model_chain" => [ "claude-sonnet-4.6", "gpt-5.2" ],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :draft,
      apply_mode: :next_attempts
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-engine-01",
      title: "Delivery task",
      position: 1,
      state: :pending,
      assigned_role: :programmer,
      risk_class: :medium
    )
    @prof1 = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-primary",
      role: :programmer,
      cli_adapter: :claude_code,
      model_id: "claude-sonnet-4.6",
      effort_level: :medium,
      chain_position: 1,
      state: :active,
      agent_credential: @cred1
    )
    @prof2 = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-fallback",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :medium,
      chain_position: 2,
      state: :active,
      agent_credential: @cred2
    )
  end

  test "selects first eligible profile in substitution chain and audits decision" do
    publish_engine_policy!
    result = AcPolicyEngineService.select_profile_for_task(task: @task)

    assert result.success?
    assert_equal @prof1, result.profile
    assert_empty result.rejected_profiles

    # Verifica auditoria explicável (G1)
    audit = AcDecisionAuditEvent.for_task(@task).where(event_type: "profile_selected").last
    assert_not_nil audit
    assert_equal "prof-primary", audit.decision_details.dig("selected_profile", "profile_key")
  end

  test "skips candidate with exhausted quota and selects fallback" do
    # Simula cota esgotada na credencial 1
    AcQuotaObservation.create!(
      company: @company,
      agent_credential: @cred1,
      cli_adapter: "claude_code",
      model_scope: "claude-sonnet-4.6",
      quota_state: :exhausted,
      confidence_level: :high,
      origin: :cli_output,
      observed_at: Time.current,
      valid_until: 1.hour.from_now
    )

    publish_engine_policy!
    result = AcPolicyEngineService.select_profile_for_task(task: @task)

    assert result.success?
    assert_equal @prof2, result.profile
    assert_equal 1, result.rejected_profiles.length
    assert_equal @prof1, result.rejected_profiles.first[:profile]
    assert_includes result.rejected_profiles.first[:reason], "Cota indisponível"

    # Verifica que houve auditoria de rejeição e de seleção
    rejection_audit = AcDecisionAuditEvent.for_task(@task).where(event_type: "profile_rejected").last
    assert_not_nil rejection_audit
    assert_equal "prof-primary", rejection_audit.decision_details.dig("rejected_profile", "profile_key")

    selection_audit = AcDecisionAuditEvent.for_task(@task).where(event_type: "profile_selected").last
    assert_not_nil selection_audit
    assert_equal "prof-fallback", selection_audit.decision_details.dig("selected_profile", "profile_key")
  end

  test "rejects low effort on high risk task (RF-18)" do
    @prof1.update!(effort_level: :low)
    @prof2.update!(effort_level: :low)
    @task.update!(risk_class: :high)

    publish_engine_policy!
    result = AcPolicyEngineService.select_profile_for_task(task: @task)

    assert_not result.success?
    assert_nil result.profile
    assert_equal 2, result.rejected_profiles.length
    assert_includes result.rejected_profiles.first[:reason], "exige esforço superior a 'low'"
  end
  private

  def publish_engine_policy!
    [ @prof1, @prof2 ].each do |profile|
      profile.update!(selection_criteria: { "eligibility" => { "status" => "documented_supported",
        "model_id" => profile.model_id, "cli_adapter" => profile.cli_adapter.to_s,
        "efforts" => [ profile.effort_level.to_s ], "valid_until" => 1.hour.from_now.iso8601 } })
      next if AcQuotaObservation.where(agent_credential: profile.agent_credential, quota_state: "exhausted").exists?

      AcQuotaObservation.create!(company: @company, agent_credential: profile.agent_credential,
        cli_adapter: profile.cli_adapter, model_scope: profile.model_id, quota_state: :available,
        confidence_level: :high, origin: :manual_import, observed_at: Time.current, valid_until: 1.hour.from_now)
    end
    raise "Policy publication failed" unless @policy.publish!(by_user: @user)
  end
end
