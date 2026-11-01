# frozen_string_literal: true

class AcExecutionFence
  def self.synchronize(execution, validate: true)
    AcExecution.transaction do
      execution.ac_execution_profile.ac_policy_revision.lock!
      execution.ac_work_context.lock!
      execution.ac_task.ac_plan.lock!
      execution.ac_task.lock!
      execution.lock!
      AcAdmissionService.validate_execution_authority!(execution_id: execution.id,
        operation_id: execution.operation_id, reported_epoch: execution.epoch) if validate
      yield
    end
  end
end
