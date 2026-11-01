# frozen_string_literal: true

# AcExecutionProfile — Combinação elegível de papel, CLI, modelo, esforço e conta
#
# Define O QUE pode ser executado (não o processo em si).
# Validação de elegibilidade inclui: CLI presente no host, modelo no catálogo,
# esforço ≤ Alto, conta ativa na company (ADR-002, RF-07, RF-08, RF-09).
#
# Plano Mestre §6 (Perfil de execução), §9 (Papéis e modelos)
class AcExecutionProfile < ApplicationRecord
  extend Enumerize

  # Locatário
  belongs_to :company

  # Política que define este perfil
  belongs_to :ac_policy_revision

  # Conta/credential associada (opcional — pool dinâmico quando nil)
  belongs_to :agent_credential, optional: true

  # Reservas de capacidade feitas com este perfil
  has_many :ac_capacity_grants, foreign_key: :ac_execution_profile_id,
           dependent: :destroy, inverse_of: :ac_execution_profile

  # Eventos de auditoria
  has_many :ac_decision_audit_events, foreign_key: :ac_execution_profile_id,
           dependent: :nullify, inverse_of: false

  # CLIs suportadas conforme ADR-002 (documented_supported)
  ELIGIBLE_CLI_ADAPTERS = %w[codex_cli claude_code grok_cli antigravity_cli].freeze

  # Esforços permitidos — Ultra/xhigh são bloqueados (ADR-002, §9.1)
  ALLOWED_EFFORT_LEVELS = %w[low medium high].freeze

  # Papéis da plataforma
  PLATFORM_ROLES = %w[manager programmer reviewer qa specialist integrator].freeze

  enumerize :role, in: PLATFORM_ROLES.map(&:to_sym),
            predicates: true, scope: true

  enumerize :cli_adapter, in: ELIGIBLE_CLI_ADAPTERS.map { |c| c.to_sym },
            predicates: true

  enumerize :effort_level, in: %i[low medium high],
            default: :medium, predicates: true

  enumerize :permanence_rule, in: %i[permanent return_to_principal conclude_and_yield],
            default: :permanent, predicates: true

  enumerize :state, in: %i[active disabled deprecated],
            default: :active, predicates: true, scope: true

  # ── Validações ──────────────────────────────────────────────────────────
  validates :profile_key, presence: true,
            format: { with: /\A[a-z0-9_\-]+\z/i }
  validates :profile_key, uniqueness: {
    scope: :ac_policy_revision_id,
    message: "já existe nesta revisão de política"
  }
  validates :role, presence: true, inclusion: { in: PLATFORM_ROLES }
  validates :cli_adapter, presence: true, inclusion: { in: ELIGIBLE_CLI_ADAPTERS }
  validates :effort_level, presence: true, inclusion: { in: ALLOWED_EFFORT_LEVELS }
  validates :model_id, presence: true
  validates :chain_position, numericality: { greater_than: 0, only_integer: true }

  # Credencial deve pertencer à mesma company (RF-49)
  validate :credential_belongs_to_company, if: :agent_credential_id?
  validate :policy_belongs_to_company

  # Motivo de inelegibilidade obrigatório quando desabilitado
  validate :ineligibility_reason_required_when_disabled
  validate :published_profile_immutable
  around_save :serialize_policy_write
  around_destroy :serialize_policy_destruction
  before_destroy :prevent_published_profile_destruction

  # ── Escopos ─────────────────────────────────────────────────────────────
  scope :for_role, ->(role) { where(role: role) }
  scope :for_cli, ->(cli) { where(cli_adapter: cli) }
  scope :eligible, -> { where(state: :active).order(:chain_position) }

  # Cadeia de substituição ordenada para um papel
  scope :substitution_chain, ->(role) {
    for_role(role).where(state: :active).order(:chain_position)
  }

  # ── Elegibilidade ────────────────────────────────────────────────────────
  # RF-09: motivo explicável por que um perfil foi escolhido ou recusado
  def eligibility_verdict
    reasons = []
    reasons << "CLI '#{cli_adapter}' não está na lista de suporte (ADR-002)" unless ELIGIBLE_CLI_ADAPTERS.include?(cli_adapter)
    reasons << "Esforço '#{effort_level}' bloqueado (ADR-002 §9.1)" unless ALLOWED_EFFORT_LEVELS.include?(effort_level)
    reasons << "Perfil não está ativo: #{ineligibility_reason}" unless active?
    reasons << "Revisão revogada, não publicada ou de outra empresa" unless
      %w[published superseded].include?(ac_policy_revision&.state.to_s) && ac_policy_revision&.company_id == company_id
    reasons << "Conta explícita obrigatória" unless agent_credential_id?
    reasons << "Elegibilidade de modo/modelo/esforço sem atestado vigente" unless catalog_attested?
    reasons << "Transporte consumidor Antigravity inelegível neste modo" if cli_adapter.to_s == "antigravity_cli"
    reasons << "Credencial inativa ou expirada" if agent_credential_id? && !credential_eligible?

    {
      eligible: reasons.empty?,
      reasons: reasons,
      profile_key: profile_key,
      policy_revision_number: ac_policy_revision.revision_number
    }
  end

  def catalog_attested?
    evidence = selection_criteria.is_a?(Hash) ? selection_criteria["eligibility"] : nil
    return false unless evidence.is_a?(Hash)

    expires = Time.iso8601(evidence["valid_until"].to_s)
    evidence["status"] == "documented_supported" && evidence["model_id"] == model_id &&
      evidence["cli_adapter"] == cli_adapter.to_s && evidence["efforts"].is_a?(Array) &&
      evidence["efforts"].include?(effort_level.to_s) && expires > Time.current &&
      cli_adapter.to_s != "antigravity_cli" && agent_credential_id.present? && credential_eligible? &&
      { "codex_cli" => "codex", "claude_code" => "claude_code", "grok_cli" => "grok" }[cli_adapter.to_s] == agent_credential.agent_type
  rescue ArgumentError
    false
  end

  def eligible?
    eligibility_verdict[:eligible]
  end

  private

  def published_profile_immutable
    revision = AcPolicyRevision.find_by(id: persisted? ? ac_policy_revision_id_in_database : ac_policy_revision_id)
    destination = AcPolicyRevision.find_by(id: ac_policy_revision_id)
    if will_save_change_to_ac_policy_revision_id? && destination && %w[published superseded revoked].include?(destination.state.to_s)
      errors.add(:base, "Não é possível adicionar perfil a uma política publicada")
      return
    end
    return unless revision && %w[published superseded revoked].include?(revision.state.to_s)
    if new_record?
      errors.add(:base, "Não é possível adicionar perfil a uma política publicada")
      return
    end
    return if (changes.keys - %w[state ineligibility_reason updated_at]).empty?

    errors.add(:base, "Perfil de política publicada é imutável; crie nova revisão")
  end

  def serialize_policy_write
    company.with_lock do
      published_profile_immutable
      raise ActiveRecord::RecordNotSaved.new("Perfil alterado durante a publicação", self) if errors.any?
      yield
    end
  end

  def serialize_policy_destruction
    company.with_lock { yield }
  end

  def prevent_published_profile_destruction
    revision = AcPolicyRevision.find_by(id: ac_policy_revision_id)
    return unless revision && %w[published superseded revoked].include?(revision.state.to_s)

    errors.add(:base, "Perfil de política publicada é imutável; crie nova revisão")
    throw(:abort)
  end

  def policy_belongs_to_company
    return if ac_policy_revision&.company_id == company_id

    errors.add(:ac_policy_revision, "deve pertencer à mesma company")
  end

  def credential_belongs_to_company
    return if agent_credential&.company_id == company_id

    errors.add(:agent_credential, "deve pertencer à mesma company (RF-49)")
  end

  def ineligibility_reason_required_when_disabled
    return unless disabled?
    return if ineligibility_reason.present?

    errors.add(:ineligibility_reason, "é obrigatório quando o perfil está desabilitado (RF-09)")
  end

  def credential_eligible?
    return true unless agent_credential_id?

    agent_credential&.active? && !agent_credential&.expires_at&.past?
  end
end
