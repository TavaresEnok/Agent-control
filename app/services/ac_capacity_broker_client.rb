# frozen_string_literal: true

require "net/http"
require "openssl"
require "uri"
require "json"
require "securerandom"

# Contract for a broker shared by installations. The broker must durably
# deduplicate every operation by operation_id, including after a lost response.
class AcCapacityBrokerClient
  class Error < StandardError; end
  class UncertainError < Error; end
  class InvalidResponseError < Error; end

  def initialize(endpoint:, bearer_token:, signing_key:, open_timeout: 5, read_timeout: 10)
    @endpoint = URI.parse(endpoint.to_s)
    unless @endpoint.is_a?(URI::HTTPS) && @endpoint.host.present? && @endpoint.userinfo.nil? &&
           @endpoint.query.nil? && @endpoint.fragment.nil? && bearer_token.present? && signing_key.present?
      raise ArgumentError, "Broker exige HTTPS e credenciais configuradas"
    end
    @bearer_token = bearer_token
    @signing_key = signing_key
    @open_timeout = open_timeout
    @read_timeout = read_timeout
  end

  def reserve!(operation_id:, account_key:, quantity:)
    raise ArgumentError, "Quantidade inválida" unless quantity.is_a?(Integer) && quantity.positive?
    request!("reserve", operation_id: operation_id, account_key: account_key, extra: { "quantity" => quantity })
  end

  def get!(operation_id:, account_key:)
    request!("get", operation_id: operation_id, account_key: account_key)
  end

  def bind!(operation_id:, account_key:, grant_id:)
    raise ArgumentError, "Grant obrigatório" if grant_id.blank?
    request!("bind", operation_id: operation_id, account_key: account_key, extra: { "grant_id" => grant_id.to_s })
  end

  def release!(operation_id:, account_key:)
    request!("release", operation_id: operation_id, account_key: account_key)
  end

  private

  def request!(action, operation_id:, account_key:, extra: {})
    raise ArgumentError, "Identidade de operação e conta obrigatórias" if operation_id.blank? || account_key.blank?

    payload = { "action" => action, "operation_id" => operation_id.to_s, "account_key" => account_key.to_s,
                "nonce" => SecureRandom.hex(16) }.merge(extra)
    body = JSON.generate(payload)
    uri = @endpoint.dup
    uri.path = "#{uri.path.to_s.delete_suffix('/')}/v1/reservations/#{action}"
    request = Net::HTTP::Post.new(uri.request_uri)
    request["Content-Type"] = "application/json"
    request["Authorization"] = "Bearer #{@bearer_token}"
    request["X-AC-Signature"] = signature(body)
    request.body = body
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: @open_timeout,
                               read_timeout: @read_timeout) { |http| http.request(request) }
    raise UncertainError, "Broker indisponível (HTTP #{response.code})" unless response.is_a?(Net::HTTPSuccess)

    verify_response!(response, payload)
  rescue IOError, SystemCallError, SocketError, Timeout::Error, OpenSSL::SSL::SSLError, Net::ProtocolError => e
    raise UncertainError, "Não foi possível confirmar a reserva no broker: #{e.class}"
  end

  def verify_response!(response, payload)
    body = response.body.to_s
    supplied = response["X-AC-Signature"].to_s
    expected = signature(body)
    unless supplied.bytesize == expected.bytesize && ActiveSupport::SecurityUtils.secure_compare(supplied, expected)
      raise InvalidResponseError, "Assinatura de resposta do broker inválida"
    end
    result = JSON.parse(body)
    unless result.is_a?(Hash) && result["operation_id"] == payload["operation_id"] &&
           result["account_key"] == payload["account_key"] && result["action"] == payload["action"] &&
           result["nonce"] == payload["nonce"] && allowed_states(payload["action"]).include?(result["state"])
      raise InvalidResponseError, "Identidade ou estado de reserva divergente"
    end
    if payload["action"] == "reserve" && %w[reserved bound].include?(result["state"]) && result["quantity"] != payload["quantity"]
      raise InvalidResponseError, "Quantidade reservada divergente"
    end
    if payload["action"] == "bind" && result["state"] == "bound" && result["grant_id"].to_s != payload["grant_id"]
      raise InvalidResponseError, "Grant vinculado divergente"
    end
    result
  rescue JSON::ParserError
    raise InvalidResponseError, "Resposta do broker inválida"
  end

  def allowed_states(action)
    { "reserve" => %w[reserved bound denied], "get" => %w[reserved bound released denied],
      "bind" => %w[bound denied], "release" => %w[released denied] }.fetch(action)
  end

  def signature(body)
    OpenSSL::HMAC.hexdigest("SHA256", @signing_key, body)
  end
end
