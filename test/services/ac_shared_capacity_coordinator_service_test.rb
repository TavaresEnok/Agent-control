# frozen_string_literal: true

require "test_helper"

class AcSharedCapacityCoordinatorServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @previous_authority = Rails.application.config.try(:ac_capacity_authority)
    Rails.application.config.ac_capacity_authority = nil
    @snapshot = { "account_key" => "fixture-account", "authority_mode" => "shared_coordinated",
      "active_slots" => 1, "max_slots" => 8, "snapshot_timestamp" => Time.current.iso8601 }
  end

  teardown do
    Rails.application.config.ac_capacity_authority = @previous_authority
  end

  test "a fresh snapshot alone cannot authorize a shared reservation" do
    assert_raises(AcSharedCapacityCoordinatorService::CoordinatorError) { reserve(@snapshot) }
  end

  test "an incomplete authority cannot be called" do
    incomplete = Class.new do
      attr_reader :called
      def reserve_shared!(**)
        @called = true
      end
    end.new
    Rails.application.config.ac_capacity_authority = incomplete
    assert_raises(AcSharedCapacityCoordinatorService::CoordinatorError) { reserve(@snapshot) }
    assert_not incomplete.called
  end

  test "a reservation requires a verified receipt bound to its identity and quantity" do
    authority = FakeAcSharedCapacityAuthority.new
    Rails.application.config.ac_capacity_authority = authority
    authority.receipt = { "operation_id" => "fixture-operation", "account_key" => "fixture-account",
      "quantity" => 1, "state" => "granted" }
    assert_raises(AcSharedCapacityCoordinatorService::UncertainReservationError) { reserve(@snapshot) }
    authority.verified = true
    authority.receipt["quantity"] = 2
    assert_raises(AcSharedCapacityCoordinatorService::UncertainReservationError) { reserve(@snapshot) }
    authority.receipt["quantity"] = 1
    assert_equal "granted", reserve(@snapshot)["state"]
  end

  test "a stale, future or account-mismatched snapshot is rejected" do
    [ @snapshot.merge("snapshot_timestamp" => 2.minutes.ago.iso8601),
      @snapshot.merge("snapshot_timestamp" => 2.minutes.from_now.iso8601),
      @snapshot.merge("account_key" => "other-account"),
      @snapshot.merge("authority_mode" => "local") ].each do |snapshot|
      assert_raises(AcSharedCapacityCoordinatorService::StaleBrokerSnapshotError) { reserve(snapshot) }
    end
  end

  private

  def reserve(snapshot)
    AcSharedCapacityCoordinatorService.coordinate_shared_reservation!(company: @company,
      account_key: "fixture-account", operation_id: "fixture-operation", requested_slots: 1, external_broker_snapshot: snapshot)
  end
end
