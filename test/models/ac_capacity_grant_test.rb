# frozen_string_literal: true

require "test_helper"

class AcCapacityGrantTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @credential = create(:agent_credential, company: @company, user: @user, agent_type: "claude_code")
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-grants",
      title: "Grant context",
      state: :active,
      origin: :new
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "grant-plan",
      version: 1,
      title: "Grant Plan",
      objective: "Test grants",
      state: :draft
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-grant-01",
      title: "Grant task",
      position: 1,
      state: :pending
    )
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_grant_pol",
      content: {
        "model_chain" => ["claude-sonnet-4.6"],
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
      profile_key: "prof-grant-test",
      role: :programmer,
      cli_adapter: :claude_code,
      model_id: "claude-sonnet-4.6",
      effort_level: :medium,
      chain_position: 1,
      state: :active,
      agent_credential: @credential
    )
  end

  test "grant_atomically! creates granted capacity (RF-13)" do
    grant = AcCapacityGrant.grant_atomically!(
      company: @company,
      ac_task: @task,
      ac_execution_profile: @profile,
      agent_credential: @credential,
      operation_id: "op-1001",
      epoch: "epoch-20261031-1",
      policy_revision_id: @policy.id,
      policy_revision_number: @policy.revision_number,
      quantity: 1,
      resource_type: :inference_slot
    )

    assert_not_nil grant
    assert grant.granted?
    assert_equal "op-1001", grant.operation_id
    assert_equal "epoch-20261031-1", grant.epoch
    assert_equal 1, grant.quantity
    assert_not_nil grant.expires_at
  end

  test "idempotent grant for same operation_id (§11.3)" do
    g1 = AcCapacityGrant.grant_atomically!(
      company: @company,
      ac_task: @task,
      ac_execution_profile: @profile,
      agent_credential: @credential,
      operation_id: "op-idempotent",
      epoch: "epoch-1",
      policy_revision_id: @policy.id,
      policy_revision_number: @policy.revision_number
    )

    g2 = AcCapacityGrant.grant_atomically!(
      company: @company,
      ac_task: @task,
      ac_execution_profile: @profile,
      agent_credential: @credential,
      operation_id: "op-idempotent",
      epoch: "epoch-1",
      policy_revision_id: @policy.id,
      policy_revision_number: @policy.revision_number
    )

    assert_equal g1.id, g2.id
  end

  test "lifecycle transitions: activate, release, expire, revoke" do
    grant = AcCapacityGrant.create!(
      company: @company,
      ac_task: @task,
      ac_execution_profile: @profile,
      agent_credential: @credential,
      operation_id: "op-lifecycle",
      epoch: "epoch-life",
      state: :granted,
      quantity: 1,
      resource_type: :inference_slot,
      policy_revision_id: @policy.id,
      policy_revision_number: 1,
      granted_at: Time.current,
      expires_at: 30.minutes.from_now
    )

    grant.activate!
    assert grant.active?

    grant.release!
    assert grant.released?
    assert_not_nil grant.released_at

    grant.update!(state: :granted)
    grant.revoke!(reason: "Abortado pelo operador")
    assert grant.revoked?
    assert_equal "Abortado pelo operador", grant.revoke_reason
  end

  test "epoch_valid? verifies execution epoch (§11.3)" do
    grant = AcCapacityGrant.new(epoch: "epoch-valid-99")
    assert grant.epoch_valid?("epoch-valid-99")
    assert_not grant.epoch_valid?("epoch-stale-00")
  end
end
