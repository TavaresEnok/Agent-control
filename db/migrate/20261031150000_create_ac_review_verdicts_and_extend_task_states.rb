# frozen_string_literal: true

# F3 — Qualidade, Revisão e Pareceres Estruturados (AC Domain)
#
# Representa pareceres estruturados de QA e Revisão (§15 — Qualidade, revisão e integração).
#
# RF-18: Revisão independente obrigatória para código; parecer aprova hash exato de artefato
# §15.1: Papéis e saídas diferentes (programador implementa, QA testa comportamento, revisor avalia diff)
# §15.2: Independência mínima — revisor não altera o próprio código
# §15.3: Identidade de aprovação — novo artefato invalida parecer prévio
class CreateAcReviewVerdictsAndExtendTaskStates < ActiveRecord::Migration[8.1]
  def change
    # 1. Atualiza constraint de estados de AcTask para suportar needs_changes e waiting_dependencies (§12.2)
    remove_check_constraint :ac_tasks, name: "ac_tasks_valid_state"
    add_check_constraint :ac_tasks,
      "state IN ('pending','waiting_dependencies','queued','running','review','needs_changes','approved','integrated','failed','cancelled')",
      name: "ac_tasks_valid_state"

    # 2. Cria tabela ac_review_verdicts
    create_table :ac_review_verdicts do |t|
      t.references :company, null: false, foreign_key: true
      t.references :project, null: false, foreign_key: true
      t.references :ac_task, null: false, foreign_key: { to_table: :ac_tasks }
      t.references :ac_execution, null: true, foreign_key: { to_table: :ac_executions }

      # Papel do avaliador: reviewer | qa (§15.1)
      t.string :reviewer_role, null: false, default: "reviewer"

      # Parecer: approved | rejected | needs_changes | waived
      t.string :verdict, null: false

      # Hash do artefato/commit exato examinado (§15.3)
      t.string :artifact_hash, null: false

      # Base commit sobre a qual a mudança foi gerada
      t.string :base_commit_hash

      # Commit SHA candidato
      t.string :candidate_commit_sha

      # Achados estruturados (§15.2: evidência, severidade, impacto, resolução)
      t.jsonb :findings, null: false, default: []

      # Identidade do executor/revisor (§15.3.1)
      t.string :evaluator_identity, null: false

      # Versão da política na aprovação
      t.integer :policy_revision_number

      # Estado do parecer: valid | invalidated | superseded (§15.3)
      t.string :state, null: false, default: "valid"

      # Motivo da invalidação quando artefato muda (§15.3)
      t.string :invalidation_reason

      t.jsonb :metadata, null: false, default: {}
      t.timestamps
    end

    add_index :ac_review_verdicts, [ :ac_task_id, :state ]
    add_index :ac_review_verdicts, [ :artifact_hash, :state ]
    add_index :ac_review_verdicts, [ :company_id, :verdict ]
    add_index :ac_review_verdicts, [ :ac_task_id, :reviewer_role, :state ]

    add_check_constraint :ac_review_verdicts,
      "verdict IN ('approved','rejected','needs_changes','waived')",
      name: "ac_review_verdicts_valid_verdict"

    add_check_constraint :ac_review_verdicts,
      "state IN ('valid','invalidated','superseded')",
      name: "ac_review_verdicts_valid_state"

    add_check_constraint :ac_review_verdicts,
      "reviewer_role IN ('reviewer','qa')",
      name: "ac_review_verdicts_valid_role"
  end
end
