# frozen_string_literal: true

# The adapter must provide durable, idempotent dispatch and independently verifiable
# process receipts; a local PID or a caller supplied exit code is not a receipt.
class AcRuntimeSupervisorService
  class UnavailableError < StandardError; end
  class UnverifiedReceiptError < StandardError; end

  class << self
    def dispatch!(execution:)
      AcExecutionFence.synchronize(execution) do
        unless %w[granted preparing running].include?(execution.state.to_s)
          raise UnverifiedReceiptError, "Estado da execução não permite despacho"
        end
        grant = execution.ac_capacity_grant
        profile = execution.ac_execution_profile
        credential = profile&.agent_credential
        unless grant && profile && credential && credential.active? &&
               credential.company_id == execution.company_id && profile.company_id == execution.company_id &&
               grant.company_id == execution.company_id && grant.ac_task_id == execution.ac_task_id &&
               grant.ac_execution_profile_id == profile.id && grant.agent_credential_id == credential.id &&
               grant.operation_id == execution.operation_id && grant.epoch.to_s == execution.epoch.to_s &&
               %w[granted active].include?(grant.state.to_s)
          raise UnverifiedReceiptError, "Concessão, perfil ou conta não correspondem à execução"
        end
        AcSharedCapacityAuthorityService.ensure_bound!(execution: execution) if grant.reconciliation_data["authority"] == "shared"
        adapter = supervisor!
        receipt = adapter.dispatch!(execution: execution, operation_id: execution.operation_id, epoch: execution.epoch)
        verify!(adapter, execution, receipt, allowed: %w[running completed failed not_started])
      end
    end

    def cancel!(execution:)
      adapter = supervisor!
      raise UnavailableError, "Supervisor não confirma cancelamento" unless adapter.respond_to?(:cancel!)

      receipt = adapter.cancel!(execution: execution, operation_id: execution.operation_id, epoch: execution.epoch)
      verify!(adapter, execution, receipt, allowed: %w[completed failed not_started])
    end

    def status!(execution:)
      adapter = supervisor!
      receipt = adapter.status!(execution: execution, operation_id: execution.operation_id, epoch: execution.epoch)
      verify!(adapter, execution, receipt, allowed: %w[running completed failed not_started])
    end

    private

    def supervisor!
      adapter = Rails.application.config.try(:ac_runtime_supervisor) || AcContainerRuntimeSupervisor.new
      unless adapter && adapter.respond_to?(:dispatch!) && adapter.respond_to?(:status!) && adapter.respond_to?(:verify_receipt!)
        raise UnavailableError, "Supervisor de execução verificável não configurado"
      end
      adapter
    end

    def verify!(adapter, execution, receipt, allowed:)
      unless receipt.is_a?(Hash) && allowed.include?(receipt["state"]) &&
             receipt["operation_id"] == execution.operation_id && receipt["epoch"].to_s == execution.epoch.to_s &&
             receipt["process_handle"].present? &&
             (execution.process_handle.blank? || receipt["process_handle"] == execution.process_handle) &&
             adapter.verify_receipt!(execution: execution, receipt: receipt) == true
        raise UnverifiedReceiptError, "Recibo do supervisor não verificável"
      end
      if %w[completed failed].include?(receipt["state"]) &&
         (!receipt["exit_code"].is_a?(Integer) || (receipt["state"] == "completed") != receipt["exit_code"].zero?)
        raise UnverifiedReceiptError, "Recibo terminal sem código de saída"
      end
      if receipt["state"] == "not_started"
        task = execution.ac_task.reload
        fenced = task.cancelled? || task.ac_plan.reload.abandoned? || execution.ac_execution_profile.ac_policy_revision.reload.revoked?
        raise UnverifiedReceiptError, "Ausência física sem proibição de novo início" unless fenced && receipt["exit_code"].nil?
      end
      receipt
    end
  end
end
