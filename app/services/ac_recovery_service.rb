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
        query = query.where("company_id = ? OR payload @> ?::jsonb", company.id, { global: true }.to_json) if company.present?
        query.exists?
      end
    rescue StandardError
      true
    end

    def enter_recovery_mode!(company: nil)
      @recovery_mode_mutex.synchronize do
        @recovery_mode_active = true if company.nil?
        target_company = company || Company.first
        if target_company.present?
          cmd = AcClientCommand.find_or_initialize_by(
            company: target_company,
            intent_id: "system-recovery-state-#{target_company.id}",
            command_type: "recovery_mode_state"
          )
          cmd.state = "processing"
          cmd.payload = { "recovery_mode" => true, "global" => company.nil? }
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
            metadata: (execution.metadata || {}).merge(
              "reconciled_by" => "AcRecoveryService",
              "reconciled_at" => Time.current.iso8601,
              "reason" => "Host recovery initialization / post-restore reconciliation (T30)"
            )
          )

          reconciled_count += 1
        end
      end

      reconciled_count
    end

    # T34 / §11.3.2: Neutraliza escritores e leases de worktree órfãs
    def neutralize_orphan_leases!(company:)
      # Leases cannot be revoked until the external writer is confirmed stopped.
      0
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
      begin
        manifest = AcBackupService.decrypt_backup(manifest)
      rescue AcBackupService::BackupError
        raise InvalidManifestError, "Backup criptografado inválido"
      end
      unless AcBackupService.verify_manifest(manifest) && manifest.dig("header", "redacted") == false
        raise InvalidManifestError, "Manifesto inválido ou digest corrompido: restauração bloqueada"
      end

      unless manifest.dig("header", "company_id") == company.id
        raise InvalidManifestError, "Manifesto pertence a outra empresa"
      end

      enter_recovery_mode!(company: company)

      entities = manifest["entities"] || {}
      validate_external_references!(company, entities)
      rehydrated = {}

      ActiveRecord::Base.transaction do
        # 1. Reidratação dos registros no banco respeitando integridade referencial ([BUG-P0-03], DEF-05)
        rehydrate_entity(AcWorkContext, entities["ac_work_contexts"], rehydrated)
        rehydrate_entity(AcPolicyRevision, entities["ac_policy_revisions"], rehydrated)
        rehydrate_entity(AcExecutionProfile, entities["ac_execution_profiles"], rehydrated)
        rehydrate_entity(AcPlan, entities["ac_plans"], rehydrated)
        rehydrate_entity(AcTask, entities["ac_tasks"], rehydrated)
        rehydrate_entity(AcIntegrationOperation, entities["ac_integration_operations"], rehydrated)
        rehydrate_entity(AcCapacityGrant, entities["ac_capacity_grants"], rehydrated)
        rehydrate_entity(AcExecution, entities["ac_executions"], rehydrated)
        rehydrate_entity(AcReviewVerdict, entities["ac_review_verdicts"], rehydrated)
        rehydrate_entity(AcQuotaObservation, entities["ac_quota_observations"], rehydrated)
        rehydrate_entity(AcDecisionAuditEvent, entities["ac_decision_audit_events"], rehydrated)
        rehydrate_entity(AcClientCommand, entities["ac_client_commands"], rehydrated)
        rehydrate_entity(AcRemoteEnvironment, entities["ac_remote_environments"], rehydrated)
        rehydrate_entity(AcRemoteOperation, entities["ac_remote_operations"], rehydrated)
        rehydrate_entity(AcTemplate, entities["ac_templates"], rehydrated)
        rehydrate_entity(TriggerEvent, entities["trigger_events"], rehydrated, quarantine_outbox: true)
        rehydrate_entity(AcNotificationReceipt, entities["ac_notification_receipts"], rehydrated)

        # 2. Neutraliza estado antigo para prevenir concorrência com processos vivos
        reconcile_active_executions!(company: company)
        neutralize_orphan_leases!(company: company)
        preserve_pauses!(company: company)

        {
          restored: true,
          manifest_root_digest: manifest["root_digest"],
          rehydrated_counts: rehydrated,
          reconciliation: {
            status: "pending_external_reconciliation",
            timestamp: Time.current.iso8601
          }
        }
      end
    rescue ActiveRecord::InvalidForeignKey, ActiveRecord::RecordNotUnique => e
      raise RecoveryError, "Dependência ausente ou conflito de identidade durante a restauração (#{e.class})"
    end

    private

    def validate_external_references!(company, entities)
      records = entities.values.flatten
      project_ids = records.filter_map { |record| record["project_id"] }.uniq
      credential_ids = records.filter_map { |record| record["agent_credential_id"] }.uniq
      unless Project.where(company: company, id: project_ids).count == project_ids.size &&
             AgentCredential.where(company: company, id: credential_ids).count == credential_ids.size
        raise RecoveryError, "Projetos ou credenciais referenciados ausentes ou de outra empresa"
      end
      user_ids = records.flat_map do |record|
        %w[user_id actor_id created_by_user_id published_by_user_id revoked_by_user_id].filter_map { |key| record[key] }
      end.uniq
      raise RecoveryError, "Usuários referenciados ausentes" unless User.where(id: user_ids).count == user_ids.size
    end

    def rehydrate_entity(model_class, records, counter_hash, quarantine_outbox: false)
      return unless records.is_a?(Array) && records.any?

      count = 0
      records.each do |attrs|
        record = model_class.find_or_initialize_by(id: attrs["id"])
        if record.persisted?
          candidate = model_class.new(attrs)
          unless attrs.keys.all? { |key| record.attributes[key] == candidate.attributes[key] }
            raise RecoveryError, "Conflito ao restaurar #{model_class.table_name} id=#{attrs['id']}"
          end
          next
        end

        restored_attrs = attrs.except("id")
        if quarantine_outbox && restored_attrs["relay_state"].in?(%w[pending dispatching])
          restored_attrs = restored_attrs.merge("relay_state" => "failed", "relay_error" => "Recuperação: estado anterior #{restored_attrs['relay_state']}; reconciliação necessária")
        end
        if [ AcTask, AcPlan, AcPolicyRevision ].include?(model_class)
          model_class.insert_all!([ restored_attrs.merge("id" => attrs["id"]) ], record_timestamps: false)
        else
          record.assign_attributes(restored_attrs)
          record.save!(validate: false)
        end
        count += 1
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
