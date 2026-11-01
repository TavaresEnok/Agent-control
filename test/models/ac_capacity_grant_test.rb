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
        "model_chain" => [ "claude-sonnet-4.6" ],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :draft,
      apply_mode: :next_attempts
    )
    @previous_capacity_accounts = Rails.application.config.try(:ac_local_capacity_accounts)
    @previous_identities = Rails.application.config.try(:ac_capacity_account_identities)
    @previous_authority_id = Rails.application.config.try(:ac_capacity_authority_id)
    Rails.application.config.ac_capacity_authority_id = "test-authority"
    Rails.application.config.ac_capacity_account_identities = {
      @credential.id => { "account_key" => "sha256:#{Digest::SHA256.hexdigest("fixture-#{@credential.id}")}",
        "authority_id" => "test-authority", "ownership" => "exclusive_local" }
    }
    Rails.application.config.ac_local_capacity_accounts = {
      AcLocalCapacityAuthorityService.account_key(@credential) => { "mode" => "local", "limit" => 1 }
    }
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

  def teardown
    Rails.application.config.ac_local_capacity_accounts = @previous_capacity_accounts
    Rails.application.config.ac_capacity_account_identities = @previous_identities
    Rails.application.config.ac_capacity_authority_id = @previous_authority_id
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

    assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) { grant.release! }
    assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) { grant.expire! }
    assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) { grant.revoke!(reason: "operator") }
    assert grant.reload.active?
  end

  test "epoch_valid? verifies execution epoch (§11.3)" do
    grant = AcCapacityGrant.new(epoch: "epoch-valid-99")
    assert grant.epoch_valid?("epoch-valid-99")
    assert_not grant.epoch_valid?("epoch-stale-00")
  end
  test "local account reservation enforces its limit and rejects mismatched retries" do
    arguments = { company: @company, ac_task: @task, ac_execution_profile: @profile,
      agent_credential: @credential, operation_id: "op-limit", epoch: "1",
      policy_revision_id: @policy.id, policy_revision_number: @policy.revision_number }
    grant = AcCapacityGrant.grant_atomically!(**arguments)
    assert_equal grant.id, AcCapacityGrant.grant_atomically!(**arguments).id
    assert_raises(AcCapacityGrant::LimitExceededError) do
      AcCapacityGrant.grant_atomically!(**arguments.merge(operation_id: "op-second"))
    end
    assert_raises(AcCapacityGrant::LimitExceededError) do
      AcCapacityGrant.grant_atomically!(**arguments.merge(epoch: "2"))
    end
    assert_equal 1, AcCapacityGrant.where(operation_id: [ "op-limit", "op-second" ]).count
  end

  test "aliases of the same attested account share one capacity limit" do
    alias_credential = create(:agent_credential, company: @company, user: @user,
      agent_type: "claude_code", account_slug: "other-account-alias")
    Rails.application.config.ac_capacity_account_identities[alias_credential.id] =
      Rails.application.config.ac_capacity_account_identities.fetch(@credential.id).dup
    alias_profile = AcExecutionProfile.create!(company: @company, ac_policy_revision: @policy,
      profile_key: "alias-profile", role: :programmer, cli_adapter: :claude_code,
      model_id: "claude-sonnet-4.6", agent_credential: alias_credential)
    args = { company: @company, ac_task: @task, ac_execution_profile: @profile, agent_credential: @credential,
      operation_id: "alias-first", epoch: "1", policy_revision_id: @policy.id, policy_revision_number: @policy.revision_number }
    AcCapacityGrant.grant_atomically!(**args)
    assert_raises(AcCapacityGrant::LimitExceededError) do
      AcCapacityGrant.grant_atomically!(**args.merge(operation_id: "alias-second",
        ac_execution_profile: alias_profile, agent_credential: alias_credential))
    end
  end

  test "unattested or other-host account cannot reserve locally" do
    identity = Rails.application.config.ac_capacity_account_identities.fetch(@credential.id)
    identity["authority_id"] = "another-host"
    assert_raises(AcCapacityGrant::LimitExceededError) { AcLocalCapacityAuthorityService.account_key(@credential) }
    identity["authority_id"] = "test-authority"
    identity["ownership"] = "shared"
    assert_raises(AcCapacityGrant::LimitExceededError) { AcLocalCapacityAuthorityService.account_key(@credential) }
    Rails.application.config.ac_capacity_account_identities.delete(@credential.id)
    assert_raises(AcCapacityGrant::LimitExceededError) { AcLocalCapacityAuthorityService.account_key(@credential) }
  end

  test "changing an identity with a live grant requires reconciliation" do
    args = { company: @company, ac_task: @task, ac_execution_profile: @profile, agent_credential: @credential,
      operation_id: "identity-before", epoch: "1", policy_revision_id: @policy.id, policy_revision_number: @policy.revision_number }
    AcCapacityGrant.grant_atomically!(**args)
    identity = Rails.application.config.ac_capacity_account_identities.fetch(@credential.id)
    identity["account_key"] = "sha256:#{Digest::SHA256.hexdigest("different")}"
    Rails.application.config.ac_local_capacity_accounts[identity["account_key"]] = { "mode" => "local", "limit" => 1 }
    assert_raises(AcCapacityGrant::LimitExceededError) { AcCapacityGrant.grant_atomically!(**args.merge(operation_id: "identity-after")) }
    assert_raises(AcCapacityGrant::LimitExceededError) { AcCapacityGrant.grant_atomically!(**args) }
  end

  test "shared accounts cannot use a local-only reservation" do
    Rails.application.config.ac_local_capacity_accounts[AcLocalCapacityAuthorityService.account_key(@credential)]["mode"] = "shared"
    assert_raises(AcCapacityGrant::LimitExceededError) do
      AcCapacityGrant.grant_atomically!(company: @company, ac_task: @task, ac_execution_profile: @profile,
        agent_credential: @credential, operation_id: "op-shared", epoch: "1",
        policy_revision_id: @policy.id, policy_revision_number: @policy.revision_number)
    end
  end

  test "legacy session cannot take an account slot held by Agent Control" do
    AcCapacityGrant.grant_atomically!(company: @company, ac_task: @task, ac_execution_profile: @profile,
      agent_credential: @credential, operation_id: "op-legacy-blocked", epoch: "1",
      policy_revision_id: @policy.id, policy_revision_number: @policy.revision_number)
    session = create(:terminal_session, user: @user, project: @project, company: @company,
      agent_type: @credential.agent_type, session_config: { "agent_credential_id" => @credential.id })
    admission = SessionAdmissionService.enqueue!(session)
    assert_empty SessionAdmissionService.drain!
    assert_nil admission.reload.admitted_at
  end

  test "Agent Control cannot take an account slot held by a legacy session" do
    session = create(:terminal_session, user: @user, project: @project, company: @company,
      agent_type: @credential.agent_type, session_config: { "agent_credential_id" => @credential.id })
    admission = SessionAdmissionService.enqueue!(session)
    assert_includes SessionAdmissionService.drain!, admission.id
    assert_raises(AcCapacityGrant::LimitExceededError) do
      AcCapacityGrant.grant_atomically!(company: @company, ac_task: @task, ac_execution_profile: @profile,
        agent_credential: @credential, operation_id: "op-ac-blocked", epoch: "1",
        policy_revision_id: @policy.id, policy_revision_number: @policy.revision_number)
    end
  end
end
