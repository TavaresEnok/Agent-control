# frozen_string_literal: true

class AcReviewCouncilService
  class CouncilError < StandardError; end
  class WaveCapacityExceededError < CouncilError; end
  class TaskNotReadyForAdjudicationError < CouncilError; end

  MAX_CONCURRENT_WAVE_SLOTS = 2

  class << self
    def submit_wave!(task:, wave_number:, reviews:)
      raise ArgumentError, "task e reviews são obrigatórios" if task.blank? || reviews.blank?
      raise ArgumentError, "onda inválida" unless wave_number.is_a?(Integer) && wave_number.positive?
      raise WaveCapacityExceededError, "Onda excede o limite de avaliadores" if reviews.size > MAX_CONCURRENT_WAVE_SLOTS

      verdicts = AcReviewVerdict.transaction do
        reviews.map do |review|
          data = review.to_h.with_indifferent_access
          submit_review!(task, data)
        end
      end
      { wave_number: wave_number, verdicts_count: verdicts.size, verdicts: verdicts }
    end

    def adjudicate!(task:, judge_role: "qa", final_decision:, rationale:, artifact_hash:,
                    execution_id: nil, evaluator_identity: nil, candidate_commit_sha: nil, base_commit_hash: nil)
      raise ArgumentError, "task é obrigatório" if task.blank?
      raise ArgumentError, "justificativa é obrigatória" if rationale.blank?

      data = { role: judge_role, verdict: final_decision, artifact_hash: artifact_hash,
               execution_id: execution_id, evaluator_identity: evaluator_identity,
               candidate_commit_sha: candidate_commit_sha, base_commit_hash: base_commit_hash }.with_indifferent_access
      result = AcReviewVerdict.transaction do
        submit_review!(task, data, rationale: rationale, require_prior: true)
      end
      { adjudication_verdict: result, task_state: task.reload.state, status: "adjudicated" }
    end

    private

    def submit_review!(task, data, rationale: nil, require_prior: false)
      role = data[:role].to_s
      unless %w[reviewer qa].include?(role) && %i[execution_id evaluator_identity artifact_hash candidate_commit_sha base_commit_hash verdict].all? { |key| data[key].present? }
        raise CouncilError, "Execução, papel, identidade e artefato/base/candidato são obrigatórios"
      end
      execution = AcExecution.where(company_id: task.company_id, ac_task_id: task.id).find_by(id: data[:execution_id])
      raise CouncilError, "Execução não pertence à tarefa" unless execution

      AcExecutionFence.synchronize(execution, validate: false) do
        prior = task.ac_review_verdicts.where(state: :valid, artifact_hash: data[:artifact_hash]).to_a
        if require_prior && prior.empty?
          raise TaskNotReadyForAdjudicationError, "Nenhum parecer válido para o artefato"
        end
        prior.each { |verdict| verify_prior!(task, verdict, data) }
        if prior.any? { |verdict| verdict.ac_execution_id == execution.id || verdict.evaluator_identity == execution.process_handle }
          raise CouncilError, "Avaliador deve ser independente dos pareceres anteriores"
        end

        receipt = AcReviewService.verify_execution!(task: task, execution: execution, role: role,
          artifact_hash: data[:artifact_hash], candidate_commit_sha: data[:candidate_commit_sha], base_commit_hash: data[:base_commit_hash])
        assessment = receipt.fetch("output", {}).fetch("review", {})
        if rationale && assessment["rationale"] != rationale
          raise CouncilError, "Justificativa não corresponde ao recibo do julgador"
        end
        findings = assessment["findings"]
        raise CouncilError, "Achados do recibo inválidos" unless findings.is_a?(Array)
        if data.key?(:findings) && data[:findings] != findings
          raise CouncilError, "Achados não correspondem ao recibo"
        end

        AcReviewService.submit_verdict!(task: task, execution: execution, reviewer_role: role,
          evaluator_identity: data[:evaluator_identity], verdict: data[:verdict], artifact_hash: data[:artifact_hash],
          candidate_commit_sha: data[:candidate_commit_sha], base_commit_hash: data[:base_commit_hash], findings: findings)
      end
    end

    def verify_prior!(task, verdict, data)
      unless verdict.ac_execution && verdict.candidate_commit_sha == data[:candidate_commit_sha] &&
             verdict.base_commit_hash == data[:base_commit_hash] && verdict.evaluator_identity == verdict.ac_execution.process_handle
        raise CouncilError, "Parecer anterior sem execução ou identidade verificável"
      end
      receipt = AcReviewService.verify_execution!(task: task, execution: verdict.ac_execution, role: verdict.reviewer_role.to_s,
        artifact_hash: verdict.artifact_hash, candidate_commit_sha: verdict.candidate_commit_sha, base_commit_hash: verdict.base_commit_hash)
      assessment = receipt.fetch("output", {}).fetch("review", {})
      unless assessment["verdict"] == verdict.verdict.to_s && assessment["artifact_hash"] == verdict.artifact_hash &&
             assessment["candidate_commit_sha"] == verdict.candidate_commit_sha && assessment["base_commit_hash"] == verdict.base_commit_hash &&
             assessment["findings"] == verdict.findings
        raise CouncilError, "Parecer anterior não corresponde ao recibo"
      end
    end
  end
end
