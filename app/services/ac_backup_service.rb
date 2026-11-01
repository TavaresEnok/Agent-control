# frozen_string_literal: true

require "digest"
require "base64"

# AcBackupService — Backup Atômico e Manifestos com Hash (RF-52, §21.1, §21.6, Épico E15)
#
# Produz backup verificável e manifestos com hashes SHA-256.
# Garante que todo o histórico útil, planos, tarefas, execuções e pareceres
# possam ser inspecionados ou restaurados sem corrupção ou perda de estado.
class AcBackupService
  class BackupError < StandardError; end
  class CorruptedManifestError < BackupError; end

  ENTITY_NAMES = %w[ac_work_contexts ac_policy_revisions ac_execution_profiles ac_plans ac_tasks
                    ac_capacity_grants ac_executions ac_review_verdicts ac_quota_observations
                    ac_decision_audit_events ac_client_commands ac_remote_environments ac_remote_operations ac_templates
                    ac_integration_operations trigger_events ac_notification_receipts].freeze

  class << self
    def export_manifest(company:)
      build_manifest(company: company, redacted: true)
    end

    def export_encrypted_backup(company:)
      key_id, encryptor = backup_encryptor
      manifest = build_manifest(company: company, redacted: false)
      { "format" => "ac-encrypted-backup-v1", "key_id" => key_id,
        "ciphertext" => encryptor.encrypt_and_sign(manifest.to_json, purpose: "agent-control-backup") }
    end

    def decrypt_backup(envelope)
      key_id, encryptor = backup_encryptor
      unless envelope.is_a?(Hash) && envelope.keys.sort == %w[ciphertext format key_id] &&
             envelope["format"] == "ac-encrypted-backup-v1" && envelope["key_id"] == key_id
        raise BackupError, "Backup criptografado inválido ou chave desconhecida"
      end
      JSON.parse(encryptor.decrypt_and_verify(envelope.fetch("ciphertext"), purpose: "agent-control-backup"))
    rescue ActiveSupport::MessageEncryptor::InvalidMessage, JSON::ParserError, TypeError
      raise BackupError, "Backup criptografado inválido"
    end

    def build_manifest(company:, redacted:)
      raise ArgumentError, "company é obrigatório" if company.blank?

      ActiveRecord::Base.transaction(isolation: :repeatable_read, requires_new: true) do
        contexts = AcWorkContext.where(company: company).order(:id).map { |record| serialize_record(record) }
        plans = AcPlan.where(company: company).order(:id).map { |record| serialize_record(record) }
        tasks = AcTask.where(company: company).order(:id).map { |record| serialize_record(record) }
        executions = AcExecution.where(company: company).order(:id).map { |record| serialize_record(record) }
        verdicts = AcReviewVerdict.where(company: company).order(:id).map { |record| serialize_record(record) }
        policy_revisions = AcPolicyRevision.where(company: company).order(:id).map { |record| serialize_record(record) }
        execution_profiles = AcExecutionProfile.where(company: company).order(:id).map { |record| serialize_record(record) }
        client_commands = AcClientCommand.where(company: company).where.not(command_type: "recovery_mode_state").order(:id).map { |record| serialize_record(record) }
        capacity_grants = AcCapacityGrant.where(company: company).order(:id).map { |record| serialize_record(record) }
        quota_observations = AcQuotaObservation.where(company: company).order(:id).map { |record| serialize_record(record) }
        decision_audit_events = AcDecisionAuditEvent.where(company: company).order(:id).map { |record| serialize_record(record) }
        remote_environments = AcRemoteEnvironment.where(company: company).order(:id).map { |record| serialize_record(record) }
        remote_operations = AcRemoteOperation.where(company: company).order(:id).map { |record| serialize_record(record) }
        templates = AcTemplate.where(company: company).order(:id).map { |record| serialize_record(record) }
        integration_operations = AcIntegrationOperation.where(ac_task_id: AcTask.where(company: company).select(:id)).order(:id).map { |record| serialize_record(record) }
        notification_events = TriggerEvent.where(company: company, source: "agent_control.notification").order(:id)
        notification_receipts = AcNotificationReceipt.where(trigger_event_id: notification_events.select(:id)).order(:id).map { |record| serialize_record(record) }
        notification_events = notification_events.map { |record| serialize_record(record) }

        entities = {
          "ac_work_contexts" => contexts,
          "ac_policy_revisions" => policy_revisions,
          "ac_execution_profiles" => execution_profiles,
          "ac_plans" => plans,
          "ac_tasks" => tasks,
          "ac_capacity_grants" => capacity_grants,
          "ac_executions" => executions,
          "ac_review_verdicts" => verdicts,
          "ac_quota_observations" => quota_observations,
          "ac_decision_audit_events" => decision_audit_events,
          "ac_client_commands" => client_commands,
          "ac_remote_environments" => remote_environments,
          "ac_remote_operations" => remote_operations,
          "ac_templates" => templates,
          "ac_integration_operations" => integration_operations,
          "trigger_events" => notification_events,
          "ac_notification_receipts" => notification_receipts
        }

        entities = redact_export(entities) if redacted

        checksums = {}
        entities.each do |table_name, records|
          checksums[table_name] = Digest::SHA256.hexdigest(records.to_json)
        end

        root_payload = {
          "version" => "1.0",
          "redacted" => redacted,
          "company_id" => company.id,
          "exported_at" => Time.current.iso8601,
          "entity_counts" => entities.transform_values(&:size),
          "checksums" => checksums
        }

        root_digest = Digest::SHA256.hexdigest(root_payload.to_json)

        {
          "manifest_version" => "1.0",
          "root_digest" => root_digest,
          "header" => root_payload,
          "entities" => entities
        }
      end
    end

    private :build_manifest

    def verify_manifest(manifest)
      return false unless manifest.is_a?(Hash)

      root_digest = manifest["root_digest"]
      header = manifest["header"]
      entities = manifest["entities"]

      return false unless root_digest.is_a?(String) && header.is_a?(Hash) && entities.is_a?(Hash)
      return false unless manifest.keys.sort == %w[entities header manifest_version root_digest]
      return false unless manifest["manifest_version"] == "1.0" && header["version"] == "1.0"
      return false unless header.keys.sort == %w[checksums company_id entity_counts exported_at redacted version]
      return false unless [ true, false ].include?(header["redacted"])
      return false unless entities.keys.sort == ENTITY_NAMES.sort
      return false unless header["checksums"].is_a?(Hash) && header["checksums"].keys.sort == ENTITY_NAMES.sort
      return false unless header["entity_counts"].is_a?(Hash) && header["entity_counts"].keys.sort == ENTITY_NAMES.sort
      return false unless entities.all? { |name, records| records.is_a?(Array) && records.all? { |record| record.is_a?(Hash) } && header["entity_counts"][name] == records.size }
      return false unless entities.values.all? do |records|
        ids = records.map { |record| record["id"] }
        ids.all? { |id| id.is_a?(Integer) && id.positive? } && ids.uniq.size == ids.size
      end
      child_tables = %w[ac_integration_operations ac_notification_receipts]
      return false unless entities.except(*child_tables).values.flatten.all? { |record| record["company_id"] == header["company_id"] }
      task_ids = entities["ac_tasks"].map { |record| record["id"] }
      event_ids = entities["trigger_events"].map { |record| record["id"] }
      return false unless entities["ac_integration_operations"].all? { |record| task_ids.include?(record["ac_task_id"]) }
      return false unless entities["trigger_events"].all? { |record| record["source"] == "agent_control.notification" }
      return false unless entities["ac_notification_receipts"].all? { |record| event_ids.include?(record["trigger_event_id"]) }

      # 1. Verifica integridade do header contra o root_digest
      expected_root = Digest::SHA256.hexdigest(header.to_json)
      return false unless expected_root == root_digest

      # 2. Verifica checksum de cada tabela
      checksums = header["checksums"] || {}
      entities.each do |table_name, records|
        expected_table_hash = checksums[table_name]
        actual_table_hash = Digest::SHA256.hexdigest(records.to_json)
        return false unless expected_table_hash == actual_table_hash
      end

      true
    rescue ArgumentError, TypeError
      false
    end

    private

    def serialize_record(record)
      record.attributes.transform_values do |value|
        value.is_a?(Time) || value.is_a?(ActiveSupport::TimeWithZone) ? value.iso8601(6) : value
      end
    end

    def backup_encryptor
      key_id = (Rails.application.config.try(:ac_backup_key_id) || Settings.agent_control.backup_key_id).to_s
      key = Base64.strict_decode64((Rails.application.config.try(:ac_backup_encryption_key) || Settings.agent_control.backup_encryption_key).to_s)
      unless key_id.match?(/\A[A-Za-z0-9_.-]{1,128}\z/) && key.bytesize == 32
        raise BackupError, "Chave de backup dedicada não configurada"
      end
      [ key_id, ActiveSupport::MessageEncryptor.new(key, cipher: "aes-256-gcm", serializer: JSON) ]
    rescue ArgumentError
      raise BackupError, "Chave de backup dedicada inválida"
    end

    def redact_export(value)
      case value
      when Hash
        value.each_with_object({}) do |(key, item), result|
          result[key] = if key.to_s.match?(/\A(?:authorization|password|api_key|access_token|refresh_token|client_secret)\z/i)
            "[REDACTED]"
          else
            redact_export(item)
          end
        end
      when Array
        value.map { |item| redact_export(item) }
      when String
        value.gsub(/\b(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/i, "[REDACTED]")
             .gsub(/\bBearer\s+[^\s,;]+/i, "[REDACTED]")
             .gsub(/\bsk-[A-Za-z0-9_-]{15,}\b/, "[REDACTED]")
             .gsub(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, "[REDACTED]")
      else
        value
      end
    end
  end
end
