# frozen_string_literal: true

require "test_helper"

class AcAdmissionServiceTest < ActiveSupport::TestCase
  include AcCapacityIdentityFixture
  teardown { restore_capacity_identity }

  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context Admission",
      external_id: "ctx-adm-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "adm-plan-#{SecureRandom.hex(4)}",
      title: "Plan Admission",
      objective: "Admission tests",
      version: 1
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-adm-#{SecureRandom.hex(4)}",
      title: "Task Admission",
      scope: "Admission scope",
      position: 1,
      risk_class: :low,
      assigned_role: :programmer,
      state: :pending
    )
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_adm_1",
      content: {
        "model_chain" => [ "gpt-5.2" ],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: { "valid" => true, "errors" => [] },
      state: :draft,
      apply_mode: :next_attempts
    )
    @credential = create(:agent_credential, user: @user, company: @company, agent_type: "codex")
    configure_capacity_identity(@credential)
    @profile = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-codex-adm",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :medium,
      agent_credential: @credential,
      chain_position: 1,
      state: :active,
      selection_criteria: { "eligibility" => { "status" => "documented_supported", "model_id" => "gpt-5.2",
        "cli_adapter" => "codex_cli", "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 } }
    )
    raise "Policy publication failed" unless @policy.publish!(by_user: @user)
    raise "Plan publication failed" unless @plan.publish!(policy_revision: @policy)
    AcQuotaObservation.create!(company: @company, agent_credential: @credential, cli_adapter: "codex_cli",
      model_scope: "gpt-5.2", quota_state: :available, confidence_level: :high, origin: :manual_import,
      observed_at: Time.current, valid_until: 1.hour.from_now)
  end

  test "admit_execution! successfully creates execution and capacity grant" do
    op_id = "op-adm-#{SecureRandom.hex(6)}"

    result = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: op_id,
      requested_by: "user-#{@user.id}",
      origin: "api",
      execution_profile: @profile,
      epoch: "1"
    )

    assert_not result[:reused]
    execution = result[:execution]
    grant = result[:grant]

    assert execution.persisted?
    assert grant.persisted?
    assert_equal "granted", execution.state
    assert_equal "granted", grant.state
    assert_equal op_id, execution.operation_id
    assert_equal grant.id, execution.ac_capacity_grant_id

    # Verifica auditoria imutável
    audit = AcDecisionAuditEvent.find_by(event_type: "capacity_granted")
    assert audit.present?
    assert_equal execution.id, audit.metadata["execution_id"]
  end

  test "admit_execution! is strictly idempotent by operation_id (RF-45, §11.3)" do
    op_id = "op-idemp-#{SecureRandom.hex(6)}"

    result1 = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: op_id,
      requested_by: "user-#{@user.id}",
      origin: "chat",
      execution_profile: @profile,
      epoch: "1"
    )
    assert_not result1[:reused]

    # Reenvio com o mesmo operation_id
    result2 = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: op_id,
      requested_by: "user-#{@user.id}",
      origin: "chat",
      execution_profile: @profile,
      epoch: "1"
    )

    assert result2[:reused]
    assert_equal result1[:execution].id, result2[:execution].id
    assert_equal result1[:grant].id, result2[:grant].id
    assert_equal 1, AcExecution.where(operation_id: op_id).count
    assert_equal 1, AcCapacityGrant.where(operation_id: op_id).count
  end

  test "validate_execution_authority! succeeds when execution, grant and epoch match" do
    op_id = "op-auth-#{SecureRandom.hex(6)}"
    result = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: op_id,
      requested_by: "relay",
      execution_profile: @profile,
      epoch: "2"
    )

    execution = AcAdmissionService.validate_execution_authority!(
      execution_id: result[:execution].id,
      operation_id: op_id,
      reported_epoch: "2"
    )

    assert_equal result[:execution].id, execution.id
  end

  test "validate_execution_authority! blocks bypass attempts (§10.2.1)" do
    # 1. ID inexistente
    assert_raises(AcAdmissionService::UnauthorizedExecutionBypassError) do
      AcAdmissionService.validate_execution_authority!(
        execution_id: 999999,
        operation_id: "op-fake",
        reported_epoch: "1"
      )
    end

    # 2. Época divergente (stale process)
    result = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: "op-epoch-check-#{SecureRandom.hex(4)}",
      requested_by: "runner",
      execution_profile: @profile,
      epoch: "5"
    )

    assert_raises(AcAdmissionService::UnauthorizedExecutionBypassError) do
      AcAdmissionService.validate_execution_authority!(
        execution_id: result[:execution].id,
        operation_id: result[:execution].operation_id,
        reported_epoch: "4" # Época antiga
      )
    end
  end
end
