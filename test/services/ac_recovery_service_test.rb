# frozen_string_literal: true

require "test_helper"

class AcRecoveryServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-recov-#{SecureRandom.hex(4)}",
      title: "Contexto Recuperação",
      state: "active"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "plan-recov-1",
      title: "Plano Recuperação",
      objective: "Testar T30",
      version: 1,
      state: :active,
      content_hash: Digest::SHA256.hexdigest("plan_recov_1")
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-recov-1",
      title: "Tarefa Teste",
      position: 1,
      state: "pending",
      risk_class: "low",
      assigned_role: "programmer"
    )

    @credential = create(:agent_credential, company: @company, user: @user)
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_recov_1",
      content: {
        "model_chain" => ["claude-haiku"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: { "valid" => true, "errors" => [] },
      state: :published,
      apply_mode: :next_attempts
    )
    @profile = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "recov-prof",
      role: :programmer,
      cli_adapter: :claude_code,
      model_id: "claude-haiku",
      effort_level: :medium,
      agent_credential: @credential,
      chain_position: 1,
      state: :active
    )

    AcRecoveryService.exit_recovery_mode!
  end

  teardown do
    AcRecoveryService.exit_recovery_mode!
  end

  # Prova G6-E2 (T30): Sistema em modo de recuperação bloqueia novas admissões até saneamento
  test "G6-E2: admission is strictly rejected when recovery mode is active" do
    AcRecoveryService.enter_recovery_mode!
    assert AcRecoveryService.recovery_mode_active?

    assert_raises(AcAdmissionService::RecoveryModeActiveError) do
      AcAdmissionService.admit_execution!(
        task: @task,
        operation_id: "op-recov-blocked-#{SecureRandom.hex(4)}",
        requested_by: "test_runner",
        execution_profile: @profile
      )
    end
  end

  # Prova G6-E2 (T30): Reconciliação neutraliza execuções pendentes/ativas e libera concessões
  test "G6-E2: reconcile_active_executions! reconciles running executions and releases grants" do
    # Admite uma execução normal
    admission = AcAdmissionService.admit_execution!(
      task: @task,
      operation_id: "op-recov-run-#{SecureRandom.hex(4)}",
      requested_by: "test_runner",
      execution_profile: @profile
    )
    execution = admission[:execution]
    grant = admission[:grant]

    execution.update!(state: :running)
    assert_equal "running", execution.state
    assert_equal "granted", grant.reload.state

    # Dispara reconciliação de recuperação pós-queda
    reconciled = AcRecoveryService.reconcile_active_executions!(company: @company)

    assert_equal 1, reconciled
    assert_equal "uncertain", execution.reload.state
    assert_equal "released", grant.reload.state
  end

  # Prova G6-E2 (T30): Preservação estrita de pausas prévias
  test "G6-E2: preserve_pauses! maintains paused plans and queues in waiting state" do
    @context.pause!(reason: "Manutenção programada")
    @task.update!(state: "queued")

    AcRecoveryService.preserve_pauses!(company: @company)

    assert_equal "paused", @context.reload.state
    assert_equal "waiting_dependencies", @task.reload.state
  end

  # Prova G6-E2: Restauração a partir de manifesto íntegro
  test "G6-E2: restore_from_manifest! succeeds with valid manifest" do
    manifest = AcBackupService.export_manifest(company: @company)

    result = AcRecoveryService.restore_from_manifest!(company: @company, manifest: manifest)

    assert_equal true, result[:restored]
    assert_equal manifest["root_digest"], result[:manifest_root_digest]
    assert AcRecoveryService.recovery_mode_active?
  end

  test "G6-E2: restore_from_manifest! aborts when manifest is corrupted" do
    manifest = AcBackupService.export_manifest(company: @company)
    manifest["root_digest"] = "corrupted_hash"

    assert_raises(AcRecoveryService::InvalidManifestError) do
      AcRecoveryService.restore_from_manifest!(company: @company, manifest: manifest)
    end
  end

  # Prova BUG-P0-03: Reidratação real de entidades no PostgreSQL
  test "BUG-P0-03: restore_from_manifest! rehydrates deleted entities into the database" do
    manifest = AcBackupService.export_manifest(company: @company)

    task_id = @task.id
    plan_id = @plan.id

    # Apaga as tarefas e planos
    @task.destroy!
    @plan.destroy!

    assert_nil AcTask.find_by(id: task_id)
    assert_nil AcPlan.find_by(id: plan_id)

    # Restaura a partir do manifesto
    result = AcRecoveryService.restore_from_manifest!(company: @company, manifest: manifest)

    assert_equal true, result[:restored]
    assert_not_nil AcPlan.find_by(id: plan_id), "Plano deve ser reidratado no banco de dados"
    assert_not_nil AcTask.find_by(id: task_id), "Tarefa deve ser reidratada no banco de dados"
    assert_equal "Tarefa Teste", AcTask.find(task_id).title
  end

  # Prova BUG-P1-04: Modo de recuperação persiste no PostgreSQL
  test "BUG-P1-04: recovery mode persists across memory resets via database" do
    AcRecoveryService.enter_recovery_mode!(company: @company)

    # Simula perda de memória do processo (Puma worker restart)
    AcRecoveryService.instance_variable_set(:@recovery_mode_active, false)

    # Modo de recuperação deve continuar ativo devido ao registro persistido no banco
    assert_equal true, AcRecoveryService.recovery_mode_active?(company: @company)

    # Saída do modo de recuperação limpa o banco
    AcRecoveryService.exit_recovery_mode!(company: @company)
    AcRecoveryService.instance_variable_set(:@recovery_mode_active, false)
    assert_equal false, AcRecoveryService.recovery_mode_active?(company: @company)
  end

  # Prova DEF-05 (RF-31, RF-34, RF-52): Reset de sequence do PostgreSQL e reidratação de auditoria
  test "DEF-05: primary key sequence is reset after rehydration preventing collision on subsequent creates" do
    # 1. Cria evento de auditoria imutável antes do backup
    audit = AcDecisionAuditEvent.create!(
      company: @company,
      project: @project,
      ac_task: @task,
      event_type: "task_state_changed",
      actor_type: "system",
      occurred_at: Time.current,
      reason: "Capacity available"
    )
    audit_id = audit.id

    manifest = AcBackupService.export_manifest(company: @company)

    # 2. Restaura o estado a partir do manifesto
    result = AcRecoveryService.restore_from_manifest!(company: @company, manifest: manifest)
    assert result[:restored]

    # Verifica que o evento de auditoria foi preservado/reidratado
    assert_not_nil AcDecisionAuditEvent.find_by(id: audit_id), "Trilha de auditoria deve ser reidratada (RF-31)"

    # 3. Cria novas entidades subsequentemente. Sem reset_pk_sequence!, falharia por PG::UniqueViolation
    new_task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-post-restore-#{SecureRandom.hex(4)}",
      title: "Tarefa Criada Pós-Restauração",
      position: 99,
      state: "pending",
      risk_class: "low",
      assigned_role: "programmer"
    )

    assert new_task.persisted?, "Nova tarefa deve ser persistida sem colisão de sequence (DEF-05)"
    assert_operator new_task.id, :>, @task.id
  end
end
