# frozen_string_literal: true

module Activities
  module AgentControl
    class AcReviewTaskActivity < Activities::Base
      activity_name "ac_review_task_activity"

      def run(input)
        task = AcTask.find(input.task_id)
        execution = task.ac_executions.find(input.execution_id)
        AcExecutionFence.synchronize(execution, validate: false) do
          task.reload
          AcAdmissionService.validate_manager!(plan: task.ac_plan, identity: input.manager_identity, epoch: input.manager_epoch, required: true)
          unless execution.metadata["manager_identity"] == input.manager_identity && execution.metadata["manager_epoch"].to_s == input.manager_epoch.to_s
            raise AcAdmissionService::UnauthorizedExecutionBypassError, "Execução não pertence ao gerente"
          end
          receipt = AcRuntimeSupervisorService.status!(execution: execution)
          assessment = receipt.fetch("output").fetch("review")
          record = AcReviewService.submit_verdict!(task: task, execution: execution,
            reviewer_role: execution.ac_execution_profile.role.to_s, evaluator_identity: execution.process_handle,
            artifact_hash: assessment.fetch("artifact_hash"), verdict: assessment.fetch("verdict"),
            candidate_commit_sha: assessment.fetch("candidate_commit_sha"), base_commit_hash: assessment.fetch("base_commit_hash"),
            findings: assessment.fetch("findings", []))
          { "verdict_id" => record.id, "task_id" => task.id, "task_state" => task.reload.state, "approved" => task.approved? }
        end
      end
    end
  end
end
