# frozen_string_literal: true

# AcReviewCouncilService — Conselho de Revisão Multi-Avaliador e Julgamento (P1 / F8, §15.4)
#
# §15.4: Template de conselho com vários revisores e julgador.
# Seus membros respeitam as vagas de avaliação; com duas vagas, três revisores executam em ondas.
# Ele não substitui o gerente e resolve divergências entre pareceres de qualidade.
class AcReviewCouncilService
  class CouncilError < StandardError; end
  class WaveCapacityExceededError < CouncilError; end
  class TaskNotReadyForAdjudicationError < CouncilError; end

  MAX_CONCURRENT_WAVE_SLOTS = 2

  class << self
    def submit_wave!(task:, wave_number:, reviews:)
      raise ArgumentError, "task e reviews são obrigatórios" if task.blank? || reviews.blank?

      if reviews.size > MAX_CONCURRENT_WAVE_SLOTS
        raise WaveCapacityExceededError,
              "Onda #{wave_number} excede o limite máximo de #{MAX_CONCURRENT_WAVE_SLOTS} avaliadores simultâneos (§15.4)"
      end

      created_verdicts = []

      AcReviewVerdict.transaction do
        reviews.each do |rev|
          role = rev[:role].to_s.in?(%w[reviewer qa]) ? rev[:role].to_s : "qa"
          verdict = AcReviewVerdict.create!(
            company: task.company,
            project: task.project,
            ac_task: task,
            verdict: rev[:verdict],
            reviewer_role: role,
            evaluator_identity: rev[:evaluator_identity] || rev[:reviewer_name] || "eval_#{role}_#{wave_number}",
            state: "valid",
            artifact_hash: rev[:artifact_hash] || "hash_wave_#{wave_number}",
            findings: rev[:findings] || [],
            metadata: {
              "wave_number" => wave_number,
              "reviewer_name" => rev[:reviewer_name] || "Reviewer_#{role}",
              "submitted_at" => Time.current.iso8601
            }
          )
          created_verdicts << verdict
        end
      end

      {
        wave_number: wave_number,
        verdicts_count: created_verdicts.size,
        verdicts: created_verdicts
      }
    end

    def adjudicate!(task:, judge_role: "qa", final_decision:, rationale:, artifact_hash:)
      raise ArgumentError, "task é obrigatório" if task.blank?

      verdicts = task.ac_review_verdicts.order(:id)
      if verdicts.empty?
        raise TaskNotReadyForAdjudicationError, "Nenhum parecer emitido para a tarefa; julgamento não aplicável"
      end

      # Cria o parecer soberano do julgador
      final_verdict = nil
      role = judge_role.to_s.in?(%w[reviewer qa]) ? judge_role.to_s : "qa"

      AcReviewVerdict.transaction do
        final_verdict = AcReviewVerdict.create!(
          company: task.company,
          project: task.project,
          ac_task: task,
          verdict: final_decision,
          reviewer_role: role,
          evaluator_identity: "judge_specialist_adjudicator",
          state: "valid",
          artifact_hash: artifact_hash,
          findings: [{ "rule" => "adjudication", "decision" => final_decision, "rationale" => rationale }],
          metadata: {
            "is_adjudication" => true,
            "rationale" => rationale,
            "adjudicated_at" => Time.current.iso8601
          }
        )

        if final_decision.to_s == "approved"
          task.update!(
            state: :approved,
            approved_commit_sha: "commit_adj_#{artifact_hash}",
            approved_artifact_hash: artifact_hash
          )
        elsif final_decision.to_s == "needs_changes"
          task.update!(state: :needs_changes)
        end
      end

      {
        adjudication_verdict: final_verdict,
        task_state: task.state,
        status: "adjudicated"
      }
    end
  end
end
