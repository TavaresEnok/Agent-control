# frozen_string_literal: true

# F1-A — Contexto de trabalho persistente (AC Domain)
#
# Um AcWorkContext é a conversa persistente associada a um gerente lógico.
# Sobrevive à troca de conta, modelo e CLI (RF-03). Um projeto pode ter
# múltiplos contextos, mas cada um tem exatamente um gerente ativo (RF-04).
#
# Referência: Plano Mestre §6 (Vocabulário), §11.1 (autoridade por tipo de estado)
class CreateAcWorkContexts < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_work_contexts do |t|
      # Locatário obrigatório
      t.references :company, null: false, foreign_key: true
      t.references :project, null: false, foreign_key: true

      # Identidade estável do contexto — referenciada em handoffs e importação
      t.string :external_id, null: false

      # Título legível pelo operador
      t.string :title, null: false

      # Estado: active | paused | archived | suspended
      # paused = pausa explícita do operador (RF-24, RF-44)
      # suspended = pausa técnica aguardando capacidade
      t.string :state, null: false, default: "active"

      # Motivo da pausa (para "paused" ou "suspended")
      t.string :pause_reason

      # Resumo do objetivo atual do contexto
      t.text :objective_summary

      # Metadados flexíveis (importação Paseo, tags, etc.)
      t.jsonb :metadata, null: false, default: {}

      # Proveniência: origem desta entrada (new | paseo_import | migration)
      t.string :origin, null: false, default: "new"

      # Snapshot da versão da política ativa no momento da criação
      t.bigint :policy_revision_id

      t.timestamps
    end

    add_index :ac_work_contexts, :external_id, unique: true
    add_index :ac_work_contexts, [ :company_id, :project_id ]
    add_index :ac_work_contexts, :state
    add_index :ac_work_contexts, :policy_revision_id
    add_index :ac_work_contexts, :created_at

    add_check_constraint :ac_work_contexts,
      "state IN ('active', 'paused', 'archived', 'suspended')",
      name: "ac_work_contexts_valid_state"

    add_check_constraint :ac_work_contexts,
      "origin IN ('new', 'paseo_import', 'migration')",
      name: "ac_work_contexts_valid_origin"
  end
end
