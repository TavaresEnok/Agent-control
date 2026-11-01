# frozen_string_literal: true

# F1-B — Perfil de execução elegível (AC Domain)
#
# Um AcExecutionProfile é a combinação elegível de papel, CLI, modelo, esforço,
# permissões e critérios de seleção de conta (§6 — Perfil de execução).
# O perfil define O QUE pode ser executado, não o processo em si.
#
# RF-07: Configurar papel, perfil, esforço, conta, prioridade e substituições
# RF-08: Validar catálogo e combinações antes de publicar
# RF-09: Exibir versão aplicada e explicar por que um perfil foi escolhido
# ADR-002: Cadeia de modelos e elegibilidade (RF-55/T39)
class CreateAcExecutionProfiles < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_execution_profiles do |t|
      # Locatário
      t.references :company, null: false, foreign_key: true

      # Política que define este perfil
      t.references :ac_policy_revision, null: false, foreign_key: { to_table: :ac_policy_revisions }

      # Nome/slug do perfil (ex: "manager_primary", "programmer_regular_1")
      t.string :profile_key, null: false

      # Papel: manager | programmer | reviewer | qa | specialist | integrator
      t.string :role, null: false

      # CLI oficial: codex_cli | claude_code | grok_cli | antigravity_cli
      # Conforme ADR-002 (documented_supported somente)
      t.string :cli_adapter, null: false

      # Identificador real do modelo conforme aceito pela CLI
      # (rótulo de exibição não substitui — §11.2)
      t.string :model_id, null: false

      # Esforço: low | medium | high
      # Ultra/xhigh são bloqueados (ADR-002, §9.1)
      t.string :effort_level, null: false, default: "medium"

      # Referência à conta/credential — usa agent_credential_id existente
      # Null = conta não fixada (seleciona por pool dinâmico)
      t.bigint :agent_credential_id

      # Posição na cadeia de substituição (1 = principal, 2 = primeira substituição, etc.)
      t.integer :chain_position, null: false, default: 1

      # Regra de permanência: permanent | return_to_principal | conclude_and_yield
      t.string :permanence_rule, null: false, default: "permanent"

      # Estado: active | disabled | deprecated
      t.string :state, null: false, default: "active"

      # Motivo de inelegibilidade (quando state = disabled)
      t.string :ineligibility_reason

      # Permissões máximas concedidas (jsonb: worktree, network, docker_socket, etc.)
      t.jsonb :permissions, null: false, default: {}

      # Limites operacionais (cpu, memory, disk, processes)
      t.jsonb :limits, null: false, default: {}

      # Critérios de seleção adicional (jsonb flexível)
      t.jsonb :selection_criteria, null: false, default: {}

      t.timestamps
    end

    add_index :ac_execution_profiles, [ :ac_policy_revision_id, :profile_key ], unique: true,
              name: "idx_ac_exec_profiles_revision_key"
    add_index :ac_execution_profiles, [ :company_id, :role, :state ]
    add_index :ac_execution_profiles, [ :company_id, :cli_adapter, :state ]
    add_index :ac_execution_profiles, :agent_credential_id, where: "agent_credential_id IS NOT NULL"
    add_index :ac_execution_profiles, :state
    add_index :ac_execution_profiles, [ :role, :chain_position ]

    add_check_constraint :ac_execution_profiles,
      "role IN ('manager','programmer','reviewer','qa','specialist','integrator')",
      name: "ac_exec_profiles_valid_role"

    add_check_constraint :ac_execution_profiles,
      "cli_adapter IN ('codex_cli','claude_code','grok_cli','antigravity_cli')",
      name: "ac_exec_profiles_valid_cli"

    add_check_constraint :ac_execution_profiles,
      "effort_level IN ('low','medium','high')",
      name: "ac_exec_profiles_valid_effort"

    add_check_constraint :ac_execution_profiles,
      "state IN ('active','disabled','deprecated')",
      name: "ac_exec_profiles_valid_state"

    add_check_constraint :ac_execution_profiles,
      "permanence_rule IN ('permanent','return_to_principal','conclude_and_yield')",
      name: "ac_exec_profiles_valid_permanence"

    add_check_constraint :ac_execution_profiles,
      "chain_position > 0",
      name: "ac_exec_profiles_positive_chain"
  end
end
