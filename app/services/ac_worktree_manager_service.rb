# frozen_string_literal: true

require "open3"
require "fileutils"
require "securerandom"

# F2 — Isolamento de Worktree e Escritor Único (AC Domain)
#
# §11.3.2: Autoridade de escrita da worktree:
# - Uma worktree de implementação tem um escritor autorizado por vez (RF-48).
# - Antes de entregar a mesma cópia a outra tentativa, neutraliza ou confirma
#   o término do acesso de escrita anterior.
# - Se não for possível neutralizar o escritor antigo, mantém a cópia em quarentena
#   e prepara outra worktree isolada, sem compartilhar diretório gravável.
class AcWorktreeManagerService
  class ActiveWriterConflictError < StandardError; end
  class GitError < StandardError; end

  class << self
    def acquire_lease!(execution:, base_path: "/tmp/ac_worktrees", repo_path: nil)
      repo_path ||= resolve_repo_path(execution)
      target_path = execution.worktree_path.presence || File.join(base_path, execution.ac_task_id.to_s, execution.operation_id)

      AcExecution.transaction do
        # Verifica se há outro escritor ativo no mesmo caminho ou tarefa
        conflicting_writer = AcExecution
          .where(ac_task_id: execution.ac_task_id)
          .where.not(id: execution.id)
          .where.not(worktree_lease_token: nil)
          .lock("FOR UPDATE")
          .first

        if conflicting_writer.present?
          # Tenta neutralizar o escritor antigo (§11.3.2)
          if neutralizable?(conflicting_writer)
            neutralize_writer!(conflicting_writer, repo_path: repo_path)
          else
            # Não é possível neutralizar: coloca diretório em quarentena e cria novo caminho isolado
            target_path = quarantine_and_diverge!(conflicting_writer, target_path)
          end
        end

        token = SecureRandom.hex(16)

        # Criação física de worktree Git caso exista repositório configurado no disco
        if repo_path.present? && Dir.exist?(File.join(repo_path, ".git"))
          FileUtils.mkdir_p(File.dirname(target_path))
          if Dir.exist?(target_path)
            Open3.capture3("git", "-C", repo_path, "worktree", "remove", "--force", target_path)
            FileUtils.rm_rf(target_path)
          end

          base_commit = execution.ac_task&.metadata&.dig("base_commit_sha") ||
                        execution.ac_task&.inputs&.dig("base_commit") ||
                        "HEAD"
          _out, err, status = Open3.capture3("git", "-C", repo_path, "worktree", "add", "--detach", target_path, base_commit)
          unless status.success?
            raise GitError, "Falha física ao alocar git worktree no caminho #{target_path}: #{err}"
          end
        else
          FileUtils.mkdir_p(target_path)
        end

        execution.acquire_worktree_lease!(token, path: target_path)
        token
      end
    end

    def release_lease!(execution:, repo_path: nil)
      repo_path ||= resolve_repo_path(execution)
      target_path = execution.worktree_path

      if repo_path.present? && Dir.exist?(File.join(repo_path, ".git")) && target_path.present?
        Open3.capture3("git", "-C", repo_path, "worktree", "remove", "--force", target_path)
        Open3.capture3("git", "-C", repo_path, "worktree", "prune")
      end

      FileUtils.rm_rf(target_path) if target_path.present? && Dir.exist?(target_path)
      execution.revoke_worktree_lease!
    end

    private

    def resolve_repo_path(execution)
      (execution.ac_task&.project&.respond_to?(:custom_fields) ? execution.ac_task.project.custom_fields&.dig("git_repo_path") : nil) ||
        execution.ac_work_context&.metadata&.dig("git_repo_path")
    end

    def neutralizable?(conflicting_writer)
      # Se o processo antigo falhou, expirou ou foi cancelado, podemos neutralizar a lease
      return true if conflicting_writer.state_cancelled? || conflicting_writer.state_failed?

      # Se o processo não envia heartbeat há mais de 10 minutos, consideramos neutralizável
      return true if conflicting_writer.heartbeat_at.present? && conflicting_writer.heartbeat_at < 10.minutes.ago

      false
    end

    def neutralize_writer!(writer, repo_path: nil)
      if repo_path.present? && Dir.exist?(File.join(repo_path, ".git")) && writer.worktree_path.present?
        Open3.capture3("git", "-C", repo_path, "worktree", "remove", "--force", writer.worktree_path)
        Open3.capture3("git", "-C", repo_path, "worktree", "prune")
      end
      FileUtils.rm_rf(writer.worktree_path) if writer.worktree_path.present? && Dir.exist?(writer.worktree_path)

      writer.update!(
        worktree_lease_token: nil,
        state: :cancelled,
        finished_at: Time.current,
        error_details: writer.error_details.merge(
          "neutralized_at" => Time.current.iso8601,
          "neutralized_by" => "AcWorktreeManagerService — preempted by newer execution"
        )
      )
    end

    def quarantine_and_diverge!(conflicting_writer, original_path)
      # Gera um caminho isolado em quarentena para a nova tentativa (§11.3.2)
      quarantine_suffix = "quarantine-#{SecureRandom.hex(4)}"
      "#{original_path}-#{quarantine_suffix}"
    end
  end
end
