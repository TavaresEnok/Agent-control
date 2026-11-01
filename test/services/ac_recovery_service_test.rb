# frozen_string_literal: true

require "test_helper"

class AcRecoveryServiceTest < ActiveSupport::TestCase
  self.use_transactional_tests = false
  teardown do
    AcIntegrationOperation.where(ac_task_id: AcTask.where(company: @company).select(:id)).delete_all
    AcNotificationReceipt.where(trigger_event_id: TriggerEvent.where(company: @company).select(:id)).delete_all
    TriggerEvent.where(company: @company).delete_all
    %w[ac_templates ac_remote_operations ac_remote_environments ac_client_commands ac_decision_audit_events
       ac_quota_observations ac_review_verdicts ac_executions ac_capacity_grants ac_tasks ac_plans
       ac_execution_profiles ac_work_contexts ac_policy_revisions].each do |table|
      ActiveRecord::Base.connection.execute("DELETE FROM #{table} WHERE company_id = #{@company.id}")
    end
    AgentCredential.where(company_id: @company.id).delete_all
    @project.delete
    @user.company_memberships.delete_all
    UserIdentity.where(user_id: @user.id).delete_all
    UserSession.where(user_id: @user.id).delete_all
    @user.delete
    CompanyAuthPolicy.where(company_id: @company.id).delete_all
    IdentityProvider.where(company_id: @company.id).delete_all
    @company.delete
  end

  setup do
    @previous_backup_key = Rails.application.config.try(:ac_backup_encryption_key)
    @previous_backup_key_id = Rails.application.config.try(:ac_backup_key_id)
    Rails.application.config.ac_backup_encryption_key = Base64.strict_encode64("a" * 32)
    Rails.application.config.ac_backup_key_id = "test-key"
    @company = create(:company, name: "Recovery #{SecureRandom.uuid}", email_domain: "#{SecureRandom.hex(8)}.example")
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
      state: :draft,
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
        "model_chain" => [ "claude-haiku" ],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: { "valid" => true, "errors" => [] },
      state: :draft,
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
      state: :active,
      selection_criteria: { "eligibility" => { "status" => "documented_supported", "model_id" => "claude-haiku",
        "cli_adapter" => "claude_code", "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 } }
    )

    raise "Recovery policy publication failed" unless @policy.publish!(by_user: @user)
    AcRecoveryService.exit_recovery_mode!(company: @company)
  end

  teardown do
    AcRecoveryService.exit_recovery_mode!(company: @company)
    Rails.application.config.ac_backup_encryption_key = @previous_backup_key
    Rails.application.config.ac_backup_key_id = @previous_backup_key_id
  end

  # Prova G6-E2 (T30): Sistema em modo de recuperação bloqueia novas admissões até saneamento
  test "G6-E2: admission is strictly rejected when recovery mode is active" do
    AcRecoveryService.enter_recovery_mode!(company: @company)
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

  test "reconciliation retains capacity for uncertain executions" do
    assert @plan.publish!(policy_revision: @policy)
    previous_accounts = Rails.application.config.try(:ac_local_capacity_accounts)
    previous_identities = Rails.application.config.try(:ac_capacity_account_identities)
    previous_authority = Rails.application.config.try(:ac_capacity_authority_id)
    Rails.application.config.ac_capacity_authority_id = "test-authority"
    Rails.application.config.ac_capacity_account_identities = {
      @credential.id => { "account_key" => "sha256:#{Digest::SHA256.hexdigest("fixture-#{@credential.id}")}",
        "authority_id" => "test-authority", "ownership" => "exclusive_local" }
    }
    Rails.application.config.ac_local_capacity_accounts = {
      AcLocalCapacityAuthorityService.account_key(@credential) => { "mode" => "local", "limit" => 1 }
    }
    AcQuotaObservation.create!(company: @company, agent_credential: @credential,
      cli_adapter: @profile.cli_adapter, model_scope: @profile.model_id, quota_state: :available,
      confidence_level: :high, origin: :manual_import, observed_at: Time.current, valid_until: 1.hour.from_now)

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
    assert_equal "granted", grant.reload.state
  ensure
    Rails.application.config.ac_local_capacity_accounts = previous_accounts
    Rails.application.config.ac_capacity_account_identities = previous_identities
    Rails.application.config.ac_capacity_authority_id = previous_authority
  end

  # Prova G6-E2 (T30): Preservação estrita de pausas prévias
  test "G6-E2: preserve_pauses! maintains paused plans and queues in waiting state" do
    @context.pause!(reason: "Manutenção programada")
    @task.update!(state: "queued")

    AcRecoveryService.preserve_pauses!(company: @company)

    assert_equal "paused", @context.reload.state
    assert_equal "waiting_dependencies", @task.reload.state
  end

  test "encrypted backup preserves data and rejects tampering and redacted exports" do
    @task.update!(title: "Bearer synthetic-backup-secret")
    backup = AcBackupService.export_encrypted_backup(company: @company)
    assert_not_includes backup.to_json, "synthetic-backup-secret"
    assert_equal "Bearer synthetic-backup-secret", AcBackupService.decrypt_backup(backup)["entities"]["ac_tasks"].first["title"]
    assert_raises(AcRecoveryService::InvalidManifestError) do
      AcRecoveryService.restore_from_manifest!(company: @company, manifest: AcBackupService.export_manifest(company: @company))
    end
    backup["ciphertext"] = "tampered"
    assert_raises(AcRecoveryService::InvalidManifestError) do
      AcRecoveryService.restore_from_manifest!(company: @company, manifest: backup)
    end
  end

  test "restore reports a conflict rather than discarding a changed row" do
    backup = AcBackupService.export_encrypted_backup(company: @company)
    @task.update!(title: "Changed after backup")
    assert_raises(AcRecoveryService::RecoveryError) do
      AcRecoveryService.restore_from_manifest!(company: @company, manifest: backup)
    end
    assert_equal "Changed after backup", @task.reload.title
  end

  test "restore stops when a referenced credential is missing" do
    backup = AcBackupService.export_encrypted_backup(company: @company)
    @profile.delete
    @credential.delete
    error = assert_raises(AcRecoveryService::RecoveryError) do
      AcRecoveryService.restore_from_manifest!(company: @company, manifest: backup)
    end
    assert_match(/credenciais/, error.message)
    assert AcRecoveryService.recovery_mode_active?(company: @company)
  end

  test "restores integration journal and quarantines an undelivered outbox event" do
    operation = AcIntegrationOperation.create!(ac_task: @task, identity: "integration-test", state: "git_applied",
      base_commit: "base", candidate_commit: "candidate", artifact_hash: "hash", branch_ref: "refs/heads/main")
    event = AcNotificationService.record!(company: @company, project: @project, actor: @user, recipient: @user,
      intent_id: "notification-1", kind: "review", title: "Review", body: "Ready")
    receipt = AcNotificationReceipt.find_by!(trigger_event: event)
    backup = AcBackupService.export_encrypted_backup(company: @company)
    receipt.delete
    event.delete
    operation.delete

    result = AcRecoveryService.restore_from_manifest!(company: @company, manifest: backup)
    assert_equal "pending_external_reconciliation", result[:reconciliation][:status]
    assert_equal "git_applied", AcIntegrationOperation.find(operation.id).state
    assert_equal "failed", TriggerEvent.find(event.id).relay_state
    assert_match(/estado anterior pending/, TriggerEvent.find(event.id).relay_error)
    assert_equal @user.id, AcNotificationReceipt.find(receipt.id).user_id
  end

  # Prova G6-E2: Restauração a partir de manifesto íntegro
  test "G6-E2: restore_from_manifest! succeeds with valid manifest" do
    manifest = AcBackupService.export_encrypted_backup(company: @company)

    result = AcRecoveryService.restore_from_manifest!(company: @company, manifest: manifest)

    assert result[:restored]
    assert_equal AcBackupService.decrypt_backup(manifest)["root_digest"], result[:manifest_root_digest]
    assert AcRecoveryService.recovery_mode_active?
  end

  test "G6-E2: restore_from_manifest! aborts when manifest is corrupted" do
    manifest = AcBackupService.export_encrypted_backup(company: @company)
    manifest["ciphertext"] = "corrupted"

    assert_raises(AcRecoveryService::InvalidManifestError) do
      AcRecoveryService.restore_from_manifest!(company: @company, manifest: manifest)
    end
  end

  # Prova BUG-P0-03: Reidratação real de entidades no PostgreSQL
  test "BUG-P0-03: restore_from_manifest! rehydrates deleted entities into the database" do
    manifest = AcBackupService.export_encrypted_backup(company: @company)

    task_id = @task.id
    plan_id = @plan.id

    # Apaga as tarefas e planos
    @task.destroy!
    @plan.destroy!

    assert_nil AcTask.find_by(id: task_id)
    assert_nil AcPlan.find_by(id: plan_id)

    # Restaura a partir do manifesto
    result = AcRecoveryService.restore_from_manifest!(company: @company, manifest: manifest)

    assert result[:restored]
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
    assert AcRecoveryService.recovery_mode_active?(company: @company)

    # Saída do modo de recuperação limpa o banco
    AcRecoveryService.exit_recovery_mode!(company: @company)
    AcRecoveryService.instance_variable_set(:@recovery_mode_active, false)
    refute AcRecoveryService.recovery_mode_active?(company: @company)
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

    manifest = AcBackupService.export_encrypted_backup(company: @company)

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
