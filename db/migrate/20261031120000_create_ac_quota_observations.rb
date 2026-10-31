# frozen_string_literal: true

# F1-C — Observação de cota (AC Domain)
#
# Uma AcQuotaObservation registra evidência com origem, instante, escopo,
# validade e nível de confiança (§6 — Observação de cota).
#
# RF-10: Distinguir cota esgotada, limite temporário, autenticação inválida,
#         falha de rede e estado desconhecido
# RF-30: Exibir uso, cota e renovação por conta quando observáveis
# RNF-14: Cota não observada nunca é apresentada como disponível
class CreateAcQuotaObservations < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_quota_observations do |t|
      # Locatário
      t.references :company, null: false, foreign_key: true

      # Conta observada (agent_credential existente)
      t.references :agent_credential, null: false, foreign_key: true

      # CLI/transporte usado para observar (codex_cli | claude_code | grok_cli | antigravity_cli)
      t.string :cli_adapter, null: false

      # Modelo/escopo da cota (ex: "gpt-6.1", "claude-sonnet-5-5", "global")
      t.string :model_scope, null: false

      # Janela de tempo observada (início e fim)
      t.datetime :window_start
      t.datetime :window_end

      # Estado da cota:
      # exhausted      → cota confirmadamente esgotada
      # rate_limited   → limite temporário (retry-after conhecido)
      # auth_error     → autenticação inválida/expirada
      # network_error  → falha de rede/transporte
      # unknown        → estado não determinável
      # available      → capacidade disponível confirmada
      t.string :quota_state, null: false

      # Dados quantitativos quando disponíveis (tokens, percentual, segundos)
      t.jsonb :quota_data, null: false, default: {}

      # Quando a observação foi coletada
      t.datetime :observed_at, null: false

      # Validade estimada da observação
      t.datetime :valid_until

      # Nível de confiança: high | medium | low | snapshot_only
      t.string :confidence_level, null: false, default: "medium"

      # Origem: cli_output | api_header | synthetic_probe | manual_import
      t.string :origin, null: false, default: "cli_output"

      # Evidência redigida (sem segredos — §11.5, RNF-08)
      t.text :redacted_evidence

      # Task que gerou esta observação (opcional)
      t.bigint :ac_task_id

      t.timestamps
    end

    add_index :ac_quota_observations, [:agent_credential_id, :observed_at]
    add_index :ac_quota_observations, [:agent_credential_id, :quota_state]
    add_index :ac_quota_observations, [:company_id, :quota_state]
    add_index :ac_quota_observations, :observed_at
    add_index :ac_quota_observations, :valid_until, where: "valid_until IS NOT NULL"
    add_index :ac_quota_observations, :ac_task_id, where: "ac_task_id IS NOT NULL"

    add_check_constraint :ac_quota_observations,
      "quota_state IN ('exhausted','rate_limited','auth_error','network_error','unknown','available')",
      name: "ac_quota_observations_valid_state"

    add_check_constraint :ac_quota_observations,
      "confidence_level IN ('high','medium','low','snapshot_only')",
      name: "ac_quota_observations_valid_confidence"

    add_check_constraint :ac_quota_observations,
      "origin IN ('cli_output','api_header','synthetic_probe','manual_import')",
      name: "ac_quota_observations_valid_origin"

    add_check_constraint :ac_quota_observations,
      "cli_adapter IN ('codex_cli','claude_code','grok_cli','antigravity_cli')",
      name: "ac_quota_observations_valid_cli"
  end
end
