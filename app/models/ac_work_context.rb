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

  def assign_active_manager!(identity:)
    raise ArgumentError, "Identidade do gerente é obrigatória (RF-04)" if identity.blank?

    update!(metadata: metadata.merge(
      "active_manager_identity" => identity.to_s,
      "manager_assigned_at" => Time.current.iso8601
    ))
  end

  private

  def pause_reason_required_when_paused
    return unless paused?
    return if pause_reason.present?

    errors.add(:pause_reason, "é obrigatório ao pausar o contexto (RF-24)")
  end
end
