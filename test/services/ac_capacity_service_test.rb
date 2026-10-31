# frozen_string_literal: true

require "test_helper"

class AcCapacityServiceTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @credential = create(:agent_credential, company: @company, user: @user, agent_type: "codex")
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-cap-svc",
      title: "Capacity context",
      state: :active,
      origin: :new
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "cap-plan",
      version: 1,
      title: "Cap Plan",
      objective: "Test cap service",
      state: :draft
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-cap-01",
      title: "Cap task",
      position: 1,
      state: :pending
    )
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_cap_pol",
      content: {
        "model_chain" => ["gpt-5.2"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :published,
      apply_mode: :next_attempts
    )
    @profile = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-cap-svc",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :medium,
      chain_position: 1,
      state: :active,
      agent_credential: @credential
    )
  end

  test "grants and releases capacity with audit trail" do
    result = AcCapacityService.grant!(
      task: @task,
      profile: @profile,
      operation_id: "op-service-test-1",
      epoch: "epoch-100",
      expires_in: 15.minutes
    )

    assert result.success?
    assert_not_nil result.grant
    assert result.grant.granted?

    audit = AcDecisionAuditEvent.where(event_type: "capacity_granted", execution_epoch: "epoch-100").last
    assert_not_nil audit
    assert_equal 1, audit.decision_details["quantity"]

    # Liberar capacidade
    assert AcCapacityService.release!(grant: result.grant)
    assert result.grant.reload.released?
  end

  test "reaps expired capacity grants" do
    grant = AcCapacityGrant.create!(
      company: @company,
      ac_task: @task,
      ac_execution_profile: @profile,
      agent_credential: @credential,
      operation_id: "op-expired-grant",
      epoch: "epoch-exp",
      state: :granted,
      quantity: 1,
      resource_type: :inference_slot,
      policy_revision_id: @policy.id,
      policy_revision_number: 1,
      granted_at: 1.hour.ago,
      expires_at: 10.minutes.ago
    )

    svc = AcCapacityService.new(company: @company, project: @project)
    reaped = svc.reap_expired!

    assert_equal 1, reaped
    assert grant.reload.expired?
  end
end
