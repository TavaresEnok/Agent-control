# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para integração condicional protegida com compare-and-swap (§15.3.1)
    class AcIntegrateTaskActivity < Activities::Base
      activity_name "ac_integrate_task_activity"

      def run(input)
        task_id = input.task_id
        expected_base_commit = input.expected_base_commit
        candidate_commit = input.candidate_commit
        current_branch_head = input.current_branch_head
        artifact_hash = input.artifact_hash
        verification_evidence = (input.verification_evidence || {}).to_h

        task = AcTask.find(task_id)

        result = AcIntegrationService.integrate_task!(
          task: task,
          expected_base_commit: expected_base_commit,
          candidate_commit: candidate_commit,
          current_branch_head: current_branch_head,
          artifact_hash: artifact_hash,
          verification_evidence: verification_evidence
        )

        {
          "integrated" => true,
          "task_id" => task.id,
          "candidate_commit" => result[:candidate_commit],
          "new_branch_head" => result[:new_branch_head],
          "unblocked_tasks" => result[:unblocked_tasks]
        }
      end
    end
  end
end
