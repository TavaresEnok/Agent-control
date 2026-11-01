# frozen_string_literal: true

require "open3"
require "digest"

class AcIntegrationService
  class IntegrationError < StandardError; end
  class TaskNotApprovedError < IntegrationError; end
  class StaleArtifactError < IntegrationError; end
  class ConcurrentBranchModificationError < IntegrationError; end
  class InvalidVerificationEvidenceError < IntegrationError; end

  class << self
    def integrate_task!(task:, expected_base_commit:, candidate_commit:, current_branch_head: nil,
                        artifact_hash:, verification_evidence: {}, repo_path: nil, manager_identity: nil, manager_epoch: nil, require_manager: false)
      raise ArgumentError, "Tarefa obrigatória" unless task
      if AcIntegrationOperation.connection_pool.with_connection(&:transaction_open?)
        raise IntegrationError, "Integração deve iniciar fora de transação SQL para persistir a intenção antes do Git"
      end

      AcAdmissionService.validate_manager!(plan: task.ac_plan, identity: manager_identity, epoch: manager_epoch, required: require_manager)
      repo_path ||= task.ac_plan.ac_work_context.metadata["git_repo_path"] || task.project.custom_fields&.dig("git_repo_path")
      raise IntegrationError, "Repositório físico obrigatório" if repo_path.blank?

      branch = task.metadata["target_branch"].presence || "main"
      ref = branch.start_with?("refs/heads/") ? branch : "refs/heads/#{branch}"
      identity = Digest::SHA256.hexdigest([ task.id, ref, expected_base_commit, candidate_commit, artifact_hash ].join(":"))
      # The intent commits before Git: a database rollback cannot erase the only
      # evidence that an external compare-and-swap may already have happened.
      operation = AcIntegrationOperation.create_or_find_by!(identity: identity) do |record|
        record.assign_attributes(ac_task: task, branch_ref: ref, base_commit: expected_base_commit,
          candidate_commit: candidate_commit, artifact_hash: artifact_hash)
      end
      AcTask.transaction do
        task.ac_plan.policy_revision&.lock!
        task.ac_plan.ac_work_context.lock!
        task.ac_plan.lock!
        task.lock!
        task.project.lock!
        task.reload
        AcAdmissionService.ensure_plan_authorized!(task.ac_plan)
        AcAdmissionService.validate_manager!(plan: task.ac_plan, identity: manager_identity, epoch: manager_epoch, required: require_manager)
        branch = task.metadata["target_branch"].presence || "main"
        ref = branch.start_with?("refs/heads/") ? branch : "refs/heads/#{branch}"
        git!(repo_path, "check-ref-format", ref)
        implementation = task.ac_executions.joins(:ac_execution_profile).where(state: "completed", ac_execution_profiles: { role: "programmer" }).order(:id).last
        source = implementation&.worktree_path
        raise StaleArtifactError, "Repositório da implementação ausente" if source.blank?
        actual_hash = AcArtifactIdentity.digest(repo: source, commit: candidate_commit, base: expected_base_commit)
        unless actual_hash == artifact_hash && task.approved_artifact_hash == actual_hash && task.approved_commit_sha == candidate_commit
          raise StaleArtifactError, "Candidato não corresponde ao artefato aprovado"
        end
        valid = task.ac_review_verdicts.where(state: :valid, verdict: :approved, reviewer_role: :reviewer,
          artifact_hash: actual_hash, candidate_commit_sha: candidate_commit, base_commit_hash: expected_base_commit).last
        raise StaleArtifactError, "Parecer vinculado à base/candidato ausente" unless valid&.ac_execution

        AcReviewService.verify_execution!(task: task, execution: valid.ac_execution, role: "reviewer",
          artifact_hash: actual_hash, candidate_commit_sha: candidate_commit, base_commit_hash: expected_base_commit)
        proof = validate_verification_evidence!(task, verification_evidence, actual_hash, candidate_commit, expected_base_commit)
        raise TaskNotApprovedError, "Tarefa não aprovada" unless task.approved? || (task.integrated? && operation.reload.state == "completed")
        git!(source, "merge-base", "--is-ancestor", expected_base_commit, candidate_commit)
        AcSafeGit.with_repository(source) do |safe_source|
          git!(repo_path, "fetch", "--no-tags", "--no-write-fetch-head", "--", safe_source, candidate_commit)
        end
        operation.update!(evidence: proof)
        AcAdmissionService.ensure_plan_authorized!(task.ac_plan)
        head = git!(repo_path, "rev-parse", "--verify", ref).strip
        if head == expected_base_commit
          git!(repo_path, "update-ref", ref, candidate_commit, expected_base_commit)
        elsif head != candidate_commit
          operation.update!(state: "uncertain")
          raise ConcurrentBranchModificationError, "Base avançou; preservar branch e reconciliar"
        end
        operation.update!(state: "git_applied")
        AcTask.transaction do
          task.update!(state: :integrated)
          operation.update!(state: "completed")
        end
        { integrated: true, candidate_commit: candidate_commit, new_branch_head: candidate_commit,
          unblocked_tasks: task.ac_plan.advance_dag!.map(&:task_key) }
      end
    end

    private

    def git!(repo, *args)
      out, err, status = AcSafeGit.capture("-C", repo, *args)
      raise IntegrationError, "Falha Git: #{err}" unless status.success?

      out
    end

    def validate_verification_evidence!(task, evidence, hash, candidate, base)
      evidence = evidence.to_h.stringify_keys
      execution = task.ac_executions.find_by(id: evidence["execution_id"])
      raise InvalidVerificationEvidenceError, "Execução independente de verificação ausente" unless execution

      unless task.ac_review_verdicts.where(ac_execution: execution, reviewer_role: :qa, verdict: :approved, state: :valid,
        artifact_hash: hash, candidate_commit_sha: candidate, base_commit_hash: base).exists?
        raise InvalidVerificationEvidenceError, "Parecer QA aprovado para esta execução/artefato ausente"
      end
      receipt = AcReviewService.verify_execution!(task: task, execution: execution, role: "qa", artifact_hash: hash,
        candidate_commit_sha: candidate, base_commit_hash: base)
      { "execution_id" => execution.id, "runtime_id" => receipt["runtime_id"], "artifact_hash" => hash }
    end
  end
end
