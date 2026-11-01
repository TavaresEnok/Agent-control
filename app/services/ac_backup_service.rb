# frozen_string_literal: true

require "digest"

# AcBackupService — Backup Atômico e Manifestos com Hash (RF-52, §21.1, §21.6, Épico E15)
#
# Produz backup verificável e manifestos com hashes SHA-256.
# Garante que todo o histórico útil, planos, tarefas, execuções e pareceres
# possam ser inspecionados ou restaurados sem corrupção ou perda de estado.
class AcBackupService
  class BackupError < StandardError; end
  class CorruptedManifestError < BackupError; end

  class << self
    def export_manifest(company:)
      raise ArgumentError, "company é obrigatório" if company.blank?

      contexts = AcWorkContext.where(company: company).order(:id).as_json
      plans = AcPlan.where(company: company).order(:id).as_json
      tasks = AcTask.where(company: company).order(:id).as_json
      executions = AcExecution.where(company: company).order(:id).as_json
      verdicts = AcReviewVerdict.where(company: company).order(:id).as_json
      policy_revisions = AcPolicyRevision.where(company: company).order(:id).as_json
      execution_profiles = AcExecutionProfile.where(company: company).order(:id).as_json
      client_commands = AcClientCommand.where(company: company).order(:id).as_json
      capacity_grants = AcCapacityGrant.where(company: company).order(:id).as_json
      quota_observations = AcQuotaObservation.where(company: company).order(:id).as_json
      decision_audit_events = AcDecisionAuditEvent.where(company: company).order(:id).as_json
      remote_environments = AcRemoteEnvironment.where(company: company).order(:id).as_json
      remote_operations = AcRemoteOperation.where(company: company).order(:id).as_json

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
        "ac_remote_operations" => remote_operations
      }

      checksums = {}
      entities.each do |table_name, records|
        checksums[table_name] = Digest::SHA256.hexdigest(records.to_json)
      end

      root_payload = {
        "version" => "1.0",
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

    def verify_manifest(manifest)
      return false unless manifest.is_a?(Hash)

      root_digest = manifest["root_digest"]
      header = manifest["header"]
      entities = manifest["entities"]

      return false if root_digest.blank? || header.blank? || entities.blank?

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
    end
  end
end
