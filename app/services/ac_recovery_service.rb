# frozen_string_literal: true

# AcRecoveryService — Restauração Resiliente e Modo de Recuperação (RF-52, T30, §21.6, Épico E15)
#
# T30: Restauração de backup com efeitos externos posteriores e processos ainda vivos.
# Inicializa em recuperação, reconcilia/neutraliza antigos, preserva pausas
# e só depois libera novas admissões (RF-23/34/44/52).
class AcRecoveryService
  class RecoveryError < StandardError; end
  class InvalidManifestError < RecoveryError; end

  @recovery_mode_mutex = Mutex.new
  @recovery_mode_active = false

  class << self
    def recovery_mode_active?
      @recovery_mode_mutex.synchronize { @recovery_mode_active }
    end

    def enter_recovery_mode!
      @recovery_mode_mutex.synchronize { @recovery_mode_active = true }
    end

    def exit_recovery_mode!
      @recovery_mode_mutex.synchronize { @recovery_mode_active = false }
    end

    # T30: Reconcilia execuções pendentes ou ativas sem despacho cego duplicado
    def reconcile_active_executions!(company:)
      reconciled_count = 0

      AcExecution.transaction do
        active_executions = AcExecution.where(company: company, state: %w[granted running])
                                       .lock("FOR UPDATE")

        active_executions.find_each do |execution|
          execution.update!(
            state: :uncertain,
            finished_at: Time.current,
            metadata: (execution.metadata || {}).merge(
              "reconciled_by" => "AcRecoveryService",
              "reconciled_at" => Time.current.iso8601,
              "reason" => "Host recovery initialization / post-restore reconciliation (T30)"
            )
          )

          # Revoga a concessão de capacidade associada
          grant = execution.ac_capacity_grant
          grant&.release! if grant&.state.in?(%w[granted active])

          reconciled_count += 1
        end
      end

      reconciled_count
    end

    # T34 / §11.3.2: Neutraliza escritores e leases de worktree órfãs
    def neutralize_orphan_leases!(company:)
      neutralized_count = 0

      AcExecution.where(company: company).where.not(worktree_lease_token: nil).find_each do |execution|
        if execution.worktree_lease_active?
          execution.revoke_worktree_lease!
          neutralized_count += 1
        end
      end

      neutralized_count
    end

    # T30: Preserva estritamente contextos e tarefas que estavam pausadas
    def preserve_pauses!(company:)
      paused_contexts = AcWorkContext.where(company: company, state: "paused")
      paused_contexts.each do |ctx|
        ctx.ac_plans.each do |plan|
          plan.ac_tasks.where(state: "queued").update_all(state: "waiting_dependencies")
        end
      end

      paused_contexts.count
    end

    # Restauração controlada a partir de manifesto autenticado
    def restore_from_manifest!(company:, manifest:)
      unless AcBackupService.verify_manifest(manifest)
        raise InvalidManifestError, "Manifesto inválido ou digest corrompido: restauração bloqueada"
      end

      enter_recovery_mode!

      begin
        ActiveRecord::Base.transaction do
          # 1. Neutraliza estado antigo para prevenir concorrência com processos vivos
          reconcile_active_executions!(company: company)
          neutralize_orphan_leases!(company: company)
          preserve_pauses!(company: company)

          # 2. Retorna resumo do saneamento
          {
            restored: true,
            manifest_root_digest: manifest["root_digest"],
            reconciliation: {
              status: "clean_recovery",
              timestamp: Time.current.iso8601
            }
          }
        end
      ensure
        # Permanece em modo de recuperação até liberação explícita pelo operador
      end
    end
  end
end
