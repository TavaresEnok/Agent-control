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
      state: "draft",
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

  test "preparation inventories records without asserting external authority" do
    result = prepare
    assert_equal "prepared", result[:status]
    assert_not @project.reload.settings.key?("authority_mode")
    assert_not @context.reload.metadata.key?("legacy_locked")
    verification = AcMigrationService.verify_migration_integrity!(project: @project)
    assert verification[:integrity_verified]
    assert_not verification.key?(:zero_loss)
  end

  test "a new task cannot mask deletion of an inventoried task" do
    prepare
    @task2.destroy!
    AcTask.create!(company: @company, project: @project, ac_plan: @plan,
      task_key: "replacement", title: "Replacement", position: 3)
    assert_raises(AcMigrationService::IntegrityMismatchError) do
      AcMigrationService.verify_migration_integrity!(project: @project)
    end
  end

  test "changed approved artifact is detected even when counts are unchanged" do
    prepare
    @task1.update_columns(approved_artifact_hash: "other")
    assert_raises(AcMigrationService::IntegrityMismatchError) do
      AcMigrationService.verify_migration_integrity!(project: @project)
    end
  end

  test "execution and review evidence remains bound to its original identity and content" do
    execution = AcExecution.create!(company: @company, ac_task: @task1, ac_work_context: @context,
      operation_id: "execution-original", epoch: "1", state: "completed", output_payload: { "hash" => "output" })
    verdict = AcReviewVerdict.create!(company: @company, project: @project, ac_task: @task1,
      ac_execution: execution, reviewer_role: "reviewer", verdict: "approved", artifact_hash: "hash-historic-1",
      evaluator_identity: "reviewer-one")
    prepare
    execution.update_columns(output_payload: { "hash" => "altered" })
    assert_raises(AcMigrationService::IntegrityMismatchError) do
      AcMigrationService.verify_migration_integrity!(project: @project)
    end
    execution.update_columns(output_payload: { "hash" => "output" })
    verdict.destroy!
    assert_raises(AcMigrationService::IntegrityMismatchError) do
      AcMigrationService.verify_migration_integrity!(project: @project)
    end
  end

  test "a prepared inventory cannot be overwritten" do
    prepare
    assert_raises(AcMigrationService::MigrationError) { prepare }
  end

  test "external authority cannot be transferred without an adapter" do
    assert_raises(AcMigrationService::AuthorityUnavailableError) do
      AcMigrationService.transfer_plan_authority!(plan: @plan, new_manager_identity: "manager", expected_epoch: 0)
    end
    assert_nil @context.reload.active_manager_identity
  end

  test "local manager assignment uses epoch fencing and rolls back on stale epoch" do
    result = AcMigrationService.assign_plan_manager!(plan: @plan, new_manager_identity: "manager-one", expected_epoch: 0)
    assert_equal 1, result[:manager_epoch]
    assert_raises(ActiveRecord::StaleObjectError) do
      AcMigrationService.assign_plan_manager!(plan: @plan, new_manager_identity: "manager-two", expected_epoch: 0)
    end
    assert_equal "manager-one", @context.reload.active_manager_identity
    assert_equal "manager-one", @plan.reload.metadata["manager_identity"]
  end

  private

  def prepare
    AcMigrationService.migrate_project!(project: @project, company: @company, assigned_owner: @owner)
  end
end
