# frozen_string_literal: true

require "digest"

class AcMigrationService
  class MigrationError < StandardError; end
  class ProjectLockedError < MigrationError; end
  class IntegrityMismatchError < MigrationError; end
  class AuthorityUnavailableError < MigrationError; end

  class << self
    def migrate_project!(project:, company:, target_authority: "agent_control_exclusive", assigned_owner:)
      raise ArgumentError, "project e company são obrigatórios" if project.blank? || company.blank?
      raise ArgumentError, "empresa não corresponde ao projeto" unless project.company_id == company.id
      membership = assigned_owner && CompanyMembership.active.find_by(user_id: assigned_owner.id, company_id: company.id)
      unless membership && !membership.viewer? && project.accessible_by?(assigned_owner)
        raise ArgumentError, "assigned_owner deve ter acesso ao projeto e permissão de escrita"
      end

      project.with_lock do
        settings = project.settings || {}
        raise MigrationError, "inventário de migração já existe" if settings["pre_migration_inventory"].present?

        inventory = build_project_inventory(project)
        project.update!(settings: settings.merge(
          "pre_migration_inventory" => inventory,
          "migration_status" => "prepared",
          "migration_target_authority" => target_authority.to_s,
          "assigned_owner_id" => assigned_owner.id
        ))
        { project_id: project.id, status: "prepared", inventory_digest: inventory["inventory_digest"] }
      end
    end

    def verify_migration_integrity!(project:)
      raise ArgumentError, "project é obrigatório" if project.blank?

      project.with_lock do
        previous = project.settings&.dig("pre_migration_inventory")
        unless previous.is_a?(Hash) && previous["version"] == 2 && previous["records"].is_a?(Hash) &&
               previous["inventory_digest"] == digest(previous["records"])
          raise MigrationError, "Inventário verificável não encontrado"
        end
        current = build_project_inventory(project)
        previous["records"].each do |kind, entries|
          unless entries.is_a?(Hash) && entries.all? { |id, signature| current["records"].fetch(kind, {})[id] == signature }
            raise IntegrityMismatchError, "Histórico ou conteúdo inventariado foi alterado: #{kind}"
          end
        end
        { integrity_verified: true, project_id: project.id, scope: "inventoried_database_records",
          inventory_digest: current["inventory_digest"] }
      end
    end

    # No authority adapter is configured yet. A database flag cannot fence the legacy writer.
    def transfer_plan_authority!(plan:, new_manager_identity:, authority_mode: "agent_control_exclusive", expected_epoch: nil)
      raise ArgumentError, "plan é obrigatório" if plan.blank?
      raise ArgumentError, "new_manager_identity é obrigatório" if new_manager_identity.blank?

      raise AuthorityUnavailableError, "Transferência requer adaptador externo de autoridade e recibo verificável"
    end

    def assign_plan_manager!(plan:, new_manager_identity:, expected_epoch:)
      raise ArgumentError, "plan é obrigatório" if plan.blank?
      raise ArgumentError, "expected_epoch é obrigatório" if expected_epoch.nil?

      context = plan.ac_work_context
      context.with_lock do
        plan.with_lock do
          current = (context.metadata || {}).fetch("manager_epoch", 0).to_i
          raise ActiveRecord::StaleObjectError, "Época de gerente divergente" unless expected_epoch == current

          if context.active_manager_identity.present? && context.active_manager_identity != new_manager_identity.to_s
            raise AuthorityUnavailableError, "Transferência de gerente requer reconciliação externa"
          end
          if AcPlan.where(ac_work_context_id: context.id).where.not(id: plan.id)
                   .where("metadata ->> 'manager_identity' = ?", new_manager_identity.to_s).exists?
            raise AuthorityUnavailableError, "Gerente já está vinculado a outro plano"
          end
          epoch = context.assign_active_manager!(identity: new_manager_identity, expected_epoch: expected_epoch)
          if context.metadata["manager_plan_id"].present? && context.metadata["manager_plan_id"].to_i != plan.id
            raise AuthorityUnavailableError, "Gerente já está vinculado a outro plano"
          end
          context.update!(metadata: context.metadata.merge("manager_plan_id" => plan.id))
          plan.update!(metadata: (plan.metadata || {}).merge("manager_identity" => new_manager_identity, "manager_epoch" => epoch))
          { plan_id: plan.id, manager_identity: new_manager_identity, manager_epoch: epoch }
        end
      end
    end

    private

    def build_project_inventory(project)
      tasks = AcTask.where(company_id: project.company_id, project_id: project.id)
      task_ids = tasks.select(:id)
      records = {
        "contexts" => signatures(AcWorkContext.where(company_id: project.company_id, project_id: project.id),
          %w[id company_id project_id external_id]),
        "plans" => signatures(AcPlan.where(company_id: project.company_id, project_id: project.id),
          %w[id company_id project_id ac_work_context_id plan_key version title objective content_hash]),
        "tasks" => signatures(tasks, %w[id company_id project_id ac_plan_id task_key title scope acceptance_criteria
          approved_commit_sha approved_artifact_hash]),
        "executions" => signatures(AcExecution.where(company_id: project.company_id, ac_task_id: task_ids),
          %w[id company_id ac_task_id ac_work_context_id ac_execution_profile_id ac_capacity_grant_id operation_id epoch
          exit_code output_payload error_details]),
        "verdicts" => signatures(AcReviewVerdict.where(company_id: project.company_id, project_id: project.id),
          %w[id company_id project_id ac_task_id ac_execution_id reviewer_role verdict artifact_hash base_commit_hash
          candidate_commit_sha findings evaluator_identity policy_revision_number]),
        "remote_artifacts" => signatures(AcRemoteOperation.where(company_id: project.company_id, project_id: project.id),
          %w[id company_id project_id ac_task_id ac_execution_id operation_id artifact_hash])
      }
      { "version" => 2, "records" => records, "inventory_digest" => digest(records), "inventoried_at" => Time.current.iso8601 }
    end

    def signatures(scope, fields)
      scope.order(:id).each_with_object({}) do |record, result|
        attributes = record.attributes.slice(*fields)
        result[record.id.to_s] = digest(attributes)
      end
    end

    def digest(value)
      Digest::SHA256.hexdigest(JSON.generate(canonical(value)))
    end

    def canonical(value)
      case value
      when Hash then value.keys.sort.to_h { |key| [ key, canonical(value[key]) ] }
      when Array then value.map { |item| canonical(item) }
      else value
      end
    end
  end
end
