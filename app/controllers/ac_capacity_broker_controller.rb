# frozen_string_literal: true

require "openssl"
require "digest"

class AcCapacityBrokerController < ActionController::API
  def create
    return head :unauthorized unless request.ssl?
    body = request.raw_post
    return head :bad_request if body.bytesize > 65_536
    payload = JSON.parse(body)
    return head :bad_request unless payload.is_a?(Hash) && payload["action"] == params[:action_name] &&
      payload["nonce"].is_a?(String) && payload["nonce"].match?(/\A[0-9a-f]{32}\z/) &&
      payload["host_id"].is_a?(String)
    host = AcCapacityBrokerConfig.host(payload["host_id"])
    return head :unauthorized unless host.is_a?(Hash) && Array(host["accounts"]).include?(payload["account_key"])
    bearer = host["bearer"].to_s
    signing_key = host["signing_key"].to_s
    return head :unauthorized unless bearer.bytesize >= 32 && signing_key.bytesize >= 32
    return head :unauthorized unless secure_equal?(request.headers["Authorization"].to_s, "Bearer #{bearer}")
    signature = OpenSSL::HMAC.hexdigest("SHA256", signing_key, body)
    return head :unauthorized unless secure_equal?(request.headers["X-AC-Signature"].to_s, signature)

    AcCapacityBrokerNonce.create!(digest: Digest::SHA256.hexdigest(payload["nonce"]), created_at: Time.current)
    result = AcCapacityBrokerAuthority.perform!(payload)
    response_body = JSON.generate(result)
    response.set_header("X-AC-Signature", OpenSSL::HMAC.hexdigest("SHA256", signing_key, response_body))
    render body: response_body, content_type: "application/json", status: :ok
  rescue JSON::ParserError, AcCapacityBrokerAuthority::InvalidRequest, ActiveRecord::RecordNotUnique
    head :bad_request
  end

  private

  def secure_equal?(left, right)
    left.bytesize == right.bytesize && ActiveSupport::SecurityUtils.secure_compare(left, right)
  end
end
