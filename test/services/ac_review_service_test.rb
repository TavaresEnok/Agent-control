# frozen_string_literal: true

require "test_helper"

class AcReviewServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context Review Test",
      external_id: "ctx-rev-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "rev-plan-#{SecureRandom.hex(4)}",
      title: "Plan Review Test",
      objective: "Review tests",
      version: 1
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-rev-#{SecureRandom.hex(4)}",
      title: "Task Review Test",
      scope: "Review scope",
      position: 1,
      risk_class: :low,
      assigned_role: :programmer,
      state: :review
    )
  end

  # Prova G3-E1: Ciclo de Reprovação -> Correção -> Nova Aprovação
  test "G3-E1: complete cycle of rejection -> correction -> re-approval of new artifact" do
    old_hash = "hash_artifact_v1_fail"
    new_hash = "hash_artifact_v2_fixed"

    # 1. Revisor reprova o artefato v1
    findings = [
      {
        "file" => "lib/core.rb",
        "line" => 42,
        "severity" => "error",
        "description" => "Método não trata nil pointer"
      }
    ]

    verdict1 = AcReviewService.submit_verdict!(
      task: @task,
      artifact_hash: old_hash,
      verdict: :rejected,
      reviewer_role: :reviewer,
      evaluator_identity: "independent-reviewer-01",
      findings: findings
    )

    assert_equal "rejected", verdict1.verdict
    @task.reload
    assert_equal "needs_changes", @task.state, "Tarefa deve transicionar para needs_changes (RF-20)"
    assert_nil @task.approved_artifact_hash

    # 2. Implementador produz nova versão corrigida -> invalida pareceres do artefato antigo
    invalidated_count = AcReviewService.invalidate_stale_verdicts!(task: @task, new_artifact_hash: new_hash)
    assert_equal 1, invalidated_count
    assert_equal "invalidated", verdict1.reload.state, "Parecer do artefato anterior deve ser invalidado (§15.3)"

    # 3. Revisor avalia o novo artefato v2 corrigido e aprova
    verdict2 = AcReviewService.submit_verdict!(
      task: @task,
      artifact_hash: new_hash,
      verdict: :approved,
      reviewer_role: :reviewer,
      evaluator_identity: "independent-reviewer-01",
      candidate_commit_sha: "commit-v2-sha"
    )

    assert_equal "approved", verdict2.verdict
    assert_equal "valid", verdict2.state
    @task.reload
    assert_equal "approved", @task.state, "Tarefa deve estar aprovada com o novo artefato"
    assert_equal new_hash, @task.approved_artifact_hash
    assert_equal "commit-v2-sha", @task.approved_commit_sha
  end

  # Prova G3-E2: Invalidação imediata quando artefato muda
  test "G3-E2: previous approval is invalidated immediately when new artifact is produced (§15.3)" do
    initial_hash = "hash_approved_initially"
    newer_hash = "hash_modified_later"

    # Aprova hash inicial
    AcReviewService.submit_verdict!(
      task: @task,
      artifact_hash: initial_hash,
      verdict: :approved,
      reviewer_role: :reviewer,
      evaluator_identity: "reviewer-1"
    )
    assert_equal "approved", @task.reload.state

    # Código é modificado -> invalida
    AcReviewService.invalidate_stale_verdicts!(task: @task, new_artifact_hash: newer_hash)

    @task.reload
    assert_not_equal "approved", @task.state, "Aprovação antiga não pode permanecer após mudança de artefato"
    assert_nil @task.approved_artifact_hash
    assert_not @task.review_approved_for?(newer_hash), "Novo artefato ainda não possui aprovação válida"
  end

  test "blocks self-approval by the same process that wrote the code (§15.2)" do
    execution = AcExecution.create!(
      company: @company,
      ac_work_context: @context,
      ac_task: @task,
      operation_id: "op-self-app-#{SecureRandom.hex(4)}",
      epoch: "1",
      process_handle: "proc-runner-99"
    )

    assert_raises(AcReviewService::SelfApprovalViolationError) do
      AcReviewService.submit_verdict!(
        task: @task,
        artifact_hash: "hash-self",
        verdict: :approved,
        evaluator_identity: "proc-runner-99", # Mesma identidade do implementador
        execution: execution
      )
    end
  end
end
