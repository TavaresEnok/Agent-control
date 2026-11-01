# frozen_string_literal: true

require "test_helper"

class AcCapacityBrokerClientTest < ActiveSupport::TestCase
  setup do
    @client = AcCapacityBrokerClient.new(endpoint: "https://broker.example", bearer_token: "token", signing_key: "key", host_id: "test-host", authority_id: "test-authority")
  end

  test "reservation verifies a signed response bound to its request" do
    stub_request(:post, "https://broker.example/v1/reservations/reserve").to_return do |request|
      payload = JSON.parse(request.body)
      assert_equal "Bearer token", request.headers["Authorization"]
      assert_equal OpenSSL::HMAC.hexdigest("SHA256", "key", request.body), request.headers["X-Ac-Signature"]
      body = payload.merge("state" => "reserved").to_json
      { status: 200, body: body, headers: { "X-AC-Signature" => OpenSSL::HMAC.hexdigest("SHA256", "key", body) } }
    end
    result = @client.reserve!(operation_id: "operation-1", account_key: "account", quantity: 2, epoch: "1")
    assert_equal "reserved", result["state"]
    assert_equal 2, result["quantity"]
  end

  test "tampered and replayed responses are refused" do
    stub_request(:post, "https://broker.example/v1/reservations/get").to_return do |request|
      body = JSON.parse(request.body).merge("nonce" => "old", "state" => "reserved").to_json
      { status: 200, body: body, headers: { "X-AC-Signature" => OpenSSL::HMAC.hexdigest("SHA256", "key", body) } }
    end
    assert_raises(AcCapacityBrokerClient::InvalidResponseError) do
      @client.get!(operation_id: "operation-1", account_key: "account")
    end
  end

  test "transport timeout leaves the reservation uncertain" do
    stub_request(:post, "https://broker.example/v1/reservations/reserve").to_timeout
    assert_raises(AcCapacityBrokerClient::UncertainError) do
      @client.reserve!(operation_id: "operation-1", account_key: "account", quantity: 1, epoch: "1")
    end
  end
end
