# frozen_string_literal: true

# F2 — Execução Durável via Temporal e Idempotência (AC Domain)
#
# Uma AcExecution representa uma tentativa física de execução associada a uma AcTask,
# controlada por Temporal, com chave de idempotência (operation_id), controle de épocas (epoch)
# e identificador externo estável do supervisor (process_handle) antes de iniciar processos.
#
# RF-45: start_execution(operation_id) com o mesmo ID retorna a mesma operação sem duplicar
# RF-48: Autoridade de escrita da worktree — escritor único com token e neutralização
# §11.3: Épocas de execução permitem rejeitar resultados de processos antigos
# §11.3.1: Falha entre registro de intenção e criação do processo — recuperação não cria cópia cega
class CreateAcExecutions < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_executions do |t|
      # Locatário
      t.references :company, null: false, foreign_key: true

      # Tarefa e contexto associados
      t.references :ac_task, null: false, foreign_key: { to_table: :ac_tasks }
      t.references :ac_work_context, null: false, foreign_key: { to_table: :ac_work_contexts }

      # Perfil de execução selecionado pela política
      t.references :ac_execution_profile, null: true, foreign_key: { to_table: :ac_execution_profiles }

      # Concessão atômica de capacidade vinculada
      t.references :ac_capacity_grant, null: true, foreign_key: { to_table: :ac_capacity_grants }

      # Identificador único de idempotência (§11.3)
      t.string :operation_id, null: false

      # Época de execução (§11.3)
      t.string :epoch, null: false

      # Estado da execução: pending | granted | preparing | running | paused | completed | failed | cancelled | uncertain
      t.string :state, null: false, default: "pending"

      # Identificador externo estável do processo/supervisor (§11.3.1)
      t.string :process_handle

      # Token do escritor único autorizado para a worktree (§11.3.2)
      t.string :worktree_lease_token

      # Caminho da worktree isolada
      t.string :worktree_path

      # Rastreabilidade Temporal
      t.string :temporal_workflow_id
      t.string :temporal_run_id

      # Timestamps de progresso
      t.datetime :heartbeat_at
      t.datetime :started_at
      t.datetime :finished_at

      # Resultado
      t.integer :exit_code
      t.jsonb :output_payload, null: false, default: {}
      t.jsonb :error_details, null: false, default: {}
      t.jsonb :metadata, null: false, default: {}

      t.timestamps
    end

    add_index :ac_executions, :operation_id, unique: true
    add_index :ac_executions, [:ac_task_id, :state]
    add_index :ac_executions, [:company_id, :state]
    add_index :ac_executions, :epoch
    add_index :ac_executions, :process_handle
    add_index :ac_executions, :worktree_lease_token

    add_check_constraint :ac_executions,
      "state IN ('pending','granted','preparing','running','paused','completed','failed','cancelled','uncertain')",
      name: "ac_executions_valid_state"
  end
end
