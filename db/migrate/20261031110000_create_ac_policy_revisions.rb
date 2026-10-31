# frozen_string_literal: true

# F1-B — Revisão de política versionada e imutável (AC Domain)
#
# Uma AcPolicyRevision representa um documento de política validado e imutável,
# usado para explicar e reproduzir uma decisão de perfil (§6, §11.2 PolicyRevision).
# Após publicação, o conteúdo não pode ser alterado; mudanças criam nova revisão.
#
# RF-08: Validar catálogo e combinações antes de publicar
# RF-09: Exibir versão aplicada e explicar decisão
# RF-42: Validar edição concorrente e disponibilizar reversão
class CreateAcPolicyRevisions < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_policy_revisions do |t|
      # Locatário
      t.references :company, null: false, foreign_key: true

      # Revisão antecessora (cadeia de versões)
      t.bigint :predecessor_id

      # Número de revisão sequencial por company
      t.integer :revision_number, null: false, default: 1

      # Estado: draft | published | superseded | revoked
      t.string :state, null: false, default: "draft"

      # Diff estruturado em relação à revisão anterior (jsonb)
      t.jsonb :diff, null: false, default: {}

      # Conteúdo completo da política (snapshot imutável após publicação)
      # Inclui: cadeia de modelos, limites de esforço, regras de permanência,
      # contas ativas, esforço máximo, etc.
      t.jsonb :content, null: false, default: {}

      # Hash de integridade do conteúdo
      t.string :content_hash, null: false

      # Resultado da validação (lista de erros se inválido)
      t.jsonb :validation_result, null: false, default: {}

      # Modo de aplicação: next_attempts | drain_and_switch | immediate_revoke
      t.string :apply_mode, null: false, default: "next_attempts"

      # Quem publicou (usuário humano)
      t.bigint :published_by_user_id
      t.datetime :published_at

      # Motivo da revogação
      t.string :revoked_reason
      t.datetime :revoked_at
      t.bigint :revoked_by_user_id

      t.timestamps
    end

    add_index :ac_policy_revisions, [:company_id, :revision_number], unique: true
    add_index :ac_policy_revisions, :content_hash, unique: true
    add_index :ac_policy_revisions, :state
    add_index :ac_policy_revisions, :predecessor_id
    add_index :ac_policy_revisions, [:company_id, :state]

    add_check_constraint :ac_policy_revisions,
      "state IN ('draft','published','superseded','revoked')",
      name: "ac_policy_revisions_valid_state"

    add_check_constraint :ac_policy_revisions,
      "apply_mode IN ('next_attempts','drain_and_switch','immediate_revoke')",
      name: "ac_policy_revisions_valid_apply_mode"

    add_check_constraint :ac_policy_revisions,
      "revision_number > 0",
      name: "ac_policy_revisions_positive_revision"
  end
end
