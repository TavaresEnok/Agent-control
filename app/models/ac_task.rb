# frozen_string_literal: true

# AcTask — Unidade de entrega do plano (RF-15, §6 — Tarefa)
#
# A tarefa é independente do provedor que a executará.
# Entidades de controle (TaskContract): projeto, contexto, plano/versão,
# tarefa, dependências, objetivo, escopo, critérios de aceite, classe de risco.
#
# RF-16: Paralelizar tarefas independentes; serializar dependências
# RF-18: QA e revisão independentes exigidos por risk_class
# RF-20: Retornar entrega reprovada à implementação
# RF-21: Limitar ciclos de correção
class AcTask < ApplicationRecord
  extend Enumerize

  # Locatário
  belongs_to :company
  belongs_to :project

  # Plano ao qual pertence
  belongs_to :ac_plan

  # Reservas de capacidade associadas
  has_many :ac_capacity_grants, foreign_key: :ac_task_id, dependent: :destroy, inverse_of: :ac_task

  # Observações de cota geradas por tentativas desta tarefa
  has_many :ac_quota_observations, foreign_key: :ac_task_id, dependent: :nullify, inverse_of: false

  # Eventos de auditoria
  has_many :ac_decision_audit_events, foreign_key: :ac_task_id,
           dependent: :nullify, inverse_of: false

  # Limite de tentativas (RF-21)
  MAX_ATTEMPT_COUNT = 5

  enumerize :state,
            in: %i[pending queued running review approved integrated failed cancelled],
            default: :pending, predicates: true, scope: true

  enumerize :risk_class, in: %i[low medium high critical],
            default: :medium, predicates: true

  enumerize :assigned_role,
            in: %i[programmer manager qa reviewer specialist integrator],
            default: :programmer, predicates: true

  # ── Validações ──────────────────────────────────────────────────────────
  validates :task_key, presence: true,
            format: { with: /\A[a-z0-9_\-]+\z/i }
  validates :task_key, uniqueness: { scope: :ac_plan_id,
            message: "já existe neste plano" }
  validates :title, presence: true, length: { maximum: 255 }
  validates :state, presence: true
  validates :risk_class, presence: true
  validates :assigned_role, presence: true
  validates :attempt_count, numericality: { greater_than_or_equal_to: 0, only_integer: true }

  # Artefato aprovado exige ambos hash e commit
  validate :approved_artifact_consistency

  # ── Escopos ─────────────────────────────────────────────────────────────
  scope :for_plan, ->(plan) { where(ac_plan: plan) }
  scope :actionable, -> { where(state: %w[pending queued running review]) }
  scope :by_position, -> { order(:position) }

  # Tarefas cujas dependências foram todas integradas
  scope :dependencies_met, ->(plan_id) {
    where(ac_plan_id: plan_id)
      .where("depends_on = '{}' OR NOT EXISTS (
        SELECT 1 FROM ac_tasks deps
        WHERE deps.ac_plan_id = ac_tasks.ac_plan_id
          AND deps.task_key = ANY(ac_tasks.depends_on)
          AND deps.state <> 'integrated'
      )")
  }

  # ── Limites de tentativa (RF-21) ──────────────────────────────────────────
  def attempt_limit_reached?
    attempt_count >= MAX_ATTEMPT_COUNT
  end

  # ── Verificações de qualidade obrigatória ─────────────────────────────────
  # RF-18: QA e revisão obrigatórios para risk_class >= high
  def requires_qa?
    high? || critical?
  end

  # ── Transições de estado ─────────────────────────────────────────────────
  def enqueue!
    update!(state: :queued)
  end

  def start_running!
    update!(state: :running, attempt_count: attempt_count + 1)
  end

  def submit_for_review!
    update!(state: :review)
  end

  def approve!(commit_sha:, artifact_hash:)
    update!(
      state: :approved,
      approved_commit_sha: commit_sha,
      approved_artifact_hash: artifact_hash
    )
  end

  def integrate!
    raise "Tarefa não aprovada" unless approved?

    update!(state: :integrated)
  end

  def reject_back_to_implementation!
    # RF-20: retorna à implementação preservando achados
    return if attempt_limit_reached?

    update!(state: :queued, approved_commit_sha: nil, approved_artifact_hash: nil)
  end

  def fail!(reason: nil)
    update!(state: :failed, metadata: metadata.merge("failure_reason" => reason))
  end

  def cancel!
    update!(state: :cancelled)
  end

  private

  def approved_artifact_consistency
    return if approved_commit_sha.blank? && approved_artifact_hash.blank?
    return if approved_commit_sha.present? && approved_artifact_hash.present?

    errors.add(:base, "approved_commit_sha e approved_artifact_hash devem ser preenchidos juntos (RF-19)")
  end
end
