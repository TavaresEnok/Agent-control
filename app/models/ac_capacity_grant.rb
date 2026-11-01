# frozen_string_literal: true

# AcCapacityGrant — Reserva atômica de capacidade por tentativa/epoch
#
# Representa o direito temporário de ocupar recursos, registrado atomicamente
# e associado a uma tentativa específica.
#
# RF-13: Reservar capacidade global e local atomicamente, sem contar a mesma conta duas vezes
# RF-47: Reservar por etapa; liberar após encerramento reconciliado
# §11.3: start_execution(operation_id) com o mesmo ID retorna a mesma concessão
# §11.3: Expirar reserva não prova que o processo terminou
#
# Plano Mestre §6 (Reserva de capacidade), §11.2 (CapacityGrant)
class AcCapacityGrant < ApplicationRecord
  extend Enumerize

  # Locatário
  belongs_to :company

  # Tarefa associada
  belongs_to :ac_task

  # Perfil de execução
  belongs_to :ac_execution_profile

  # Conta/credential
  belongs_to :agent_credential

  RESOURCE_TYPES = %w[inference_slot worktree disk_mb process].freeze
  STATES = %w[pending granted active released expired revoked].freeze

  enumerize :state, in: STATES.map(&:to_sym), default: :pending,
            predicates: true, scope: true

  enumerize :resource_type, in: RESOURCE_TYPES.map(&:to_sym),
            default: :inference_slot, predicates: true

  # ── Validações ──────────────────────────────────────────────────────────
  validates :operation_id, presence: true, uniqueness: true
  validates :epoch, presence: true
  validates :state, presence: true
  validates :quantity, numericality: { greater_than: 0, only_integer: true }
  validates :resource_type, presence: true
  validates :policy_revision_id, presence: true
  validates :policy_revision_number, presence: true, numericality: { greater_than: 0 }

  # Credencial deve pertencer à mesma company (RF-49)
  validate :credential_belongs_to_company

  # Tarefa deve pertencer à mesma company
  validate :task_belongs_to_company

  # ── Escopos ─────────────────────────────────────────────────────────────
  scope :for_company, ->(company) { where(company: company) }
  scope :for_credential, ->(cred) { where(agent_credential: cred) }
  scope :active_or_granted, -> { where(state: %w[granted active]) }
  scope :expiring_soon, -> { active_or_granted.where("expires_at < ?", 5.minutes.from_now) }
  scope :for_epoch, ->(epoch) { where(epoch: epoch) }

  # ── Busca idempotente (§11.3) ───────────────────────────────────────────
  # start_execution(operation_id) com o mesmo ID retorna a mesma concessão
  def self.find_or_initialize_for_operation(operation_id:, **attrs)
    find_by(operation_id: operation_id) || new(operation_id: operation_id, **attrs)
  end

  # ── Concessão atômica (RF-13) ────────────────────────────────────────────
  # Usa SELECT FOR UPDATE para garantir atomicidade sem dupla contagem
  def self.grant_atomically!(
    company:, ac_task:, ac_execution_profile:, agent_credential:,
    operation_id:, epoch:, policy_revision_id:, policy_revision_number:,
    quantity: 1, resource_type: :inference_slot, expires_in: 30.minutes
  )
    # All admission paths must share one durable authority. The legacy broker's
    # snapshot is not a reservation, so it cannot authorize an independent grant.
    authority = Rails.application.config.try(:ac_capacity_authority) || AcLocalCapacityAuthorityService
    unless authority && authority.respond_to?(:grant_atomically!)
      raise LimitExceededError, "Autoridade compartilhada de capacidade não configurada"
    end

    authority.grant_atomically!(
      company: company, ac_task: ac_task, ac_execution_profile: ac_execution_profile,
      agent_credential: agent_credential, operation_id: operation_id, epoch: epoch,
      policy_revision_id: policy_revision_id, policy_revision_number: policy_revision_number,
      quantity: quantity, resource_type: resource_type, expires_in: expires_in
    )
  end

  # ── Transições de estado ─────────────────────────────────────────────────
  def activate!
    update!(state: :active)
  end

  # Liberar a concessão (RF-47)
  # §11.3: Expirar reserva não prova que o processo terminou —
  #        use release! somente após confirmar encerramento ou revogação
  def release!
    execution = AcExecution.find_by(ac_capacity_grant_id: id)
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Execução não encontrada" unless execution
    receipt = AcRuntimeSupervisorService.status!(execution: execution)
    unless %w[completed failed not_started].include?(receipt["state"])
      raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Término não comprovado"
    end
    update!(state: :released, released_at: Time.current)
  end

  def expire!
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Expiração não comprova término do escritor"
  end

  # Revogação explícita (§11.3, §11.4 — bloqueio emergencial)
  def revoke!(reason:)
    raise AcRuntimeSupervisorService::UnverifiedReceiptError, "Revogação não comprova término do escritor"
  end

  # §11.3: resultado de processo antigo (epoch diferente) deve ser rejeitado
  def epoch_valid?(execution_epoch)
    epoch == execution_epoch
  end

  LimitExceededError = Class.new(StandardError)

  private

  def credential_belongs_to_company
    return if agent_credential&.company_id == company_id

    errors.add(:agent_credential, "deve pertencer à mesma company (RF-49)")
  end

  def task_belongs_to_company
    return if ac_task&.company_id == company_id

    errors.add(:ac_task, "deve pertencer à mesma company")
  end
end
