# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para avaliar e avançar o DAG de tarefas de um AcPlan (§12.1)
    class AcAdvancePlanDagActivity < Activities::Base
      activity_name "ac_advance_plan_dag_activity"

      def run(input)
        plan_id = input.plan_id
        plan = AcPlan.find(plan_id)

        newly_ready = plan.advance_dag!
        ready_tasks = plan.ready_tasks

        ready_task_details = ready_tasks.map do |t|
          last_completed_exec = (t.respond_to?(:ac_executions) ? t.ac_executions : AcExecution.where(ac_task_id: t.id)).where(state: "completed").order(:id).last
          {
            "id" => t.id,
            "task_key" => t.task_key,
            "state" => t.state,
            "approved" => t.approved?,
            "approved_artifact_hash" => t.approved_artifact_hash,
            "approved_commit_sha" => t.approved_commit_sha,
            "has_completed_execution" => last_completed_exec.present?,
            "execution_artifact_hash" => last_completed_exec&.output_payload&.dig("artifact_hash") || last_completed_exec&.metadata&.dig("artifact_hash"),
            "execution_commit_sha" => last_completed_exec&.output_payload&.dig("commit_sha") || last_completed_exec&.metadata&.dig("candidate_commit_sha")
          }
        end

        {
          "plan_id" => plan.id,
          "ready_task_ids" => ready_tasks.map(&:id),
          "ready_task_keys" => ready_tasks.map(&:task_key),
          "ready_task_details" => ready_task_details,
          "newly_unblocked_keys" => newly_ready.map(&:task_key),
          "all_completed" => plan.all_tasks_completed?
        }
      end
    end
  end
end
