# frozen_string_literal: true

# AcQuotaObservation — Evidência de cota com origem, validade e nível de confiança
#
# RF-10: Distinguir cota esgotada, limite temporário, autenticação inválida,
#         falha de rede e estado desconhecido
# RF-30: Exibir uso, cota e renovação por conta quando observáveis
# RNF-14: Cota não observada NUNCA é apresentada como disponível sem identificação
#
# Plano Mestre §6 (Observação de cota), §11.2 (QuotaObservation)
class AcQuotaObservation < ApplicationRecord
  extend Enumerize

  # Locatário
  belongs_to :company

  # Conta observada
  belongs_to :agent_credential

  # Tarefa que gerou a observação (opcional)
  belongs_to :ac_task, optional: true

  QUOTA_STATES = %w[exhausted rate_limited auth_error network_error unknown available].freeze
  CONFIDENCE_LEVELS = %w[high medium low snapshot_only].freeze
  ORIGINS = %w[cli_output api_header synthetic_probe manual_import].freeze

  enumerize :quota_state, in: QUOTA_STATES.map(&:to_sym), predicates: true, scope: true
  enumerize :confidence_level, in: CONFIDENCE_LEVELS.map(&:to_sym),
            default: :medium, predicates: true
  enumerize :origin, in: ORIGINS.map(&:to_sym), default: :cli_output, predicates: true

  # ── Validações ──────────────────────────────────────────────────────────
  validates :cli_adapter, presence: true,
            inclusion: { in: AcExecutionProfile::ELIGIBLE_CLI_ADAPTERS,
                         message: "CLI não suportada (ADR-002)" }
  validates :model_scope, presence: true
  validates :quota_state, presence: true
  validates :confidence_level, presence: true
  validates :origin, presence: true
  validates :observed_at, presence: true

  # Conta deve pertencer à mesma company (RF-49)
  validate :credential_belongs_to_company

  # Evidência redigida obrigatória quando disponível (RNF-08)
  validate :no_secrets_in_evidence

  # ── Escopos ─────────────────────────────────────────────────────────────
  scope :for_credential, ->(cred) { where(agent_credential: cred) }
  scope :recent, -> { order(observed_at: :desc) }
  scope :valid_now, -> { where("valid_until IS NULL OR valid_until > ?", Time.current) }
  scope :blocking, -> { where(quota_state: %w[exhausted auth_error]) }

  # Observação mais recente e ainda válida para uma conta/cli/modelo
  def self.latest_for(agent_credential:, cli_adapter:, model_scope:)
    where(agent_credential: agent_credential,
          cli_adapter: cli_adapter,
          model_scope: model_scope)
      .valid_now
      .order(observed_at: :desc)
      .first
  end

  # ── Estado ───────────────────────────────────────────────────────────────
  def blocking?
    exhausted? || auth_error?
  end

  def still_valid?
    valid_until.nil? || valid_until > Time.current
  end

  # RF-10: descrição explicável do estado
  def state_description
    case quota_state
    when "exhausted"    then "Cota esgotada: nenhuma capacidade disponível nesta janela"
    when "rate_limited" then "Limite temporário: aguardar retry-after antes de tentar novamente"
    when "auth_error"   then "Autenticação inválida ou expirada: credencial deve ser renovada"
    when "network_error" then "Falha de rede/transporte: sem confirmação do estado real"
    when "unknown"      then "Estado desconhecido: não é seguro assumir disponibilidade (RNF-14)"
    when "available"    then "Capacidade disponível confirmada (confiança: #{confidence_level})"
    end
  end

  private

  def credential_belongs_to_company
    return if agent_credential&.company_id == company_id

    errors.add(:agent_credential, "deve pertencer à mesma company (RF-49)")
  end

  def no_secrets_in_evidence
    return if redacted_evidence.blank?

    # Detecta tokens/chaves reais que não foram substituídos por tags de redação
    clean_text = redacted_evidence.gsub(/\[REDACTED[^\]]*\]/, "")
    secret_pattern = /eyJ[A-Za-z0-9_\-]{10,}|sk-[A-Za-z0-9]{15,}|Bearer\s+[A-Za-z0-9_\-\.]{10,}/i
    if clean_text.match?(secret_pattern)
      errors.add(:redacted_evidence, "parece conter credenciais não redigidas (RNF-08)")
    end
  end
end
