# frozen_string_literal: true

require "test_helper"

class AcReviewCouncilServiceTest < ActiveSupport::TestCase
  include AcSafetyFixtures

  setup do
    @plan = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Council", objective: "Independent review", version: 1, state: :draft)
    @task = AcTask.create!(company: @company, project: @project, ac_plan: @plan,
      task_key: "council", title: "High risk", risk_class: :high, assigned_role: :programmer)
    raise "Plan publication failed" unless @plan.publish!(policy_revision: @policy)
    @task.update!(state: :review)
    @hash = Digest::SHA256.hexdigest("artifact")
    @candidate = Digest::SHA256.hexdigest("candidate")
    @base = Digest::SHA256.hexdigest("base")
    execution("programmer")
  end

  test "rejects over-capacity wave" do
    assert_raises(AcReviewCouncilService::WaveCapacityExceededError) do
      AcReviewCouncilService.submit_wave!(task: @task, wave_number: 1, reviews: [ {}, {}, {} ])
    end
  end

  test "self-declared reviewer or judge cannot create a verdict" do
    assert_raises(AcReviewCouncilService::CouncilError) do
      AcReviewCouncilService.submit_wave!(task: @task, wave_number: 1,
        reviews: [ { role: "reviewer", verdict: "approved", reviewer_name: "someone", artifact_hash: @hash } ])
    end
    assert_raises(AcReviewCouncilService::CouncilError) do
      AcReviewCouncilService.adjudicate!(task: @task, final_decision: "approved", rationale: "claimed", artifact_hash: @hash)
    end
    assert_empty @task.ac_review_verdicts
    assert @task.reload.review?
  end

  test "independent receipts must satisfy both reviewer and QA gates" do
    reviewer = execution("reviewer")
    qa = execution("qa")
    result = AcReviewCouncilService.submit_wave!(task: @task, wave_number: 1, reviews: [ review(qa, "qa") ])
    assert_equal 1, result[:verdicts_count]
    assert @task.reload.review?
    result = AcReviewCouncilService.adjudicate!(task: @task, judge_role: "reviewer", final_decision: "approved",
      rationale: "verified", **review(reviewer, "reviewer").slice(:execution_id, :evaluator_identity, :artifact_hash,
        :candidate_commit_sha, :base_commit_hash))
    assert_equal "adjudicated", result[:status]
    assert @task.reload.approved?
    assert_equal @candidate, @task.approved_commit_sha
    assert_equal @hash, @task.approved_artifact_hash
  end

  test "adjudicator cannot reuse an existing reviewer or falsify the rationale" do
    reviewer = execution("reviewer")
    qa = execution("qa")
    AcReviewCouncilService.submit_wave!(task: @task, wave_number: 1, reviews: [ review(qa, "qa") ])
    assert_raises(AcReviewCouncilService::CouncilError) do
      AcReviewCouncilService.adjudicate!(task: @task, judge_role: "qa", final_decision: "approved", rationale: "verified",
        **review(qa, "qa").slice(:execution_id, :evaluator_identity, :artifact_hash, :candidate_commit_sha, :base_commit_hash))
    end
    assert_raises(AcReviewCouncilService::CouncilError) do
      AcReviewCouncilService.adjudicate!(task: @task, judge_role: "reviewer", final_decision: "approved", rationale: "invented",
        **review(reviewer, "reviewer").slice(:execution_id, :evaluator_identity, :artifact_hash, :candidate_commit_sha, :base_commit_hash))
    end
    assert @task.reload.review?
  end

  private

  def execution(role)
    operation = SecureRandom.uuid
    profile = @profiles.fetch(role)
    grant = AcCapacityGrant.create!(company: @company, ac_task: @task, ac_execution_profile: profile,
      agent_credential: @credential, operation_id: operation, epoch: "1", state: :released,
      policy_revision_id: @policy.id, policy_revision_number: @policy.revision_number)
    output = { "commit_sha" => @candidate, "base_commit_sha" => @base, "artifact_hash" => @hash,
      "review" => { "artifact_hash" => @hash, "candidate_commit_sha" => @candidate, "base_commit_hash" => @base,
        "verdict" => "approved", "findings" => [], "rationale" => "verified" } }
    record = AcExecution.create!(company: @company, ac_task: @task, ac_work_context: @context,
      ac_execution_profile: profile, ac_capacity_grant: grant, operation_id: operation, epoch: "1",
      state: :completed, process_handle: "runtime-#{operation}", exit_code: 0, output_payload: output)
    @supervisor.receipts[record.id] = { "operation_id" => operation, "epoch" => "1", "process_handle" => record.process_handle,
      "state" => "completed", "exit_code" => 0, "runtime_id" => operation, "output" => output, "error" => {} }
    record
  end

  def review(execution, role)
    { execution_id: execution.id, role: role, evaluator_identity: execution.process_handle,
      artifact_hash: @hash, candidate_commit_sha: @candidate, base_commit_hash: @base, verdict: "approved" }
  end
end
