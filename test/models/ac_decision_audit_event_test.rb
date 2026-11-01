# frozen_string_literal: true

require "test_helper"

class AcDecisionAuditEventTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-audit",
      title: "Audit context",
      state: :active,
      origin: :new
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "audit-plan",
      version: 1,
      title: "Audit Plan",
      objective: "Test audit events",
      state: :draft
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-audit-01",
      title: "Audit task",
      position: 1,
      state: :pending
    )
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_audit_pol",
      content: {
        "model_chain" => [ "claude-sonnet-4.6" ],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :draft,
      apply_mode: :next_attempts
    )
    @profile = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-audit-test",
      role: :programmer,
      cli_adapter: :claude_code,
      model_id: "claude-sonnet-4.6",
      effort_level: :medium,
      chain_position: 1,
      state: :active
    )
  end

  test "enforces append-only immutability (RF-31)" do
    event = AcDecisionAuditEvent.create!(
      company: @company,
      project: @project,
      event_type: "quota_state_changed",
      actor_type: "system",
      occurred_at: Time.current,
      reason: "Cota restabelecida"
    )

    event.reason = "Tentativa de alteração"
    assert_not event.save
    assert_includes event.errors[:base], "AcDecisionAuditEvent é append-only e não pode ser atualizado"

    assert_not event.destroy
    assert_includes event.errors[:base], "AcDecisionAuditEvent é append-only e não pode ser excluído"
  end

  test "requires non-empty decision_details for profile decisions (critério G1)" do
    event = AcDecisionAuditEvent.new(
      company: @company,
      project: @project,
      event_type: "profile_selected",
      actor_type: "policy_service",
      occurred_at: Time.current,
      decision_details: {}
    )
    assert_not event.valid?
    assert_includes event.errors[:decision_details], "não pode ser vazio para eventos de decisão de perfil (critério G1)"
  end

  test "record_profile_selection! creates explainable event" do
    event = AcDecisionAuditEvent.record_profile_selection!(
      company: @company,
      project: @project,
      task: @task,
      profile: @profile,
      policy_revision: @policy,
      reason: "Melhor perfil elegível",
      alternatives_considered: [ { "profile_key" => "prof-other", "reason" => "cota esgotada" } ]
    )

    assert_not_nil event
    assert_equal "profile_selected", event.event_type
    assert_equal "Melhor perfil elegível", event.reason
    assert_equal "prof-audit-test", event.decision_details.dig("selected_profile", "profile_key")
    assert_equal 1, event.decision_details["alternatives_considered"].length

    explanation = event.explain
    assert_equal "profile_selected", explanation[:event_type]
    assert_equal "Melhor perfil elegível", explanation[:reason]
  end

  test "record_profile_rejection! records rejection reason" do
    event = AcDecisionAuditEvent.record_profile_rejection!(
      company: @company,
      project: @project,
      task: @task,
      profile: @profile,
      policy_revision: @policy,
      rejection_reason: "Cota diária esgotada na conta OpenAI"
    )

    assert_not_nil event
    assert_equal "profile_rejected", event.event_type
    assert_equal "Cota diária esgotada na conta OpenAI", event.reason
    assert_equal "Cota diária esgotada na conta OpenAI", event.decision_details["rejection_reason"]
  end

  test "record_human_intervention! records operator action (RF-09)" do
    event = AcDecisionAuditEvent.record_human_intervention!(
      company: @company,
      project: @project,
      task: @task,
      user: @user,
      action: "pause_execution",
      reason: "Intervenção manual para validação de custos"
    )

    assert_not_nil event
    assert_equal "human_intervention", event.event_type
    assert_equal "human", event.actor_type
    assert_equal @user, event.actor_user
    assert_equal "pause_execution", event.decision_details["action"]
    assert_equal @user.email, event.decision_details["user_email"]
  end
end
