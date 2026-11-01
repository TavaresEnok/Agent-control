# frozen_string_literal: true

require "test_helper"

class AcIntegrationServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context Integration Test",
      external_id: "ctx-int-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "int-plan-#{SecureRandom.hex(4)}",
      title: "Plan Integration Test",
      objective: "Integration tests",
      version: 1
    )
    @task1 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-feat-01",
      title: "Task 1",
      scope: "Feature 1",
      position: 1,
      risk_class: :low,
      assigned_role: :programmer,
      state: :approved,
      approved_commit_sha: "cand-commit-123",
      approved_artifact_hash: "art-hash-123"
    )
    @task2 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-feat-02",
      title: "Task 2 (Depends on 1)",
      scope: "Feature 2",
      position: 2,
      risk_class: :low,
      assigned_role: :programmer,
      depends_on: ["task-feat-01"],
      state: :waiting_dependencies
    )

    # Cria aprovação válida para @task1
    AcReviewVerdict.create!(
      company: @company,
      project: @project,
      ac_task: @task1,
      reviewer_role: :reviewer,
      verdict: :approved,
      artifact_hash: "art-hash-123",
      candidate_commit_sha: "cand-commit-123",
      evaluator_identity: "independent-reviewer",
      state: :valid
    )
  end

  # Prova G3-E4: Integração atômica condicional com sucesso
  test "G3-E4: integrate_task! succeeds when CAS base matches and evidence is verified" do
    result = AcIntegrationService.integrate_task!(
      task: @task1,
      expected_base_commit: "main-base-v1",
      candidate_commit: "cand-commit-123",
      current_branch_head: "main-base-v1", # Base confere com o esperado
      artifact_hash: "art-hash-123",
      verification_evidence: {
        executor_identity: "ci-runner-verified",
        exit_code: 0,
        test_summary: "42 passed"
      }
    )

    assert result[:integrated]
    @task1.reload
    assert_equal "integrated", @task1.state
    assert_equal "cand-commit-123", @task1.approved_commit_sha

    # Verifica se a tarefa dependente foi desbloqueada pelo DAG
    @task2.reload
    assert_equal "pending", @task2.state, "Tarefa dependente deve ser desbloqueada após integração de antecedente"
  end

  # Prova G3-E4 (Rejeição de corrida de branch concorrente):
  test "G3-E4: blocks integration when current branch head diverged from expected base (§15.3.1)" do
    assert_raises(AcIntegrationService::ConcurrentBranchModificationError) do
      AcIntegrationService.integrate_task!(
        task: @task1,
        expected_base_commit: "main-base-v1",
        candidate_commit: "cand-commit-123",
        current_branch_head: "main-base-v2-concurrent", # Base avançou concorrentemente!
        artifact_hash: "art-hash-123"
      )
    end

    @task1.reload
    assert_equal "approved", @task1.state, "Estado deve permanecer inalterado e não integrado"
  end

  test "blocks integration when verification evidence reported failure (§15.3.1)" do
    assert_raises(AcIntegrationService::InvalidVerificationEvidenceError) do
      AcIntegrationService.integrate_task!(
        task: @task1,
        expected_base_commit: "main-base-v1",
        candidate_commit: "cand-commit-123",
        current_branch_head: "main-base-v1",
        artifact_hash: "art-hash-123",
        verification_evidence: {
          executor_identity: "ci-runner",
          exit_code: 1 # Falha nos testes de integração
        }
      )
    end
  end
end
