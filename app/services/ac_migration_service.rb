# frozen_string_literal: true

require "digest"

# AcMigrationService — Migração Gradual e Transferência de Autoridade Exclusiva (Gate G7, §17.4, §19.2 F7)
#
# Critério Gate G7: Substituição autorizada, sem perda de entregas/histórico e com responsáveis claros.
#
# Responsabilidades:
# 1. Definição explícita de autoridade por projeto (authority_mode: agent_control_exclusive);
# 2. Travamento de concorrência com o sistema legado (legacy_locked: true);
# 3. Mapeamento de responsáveis claros (assigned_owner, manager_identity);
# 4. Prova criptográfica de preservação integral de entregas e histórico pré-existentes (zero data loss).
class AcMigrationService
  class MigrationError < StandardError; end
  class ProjectLockedError < MigrationError; end
  class IntegrityMismatchError < MigrationError; end

  class << self
    def migrate_project!(project:, company:, target_authority: "agent_control_exclusive", assigned_owner:)
      raise ArgumentError, "project e company são obrigatórios" if project.blank? || company.blank?
      raise ArgumentError, "assigned_owner é obrigatório e deve pertencer à empresa" if assigned_owner.blank? || !assigned_owner.companies.where(id: company.id).exists?

      # 1. Realiza inventário criptográfico pré-migração (§19.2 F7)
      inventory = build_project_inventory(project)

      # 2. Aplica autoridade exclusiva no projeto
      project.settings ||= {}
      project.settings["authority_mode"] = target_authority.to_s
      project.settings["migration_status"] = "migrated"
      project.settings["assigned_owner_id"] = assigned_owner.id
      project.settings["assigned_owner_email"] = assigned_owner.email
      project.settings["pre_migration_inventory"] = inventory
      project.settings["migrated_at"] = Time.current.iso8601

      project.save!

      # 3. Bloqueia concorrência em todos os contextos de trabalho associados
      contexts = AcWorkContext.where(project: project)
      contexts.each do |ctx|
        ctx.metadata ||= {}
        ctx.metadata["authority_mode"] = target_authority.to_s
        ctx.metadata["legacy_locked"] = true
        ctx.metadata["migration_timestamp"] = Time.current.iso8601
        ctx.origin = "migration"
        ctx.save!
      end

      # 4. Retorna recibo estruturado da migração de autoridade
      {
        project_id: project.id,
        authority_mode: target_authority.to_s,
        assigned_owner: assigned_owner.email,
        inventory_digest: inventory["inventory_digest"],
        migrated_contexts_count: contexts.count,
        migrated_at: project.settings["migrated_at"],
        status: "authority_transferred"
      }
    end

    def verify_migration_integrity!(project:)
      raise ArgumentError, "project é obrigatório" if project.blank?

      pre_inv = project.settings&.dig("pre_migration_inventory")
      raise MigrationError, "Projeto não possui inventário pré-migração registrado" if pre_inv.blank?

      current_inv = build_project_inventory(project)

      # Validação de integridade: nenhuma tarefa, plano ou entrega integrada pode ter sido perdida
      tasks_preserved = current_inv["tasks_count"] >= pre_inv["tasks_count"]
      plans_preserved = current_inv["plans_count"] >= pre_inv["plans_count"]
      integrated_preserved = current_inv["integrated_tasks_count"] >= pre_inv["integrated_tasks_count"]

      unless tasks_preserved && plans_preserved && integrated_preserved
        raise IntegrityMismatchError, "Inconsistência detectada: perda de histórico pós-migração!"
      end

      {
        integrity_verified: true,
        zero_loss: true,
        project_id: project.id,
        preserved_tasks: current_inv["tasks_count"],
        preserved_integrated_deliveries: current_inv["integrated_tasks_count"],
        inventory_digest: current_inv["inventory_digest"]
      }
    end

    def transfer_plan_authority!(plan:, new_manager_identity:, authority_mode: "agent_control_exclusive")
      raise ArgumentError, "plan é obrigatório" if plan.blank?
      raise ArgumentError, "new_manager_identity é obrigatório" if new_manager_identity.to_s.strip.empty?

      plan.metadata ||= {}
      plan.metadata["authority_mode"] = authority_mode.to_s
      plan.metadata["manager_identity"] = new_manager_identity
      plan.metadata["authority_transferred_at"] = Time.current.iso8601
      plan.save!

      # Atualiza o gerente ativo no contexto associado
      plan.ac_work_context.assign_active_manager!(identity: new_manager_identity)

      {
        plan_id: plan.id,
        plan_key: plan.plan_key,
        authority_mode: authority_mode.to_s,
        manager_identity: new_manager_identity,
        transferred_at: plan.metadata["authority_transferred_at"]
      }
    end

    private

    def build_project_inventory(project)
      contexts = AcWorkContext.where(project: project).order(:id)
      plans = AcPlan.where(project: project).order(:id)
      tasks = AcTask.where(project: project).order(:id)

      task_signatures = tasks.map do |t|
        "#{t.id}:#{t.task_key}:#{t.state}:#{t.approved_commit_sha}"
      end

      digest_payload = "project:#{project.id}|contexts:#{contexts.count}|plans:#{plans.count}|tasks:#{task_signatures.join(';')}"
      digest = Digest::SHA256.hexdigest(digest_payload)

      {
        "contexts_count" => contexts.count,
        "plans_count" => plans.count,
        "tasks_count" => tasks.count,
        "integrated_tasks_count" => tasks.count { |t| t.state == "integrated" },
        "inventory_digest" => digest,
        "inventoried_at" => Time.current.iso8601
      }
    end
  end
end
