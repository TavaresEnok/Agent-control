# frozen_string_literal: true

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

  class << self
    def acquire_lease!(execution:, base_path: "/tmp/ac_worktrees")
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
            neutralize_writer!(conflicting_writer)
          else
            # Não é possível neutralizar: coloca diretório em quarentena e cria novo caminho isolado
            target_path = quarantine_and_diverge!(conflicting_writer, target_path)
          end
        end

        token = SecureRandom.hex(16)
        execution.acquire_worktree_lease!(token, path: target_path)
        token
      end
    end

    def release_lease!(execution:)
      execution.revoke_worktree_lease!
    end

    private

    def neutralizable?(conflicting_writer)
      # Se o processo antigo falhou, expirou ou foi cancelado, podemos neutralizar a lease
      return true if conflicting_writer.state_cancelled? || conflicting_writer.state_failed?

      # Se o processo não envia heartbeat há mais de 10 minutos, consideramos neutralizável
      return true if conflicting_writer.heartbeat_at.present? && conflicting_writer.heartbeat_at < 10.minutes.ago

      false
    end

    def neutralize_writer!(writer)
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
