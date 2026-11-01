# frozen_string_literal: true

# F2 — Execução Durável via Temporal e Idempotência (AC Domain)
#
# Representa uma tentativa de execução durável de uma AcTask com:
# - Idempotência estrita por operation_id (§11.3, RF-45)
# - Rejeição de stale results por epoch mismatch (§11.3)
# - Escritor único por worktree através de worktree_lease_token (§11.3.2, RF-48)
# - Rastreabilidade de identificador externo estável process_handle (§11.3.1)
class AcExecution < ApplicationRecord
  self.table_name = "ac_executions"

  belongs_to :company
  belongs_to :ac_task
  belongs_to :ac_work_context
  belongs_to :ac_execution_profile, optional: true
  belongs_to :ac_capacity_grant, optional: true

  enum :state, {
    pending: "pending",
    granted: "granted",
    preparing: "preparing",
    running: "running",
    paused: "paused",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    uncertain: "uncertain"
  }, prefix: true

  def uncertain
    state_uncertain?
  end

  def uncertain?
    state_uncertain?
  end

  validates :operation_id, presence: true, uniqueness: true
  validates :epoch, presence: true
  validates :state, presence: true
  validate :prevent_stale_epoch_transition, on: :update

  # RF-45, §11.3: Retorna a execução existente se o mesmo operation_id for reenviado
  def self.idempotent_find_or_create!(operation_id:, **attributes)
    existing = find_by(operation_id: operation_id)
    return existing if existing.present?

    create!(attributes.merge(operation_id: operation_id))
  rescue ActiveRecord::RecordNotUnique
    find_by!(operation_id: operation_id)
  end

  # §11.3.2: Assegura escritor único para a worktree associada
  def acquire_worktree_lease!(token = SecureRandom.hex(16), path: nil)
    update!(
      worktree_lease_token: token,
      worktree_path: path || worktree_path || "/tmp/ac_worktrees/#{ac_task_id}/#{operation_id}",
      state: :preparing
    )
    token
  end

  # Neutraliza escritor anterior (§11.3.2)
  def assert_no_unsettled_remote_operations!
    if AcRemoteOperation.where(ac_execution_id: id, state: %w[pending running uncertain]).exists?
      raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Operação remota ainda não terminou"
    end
  end

  def revoke_worktree_lease!
    with_lock do
      assert_no_unsettled_remote_operations!
      update!(worktree_lease_token: nil)
    end
  end

  # Marca início da execução com handle externo estável (§11.3.1)
  def mark_running!(handle:)
    raise ArgumentError, "process_handle é obrigatório para iniciar execução" if handle.blank?

    update!(
      process_handle: handle,
      started_at: Time.current,
      heartbeat_at: Time.current,
      state: :running
    )
  end

  # Registra batimento cardíaco da execução
  def record_heartbeat!
    update!(heartbeat_at: Time.current)
  end

  # §11.3: Reconciliação com validação de época — rejeita resultados de épocas antigas
  def reconcile_outcome!(exit_code:, reported_epoch:, output: {}, error: {})
    with_lock do
      if reported_epoch.to_s != epoch.to_s
        raise StaleEpochError, "Resultado rejeitado: reported_epoch (#{reported_epoch}) diverge da época atual (#{epoch})"
      end
      assert_no_unsettled_remote_operations!
      terminal_state = (exit_code == 0) ? :completed : :failed
      update!(exit_code: exit_code, finished_at: Time.current, output_payload: output || {},
        error_details: error || {}, state: terminal_state)
    end
  end

  # §11.3.1: Quando o supervisor não consegue provar se o processo existe, entra em uncertain
  def mark_uncertain!(reason:)
    update!(
      state: :uncertain,
      error_details: error_details.merge("uncertain_reason" => reason, "marked_at" => Time.current.iso8601)
    )
  end

  # Cancelamento coordenado
  def cancel!(reason: "Cancelado pelo usuário ou workflow")
    with_lock do
      assert_no_unsettled_remote_operations!
      update!(state: :cancelled, finished_at: Time.current,
        error_details: error_details.merge("cancellation_reason" => reason))
    end
  end

  class StaleEpochError < StandardError; end

  private

  def prevent_stale_epoch_transition
    return unless epoch_changed? && epoch_was.present?

    # Épocas devem ser sequenciais ou estritamente crescentes
    if epoch.to_i < epoch_was.to_i
      errors.add(:epoch, "não pode regredir para um valor anterior (#{epoch} < #{epoch_was})")
    end
  end
end
