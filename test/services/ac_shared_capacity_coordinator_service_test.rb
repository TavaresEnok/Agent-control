# frozen_string_literal: true

require "test_helper"

class AcSharedCapacityCoordinatorServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
  end

  # Prova G6-E3 (T28): Coexistência autorizada com autoridade comum e cálculo de soma global
  test "G6-E3: coordinates shared capacity when global usage is within ceiling" do
    broker_snapshot = {
      "account_key" => "codex_shared_pool",
      "authority_mode" => "shared_coordinated",
      "active_slots" => 3,
      "max_slots" => 8,
      "snapshot_timestamp" => Time.current.iso8601
    }

    result = AcSharedCapacityCoordinatorService.coordinate_shared_reservation!(
      company: @company,
      account_key: "codex_shared_pool",
      requested_slots: 2,
      external_broker_snapshot: broker_snapshot
    )

    assert_equal true, result[:authorized]
    assert_equal "codex_shared_pool", result[:account_key]
    assert_predicate result[:reservation_token], :present?
    assert_equal 2, result[:allocated_slots]
    assert_equal 3, result[:global_usage][:external_active_slots]
    assert_equal 3, result[:global_usage][:remaining_slots] # 8 - (0 local + 3 external + 2 requested)
  end

  # Prova G6-E3 (T28): Rejeição estrita quando a soma combinada excede o teto
  test "G6-E3: raises SharedCapacityExceededError when total exceeds max slots" do
    broker_snapshot = {
      "account_key" => "codex_shared_pool",
      "authority_mode" => "shared_coordinated",
      "active_slots" => 7,
      "max_slots" => 8,
      "snapshot_timestamp" => Time.current.iso8601
    }

    # Tenta pedir 2 vagas quando só resta 1 (7 + 2 = 9 > 8)
    assert_raises(AcSharedCapacityCoordinatorService::SharedCapacityExceededError) do
      AcSharedCapacityCoordinatorService.coordinate_shared_reservation!(
        company: @company,
        account_key: "codex_shared_pool",
        requested_slots: 2,
        external_broker_snapshot: broker_snapshot
      )
    end
  end

  # Prova G6-E3 (T28): Rejeição de snapshot do broker legado com carimbo de tempo expirado (stale)
  test "G6-E3: raises StaleBrokerSnapshotError when snapshot timestamp is older than threshold" do
    broker_snapshot = {
      "account_key" => "codex_shared_pool",
      "authority_mode" => "shared_coordinated",
      "active_slots" => 2,
      "max_slots" => 8,
      "snapshot_timestamp" => 2.minutes.ago.iso8601 # > 60s
    }

    assert_raises(AcSharedCapacityCoordinatorService::StaleBrokerSnapshotError) do
      AcSharedCapacityCoordinatorService.coordinate_shared_reservation!(
        company: @company,
        account_key: "codex_shared_pool",
        requested_slots: 1,
        external_broker_snapshot: broker_snapshot
      )
    end
  end

  test "G6-E3: raises StaleBrokerSnapshotError on mismatched account_key" do
    broker_snapshot = {
      "account_key" => "other_account",
      "authority_mode" => "shared_coordinated",
      "active_slots" => 1,
      "max_slots" => 8,
      "snapshot_timestamp" => Time.current.iso8601
    }

    assert_raises(AcSharedCapacityCoordinatorService::StaleBrokerSnapshotError) do
      AcSharedCapacityCoordinatorService.coordinate_shared_reservation!(
        company: @company,
        account_key: "codex_shared_pool",
        requested_slots: 1,
        external_broker_snapshot: broker_snapshot
      )
    end
  end
end
