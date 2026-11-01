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

      unless %w[approved rejected needs_changes].include?(verdict.to_s)
        raise InvalidVerdictError, "Dispensa de QA é decisão de política, não parecer do executor"
      end
      receipt = verify_execution!(task: task, execution: execution, role: reviewer_role.to_s,
        artifact_hash: artifact_hash, candidate_commit_sha: candidate_commit_sha, base_commit_hash: base_commit_hash)
      assessment = receipt.fetch("output", {}).fetch("review", {})
      unless evaluator_identity == execution.process_handle && assessment["verdict"] == verdict.to_s &&
             assessment["artifact_hash"] == artifact_hash && assessment["candidate_commit_sha"] == candidate_commit_sha &&
             assessment["base_commit_hash"] == base_commit_hash
        raise InvalidVerdictError, "Parecer não corresponde ao recibo independente"
      end

      AcExecutionFence.synchronize(execution, validate: false) do
        task.reload
        AcAdmissionService.ensure_task_authorized!(task)
        existing = task.ac_review_verdicts.find_by(ac_execution: execution, reviewer_role: reviewer_role,
          artifact_hash: artifact_hash, candidate_commit_sha: candidate_commit_sha, base_commit_hash: base_commit_hash, state: :valid)
        next existing if existing && existing.verdict.to_s == verdict.to_s
        unless %w[review approved].include?(task.state.to_s)
          raise InvalidVerdictError, "Tarefa não está na etapa de revisão"
        end
        implementation = task.ac_executions.joins(:ac_execution_profile).where(state: "completed",
          ac_execution_profiles: { role: "programmer" }).order(:id).last
        current = implementation&.output_payload || {}
        unless current["artifact_hash"] == artifact_hash && current["commit_sha"] == candidate_commit_sha &&
               current["base_commit_sha"] == base_commit_hash && !execution.ac_execution_profile.ac_policy_revision.revoked?
          raise InvalidVerdictError, "Parecer não corresponde à implementação atual"
        end
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
        elsif %w[approved waived].include?(verdict.to_s)
          # Verifica se todos os critérios de aprovação exigidos por risk_class foram atendidos (§15.3, §15.4, RF-57)
          if meets_approval_requirements?(task, artifact_hash)
            commit_to_approve = candidate_commit_sha.presence ||
                                task.ac_review_verdicts.where(state: :valid, reviewer_role: :reviewer, artifact_hash: artifact_hash).pluck(:candidate_commit_sha).compact.first.presence ||
                                raise(InvalidVerdictError, "Commit do parecer obrigatório")
            task.approve!(
              commit_sha: commit_to_approve,
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

    def verify_execution!(task:, execution:, role:, artifact_hash:, candidate_commit_sha:, base_commit_hash:)
      AcAdmissionService.ensure_task_authorized!(task)
      unless execution && !execution.ac_execution_profile&.ac_policy_revision&.revoked? && execution.ac_task_id == task.id && execution.company_id == task.company_id &&
             execution.state_completed? && execution.ac_execution_profile&.role.to_s == role && execution.exit_code == 0
        raise InvalidVerdictError, "Execução independente concluída obrigatória"
      end
      implementations = task.ac_executions.joins(:ac_execution_profile).where(ac_execution_profiles: { role: "programmer" })
      if implementations.where(process_handle: execution.process_handle).exists?
        raise SelfApprovalViolationError, "Sessão implementadora não pode validar a si mesma"
      end
      receipt = AcRuntimeSupervisorService.status!(execution: execution)
      output = receipt["output"] || {}
      unless receipt["state"] == "completed" && receipt["exit_code"] == 0 && output["artifact_hash"] == artifact_hash &&
             output["commit_sha"] == candidate_commit_sha && output["base_commit_sha"] == base_commit_hash
        raise InvalidVerdictError, "Artefato/base não correspondem à execução verificada"
      end
      receipt
    end

    private

    def meets_approval_requirements?(task, artifact_hash)
      # Revisor de código é obrigatório
      reviewer_approved = task.ac_review_verdicts
                              .where(state: :valid, verdict: :approved, reviewer_role: :reviewer, artifact_hash: artifact_hash)
                              .exists?

      return false unless reviewer_approved

      # Se a tarefa exigir QA por risk_class (RF-18, §15.4, RF-57), exige parecer de QA aprovado ou dispensado (waived) no MESMO artefato
      if task.requires_qa?
        qa_satisfied = task.ac_review_verdicts
                           .where(state: :valid, reviewer_role: :qa, artifact_hash: artifact_hash)
                           .where(verdict: "approved")
                           .exists?
        return false unless qa_satisfied
      end

      true
    end
  end
end
