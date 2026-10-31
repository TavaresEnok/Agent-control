# frozen_string_literal: true

# F1-A — Tarefa do plano (AC Domain)
#
# Uma AcTask é a unidade de entrega com escopo, entradas, saídas e verificação
# (RF-15). A tarefa é independente do provedor que a executará.
# Referência: Plano Mestre §6 (Tarefa), §11.2 (TaskContract)
class CreateAcTasks < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_tasks do |t|
      # Locatário
      t.references :company, null: false, foreign_key: true
      t.references :project, null: false, foreign_key: true

      # Plano ao qual a tarefa pertence
      t.references :ac_plan, null: false, foreign_key: { to_table: :ac_plans }

      # Chave estável da tarefa dentro do plano
      t.string :task_key, null: false

      # Título e escopo
      t.string :title, null: false
      t.text :scope

      # Entradas esperadas (JSON schema ou descrição)
      t.jsonb :inputs, null: false, default: {}

      # Saídas esperadas (JSON schema ou descrição)
      t.jsonb :outputs, null: false, default: {}

      # Critérios de aceite
      t.text :acceptance_criteria

      # Classe de risco: low | medium | high | critical
      # Influencia se QA e revisão independente são obrigatórios (RF-18)
      t.string :risk_class, null: false, default: "medium"

      # Papel responsável pela execução
      # programmer | manager | qa | reviewer | specialist | integrator
      t.string :assigned_role, null: false, default: "programmer"

      # Dependências: array de task_keys dentro do mesmo plano
      t.string :depends_on, null: false, default: [], array: true

      # Estado: pending | queued | running | review | approved | integrated | failed | cancelled
      t.string :state, null: false, default: "pending"

      # Ordem de prioridade dentro do plano
      t.integer :position, null: false, default: 0

      # Commit/artefato aprovado final
      t.string :approved_commit_sha
      t.string :approved_artifact_hash

      # Tentativas de execução (contagem para limite RF-21)
      t.integer :attempt_count, null: false, default: 0

      t.jsonb :metadata, null: false, default: {}
      t.timestamps
    end

    add_index :ac_tasks, [:ac_plan_id, :task_key], unique: true
    add_index :ac_tasks, [:ac_plan_id, :position]
    add_index :ac_tasks, [:company_id, :project_id, :state]
    add_index :ac_tasks, :state
    add_index :ac_tasks, :assigned_role
    add_index :ac_tasks, :approved_commit_sha, where: "approved_commit_sha IS NOT NULL"

    add_check_constraint :ac_tasks,
      "state IN ('pending','queued','running','review','approved','integrated','failed','cancelled')",
      name: "ac_tasks_valid_state"

    add_check_constraint :ac_tasks,
      "risk_class IN ('low','medium','high','critical')",
      name: "ac_tasks_valid_risk_class"

    add_check_constraint :ac_tasks,
      "assigned_role IN ('programmer','manager','qa','reviewer','specialist','integrator')",
      name: "ac_tasks_valid_role"

    add_check_constraint :ac_tasks,
      "attempt_count >= 0",
      name: "ac_tasks_nonneg_attempts"
  end
end
