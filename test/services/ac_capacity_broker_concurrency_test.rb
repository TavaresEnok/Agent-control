# frozen_string_literal: true

require "test_helper"

class AcCapacityBrokerConcurrencyTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  test "distinct hosts cannot reserve the final slot simultaneously" do
    old_accounts = Rails.application.config.try(:ac_capacity_broker_accounts)
    old_authority = Rails.application.config.try(:ac_capacity_broker_authority_id)
    assert_operator ActiveRecord::Base.connection_pool.size, :>=, 3, "Connection pool needs at least three connections"
    key = "sha256:#{SecureRandom.hex(32)}"
    operations = 2.times.map { SecureRandom.uuid }
    Rails.application.config.ac_capacity_broker_accounts = { key => 1 }
    Rails.application.config.ac_capacity_broker_authority_id = "test-authority"
    ready = Queue.new
    start = Queue.new
    threads = operations.each_with_index.map do |operation, index|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          ready << true
          start.pop
          AcCapacityBrokerAuthority.perform!("action" => "reserve", "operation_id" => operation,
            "account_key" => key, "host_id" => "host-#{index}", "authority_id" => "test-authority",
            "nonce" => SecureRandom.hex(16), "quantity" => 1, "epoch" => "1")["state"]
        end
      end
    end
    Timeout.timeout(20) { 2.times { ready.pop } }
    2.times { start << true }
    assert_equal %w[denied reserved], threads.map(&:value).sort
    assert_equal 1, AcCapacityBrokerReservation.where(account_key: key, state: "reserved").sum(:quantity)
  ensure
    threads&.each { |thread| thread.kill if thread.alive? }
    AcCapacityBrokerReservation.where(operation_id: operations).delete_all if operations
    Rails.application.config.ac_capacity_broker_accounts = old_accounts
    Rails.application.config.ac_capacity_broker_authority_id = old_authority
  end
end
