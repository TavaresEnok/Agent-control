# frozen_string_literal: true

require "test_helper"

class AcCapacityBrokerAuthenticationTest < ActionDispatch::IntegrationTest
  setup do
    @key = "sha256:#{'b' * 64}"
    @bearer = "b" * 32
    @signing = "s" * 32
    @old_authority = Rails.application.config.try(:ac_capacity_broker_authority_id)
    Rails.application.config.ac_capacity_broker_authority_id = "test-authority"
    @old_hosts = Rails.application.config.try(:ac_capacity_broker_hosts)
    @old_accounts = Rails.application.config.try(:ac_capacity_broker_accounts)
    Rails.application.config.ac_capacity_broker_hosts = { "host" => { "bearer" => @bearer, "signing_key" => @signing, "accounts" => [ @key ] } }
    Rails.application.config.ac_capacity_broker_accounts = { @key => 1 }
    https!
  end

  teardown do
    Rails.application.config.ac_capacity_broker_authority_id = @old_authority
    Rails.application.config.ac_capacity_broker_hosts = @old_hosts
    Rails.application.config.ac_capacity_broker_accounts = @old_accounts
  end

  test "requires authenticated request and rejects nonce replay" do
    payload = { "action" => "reserve", "operation_id" => "op", "account_key" => @key, "host_id" => "host",
      "authority_id" => "test-authority", "nonce" => SecureRandom.hex(16), "quantity" => 1, "epoch" => "1" }
    body = JSON.generate(payload)
    headers = { "CONTENT_TYPE" => "application/json", "Authorization" => "Bearer #{@bearer}",
      "X-AC-Signature" => OpenSSL::HMAC.hexdigest("SHA256", @signing, body) }
    post "/v1/reservations/reserve", params: body, headers: headers
    assert_response :success
    assert_equal OpenSSL::HMAC.hexdigest("SHA256", @signing, response.body), response.headers["X-AC-Signature"]
    post "/v1/reservations/reserve", params: body, headers: headers
    assert_response :bad_request
    post "/v1/reservations/reserve", params: body, headers: headers.merge("Authorization" => "Bearer wrong")
    assert_response :unauthorized
    assert_equal 1, AcCapacityBrokerReservation.count
  end
end
