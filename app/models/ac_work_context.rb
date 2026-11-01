# frozen_string_literal: true

# AcWorkContext — Contexto de trabalho persistente com gerente lógico
#
# Sobrevive à troca de conta, modelo e CLI (RF-03).
# Um projeto pode ter múltiplos contextos; cada um tem exatamente
# um gerente ativo autorizado (RF-04).
#
# Plano Mestre §6 (Contexto de trabalho), §11.1
class AcWorkContext < ApplicationRecord
  extend Enumerize

  # Locatário
  belongs_to :company
  belongs_to :project

  # Política vigente na criação
  belongs_to :policy_revision, class_name: "AcPolicyRevision",
             foreign_key: :policy_revision_id, optional: true

  # Planos associados
  has_many :ac_plans, foreign_key: :ac_work_context_id, dependent: :destroy, inverse_of: :ac_work_context

  # Eventos de auditoria
  has_many :ac_decision_audit_events, foreign_key: :ac_work_context_id,
           dependent: :nullify, inverse_of: false

  enumerize :state, in: %i[active paused archived suspended],
            default: :active, predicates: true, scope: true

  enumerize :origin, in: %i[new paseo_import migration],
            default: :new, predicates: true

  # ── Validações ──────────────────────────────────────────────────────────
  validates :external_id, presence: true, uniqueness: true,
            format: { with: /\A[a-z0-9_\-]+\z/i, message: "only letters, digits, hyphens and underscores" }
  validates :title, presence: true, length: { maximum: 255 }
  validates :state, presence: true
  validates :origin, presence: true

  # Pausa explícita exige motivo (RF-24)
  validate :pause_reason_required_when_paused

  # ── Escopos ─────────────────────────────────────────────────────────────
  scope :for_company, ->(company) { where(company: company) }
  scope :for_project, ->(project) { where(project: project) }
  scope :manageable, -> { where(state: %w[active paused suspended]) }

  # ── Transições de estado ─────────────────────────────────────────────────
  def pause!(reason:)
    update!(state: :paused, pause_reason: reason)
  end

  def resume!
    update!(state: :active, pause_reason: nil)
  end

  def suspend!(reason:)
    update!(state: :suspended, pause_reason: reason)
  end

  def archive!
    update!(state: :archived)
  end

  # ── Helpers ──────────────────────────────────────────────────────────────
  def active_plan
    ac_plans.where(state: :active).order(version: :desc).first
  end

  # ── Gerente Único Ativo por Contexto (RF-04) ─────────────────────────────
  def active_manager_identity
    metadata["active_manager_identity"]
  end

  def assign_active_manager!(identity:, expected_epoch: nil)
    raise ArgumentError, "Identidade do gerente é obrigatória (RF-04)" if identity.blank?

    with_lock do
      current = metadata.fetch("manager_epoch", 0).to_i
      return current if active_manager_identity == identity.to_s
      if active_manager_identity.present?
        raise ActiveRecord::StaleObjectError, "Troca de gerente requer reconciliação externa"
      end
      if expected_epoch.present? && expected_epoch.to_i != current
        raise ActiveRecord::StaleObjectError, "Época de gerente divergente"
      end
      pending_executions = AcExecution.where(ac_work_context_id: id)
      if pending_executions.where.not(state: %w[completed failed cancelled]).exists? ||
         pending_executions.where.not(worktree_lease_token: nil).exists? ||
         AcCapacityGrant.joins(ac_task: :ac_plan).where(ac_plans: { ac_work_context_id: id }, state: %w[granted active]).exists?
        raise ActiveRecord::StaleObjectError, "Execuções ou recursos anteriores exigem reconciliação"
      end
      plan_ids = AcPlan.where(ac_work_context_id: id).pluck(:id).map(&:to_s)
      previous_launches = TriggerEvent.where(company_id: company_id, source: "agent_control.plan.start")
      previous_launches = previous_launches.where("data ->> 'plan_id' IN (?)", plan_ids) if plan_ids.any?
      unreconciled = plan_ids.any? && previous_launches.any? do |event|
        previous_plan = AcPlan.find_by(id: event.data["plan_id"], ac_work_context_id: id)
        !previous_plan || !AcPlanLaunchService.terminal_ack?(plan: previous_plan,
          identity: event.data["manager_identity"], epoch: event.data["manager_epoch"])
      end
      raise ActiveRecord::StaleObjectError, "Lançamento anterior exige reconciliação" if unreconciled
      update!(metadata: metadata.merge("active_manager_identity" => identity.to_s,
        "manager_epoch" => current + 1, "manager_assigned_at" => Time.current.iso8601))
      current + 1
    end
  end

  def authorize_manager!(identity:, epoch:)
    unless active? && identity.present? && epoch.present? && active_manager_identity.present? &&
           identity.to_s == active_manager_identity && epoch.to_s == metadata["manager_epoch"].to_s
      raise ActiveRecord::StaleObjectError, "Gerente sem autoridade vigente"
    end
    true
  end

  private

  def pause_reason_required_when_paused
    return unless paused?
    return if pause_reason.present?

    errors.add(:pause_reason, "é obrigatório ao pausar o contexto (RF-24)")
  end
end
