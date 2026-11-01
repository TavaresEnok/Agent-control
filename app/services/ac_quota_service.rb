# frozen_string_literal: true

# AcQuotaService — Registro e classificação de evidências de cota (F1-C, RF-10)
#
# Classifica e persiste observações com origem, instante, validade e confiança:
# - Distingue cota esgotada, limite temporário, autenticação inválida, falha de rede e desconhecido (RF-10)
# - Redige tokens e credenciais antes da persistência (RNF-08)
# - Fornece consulta de saúde da conta para decisão de perfil
class AcQuotaService
  # Padrões conhecidos de saída de CLI e headers de API
  EXHAUSTED_PATTERNS = [
    /quota exceeded/i,
    /insufficient_quota/i,
    /monthly limit reached/i,
    /credit balance is too low/i,
    /usage limit reached/i,
    /out of credits/i
  ].freeze

  RATE_LIMIT_PATTERNS = [
    /rate limit exceeded/i,
    /too many requests/i,
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?[\s:=]+)429\b/i,
    /please try again in/i,
    /rate_limit/i
  ].freeze

  AUTH_ERROR_PATTERNS = [
    /invalid api key/i,
    /unauthorized/i,
    /authentication failed/i,
    /invalid_token/i,
    /token expired/i,
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?[\s:=]+)401\b/i,
    /forbidden/i,
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?[\s:=]+)403\b/i
  ].freeze

  NETWORK_ERROR_PATTERNS = [
    /connection refused/i,
    /network unreachable/i,
    /timeout/i,
    /dns resolution failed/i,
    /could not resolve host/i,
    /econnrefused/i
  ].freeze

  SECRET_MASKS = [
    [ /(eyJ[A-Za-z0-9_\-]{10,})/, "[REDACTED_JWT]" ],
    [ /(sk-[A-Za-z0-9_\-]{15,})/, "[REDACTED_KEY]" ],
    [ /(Bearer\s+)(\S+)/i, "[REDACTED_BEARER_AUTH]" ],
    [ /([a-f0-9]{32,64})/i, "[REDACTED_HEX]" ]
  ].freeze

  def self.record_from_output!(
    company:,
    agent_credential:,
    cli_adapter:,
    model_scope:,
    raw_output:,
    task: nil,
    exit_code: nil,
    origin: "cli_output"
  )
    new(company: company).record_observation(
      agent_credential: agent_credential,
      cli_adapter: cli_adapter,
      model_scope: model_scope,
      raw_output: raw_output,
      task: task,
      exit_code: exit_code,
      origin: origin
    )
  end

  def initialize(company:)
    @company = company
  end

  def record_observation(
    agent_credential:,
    cli_adapter:,
    model_scope:,
    raw_output:,
    task: nil,
    exit_code: nil,
    origin: "cli_output"
  )
    redacted = redact_secrets(raw_output.to_s)
    state, confidence, valid_duration = classify(redacted, exit_code)

    AcQuotaObservation.create!(
      company: @company,
      agent_credential: agent_credential,
      ac_task: task,
      cli_adapter: cli_adapter,
      model_scope: model_scope,
      quota_state: state,
      confidence_level: confidence,
      origin: origin,
      observed_at: Time.current,
      valid_until: valid_duration ? Time.current + valid_duration : nil,
      redacted_evidence: redacted.truncate(2000),
      quota_data: { raw_status_code: exit_code&.to_s }
    )
  end

  def classify(text, _exit_code = nil)
    if EXHAUSTED_PATTERNS.any? { |p| text.match?(p) }
      [ :exhausted, :high, 4.hours ]
    elsif RATE_LIMIT_PATTERNS.any? { |p| text.match?(p) }
      [ :rate_limited, :high, 10.minutes ]
    elsif AUTH_ERROR_PATTERNS.any? { |p| text.match?(p) }
      [ :auth_error, :high, 24.hours ]
    elsif NETWORK_ERROR_PATTERNS.any? { |p| text.match?(p) }
      [ :network_error, :medium, 5.minutes ]
    else
      [ :unknown, :low, 15.minutes ]
    end
  end

  private

  def redact_secrets(text)
    sanitized = text.dup
    SECRET_MASKS.each do |pattern, mask|
      sanitized.gsub!(pattern, mask)
    end
    sanitized
  end
end
