# frozen_string_literal: true

require "minitest/autorun"
require_relative "../guard"

class AdmissionGuardTest < Minitest::Test
  def environment
    { "F0_ADMISSION_LAB" => AdmissionLab::IDENTITY, "F0_ADMISSION_SOCKET" => AdmissionLab::SOCKET }
  end

  def test_missing_or_remote_database_is_refused
    assert_raises(RuntimeError) { AdmissionLab.config!({}) }
    assert_raises(RuntimeError) { AdmissionLab.config!(environment.merge("F0_ADMISSION_SOCKET" => "localhost")) }
    %w[PGHOST PGSERVICE PGPASSFILE PGOPTIONS DATABASE_URL].each do |key|
      assert_raises(RuntimeError) { AdmissionLab.config!(environment.merge(key => "forbidden")) }
    end
    config = AdmissionLab.config!(environment)
    assert_equal "/lab-pg", config[:host]
    assert_equal "f0_admission_sql", config[:database]
  end

  Connection = Struct.new(:row, :adapter_name) do
    def select_one(*) = row
  end

  def test_server_marker_role_database_and_socket_are_all_mandatory
    row = { "db" => AdmissionLab::DATABASE, "role" => AdmissionLab::USER,
      "identity" => AdmissionLab::IDENTITY, "network_address" => nil }
    assert AdmissionLab.verify!(Connection.new(row, "PostgreSQL"))
    row.each_key do |key|
      assert_raises(RuntimeError) { AdmissionLab.verify!(Connection.new(row.merge(key => "wrong"), "PostgreSQL")) }
    end
    assert_raises(RuntimeError) { AdmissionLab.verify!(Connection.new(nil, "PostgreSQL")) }
    assert_raises(RuntimeError) { AdmissionLab.verify!(Connection.new(row, "SQLite")) }
  end
end
