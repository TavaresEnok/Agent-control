# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para submissão de parecer estruturado de revisão/QA (§15)
    class AcReviewTaskActivity < Activities::Base
      activity_name "ac_review_task_activity"

      def run(input)
        task_id = input.task_id
        artifact_hash = input.artifact_hash
        verdict = input.verdict
        reviewer_role = input.reviewer_role || "reviewer"
        evaluator_identity = input.evaluator_identity
        findings = input.findings || []
        candidate_commit_sha = input.candidate_commit_sha
        base_commit_hash = input.base_commit_hash
        execution_id = input.execution_id

        task = AcTask.find(task_id)
        execution = execution_id.present? ? AcExecution.find_by(id: execution_id) : nil

        verdict_record = AcReviewService.submit_verdict!(
          task: task,
          artifact_hash: artifact_hash,
          verdict: verdict,
          reviewer_role: reviewer_role,
          evaluator_identity: evaluator_identity,
          findings: findings,
          candidate_commit_sha: candidate_commit_sha,
          base_commit_hash: base_commit_hash,
          execution: execution
        )

        task.reload

        {
          "verdict_id" => verdict_record.id,
          "verdict" => verdict_record.verdict,
          "task_id" => task.id,
          "task_state" => task.state,
          "approved" => task.approved?,
          "needs_changes" => (task.state == "needs_changes")
        }
      end
    end
  end
end
