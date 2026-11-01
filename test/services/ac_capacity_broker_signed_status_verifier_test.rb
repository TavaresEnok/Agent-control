# frozen_string_literal: true

require "test_helper"

class AcCapacityBrokerSignedStatusVerifierTest < ActiveSupport::TestCase
  setup do
    @old_hosts = Rails.application.config.try(:ac_capacity_broker_hosts)
    @status_key = "s" * 32
    Rails.application.config.ac_capacity_broker_hosts = { "host" => {
      "bearer" => "b" * 32, "signing_key" => "c" * 32, "status_url" => "https://host.example/v1/capacity/status",
      "status_bearer" => "d" * 32, "status_key" => @status_key } }
    @reservation = AcCapacityBrokerReservation.new(host_id: "host", authority_id: "test-authority", operation_id: "operation", epoch: "1",
      account_key: "sha256:#{'a' * 64}", quantity: 1, state: "bound", grant_id: "host:grant")
  end

  teardown { Rails.application.config.ac_capacity_broker_hosts = @old_hosts }

  test "accepts only signed terminal status bound to runtime and nonce" do
    stub_request(:post, "https://host.example/v1/capacity/status").to_return do |request|
      payload = JSON.parse(request.body)
      assert_equal "Bearer #{'d' * 32}", request.headers["Authorization"]
      assert_equal OpenSSL::HMAC.hexdigest("SHA256", @status_key, request.body), request.headers["X-Ac-Signature"]
      body = payload.merge("state" => "completed").to_json
      { status: 200, body: body, headers: { "X-AC-Signature" => OpenSSL::HMAC.hexdigest("SHA256", @status_key, body) } }
    end
    assert AcCapacityBrokerSignedStatusVerifier.verify!(reservation: @reservation, proof: { "execution_id" => 9, "runtime_id" => "runtime" })
  end

  test "rejects stale nonce and invalid signatures" do
    stub_request(:post, "https://host.example/v1/capacity/status").to_return do |request|
      body = JSON.parse(request.body).merge("nonce" => "old", "state" => "completed").to_json
      { status: 200, body: body, headers: { "X-AC-Signature" => OpenSSL::HMAC.hexdigest("SHA256", @status_key, body) } }
    end
    assert_not AcCapacityBrokerSignedStatusVerifier.verify!(reservation: @reservation, proof: { "execution_id" => 9, "runtime_id" => "runtime" })
  end
end
