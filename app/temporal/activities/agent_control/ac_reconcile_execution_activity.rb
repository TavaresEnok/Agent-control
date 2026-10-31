# frozen_string_literal: true

module Activities
  module AgentControl
    # Atividade para reconciliação do término de processo com validação de época (§11.3)
    class AcReconcileExecutionActivity < Activities::Base
      activity_name "ac_reconcile_execution_activity"

      def run(input)
        execution_id = input.execution_id
        reported_epoch = input.epoch
        exit_code = input.exit_code || 0
        output = input.output || {}
        error = input.error || {}

        execution = AcExecution.find(execution_id)

        # Reconciliação com validação estrita de época (§11.3)
        execution.reconcile_outcome!(
          exit_code: exit_code,
          reported_epoch: reported_epoch,
          output: output,
          error: error
        )

        task = execution.ac_task
        if exit_code == 0
          task.update!(state: :review) if task.respond_to?(:state) && task.state != "completed"
        else
          task.update!(state: :failed) if task.respond_to?(:state)
        end

        {
          "execution_id" => execution.id,
          "state" => execution.state,
          "exit_code" => execution.exit_code,
          "finished_at" => execution.finished_at&.iso8601
        }
      end
    end
  end
end
