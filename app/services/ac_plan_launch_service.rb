# frozen_string_literal: true

class AcPlanLaunchService
  EVENT_TYPE = "agent_control.plan.start"

  def self.record!(plan:, actor:)
    AcAdmissionService.ensure_plan_authorized!(plan)
    unless plan.project.accessible_by?(actor) && (actor.super_admin? || actor == plan.project.owner ||
      actor.company_memberships.active.where(company: plan.company, role: "admin").exists?)
      raise Pundit::NotAuthorizedError, "Sem autorização para iniciar o plano"
    end
    workflow_id = "ac-plan-#{plan.company_id}-#{plan.id}-#{plan.version}"
    key = "agent-control:launch:#{plan.company_id}:#{plan.id}:#{plan.version}"
    AcWorkContext.transaction do
      context = AcWorkContext.lock.find(plan.ac_work_context_id)
      plan.lock!
      AcAdmissionService.ensure_plan_authorized!(plan)
      existing = TriggerEvent.find_by(dedup_key: key)
      if existing
        AcAdmissionService.validate_manager!(plan: plan, identity: existing.data["manager_identity"],
          epoch: existing.data["manager_epoch"], required: true)
        next existing
      end
      if context.active_manager_identity.present?
        raise ActiveRecord::StaleObjectError, "Contexto já possui gerente; reconciliação obrigatória"
      end
      epoch = context.assign_active_manager!(identity: workflow_id, expected_epoch: context.metadata.fetch("manager_epoch", 0).to_i)
      context.update!(metadata: context.metadata.merge("manager_plan_id" => plan.id))
      plan.update!(metadata: plan.metadata.merge("manager_identity" => workflow_id, "manager_epoch" => epoch))
      TriggerEvent.create!(company: plan.company, project: plan.project, actor: actor, source: EVENT_TYPE,
        event_type: EVENT_TYPE, relay_state: "pending", occurred_at: Time.current, dedup_key: key,
        data: { "plan_id" => plan.id, "version" => plan.version, "content_hash" => plan.content_hash,
                "manager_identity" => workflow_id, "manager_epoch" => epoch })
    end
  end

  def self.terminal_ack?(plan:, identity:, epoch:)
    metadata = plan.metadata || {}
    %w[completed abandoned].include?(plan.state.to_s) && identity.present? && epoch.present? &&
      metadata["manager_released_identity"] == identity.to_s && metadata["manager_released_epoch"].to_s == epoch.to_s
  end

  def self.release_manager_if_safe!(plan:, identity:, epoch:)
    AcWorkContext.transaction do
      context = AcWorkContext.lock.find(plan.ac_work_context_id)
      plan.lock!
      next true if terminal_ack?(plan: plan, identity: identity, epoch: epoch)

      AcAdmissionService.validate_manager!(plan: plan, identity: identity, epoch: epoch, required: true, allow_paused: true)
      next false unless %w[completed abandoned].include?(plan.state.to_s)

      executions = AcExecution.where(ac_work_context_id: context.id)
      occupied = executions.where.not(state: %w[completed failed cancelled]).exists? ||
        executions.where.not(worktree_lease_token: nil).exists? ||
        AcCapacityGrant.joins(ac_task: :ac_plan).where(ac_plans: { ac_work_context_id: context.id }, state: %w[granted active]).exists?
      next false if occupied

      plan.update!(metadata: plan.metadata.merge("manager_released_identity" => identity.to_s,
        "manager_released_epoch" => epoch, "manager_released_at" => Time.current.iso8601))
      context.update!(metadata: context.metadata.except("active_manager_identity", "manager_plan_id", "manager_assigned_at"))
      true
    end
  end

  def self.dispatch_event(event)
    plan = AcPlan.where(company_id: event.company_id, project_id: event.project_id).find(event.data.fetch("plan_id"))
    raise ArgumentError, "Contrato do plano mudou" unless plan.version == event.data["version"] && plan.content_hash == event.data["content_hash"]
    identity = event.data.fetch("manager_identity")
    epoch = event.data.fetch("manager_epoch")
    return [] if terminal_ack?(plan: plan, identity: identity, epoch: epoch)

    AcAdmissionService.ensure_plan_authorized!(plan)
    AcAdmissionService.validate_manager!(plan: plan, identity: identity, epoch: epoch, required: true)
    result = TemporalService.start_workflow(TemporalWorkflowRegistry.ac_plan_execution_workflow_v2,
      { plan_id: plan.id, manager_identity: identity, manager_epoch: epoch }, id: identity, reject_duplicate: true)
    raise result[:error].to_s unless result[:ok]

    []
  end
end
