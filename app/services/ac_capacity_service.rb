# frozen_string_literal: true

# AcCapacityService — Gestão atômica de reservas de capacidade e ciclo de vida (F1-C)
#
# Coordena a reserva atômica de slots de capacidade por tentativa (RF-13, RF-47, §11.3):
# - Concessão atômica via SELECT FOR UPDATE / transação
# - Idempotência por operation_id
# - Registro de auditoria append-only de concessão e negação
# - Liberação e expiração reconciliadas
class AcCapacityService
  Result = Struct.new(:success?, :grant, :denial_reason, keyword_init: true)

  def self.grant!(task:, profile:, operation_id:, epoch:, expires_in: 30.minutes, quantity: 1, resource_type: :inference_slot)
    new(company: task.company, project: task.project).grant(
      task: task,
      profile: profile,
      operation_id: operation_id,
      epoch: epoch,
      expires_in: expires_in,
      quantity: quantity,
      resource_type: resource_type
    )
  end

  def self.release!(grant:)
    new(company: grant.company, project: grant.ac_task&.project).release(grant: grant)
  end

  def initialize(company:, project:)
    @company = company
    @project = project
  end

  def grant(task:, profile:, operation_id:, epoch:, expires_in: 30.minutes, quantity: 1, resource_type: :inference_slot)
    policy_rev = profile.ac_policy_revision

    begin
      grant = AcCapacityGrant.grant_atomically!(
        company: @company,
        ac_task: task,
        ac_execution_profile: profile,
        agent_credential: profile.agent_credential,
        operation_id: operation_id,
        epoch: epoch,
        policy_revision_id: policy_rev.id,
        policy_revision_number: policy_rev.revision_number,
        quantity: quantity,
        resource_type: resource_type,
        expires_in: expires_in
      )

      AcDecisionAuditEvent.record_capacity_granted!(
        grant: grant,
        actor_type: "system",
        metadata: { task_key: task.task_key, profile_key: profile.profile_key }
      )

      Result.new(success?: true, grant: grant, denial_reason: nil)
    rescue AcCapacityGrant::LimitExceededError => e
      AcDecisionAuditEvent.record_capacity_denied!(
        company: @company,
        project: @project,
        task: task,
        profile: profile,
        reason: e.message,
        actor_type: "system"
      )

      Result.new(success?: false, grant: nil, denial_reason: e.message)
    end
  end

  def release(grant:)
    return false unless grant.granted? || grant.active?

    grant.release!
    true
  end

  def reap_expired!
    expired_count = 0
    AcCapacityGrant.for_company(@company).active_or_granted.where("expires_at <= ?", Time.current).find_each do |grant|
      grant.expire!
      expired_count += 1
    end
    expired_count
  end
end
