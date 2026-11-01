# frozen_string_literal: true

module Workflows
  # A new workflow name keeps previously recorded v1 histories on their original
  # command sequence. New callers explicitly select this version.
  class AcPlanExecutionWorkflowV2 < Workflows::Base
    workflow_name "ac_plan_execution_workflow_v2"

    workflow_signal
    def pause_plan
      @paused = true
    end

    workflow_signal
    def resume_plan
      @paused = false
    end

    workflow_signal
    def cancel_plan(reason = "Cancelado")
      @cancelled = reason
    end

    def run(input)
      loop do
        Temporalio::Workflow.wait_condition { !@paused || @cancelled } if @paused
        if @cancelled
          finish_cancellation(input)
          return { "status" => "cancelled" }
        end

        state = execute_activity(activities.ac_advance_plan_dag_activity, { plan_id: input.plan_id, manager_identity: input.manager_identity, manager_epoch: input.manager_epoch })
        return { "status" => "cancelled" } if state["cancelled"]
        return { "status" => "completed" } if state["all_completed"]
        return { "status" => "blocked", "reason" => "Tarefa atingiu limite de correções" } if state["blocked"]
        if state["paused"] || state["ready_task_details"].empty?
          Temporalio::Workflow.sleep(10)
          next
        end
        # Workflow futures are replayable and keep independent tasks concurrent.
        futures = state["ready_task_details"].map do |detail|
          Temporalio::Workflow::Future.new { process_task(input.plan_id, detail, input.manager_identity, input.manager_epoch) }
        end
        Temporalio::Workflow.wait_condition { @cancelled || futures.all?(&:done?) }
        if @cancelled
          execute_activity(activities.ac_cancel_plan_activity, { plan_id: input.plan_id, reason: @cancelled, manager_identity: input.manager_identity, manager_epoch: input.manager_epoch })
        end
        errors = []
        futures.each do |future|
          begin
            future.wait
          rescue StandardError => e
            errors << e
          end
        end
        if @cancelled
          finish_cancellation(input)
          return { "status" => "cancelled" }
        end
        raise errors.first if errors.any?
      end
    end

    private

    def finish_cancellation(input)
      loop do
        result = execute_activity(activities.ac_cancel_plan_activity,
          { plan_id: input.plan_id, reason: @cancelled, manager_identity: input.manager_identity, manager_epoch: input.manager_epoch })
        return unless result["release_pending"]

        Temporalio::Workflow.sleep(10)
      end
    end

    def process_task(plan_id, detail, manager_identity, manager_epoch)
      id = detail.fetch("id")
      generations = detail.fetch("phase_generations", {})
      if %w[pending queued needs_changes].include?(detail["state"])
        execute_phase(plan_id, id, "programmer", generations.fetch("programmer", 0).to_i + 1, manager_identity, manager_epoch)
      elsif detail["state"] == "review"
        %w[qa reviewer].each do |role|
          previous = detail[role == "qa" ? "verification_execution_id" : "review_execution_id"]
          result = previous ? { "status" => "completed", "execution_id" => previous } :
            execute_phase(plan_id, id, role, generations.fetch(role, 0).to_i + 1, manager_identity, manager_epoch)
          break unless result["status"] == "completed"

          assessment = execute_activity(activities.ac_review_task_activity, { task_id: id, execution_id: result["execution_id"], manager_identity: manager_identity, manager_epoch: manager_epoch })
          break if assessment["task_state"] == "needs_changes"
        end
      elsif detail["state"] == "approved"
        execute_activity(activities.ac_integrate_task_activity,
          { task_id: id, manager_identity: manager_identity, manager_epoch: manager_epoch, expected_base_commit: detail["execution_base_commit_sha"],
            candidate_commit: detail["approved_commit_sha"], artifact_hash: detail["approved_artifact_hash"],
            verification_evidence: { execution_id: detail["verification_execution_id"] } })
      end
    end

    def execute_phase(plan, task, role, attempt, manager_identity, manager_epoch)
      key = "ac-v2-#{plan}-#{task}-#{role}-#{attempt}"
      Temporalio::Workflow.execute_child_workflow("ac_task_execution_workflow_v2",
        { task_id: task, operation_id: key, epoch: attempt.to_s, role: role, origin: "temporal", manager_identity: manager_identity, manager_epoch: manager_epoch }, id: key)
    end
  end
end
