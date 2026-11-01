# frozen_string_literal: true

require "digest"
require "fileutils"
require "open3"
require "securerandom"

class AcWorktreeManagerService
  class ActiveWriterConflictError < StandardError; end
  class GitError < StandardError; end
  class UnsafePathError < StandardError; end

  class << self
    def acquire_lease!(execution:, base_path: nil, repo_path: nil)
      base_path ||= Rails.application.config.try(:ac_worktree_base_dir) || Settings.agent_control.worktree_base_dir
      repo_path ||= resolve_repo_path(execution)
      raise UnsafePathError, "operation_id ausente" if execution.operation_id.blank?

      AcExecutionFence.synchronize(execution) do
        next execution.worktree_lease_token if execution.worktree_lease_token.present?
        raise ActiveWriterConflictError, "Worktree anterior deve ser preservada" if execution.worktree_path.present?

        root = File.expand_path(base_path)
        FileUtils.mkdir_p(root)
        root = File.realpath(root)
        task_dir = File.join(root, execution.ac_task_id.to_s)
        raise UnsafePathError, "Diretório de tarefa é symlink" if File.symlink?(task_dir)
        FileUtils.mkdir_p(task_dir)
        raise UnsafePathError, "Diretório fora da raiz" unless File.realpath(task_dir).start_with?("#{root}/")

        name = Digest::SHA256.hexdigest("#{execution.id}:#{execution.operation_id}:#{SecureRandom.hex(16)}")
        target = File.join(task_dir, name)
        raise GitError, "Repositório local obrigatório" unless repo_path.present? && Dir.exist?(repo_path)

        repo = File.realpath(repo_path)
        requested = requested_commit(execution)
        commit = git!("-C", repo, "rev-parse", "--verify", "--end-of-options", "#{requested}^{commit}").strip
        raise GitError, "Identidade de commit inválida" unless commit.match?(/\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z/)

        AcSafeGit.with_repository(repo) do |safe_source|
          git!("clone", "--no-hardlinks", "--no-local", "--no-checkout", "--", safe_source, target)
        end
        # A detached commit may not be reachable from any advertised branch.
        AcSafeGit.with_repository(repo) do |safe_source|
          git!("-C", target, "fetch", "--no-tags", "--no-write-fetch-head", "--", safe_source, commit)
        end
        git!("-C", target, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit, "--")
        actual = git!("-C", target, "rev-parse", "--verify", "HEAD^{commit}").strip
        raise GitError, "Commit do clone divergente" unless actual == commit
        execution.metadata = (execution.metadata || {}).merge("base_commit_sha" => commit)

        token = SecureRandom.hex(16)
        execution.acquire_worktree_lease!(token, path: target)
        token
      end
    end

    # Caller must independently prove that the writer has stopped. Artifacts stay
    # in place; retention and deletion require a separate ownership-aware policy.
    def release_lease!(execution:, repo_path: nil)
      return if execution.worktree_lease_token.blank?

      receipt = AcRuntimeSupervisorService.status!(execution: execution)
      unless %w[completed failed not_started].include?(receipt["state"])
        raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Término do escritor não comprovado"
      end
      execution.revoke_worktree_lease!
    end

    private

    def requested_commit(execution)
      role = execution.ac_execution_profile&.role.to_s
      artifact = execution.metadata&.dig("source_artifact", "commit_sha")
      if %w[reviewer qa].include?(role)
        unless artifact.to_s.match?(/\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z/)
          raise GitError, "Commit do artefato de revisão ausente ou inválido"
        end
        return artifact
      end
      value = execution.metadata&.dig("base_commit_sha") || execution.ac_task&.metadata&.dig("base_commit_sha") ||
              execution.ac_task&.inputs&.dig("base_commit") || "HEAD"
      raise GitError, "Referência de commit inválida" if value.to_s.blank? || value.to_s.start_with?("-") || value.to_s.include?("\0")
      value.to_s
    end

    def git!(*args)
      out, err, status = AcSafeGit.capture(*args)
      raise GitError, "Git falhou: #{err.to_s.truncate(500)}" unless status.success?

      out
    end

    def resolve_repo_path(execution)
      if %w[reviewer qa].include?(execution.ac_execution_profile&.role.to_s)
        return execution.metadata["source_repository"]
      end
      (execution.ac_task&.project.respond_to?(:custom_fields) ? execution.ac_task.project.custom_fields&.dig("git_repo_path") : nil) ||
        execution.ac_work_context&.metadata&.dig("git_repo_path")
    end
  end
end
