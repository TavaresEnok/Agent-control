# frozen_string_literal: true

require "net/http"
require "openssl"
require "uri"
require "securerandom"

class AcCapacityBrokerSignedStatusVerifier
  def self.verify!(reservation:, proof:)
    host = AcCapacityBrokerConfig.host(reservation.host_id)
    return false unless host.is_a?(Hash)

    uri = URI.parse(host["status_url"].to_s)
    bearer = host["status_bearer"].to_s
    key = host["status_key"].to_s
    return false unless uri.is_a?(URI::HTTPS) && uri.host.present? && uri.userinfo.nil? && uri.query.nil? &&
      uri.fragment.nil? && bearer.bytesize >= 32 && key.bytesize >= 32 &&
      bearer != host["bearer"].to_s && key != host["signing_key"].to_s

    payload = { "operation_id" => reservation.operation_id, "account_key" => reservation.account_key,
      "host_id" => reservation.host_id, "authority_id" => reservation.authority_id, "epoch" => reservation.epoch, "grant_id" => reservation.grant_id,
      "execution_id" => proof["execution_id"], "runtime_id" => proof["runtime_id"], "nonce" => SecureRandom.hex(16) }
    body = JSON.generate(payload)
    request = Net::HTTP::Post.new(uri.request_uri)
    request["Content-Type"] = "application/json"
    request["Authorization"] = "Bearer #{bearer}"
    request["X-AC-Signature"] = OpenSSL::HMAC.hexdigest("SHA256", key, body)
    request.body = body
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 5, read_timeout: 10) { |http| http.request(request) }
    return false unless response.is_a?(Net::HTTPSuccess)

    expected = OpenSSL::HMAC.hexdigest("SHA256", key, response.body.to_s)
    supplied = response["X-AC-Signature"].to_s
    return false unless supplied.bytesize == expected.bytesize && ActiveSupport::SecurityUtils.secure_compare(supplied, expected)

    result = JSON.parse(response.body.to_s)
    return false unless result.is_a?(Hash)

    payload.all? { |field, value| result[field] == value } && %w[completed failed not_started].include?(result["state"]) &&
      (result["state"] == "not_started" || result["runtime_id"].present?)
  rescue URI::InvalidURIError, JSON::ParserError, IOError, SystemCallError, SocketError, Timeout::Error, OpenSSL::SSL::SSLError, Net::ProtocolError
    false
  end
end
