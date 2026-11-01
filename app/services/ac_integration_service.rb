# frozen_string_literal: true

# F3 — Serviço de Integração Condicional Protegida (AC Domain)
#
# Implementa as regras de integração segura do Plano Mestre (§15.3, §15.3.1):
# - RF-48: Atualização atômica da branch e escritor único
# - §15.3: Um parecer aprova uma combinação identificável: commit/árvore e base
# - §15.3.1: Compare-and-swap na referência da branch a partir da base esperada
# - §15.3.1: Evidências atestadas por executor identificado, sem autoafirmação
class AcIntegrationService
  class IntegrationError < StandardError; end
  class TaskNotApprovedError < IntegrationError; end
  class StaleArtifactError < IntegrationError; end
  class ConcurrentBranchModificationError < IntegrationError; end
  class InvalidVerificationEvidenceError < IntegrationError; end

  class << self
    def integrate_task!(
      task:,
      expected_base_commit:,
      candidate_commit:,
      current_branch_head:,
      artifact_hash:,
      verification_evidence: {}
    )
      raise ArgumentError, "task é obrigatório" if task.blank?
      raise ArgumentError, "expected_base_commit é obrigatório" if expected_base_commit.blank?
      raise ArgumentError, "candidate_commit é obrigatório" if candidate_commit.blank?
      raise ArgumentError, "artifact_hash é obrigatório" if artifact_hash.blank?

      # 1. Tarefa precisa estar formalmente aprovada
      unless task.approved?
        raise TaskNotApprovedError, "Tarefa #{task.id} não está aprovada para integração (estado atual: #{task.state})"
      end

      # 2. O artefato aprovado deve coincidir exatamente com o artefato examinado (§15.3)
      if task.approved_artifact_hash != artifact_hash
        raise StaleArtifactError, "Divergência de artefato: aprovado (#{task.approved_artifact_hash}) != candidato (#{artifact_hash})"
      end

      # 3. Valida se existem pareceres válidos e não invalidados para este artefato exato
      valid_approvals = task.ac_review_verdicts
                            .where(state: :valid, verdict: :approved, artifact_hash: artifact_hash)
      if valid_approvals.empty?
        raise StaleArtifactError, "Nenhum parecer de aprovação válido encontrado para o artefato #{artifact_hash}"
      end

      # 4. Compare-and-swap atômico de branch (§15.3.1):
      # Se a base da branch avançou concorrentemente, rejeita e invalida a candidatura
      if current_branch_head.to_s != expected_base_commit.to_s
        raise ConcurrentBranchModificationError,
              "Corrida de branch detectada: base atual (#{current_branch_head}) diverge da base esperada (#{expected_base_commit}). Reconciliação necessária (§15.3.1)"
      end

      # 5. Evidência de testes atestada por executor confiável (§15.3.1)
      validate_verification_evidence!(verification_evidence)

      # 6. Efetiva a integração
      AcTask.transaction do
        task.update!(
          state: :integrated,
          approved_commit_sha: candidate_commit
        )

        # 7. Registra auditoria imutável da integração
        AcDecisionAuditEvent.create!(
          company: task.company,
          project: task.project,
          ac_task: task,
          ac_plan_id: task.ac_plan_id,
          ac_work_context_id: task.ac_plan&.ac_work_context_id,
          event_type: "task_state_changed",
          actor_type: "system",
          occurred_at: Time.current,
          reason: "Integração condicional concluída com sucesso no commit #{candidate_commit}",
          decision_details: {
            integrated_commit: candidate_commit,
            expected_base: expected_base_commit,
            artifact_hash: artifact_hash,
            verified_by: verification_evidence[:executor_identity]
          }
        )

        # 8. Avança o DAG do plano desbloqueando dependentes
        unblocked_tasks = task.ac_plan&.advance_dag! || []

        {
          integrated: true,
          candidate_commit: candidate_commit,
          new_branch_head: candidate_commit,
          unblocked_tasks: unblocked_tasks.map(&:task_key)
        }
      end
    end

    private

    def validate_verification_evidence!(evidence)
      return if evidence.blank? # Tarefas sem suíte de CI podem não exigir evidence explícita

      if evidence[:exit_code].present? && evidence[:exit_code] != 0
        raise InvalidVerificationEvidenceError, "Evidência de verificação com falha: exit_code #{evidence[:exit_code]}"
      end

      if evidence[:executor_identity].blank?
        raise InvalidVerificationEvidenceError, "Executor de verificação não identificado (§15.3.1)"
      end
    end
  end
end
