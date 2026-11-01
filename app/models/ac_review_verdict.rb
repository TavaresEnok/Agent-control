# frozen_string_literal: true

# F3 — Parecer Estruturado de Qualidade e Revisão (AC Domain)
#
# Representa a avaliação formal de um artefato por QA ou Revisor independente (§15).
#
# RF-18: Revisão independente obrigatória para código; parecer aprova hash exato de artefato
# §15.1: Papéis e saídas diferentes (programador implementa, QA testa comportamento, revisor avalia diff)
# §15.2: Independência mínima — sessões separadas, revisor não altera o próprio código
# §15.3: Identidade de aprovação — novo artefato invalida parecer prévio
class AcReviewVerdict < ApplicationRecord
  self.table_name = "ac_review_verdicts"

  belongs_to :company
  belongs_to :project
  belongs_to :ac_task
  belongs_to :ac_execution, optional: true

  enum :verdict, {
    approved: "approved",
    rejected: "rejected",
    needs_changes: "needs_changes",
    waived: "waived"
  }, prefix: true

  enum :reviewer_role, {
    reviewer: "reviewer",
    qa: "qa"
  }, prefix: true

  enum :state, {
    valid: "valid",
    invalidated: "invalidated",
    superseded: "superseded"
  }, prefix: true

  validates :reviewer_role, presence: true
  validates :verdict, presence: true
  validates :artifact_hash, presence: true
  validates :evaluator_identity, presence: true
  validates :state, presence: true

  scope :valid_verdicts, -> { where(state: :valid) }
  scope :approvals, -> { where(state: :valid, verdict: :approved) }
  scope :rejections, -> { where(state: :valid, verdict: %w[rejected needs_changes]) }
  scope :for_task, ->(task) { where(ac_task_id: task.id) }
  scope :for_artifact, ->(hash) { where(artifact_hash: hash) }

  # Invalidação explícita de parecer quando o artefato é alterado (§15.3)
  def invalidate!(reason:)
    update!(
      state: :invalidated,
      invalidation_reason: reason
    )
  end

  # Substituição por um parecer mais recente para o mesmo artefato
  def supersede!(reason: "Substituído por avaliação posterior")
    update!(
      state: :superseded,
      invalidation_reason: reason
    )
  end
end
