# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para admissão atômica da tarefa via AcAdmissionService
    class AcAdmitTaskActivity < Activities::Base
      activity_name "ac_admit_task_activity"

      def run(input)
        task_id = input.task_id
        operation_id = input.operation_id
        requested_by = input.requested_by || "temporal_workflow"
        origin = input.origin || "temporal"
        epoch = input.epoch || "1"
        profile_id = input.execution_profile_id

        task = AcTask.find(task_id)
        return { "cancelled" => true } if task.cancelled? || task.ac_plan.abandoned?
        profile = profile_id.present? ? AcExecutionProfile.find(profile_id) : nil

        result = AcAdmissionService.admit_execution!(
          task: task,
          operation_id: operation_id,
          requested_by: requested_by,
          origin: origin,
          execution_profile: profile,
          epoch: epoch,
          role: input.role,
          manager_identity: input.manager_identity,
          manager_epoch: input.manager_epoch
        )

        {
          "execution_id" => result[:execution].id,
          "grant_id" => result[:grant]&.id,
          "reused" => result[:reused],
          "state" => result[:execution].state,
          "profile_id" => result[:execution].ac_execution_profile_id,
          "operation_id" => operation_id,
          "epoch" => epoch
        }
      rescue AcAdmissionService::ProfileNotEligibleError, AcCapacityGrant::LimitExceededError => e
        task&.update!(metadata: (task.metadata || {}).merge("waiting_reason" => e.message))
        { "waiting" => true, "reason" => e.message }
      rescue AcAdmissionService::TaskNotEligibleForAdmissionError => e
        if task && (task.ac_plan.paused? || !task.ac_plan.ac_work_context.active?)
          { "waiting" => true, "reason" => e.message }
        else
          raise
        end
      end
    end
  end
end
