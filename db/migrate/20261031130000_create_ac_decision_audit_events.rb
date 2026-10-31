# frozen_string_literal: true

# F1-D — Evento de auditoria de decisão (AC Domain)
#
# Um AcDecisionAuditEvent registra toda decisão de política explicável:
# perfil escolhido/recusado com motivo, trocas, tentativas, revisão,
# integração e intervenção humana (RF-31, RF-09).
#
# O evento é append-only: nenhum registro pode ser atualizado ou deletado.
# Garante o critério G1: "decisões explicáveis".
class CreateAcDecisionAuditEvents < ActiveRecord::Migration[8.1]
  def change
    create_table :ac_decision_audit_events do |t|
      # Locatário
      t.references :company, null: false, foreign_key: true
      t.references :project, null: false, foreign_key: true

      # Tipo de evento:
      # profile_selected        → perfil escolhido com sucesso
      # profile_rejected        → perfil recusado com motivo
      # capacity_granted        → reserva de capacidade concedida
      # capacity_denied         → reserva negada (quota, limite, etc.)
      # capacity_revoked        → reserva revogada explicitamente
      # policy_published        → nova política publicada
      # policy_revoked          → política revogada
      # quota_state_changed     → estado de cota alterado
      # task_state_changed      → tarefa mudou de estado
      # human_intervention      → intervenção humana registrada
      # profile_substitution    → substituição de perfil por fallback
      t.string :event_type, null: false

      # Referências ao contexto do evento
      t.bigint :ac_work_context_id
      t.bigint :ac_plan_id
      t.bigint :ac_task_id
      t.bigint :ac_execution_profile_id
      t.bigint :ac_capacity_grant_id
      t.bigint :ac_policy_revision_id
      t.bigint :agent_credential_id

      # Actores
      t.string :actor_type, null: false  # human | manager_agent | policy_service | system
      t.bigint :actor_user_id

      # Detalhes explicáveis (nunca vazio para decisões de perfil)
      # Inclui: motivo, critério consultado, versão da política, valores comparados
      t.jsonb :decision_details, null: false, default: {}

      # Estado antes e depois (para eventos de mudança de estado)
      t.string :previous_state
      t.string :new_state

      # Motivo legível pelo operador
      t.text :reason

      # Instante preciso do evento
      t.datetime :occurred_at, null: false

      # Epoch de execução (para correlacionar com grants)
      t.string :execution_epoch

      # Metadados adicionais
      t.jsonb :metadata, null: false, default: {}

      # Apenas created_at — sem updated_at (append-only)
      t.datetime :created_at, null: false
    end

    add_index :ac_decision_audit_events, [:company_id, :occurred_at]
    add_index :ac_decision_audit_events, [:ac_task_id, :occurred_at], where: "ac_task_id IS NOT NULL"
    add_index :ac_decision_audit_events, [:ac_work_context_id, :occurred_at], where: "ac_work_context_id IS NOT NULL"
    add_index :ac_decision_audit_events, :event_type
    add_index :ac_decision_audit_events, :occurred_at
    add_index :ac_decision_audit_events, :agent_credential_id, where: "agent_credential_id IS NOT NULL"
    add_index :ac_decision_audit_events, :actor_type

    add_check_constraint :ac_decision_audit_events,
      "event_type IN ('profile_selected','profile_rejected','capacity_granted','capacity_denied',
        'capacity_revoked','policy_published','policy_revoked','quota_state_changed',
        'task_state_changed','human_intervention','profile_substitution')",
      name: "ac_audit_events_valid_type"

    add_check_constraint :ac_decision_audit_events,
      "actor_type IN ('human','manager_agent','policy_service','system')",
      name: "ac_audit_events_valid_actor"
  end
end
