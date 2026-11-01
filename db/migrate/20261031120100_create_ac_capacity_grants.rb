# frozen_string_literal: true

# F1-C — Reserva de capacidade atômica (AC Domain)
#
# Uma AcCapacityGrant representa o direito temporário de ocupar recursos,
# registrado atomicamente e associado a uma tentativa (§6 — Reserva de capacidade).
#
# RF-13: Reservar capacidade global e local atomicamente, sem contar a mesma conta duas vezes
# RF-47: Reservar recursos por execução de etapa e liberar após encerramento reconciliado
# §11.3: Idempotência e concessões — ticket referencia concessão e política imutáveis
# §11.3: Expirar reserva não prova que o processo terminou
class CreateAcCapacityGrants < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_capacity_grants do |t|
      # Locatário
      t.references :company, null: false, foreign_key: true

      # Tarefa e plano associados
      t.references :ac_task, null: false, foreign_key: { to_table: :ac_tasks }

      # Perfil de execução para o qual a concessão foi feita
      t.references :ac_execution_profile, null: false, foreign_key: { to_table: :ac_execution_profiles }

      # Conta/credential associada
      t.references :agent_credential, null: false, foreign_key: true

      # Identificador único da tentativa (idempotência — §11.3)
      # O mesmo operation_id retorna a mesma concessão em vez de criar outra
      t.string :operation_id, null: false

      # Época de execução (permite rejeitar resultados de processos antigos — §11.3)
      t.string :epoch, null: false

      # Estado: pending | granted | active | released | expired | revoked
      t.string :state, null: false, default: "pending"

      # Quantidade reservada (unidades abstratas conforme tipo de recurso)
      t.integer :quantity, null: false, default: 1

      # Tipo de recurso reservado: inference_slot | worktree | disk_mb | process
      t.string :resource_type, null: false, default: "inference_slot"

      # Política vigente no momento da concessão (snapshot imutável — §11.3)
      t.bigint :policy_revision_id, null: false

      # Versão da política fixada no ticket (para detectar mudanças — §11.3)
      t.integer :policy_revision_number, null: false

      # Validade da concessão
      t.datetime :granted_at
      t.datetime :expires_at
      t.datetime :released_at

      # Motivo da revogação (quando state = revoked)
      t.string :revoke_reason

      # Referência ao processo externo (preenchida após lançamento real)
      t.string :external_process_id

      # Metadados de reconciliação
      t.jsonb :reconciliation_data, null: false, default: {}

      t.timestamps
    end

    add_index :ac_capacity_grants, :operation_id, unique: true
    add_index :ac_capacity_grants, [ :ac_task_id, :state ]
    add_index :ac_capacity_grants, [ :agent_credential_id, :state ]
    add_index :ac_capacity_grants, [ :company_id, :state ]
    add_index :ac_capacity_grants, :state
    add_index :ac_capacity_grants, :expires_at, where: "state IN ('granted','active')"
    add_index :ac_capacity_grants, :epoch

    add_check_constraint :ac_capacity_grants,
      "state IN ('pending','granted','active','released','expired','revoked')",
      name: "ac_capacity_grants_valid_state"

    add_check_constraint :ac_capacity_grants,
      "resource_type IN ('inference_slot','worktree','disk_mb','process')",
      name: "ac_capacity_grants_valid_resource"

    add_check_constraint :ac_capacity_grants,
      "quantity > 0",
      name: "ac_capacity_grants_positive_qty"
  end
end
