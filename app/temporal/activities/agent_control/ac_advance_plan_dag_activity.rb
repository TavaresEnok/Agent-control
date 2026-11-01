# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para avaliar e avançar o DAG de tarefas de um AcPlan (§12.1)
    class AcAdvancePlanDagActivity < Activities::Base
      activity_name "ac_advance_plan_dag_activity"

      def run(input)
        plan_id = input.plan_id
        plan = AcPlan.find(plan_id)

        AcWorkContext.transaction do
          plan.ac_work_context.lock!
          plan.lock!
          if AcPlanLaunchService.terminal_ack?(plan: plan, identity: input.manager_identity, epoch: input.manager_epoch)
            next { "plan_id" => plan.id, "paused" => false, "cancelled" => plan.abandoned?, "blocked" => false,
                   "ready_task_ids" => [], "ready_task_keys" => [], "ready_task_details" => [],
                   "newly_unblocked_keys" => [], "all_completed" => plan.completed? }
          end
          AcAdmissionService.validate_manager!(plan: plan, identity: input.manager_identity, epoch: input.manager_epoch, required: true, allow_paused: true)
          newly_ready = plan.advance_dag!
          ready_tasks = plan.ready_tasks

          ready_task_details = ready_tasks.map do |t|
            last_completed_exec = t.ac_executions.joins(:ac_execution_profile).where(state: "completed", ac_execution_profiles: { role: "programmer" }).order(:id).last
            {
              "id" => t.id,
              "task_key" => t.task_key,
              "state" => t.state,
              "attempt_count" => t.attempt_count,
              "phase_generations" => t.metadata.fetch("phase_generations", {}),
              "execution_generation" => t.metadata.fetch("execution_generation", t.attempt_count),
              "requires_qa" => t.requires_qa?,
              "verification_execution_id" => t.metadata["verification_execution_id"],
              "review_execution_id" => t.metadata["review_execution_id"],
              "approved" => t.approved?,
              "approved_artifact_hash" => t.approved_artifact_hash,
              "approved_commit_sha" => t.approved_commit_sha,
              "has_completed_execution" => last_completed_exec.present?,
              "execution_artifact_hash" => last_completed_exec&.output_payload&.dig("artifact_hash") || last_completed_exec&.metadata&.dig("artifact_hash"),
              "execution_base_commit_sha" => last_completed_exec&.output_payload&.dig("base_commit_sha"),
              "execution_commit_sha" => last_completed_exec&.output_payload&.dig("commit_sha") || last_completed_exec&.metadata&.dig("candidate_commit_sha")
            }
          end

          plan.update!(state: :completed) if plan.active? && !plan.paused? && plan.all_tasks_completed?
          released = if plan.completed? || plan.abandoned?
            AcPlanLaunchService.release_manager_if_safe!(plan: plan, identity: input.manager_identity, epoch: input.manager_epoch)
          else
            false
          end

          {
            "plan_id" => plan.id,
            "paused" => plan.paused? || !plan.ac_work_context.active? || ((plan.completed? || plan.abandoned?) && !released),
            "cancelled" => plan.abandoned? && released,
            "blocked" => plan.ac_tasks.where(state: "failed").exists?,
            "ready_task_ids" => ready_tasks.map(&:id),
            "ready_task_keys" => ready_tasks.map(&:task_key),
            "ready_task_details" => ready_task_details,
            "newly_unblocked_keys" => newly_ready.map(&:task_key),
            "all_completed" => plan.completed? && released
          }
        end
      end
    end
  end
end
