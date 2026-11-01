# frozen_string_literal: true

module Activities
  module AgentControl
    module AcRemoteOperationBinding
      private

      def bound_execution!(input)
        required = %i[company_id task_id execution_id environment_id operation_id epoch manager_identity manager_epoch]
        raise ArgumentError, "Identidade de operação remota incompleta" unless required.all? { |key| input.public_send(key).present? }

        execution = AcExecution.find_by!(id: input.execution_id, company_id: input.company_id, ac_task_id: input.task_id)
        environment = AcRemoteEnvironment.find_by!(id: input.environment_id, company_id: input.company_id,
          project_id: execution.ac_task.project_id)
        unless execution.epoch.to_s == input.epoch.to_s &&
               execution.metadata["manager_identity"].to_s == input.manager_identity.to_s &&
               execution.metadata["manager_epoch"].to_s == input.manager_epoch.to_s
          raise AcAdmissionService::UnauthorizedExecutionBypassError, "Identidade ou época da execução divergente"
        end
        [ execution, environment ]
      end

      def bound_operation!(input)
        execution, environment = bound_execution!(input)
        operation = AcRemoteOperation.find_by!(operation_id: input.operation_id, company_id: execution.company_id,
          ac_task_id: execution.ac_task_id, ac_execution_id: execution.id, ac_remote_environment_id: environment.id)
        unless operation.metadata["execution_epoch"].to_s == execution.epoch.to_s
          raise AcAdmissionService::UnauthorizedExecutionBypassError, "Época da operação divergente"
        end
        [ operation, execution ]
      end

      def remote_status_result(status)
        { "operation_id" => status[:operation_id], "remote_job_id" => status[:remote_job_id],
          "state" => status[:state], "result" => (status[:result] || {}).transform_keys(&:to_s) }
      end
    end
  end
end
