# frozen_string_literal: true

require "test_helper"

class AcBackupServiceTest < ActiveSupport::TestCase
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
    @company = create(:company, name: "Recovery #{SecureRandom.uuid}", email_domain: "#{SecureRandom.hex(8)}.example")
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-backup-#{SecureRandom.hex(4)}",
      title: "Contexto para Backup",
      state: "active"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "plan-backup-1",
      title: "Plano Backup",
      objective: "Testar manifestos criptográficos",
      version: 1,
      state: :draft,
      content_hash: Digest::SHA256.hexdigest("plan_backup_1")
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-bkp-1",
      title: "Tarefa Backup",
      position: 1,
      state: "pending",
      risk_class: "low",
      assigned_role: "programmer"
    )
  end

  # Prova G6-E1: Exportação de manifesto com hashes SHA-256 e validação de integridade (RF-52, §21.1)
  test "G6-E1: exports atomic manifest with root digest and verifies successfully" do
    manifest = AcBackupService.export_manifest(company: @company)

    assert_equal "1.0", manifest["manifest_version"]
    assert_predicate manifest["root_digest"], :present?
    assert_predicate manifest["header"], :present?
    assert_equal @company.id, manifest["header"]["company_id"]

    # Checa contagens de entidades
    counts = manifest["header"]["entity_counts"]
    assert_operator counts["ac_work_contexts"], :>=, 1
    assert_operator counts["ac_plans"], :>=, 1
    assert_operator counts["ac_tasks"], :>=, 1

    # Validação do manifesto íntegro
    assert AcBackupService.verify_manifest(manifest), "Manifesto gerado deve ser verificado como íntegro"
  end

  test "G6-E1: verify_manifest rejects altered entity data" do
    manifest = AcBackupService.export_manifest(company: @company)

    # Adulteração de dados na tabela de tarefas
    manifest["entities"]["ac_tasks"][0]["title"] = "TITULO_CORROMPIDO"

    assert_not AcBackupService.verify_manifest(manifest), "Manifesto adulterado deve ser rejeitado"
  end

  test "G6-E1: verify_manifest rejects tampered root_digest" do
    manifest = AcBackupService.export_manifest(company: @company)
    manifest["root_digest"] = Digest::SHA256.hexdigest("fake_digest")

    assert_not AcBackupService.verify_manifest(manifest), "Root digest adulterado deve ser rejeitado"
  end

  # Prova DEF-05 (RF-31, RF-34, RF-52): Inclusão obrigatória de eventos de auditoria e concessões
  test "DEF-05: export_manifest includes immutable audit trail and capacity grants in manifest" do
    # Cria evento de auditoria e concessão para a empresa
    AcDecisionAuditEvent.create!(
      company: @company,
      project: @project,
      ac_task: @task,
      event_type: "task_state_changed",
      actor_type: "system",
      occurred_at: Time.current,
      reason: "Capacity granted"
    )

    manifest = AcBackupService.export_manifest(company: @company)
    counts = manifest["header"]["entity_counts"]

    assert counts.key?("ac_decision_audit_events"), "Manifesto deve conter tabela de auditoria imutável (RF-31)"
    assert counts.key?("ac_capacity_grants"), "Manifesto deve conter concessões de capacidade"
    assert counts.key?("ac_quota_observations"), "Manifesto deve conter observações de cota"
    assert_operator counts["ac_decision_audit_events"], :>=, 1
    assert AcBackupService.verify_manifest(manifest)
  end
  test "rejects a missing required collection even with a matching header" do
    manifest = AcBackupService.export_manifest(company: @company)
    manifest["entities"].delete("ac_tasks")
    assert_not AcBackupService.verify_manifest(manifest)
  end

  test "manifest contains integration and notification collections and requires them" do
    manifest = AcBackupService.export_manifest(company: @company)
    %w[ac_integration_operations trigger_events ac_notification_receipts].each do |name|
      assert manifest["entities"].key?(name)
      missing = manifest.deep_dup
      missing["entities"].delete(name)
      assert_not AcBackupService.verify_manifest(missing)
    end
  end

  test "redacts secrets in exported text" do
    @task.update!(title: "Bearer synthetic-secret-token")
    manifest = AcBackupService.export_manifest(company: @company)
    assert_not_includes manifest.to_json, "synthetic-secret-token"
    assert AcBackupService.verify_manifest(manifest)
  end
end
