# frozen_string_literal: true

# F3 — Serviço de Revisão Independente e Qualidade (AC Domain)
#
# Implementa as regras de qualidade do Plano Mestre (§15):
# - RF-18: Revisão independente obrigatória para código; parecer aprova hash exato de artefato
# - §15.1: Papéis separados (programador implementa, QA testa comportamento, revisor avalia diff)
# - §15.2: Independência mínima — sessões separadas, revisor não altera o código que vai aprovar
# - §15.3: Identidade de aprovação — novo artefato invalida parecer prévio
class AcReviewService
  class ReviewError < StandardError; end
  class InvalidVerdictError < ReviewError; end
  class SelfApprovalViolationError < ReviewError; end

  class << self
    def submit_verdict!(
      task:,
      artifact_hash:,
      verdict:,
      reviewer_role: :reviewer,
      evaluator_identity:,
      findings: [],
      candidate_commit_sha: nil,
      base_commit_hash: nil,
      execution: nil
    )
      raise ArgumentError, "task é obrigatório" if task.blank?
      raise ArgumentError, "artifact_hash é obrigatório" if artifact_hash.blank?
      raise ArgumentError, "evaluator_identity é obrigatório" if evaluator_identity.blank?

      # Validação de autoaprovação (§15.2):
      # O implementador não pode ser o mesmo avaliador independente para aprovar a entrega
      if verdict.to_s == "approved" && execution&.process_handle.present? && execution.process_handle == evaluator_identity
        raise SelfApprovalViolationError, "Autoaprovação proibida: o mesmo processo implementador não pode aprovar a entrega (§15.2)"
      end

      AcReviewVerdict.transaction do
        # 1. Registra o parecer estruturado
        record = AcReviewVerdict.create!(
          company: task.company,
          project: task.project,
          ac_task: task,
          ac_execution: execution,
          reviewer_role: reviewer_role,
          verdict: verdict,
          artifact_hash: artifact_hash,
          base_commit_hash: base_commit_hash,
          candidate_commit_sha: candidate_commit_sha,
          findings: findings || [],
          evaluator_identity: evaluator_identity,
          policy_revision_number: task.ac_plan&.policy_revision&.revision_number,
          state: :valid
        )

        # 2. Atualiza estado da tarefa conforme o parecer
        if %w[rejected needs_changes].include?(verdict.to_s)
          # Reprovação → retorna à implementação com achados (§12.2, §15.2)
          rejection_msg = "Reprovado por #{reviewer_role} (#{evaluator_identity}): #{(findings || []).size} achados registrados"
          task.reject_back_to_implementation!(reason: rejection_msg)
        elsif verdict.to_s == "approved"
          # Verifica se todos os critérios de aprovação exigidos por risk_class foram atendidos (§15.3, §15.4)
          if meets_approval_requirements?(task, artifact_hash)
            task.approve!(
              commit_sha: candidate_commit_sha || artifact_hash,
              artifact_hash: artifact_hash
            )
          end
        end

        record
      end
    end

    # §15.3: Invalidação de pareceres prévios quando um novo artefato/commit é produzido
    def invalidate_stale_verdicts!(task:, new_artifact_hash:)
      raise ArgumentError, "new_artifact_hash é obrigatório" if new_artifact_hash.blank?

      stale_verdicts = task.ac_review_verdicts
                           .where(state: :valid)
                           .where.not(artifact_hash: new_artifact_hash)

      stale_count = 0
      stale_verdicts.each do |v|
        v.invalidate!(reason: "Artefato alterado para #{new_artifact_hash} — parecer anterior desconsiderado (§15.3)")
        stale_count += 1
      end

      # Limpa campos de aprovação se apontavam para o artefato antigo
      if task.approved_artifact_hash.present? && task.approved_artifact_hash != new_artifact_hash
        task.update!(
          state: :needs_changes,
          approved_commit_sha: nil,
          approved_artifact_hash: nil
        )
      end

      stale_count
    end

    private

    def meets_approval_requirements?(task, artifact_hash)
      # Revisor de código é obrigatório
      reviewer_approved = task.ac_review_verdicts
                              .where(state: :valid, verdict: :approved, reviewer_role: :reviewer, artifact_hash: artifact_hash)
                              .exists?

      return false unless reviewer_approved

      # Se a tarefa exigir QA por risk_class (RF-18, §15.4), exige parecer de QA aprovado no MESMO artefato
      if task.requires_qa?
        qa_approved = task.ac_review_verdicts
                          .where(state: :valid, verdict: :approved, reviewer_role: :qa, artifact_hash: artifact_hash)
                          .exists?
        return false unless qa_approved
      end

      true
    end
  end
end
