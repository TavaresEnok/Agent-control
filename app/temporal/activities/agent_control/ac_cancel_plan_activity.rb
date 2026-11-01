# frozen_string_literal: true

module Activities
  module AgentControl
    class AcCancelPlanActivity < Activities::Base
      activity_name "ac_cancel_plan_activity"

      def run(input)
        plan = AcPlan.find(input.plan_id)
        AcWorkContext.transaction do
          plan.ac_work_context.lock!
          plan.lock!
          if plan.abandoned? && AcPlanLaunchService.terminal_ack?(plan: plan, identity: input.manager_identity, epoch: input.manager_epoch)
            next { "cancelled" => true, "plan_id" => plan.id, "release_pending" => false }
          end
          AcAdmissionService.validate_manager!(plan: plan, identity: input.manager_identity, epoch: input.manager_epoch, required: true, allow_paused: true)
          plan.cancel!(reason: input.reason) unless plan.abandoned?
          released = AcPlanLaunchService.release_manager_if_safe!(plan: plan, identity: input.manager_identity, epoch: input.manager_epoch)
          { "cancelled" => true, "plan_id" => plan.id, "release_pending" => !released }
        end
      end
    end
  end
end
