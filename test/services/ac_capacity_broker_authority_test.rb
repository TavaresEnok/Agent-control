# frozen_string_literal: true

require "test_helper"

class AcCapacityBrokerAuthorityTest < ActiveSupport::TestCase
  class VerifiedRelease
    def self.verify!(reservation:, proof:)
      proof["operation_id"] == reservation.operation_id && proof["grant_id"] == reservation.grant_id
    end
  end

  setup do
    @key = "sha256:#{'a' * 64}"
    @old_authority = Rails.application.config.try(:ac_capacity_broker_authority_id)
    Rails.application.config.ac_capacity_broker_authority_id = "test-authority"
    @old_accounts = Rails.application.config.try(:ac_capacity_broker_accounts)
    @old_verifier = Rails.application.config.try(:ac_capacity_broker_release_verifier)
    Rails.application.config.ac_capacity_broker_accounts = { @key => 1 }
    Rails.application.config.ac_capacity_broker_release_verifier = VerifiedRelease
  end

  teardown do
    Rails.application.config.ac_capacity_broker_authority_id = @old_authority
    Rails.application.config.ac_capacity_broker_accounts = @old_accounts
    Rails.application.config.ac_capacity_broker_release_verifier = @old_verifier
  end

  test "reservation is durable and idempotent and bind and release require matching evidence" do
    reserved = perform("reserve", "one", "quantity" => 1, "epoch" => "1")
    assert_equal "reserved", reserved["state"]
    assert_equal "reserved", perform("reserve", "one", "quantity" => 1, "epoch" => "1")["state"]
    assert_equal "denied", perform("reserve", "two", "quantity" => 1, "epoch" => "1")["state"]
    assert_equal "bound", perform("bind", "one", "grant_id" => "host:grant-one")["state"]
    assert_raises(AcCapacityBrokerAuthority::InvalidRequest) { perform("release", "one", "release_proof" => {}) }
    assert_equal "bound", perform("get", "one")["state"]
    proof = { "operation_id" => "one", "grant_id" => "host:grant-one" }
    assert_equal "released", perform("release", "one", "release_proof" => proof)["state"]
    assert_equal "released", perform("release", "one", "release_proof" => proof)["state"]
    assert_equal "reserved", perform("reserve", "two", "quantity" => 1, "epoch" => "1")["state"]
  end

  test "operation cannot change account host epoch or quantity" do
    perform("reserve", "one", "quantity" => 1, "epoch" => "1")
    assert_raises(AcCapacityBrokerAuthority::InvalidRequest) { perform("reserve", "one", "quantity" => 2, "epoch" => "1") }
    assert_raises(AcCapacityBrokerAuthority::InvalidRequest) { perform("reserve", "one", "quantity" => 1, "epoch" => "2") }
    assert_raises(AcCapacityBrokerAuthority::InvalidRequest) { perform("get", "one", "host_id" => "other") }
  end

  private

  def perform(action, operation, extra = {})
    AcCapacityBrokerAuthority.perform!({ "action" => action, "operation_id" => operation, "account_key" => @key,
      "host_id" => "host", "authority_id" => "test-authority", "nonce" => SecureRandom.hex(16) }.merge(extra))
  end
end
