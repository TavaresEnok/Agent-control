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

        {
          "plan_id" => plan.id,
          "ready_task_ids" => ready_tasks.map(&:id),
          "ready_task_keys" => ready_tasks.map(&:task_key),
          "newly_unblocked_keys" => newly_ready.map(&:task_key),
          "all_completed" => plan.all_tasks_completed?
        }
      end
    end
  end
end
