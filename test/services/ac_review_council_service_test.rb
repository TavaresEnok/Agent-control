# frozen_string_literal: true

require "test_helper"

class AcReviewCouncilServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-council-#{SecureRandom.hex(4)}",
      title: "Contexto Conselho",
      state: "active"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "plan-council-1",
      title: "Plano Conselho",
      objective: "Testar conselho multi-avaliador",
      version: 1,
      state: :active,
      content_hash: Digest::SHA256.hexdigest("plan_council_1")
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-council-1",
      title: "Tarefa com Conselho",
      position: 1,
      state: "review",
      risk_class: "high",
      assigned_role: "programmer"
    )
  end

  # Prova G8-E1 (§15.4): Submissão de ondas respeitando vagas de avaliação simultâneas
  test "G8-E1: submit_wave! records verdicts within concurrent slot limits" do
    wave_reviews = [
      { verdict: "approved", role: "reviewer", reviewer_name: "Rev_1", artifact_hash: "hash_art_1" },
      { verdict: "needs_changes", role: "qa", reviewer_name: "QA_1", artifact_hash: "hash_art_1", findings: [{ "issue" => "edge_case" }] }
    ]

    res = AcReviewCouncilService.submit_wave!(
      task: @task,
      wave_number: 1,
      reviews: wave_reviews
    )

    assert_equal 1, res[:wave_number]
    assert_equal 2, res[:verdicts_count]
    assert_equal 2, @task.ac_review_verdicts.count
  end

  test "G8-E1: submit_wave! rejects waves exceeding maximum concurrent slots" do
    excessive_reviews = [
      { verdict: "approved", role: "reviewer" },
      { verdict: "approved", role: "qa" },
      { verdict: "approved", role: "specialist" } # 3 > 2 vagas
    ]

    assert_raises(AcReviewCouncilService::WaveCapacityExceededError) do
      AcReviewCouncilService.submit_wave!(
        task: @task,
        wave_number: 1,
        reviews: excessive_reviews
      )
    end
  end

  # Prova G8-E1 (§15.4): Julgamento (adjudicação) arbitra divergências e define parecer final
  test "G8-E1: adjudicate! arbitrates diverging verdicts and sets binding decision" do
    # 1. Cria pareceres divergentes na onda 1
    AcReviewVerdict.create!(
      company: @company,
      project: @project,
      ac_task: @task,
      verdict: "approved",
      reviewer_role: "reviewer",
      evaluator_identity: "rev_test_1",
      state: "valid",
      artifact_hash: "art_hash_123"
    )
    AcReviewVerdict.create!(
      company: @company,
      project: @project,
      ac_task: @task,
      verdict: "needs_changes",
      reviewer_role: "qa",
      evaluator_identity: "qa_test_1",
      state: "valid",
      artifact_hash: "art_hash_123"
    )

    # 2. Juiz / Especialista faz a arbitragem final
    adj_result = AcReviewCouncilService.adjudicate!(
      task: @task,
      judge_role: "qa",
      final_decision: "approved",
      rationale: "O apontamento de QA é não-bloqueante e pode ser absorvido na fase seguinte",
      artifact_hash: "art_hash_123"
    )

    assert_equal "adjudicated", adj_result[:status]
    assert_equal "approved", adj_result[:task_state].to_s
    assert_equal "approved", @task.reload.state
    assert_equal "art_hash_123", @task.approved_artifact_hash
  end
end
