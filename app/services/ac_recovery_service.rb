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
    def recovery_mode_active?(company: nil)
      @recovery_mode_mutex.synchronize do
        return true if @recovery_mode_active

        # Persistência no PostgreSQL para sobrevivência a reinicializações e Puma cluster ([BUG-P1-04])
        query = AcClientCommand.where(command_type: "recovery_mode_state", state: "processing")
        query = query.where(company_id: company.id) if company.present?
        query.exists?
      end
    rescue StandardError
      @recovery_mode_active
    end

    def enter_recovery_mode!(company: nil)
      @recovery_mode_mutex.synchronize do
        @recovery_mode_active = true
        target_company = company || Company.first
        if target_company.present?
          cmd = AcClientCommand.find_or_initialize_by(
            company: target_company,
            intent_id: "system-recovery-state-#{target_company.id}",
            command_type: "recovery_mode_state"
          )
          cmd.state = "processing"
          cmd.payload = { "recovery_mode" => true }
          cmd.processed_at = Time.current
          cmd.save!
        end
        true
      end
    end

    def exit_recovery_mode!(company: nil)
      @recovery_mode_mutex.synchronize do
        @recovery_mode_active = false
        target_company = company || Company.first
        if target_company.present?
          AcClientCommand.where(
            company: target_company,
            command_type: "recovery_mode_state"
          ).update_all(state: "processed", payload: { "recovery_mode" => false }, updated_at: Time.current)
        end
        false
      end
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

    # Restauração controlada e reidratação física a partir de manifesto autenticado ([BUG-P0-03])
    def restore_from_manifest!(company:, manifest:)
      unless AcBackupService.verify_manifest(manifest)
        raise InvalidManifestError, "Manifesto inválido ou digest corrompido: restauração bloqueada"
      end

      enter_recovery_mode!(company: company)

      entities = manifest["entities"] || {}
      rehydrated = {}

      ActiveRecord::Base.transaction do
        # 1. Reidratação dos registros no banco respeitando integridade referencial ([BUG-P0-03], DEF-05)
        rehydrate_entity(AcWorkContext, entities["ac_work_contexts"], rehydrated)
        rehydrate_entity(AcPolicyRevision, entities["ac_policy_revisions"], rehydrated)
        rehydrate_entity(AcExecutionProfile, entities["ac_execution_profiles"], rehydrated)
        rehydrate_entity(AcPlan, entities["ac_plans"], rehydrated)
        rehydrate_entity(AcTask, entities["ac_tasks"], rehydrated)
        rehydrate_entity(AcCapacityGrant, entities["ac_capacity_grants"], rehydrated)
        rehydrate_entity(AcExecution, entities["ac_executions"], rehydrated)
        rehydrate_entity(AcReviewVerdict, entities["ac_review_verdicts"], rehydrated)
        rehydrate_entity(AcQuotaObservation, entities["ac_quota_observations"], rehydrated)
        rehydrate_entity(AcDecisionAuditEvent, entities["ac_decision_audit_events"], rehydrated)
        rehydrate_entity(AcClientCommand, entities["ac_client_commands"], rehydrated)
        rehydrate_entity(AcRemoteEnvironment, entities["ac_remote_environments"], rehydrated)
        rehydrate_entity(AcRemoteOperation, entities["ac_remote_operations"], rehydrated)

        # 2. Neutraliza estado antigo para prevenir concorrência com processos vivos
        reconcile_active_executions!(company: company)
        neutralize_orphan_leases!(company: company)
        preserve_pauses!(company: company)

        {
          restored: true,
          manifest_root_digest: manifest["root_digest"],
          rehydrated_counts: rehydrated,
          reconciliation: {
            status: "clean_recovery",
            timestamp: Time.current.iso8601
          }
        }
      end
    end

    private

    def rehydrate_entity(model_class, records, counter_hash)
      return unless records.is_a?(Array) && records.any?

      count = 0
      records.each do |attrs|
        record = model_class.find_or_initialize_by(id: attrs["id"])
        if record.new_record?
          record.assign_attributes(attrs.except("id", "created_at", "updated_at"))
          record.save!(validate: false)
          count += 1
        end
      end

      # Reset da sequence de chave primária no PostgreSQL para evitar colisão de PKs (DEF-05)
      conn = ActiveRecord::Base.connection
      if conn.respond_to?(:reset_pk_sequence!)
        conn.reset_pk_sequence!(model_class.table_name)
      end

      counter_hash[model_class.table_name] = count
    end
  end
end
