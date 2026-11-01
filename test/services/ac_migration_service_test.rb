# frozen_string_literal: true

require "test_helper"

class AcMigrationServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @owner = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @owner)

    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Contexto Legado de Produção",
      external_id: "ctx-leg-#{SecureRandom.hex(4)}",
      origin: "paseo_import",
      state: "active"
    )

    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "plan-leg-1",
      title: "Plano Legado em Andamento",
      objective: "Migrar para o Agent Control",
      version: 1,
      state: "active",
      content_hash: Digest::SHA256.hexdigest("plan_leg_1")
    )

    # Tarefa 1: já integrada anteriormente no legado
    @task1 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-leg-1",
      title: "Entrega Histórica Concluída",
      position: 1,
      state: "integrated",
      approved_commit_sha: "commit-sha-historic-1",
      approved_artifact_hash: "hash-historic-1"
    )

    # Tarefa 2: pendente para conclusão no Agent Control
    @task2 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-leg-2",
      title: "Entrega Futura a Concluir",
      position: 2,
      state: "pending"
    )
  end

  # Prova G7-E1: Substituição autorizada com autoridade exclusiva e responsáveis claros (§19.2 F7)
  test "G7-E1: migrates project to exclusive authority and locks legacy system" do
    result = AcMigrationService.migrate_project!(
      project: @project,
      company: @company,
      target_authority: "agent_control_exclusive",
      assigned_owner: @owner
    )

    assert_equal "authority_transferred", result[:status]
    assert_equal "agent_control_exclusive", result[:authority_mode]
    assert_equal @owner.email, result[:assigned_owner]
    assert_equal 1, result[:migrated_contexts_count]

    @project.reload
    assert_equal "agent_control_exclusive", @project.settings["authority_mode"]
    assert_equal @owner.id, @project.settings["assigned_owner_id"]

    @context.reload
    assert_equal "agent_control_exclusive", @context.metadata["authority_mode"]
    assert_equal true, @context.metadata["legacy_locked"], "Deve travar modificações concorrentes no legado"
    assert_equal "migration", @context.origin
  end

  # Prova G7-E2: Prova criptográfica de ZERO perda de entregas e histórico prévio (Gate G7)
  test "G7-E2: cryptographic proof confirms zero data loss for historic deliveries and plans" do
    # 1. Executa a migração
    AcMigrationService.migrate_project!(
      project: @project,
      company: @company,
      assigned_owner: @owner
    )

    # 2. Valida integridade imediata
    integrity = AcMigrationService.verify_migration_integrity!(project: @project)
    assert_equal true, integrity[:integrity_verified]
    assert_equal true, integrity[:zero_loss]
    assert_equal 2, integrity[:preserved_tasks]
    assert_equal 1, integrity[:preserved_integrated_deliveries]

    # 3. Adiciona nova tarefa após migração: integridade continua mantida
    AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-new-3",
      title: "Nova Tarefa Pós-Migração",
      position: 3,
      state: "pending"
    )

    integrity_after = AcMigrationService.verify_migration_integrity!(project: @project)
    assert_equal true, integrity_after[:zero_loss]
    assert_operator integrity_after[:preserved_tasks], :>=, 2
  end

  # Prova G7-E3: Transferência atômica de autoridade de plano com responsável inequívoco
  test "G7-E3: transfers plan authority with clear logical manager identity" do
    result = AcMigrationService.transfer_plan_authority!(
      plan: @plan,
      new_manager_identity: "manager-lead-agent-01"
    )

    assert_equal "agent_control_exclusive", result[:authority_mode]
    assert_equal "manager-lead-agent-01", result[:manager_identity]

    @plan.reload
    assert_equal "manager-lead-agent-01", @plan.metadata["manager_identity"]

    @context.reload
    assert_equal "manager-lead-agent-01", @context.active_manager_identity
  end
end
