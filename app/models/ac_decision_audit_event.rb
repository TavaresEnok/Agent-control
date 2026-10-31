# frozen_string_literal: true

# AcDecisionAuditEvent — Registro append-only de decisões explicáveis (F1-D, RF-31, RF-09)
#
# Registra toda decisão de política: perfil selecionado ou recusado com motivo,
# concessão/negação de capacidade, publicação de política e intervenção humana.
# Garante o critério G1: "decisões explicáveis".
#
# Imutabilidade: registros são estritamente append-only (sem UPDATE nem DELETE).
class AcDecisionAuditEvent < ApplicationRecord
  self.table_name = "ac_decision_audit_events"

  EVENT_TYPES = %w[
    profile_selected
    profile_rejected
    capacity_granted
    capacity_denied
    capacity_revoked
    policy_published
    policy_revoked
    quota_state_changed
    task_state_changed
    human_intervention
    profile_substitution
  ].freeze

  ACTOR_TYPES = %w[human manager_agent policy_service system].freeze

  # Associações
  belongs_to :company
  belongs_to :project
  belongs_to :ac_work_context, optional: true
  belongs_to :ac_plan, optional: true
  belongs_to :ac_task, optional: true
  belongs_to :ac_execution_profile, optional: true
  belongs_to :ac_capacity_grant, optional: true
  belongs_to :ac_policy_revision, optional: true
  belongs_to :agent_credential, optional: true
  belongs_to :actor_user, class_name: "User", optional: true

  # Validações
  validates :event_type, presence: true, inclusion: { in: EVENT_TYPES }
  validates :actor_type, presence: true, inclusion: { in: ACTOR_TYPES }
  validates :occurred_at, presence: true
  validate :validate_decision_details_for_profile_decisions

  # Append-only: proíbe UPDATE e DELETE
  before_update :prevent_update
  before_destroy :prevent_destroy

  # Scopes
  scope :for_task, ->(task) { where(ac_task_id: task.is_a?(ActiveRecord::Base) ? task.id : task) }
  scope :for_context, ->(ctx) { where(ac_work_context_id: ctx.is_a?(ActiveRecord::Base) ? ctx.id : ctx) }
  scope :profile_decisions, -> { where(event_type: %w[profile_selected profile_rejected profile_substitution]) }
  scope :chronological, -> { order(occurred_at: :asc) }
  scope :reverse_chronological, -> { order(occurred_at: :desc) }

  # Fábricas convenientes para gravação de eventos de auditoria

  def self.record_profile_selection!(
    company:,
    project:,
    task:,
    profile:,
    policy_revision:,
    actor_type: "policy_service",
    actor_user: nil,
    reason: nil,
    alternatives_considered: [],
    metadata: {}
  )
    create!(
      company: company,
      project: project,
      ac_task: task,
      ac_plan_id: task&.ac_plan_id,
      ac_work_context_id: task&.ac_plan&.ac_work_context_id,
      ac_execution_profile: profile,
      ac_policy_revision: policy_revision,
      agent_credential_id: profile.agent_credential_id,
      event_type: "profile_selected",
      actor_type: actor_type,
      actor_user: actor_user,
      reason: reason || "Perfil #{profile.profile_key} selecionado conforme política #{policy_revision&.revision_number}",
      occurred_at: Time.current,
      decision_details: {
        selected_profile: {
          id: profile.id,
          profile_key: profile.profile_key,
          cli_adapter: profile.cli_adapter,
          model_id: profile.model_id,
          effort_level: profile.effort_level
        },
        policy_revision_id: policy_revision&.id,
        policy_revision_number: policy_revision&.revision_number,
        alternatives_considered: alternatives_considered
      },
      metadata: metadata
    )
  end

  def self.record_profile_rejection!(
    company:,
    project:,
    task:,
    profile:,
    policy_revision:,
    rejection_reason:,
    actor_type: "policy_service",
    actor_user: nil,
    metadata: {}
  )
    create!(
      company: company,
      project: project,
      ac_task: task,
      ac_plan_id: task&.ac_plan_id,
      ac_work_context_id: task&.ac_plan&.ac_work_context_id,
      ac_execution_profile: profile,
      ac_policy_revision: policy_revision,
      event_type: "profile_rejected",
      actor_type: actor_type,
      actor_user: actor_user,
      reason: rejection_reason,
      occurred_at: Time.current,
      decision_details: {
        rejected_profile: {
          id: profile.id,
          profile_key: profile.profile_key,
          cli_adapter: profile.cli_adapter,
          model_id: profile.model_id
        },
        rejection_reason: rejection_reason,
        policy_revision_id: policy_revision&.id,
        policy_revision_number: policy_revision&.revision_number
      },
      metadata: metadata
    )
  end

  def self.record_capacity_granted!(
    grant:,
    actor_type: "system",
    metadata: {}
  )
    create!(
      company: grant.company,
      project: grant.ac_task&.project,
      ac_task_id: grant.ac_task_id,
      ac_execution_profile_id: grant.ac_execution_profile_id,
      ac_capacity_grant: grant,
      agent_credential_id: grant.agent_credential_id,
      event_type: "capacity_granted",
      actor_type: actor_type,
      occurred_at: Time.current,
      execution_epoch: grant.epoch,
      reason: "Capacidade concedida: #{grant.quantity} unidades (#{grant.resource_type}) até #{grant.expires_at&.iso8601}",
      decision_details: {
        quantity: grant.quantity,
        epoch: grant.epoch,
        expires_at: grant.expires_at&.iso8601,
        resource_type: grant.resource_type
      },
      metadata: metadata
    )
  end

  def self.record_capacity_denied!(
    company:,
    project:,
    task:,
    profile:,
    reason:,
    actor_type: "system",
    metadata: {}
  )
    create!(
      company: company,
      project: project,
      ac_task: task,
      ac_execution_profile: profile,
      event_type: "capacity_denied",
      actor_type: actor_type,
      occurred_at: Time.current,
      reason: reason,
      decision_details: {
        denial_reason: reason,
        profile_id: profile&.id
      },
      metadata: metadata
    )
  end

  def self.record_human_intervention!(
    company:,
    project:,
    task: nil,
    user:,
    action:,
    reason:,
    metadata: {}
  )
    create!(
      company: company,
      project: project,
      ac_task: task,
      actor_type: "human",
      actor_user: user,
      event_type: "human_intervention",
      occurred_at: Time.current,
      reason: reason,
      decision_details: {
        action: action,
        user_email: user.email,
        user_id: user.id
      },
      metadata: metadata
    )
  end

  # Representação legível para auditoria / G1
  def explain
    {
      id: id,
      event_type: event_type,
      occurred_at: occurred_at&.iso8601,
      actor: "#{actor_type}#{actor_user ? " (#{actor_user.email})" : ''}",
      reason: reason,
      details: decision_details,
      epoch: execution_epoch
    }
  end

  private

  def validate_decision_details_for_profile_decisions
    return unless %w[profile_selected profile_rejected profile_substitution].include?(event_type)

    if decision_details.blank?
      errors.add(:decision_details, "não pode ser vazio para eventos de decisão de perfil (critério G1)")
    end
  end

  def prevent_update
    errors.add(:base, "AcDecisionAuditEvent é append-only e não pode ser atualizado")
    throw(:abort)
  end

  def prevent_destroy
    errors.add(:base, "AcDecisionAuditEvent é append-only e não pode ser excluído")
    throw(:abort)
  end
end
