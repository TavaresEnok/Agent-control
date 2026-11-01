# frozen_string_literal: true

module Activities
  module AgentControl
    class AcReconcileExecutionActivity < Activities::Base
      activity_name "ac_reconcile_execution_activity"

      def run(input)
        execution = AcExecution.find(input.execution_id)
        raise AcExecution::StaleEpochError, "Época divergente" if execution.epoch.to_s != input.epoch.to_s

        AcExecutionFence.synchronize(execution, validate: false) do
          task = execution.ac_task
          AcAdmissionService.validate_manager!(plan: task.ac_plan, identity: execution.metadata["manager_identity"],
            epoch: execution.metadata["manager_epoch"], allow_paused: true)
          raise AcExecution::StaleEpochError, "Época divergente" if execution.epoch.to_s != input.epoch.to_s
          if execution.state.to_s == "cancelled"
            next { "execution_id" => execution.id, "state" => "cancelled", "exit_code" => execution.exit_code }
          end
          if task.cancelled? || task.ac_plan.abandoned? || execution.ac_execution_profile.ac_policy_revision.revoked?
            receipt = AcRuntimeSupervisorService.cancel!(execution: execution)
            execution.cancel!(reason: "Cancelamento/fencing confirmado pelo runtime")
            next { "execution_id" => execution.id, "state" => "cancelled", "exit_code" => receipt["exit_code"] }
          end
          receipt = AcRuntimeSupervisorService.status!(execution: execution)
          unless %w[completed failed].include?(receipt["state"])
            execution.mark_uncertain!(reason: "Supervisor ainda não comprovou término")
            next { "execution_id" => execution.id, "state" => execution.state, "exit_code" => nil }
          end

          exit_code = receipt.fetch("exit_code")
          if execution.metadata["outcome_reconciled"]
            next { "execution_id" => execution.id, "state" => execution.state,
                     "exit_code" => execution.exit_code, "finished_at" => execution.finished_at&.iso8601 }
          end

          error = receipt["error"].is_a?(Hash) ? receipt["error"] : {}
          stderr = error["stderr"].to_s
          category = exit_code.zero? ? :unknown : AcQuotaService.new(company: task.company).classify(stderr, exit_code).first
          infrastructure_failure = %i[exhausted rate_limited auth_error network_error].include?(category)
          if infrastructure_failure
            observation = AcQuotaService.record_from_output!(company: task.company, agent_credential: execution.ac_execution_profile.agent_credential,
              cli_adapter: execution.ac_execution_profile.cli_adapter, model_scope: execution.ac_execution_profile.model_id,
              raw_output: stderr, task: task, exit_code: exit_code)
            error = { "stderr" => observation.redacted_evidence, "failure_category" => category.to_s }
          end
          execution.reconcile_outcome!(exit_code: exit_code, reported_epoch: input.epoch,
                                       output: receipt["output"] || {}, error: error)
          role = execution.ac_execution_profile.role.to_s
          if infrastructure_failure
            if role == "programmer" && task.state.to_s == "running"
              task.update!(state: :queued, attempt_count: [ task.attempt_count - 1, 0 ].max,
                           metadata: task.metadata.merge("waiting_reason" => category.to_s, "waiting_role" => role))
            elsif %w[qa reviewer].include?(role) && task.state.to_s == "review"
              task.update!(metadata: task.metadata.merge("waiting_reason" => category.to_s, "waiting_role" => role))
            end
          elsif role == "programmer"
            if exit_code.zero?
              AcReviewService.invalidate_stale_verdicts!(task: task, new_artifact_hash: receipt.fetch("output").fetch("artifact_hash"))
              task.update!(state: :review, metadata: task.metadata.except("review_execution_id", "verification_execution_id", "waiting_reason", "waiting_role"))
            else
              task.reject_back_to_implementation!(reason: error.fetch("stderr", "Implementação falhou"))
            end
          elsif !exit_code.zero?
            task.reject_back_to_implementation!(reason: "Validação independente falhou")
          else
            key = role == "qa" ? "verification_execution_id" : "review_execution_id"
            task.update!(metadata: task.metadata.except("waiting_reason", "waiting_role").merge(key => execution.id))
          end
          execution.update!(metadata: execution.metadata.merge("outcome_reconciled" => true, "failure_category" => (category.to_s if infrastructure_failure)))
          { "execution_id" => execution.id, "state" => execution.state,
            "exit_code" => execution.exit_code, "finished_at" => execution.finished_at&.iso8601 }
        end
      rescue AcRuntimeSupervisorService::UnavailableError, AcRuntimeSupervisorService::UnverifiedReceiptError => e
        if execution
          AcExecutionFence.synchronize(execution, validate: false) do
            execution.mark_uncertain!(reason: e.message) unless %w[completed failed cancelled].include?(execution.state.to_s)
          end
        end
        raise
      end
    end
  end
end
