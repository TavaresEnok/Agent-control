# frozen_string_literal: true

# F1-A — Plano versionado (AC Domain)
#
# Um AcPlan é a versão de um objetivo dividido em tarefas, com dependências,
# contratos de entrada/saída e critérios de aceite (RF-15).
# Planos são imutáveis após publicação: uma revisão cria nova versão.
#
# Referência: Plano Mestre §6, §11.2 (contratos mínimos — TaskContract)
class CreateAcPlans < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_plans do |t|
      # Locatário
      t.references :company, null: false, foreign_key: true
      t.references :project, null: false, foreign_key: true

      # Contexto de trabalho ao qual este plano pertence
      t.references :ac_work_context, null: false, foreign_key: { to_table: :ac_work_contexts }

      # Identificação estável do "thread" de planos (versões do mesmo objetivo)
      t.string :plan_key, null: false

      # Versão sequencial dentro do plan_key
      t.integer :version, null: false, default: 1

      # Título e descrição do objetivo
      t.string :title, null: false
      t.text :objective

      # Estado: draft | active | completed | abandoned | superseded
      t.string :state, null: false, default: "draft"

      # Hash de integridade do conteúdo (garante imutabilidade pós-publicação)
      t.string :content_hash

      # Timestamp de publicação (após publicação, não se editam tasks existentes)
      t.datetime :published_at

      # Quem criou (usuário humano ou referência ao gerente IA)
      t.string :created_by_type, null: false, default: "human"
      t.bigint :created_by_user_id

      # Referência ao policy_revision vigente na publicação
      t.bigint :policy_revision_id

      t.jsonb :metadata, null: false, default: {}
      t.timestamps
    end

    add_index :ac_plans, [ :plan_key, :version ], unique: true
    add_index :ac_plans, [ :ac_work_context_id, :state ]
    add_index :ac_plans, [ :company_id, :project_id ]
    add_index :ac_plans, :state
    add_index :ac_plans, :content_hash, where: "content_hash IS NOT NULL"

    add_check_constraint :ac_plans,
      "state IN ('draft', 'active', 'completed', 'abandoned', 'superseded')",
      name: "ac_plans_valid_state"

    add_check_constraint :ac_plans,
      "version > 0",
      name: "ac_plans_positive_version"

    add_check_constraint :ac_plans,
      "created_by_type IN ('human', 'manager_agent', 'import')",
      name: "ac_plans_valid_creator_type"
  end
end
