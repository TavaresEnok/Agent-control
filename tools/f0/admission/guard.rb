# frozen_string_literal: true

module AdmissionLab
  IDENTITY = "agent-control:F0-G0:admission-sql:disposable:v1"
  DATABASE = "f0_admission_sql"
  USER = "f0_admission_lab"
  SOCKET = "/lab-pg"

  def self.config!(env = ENV)
    forbidden = env.keys.select { |key| key.start_with?("PG") || %w[DATABASE_URL DATABASE_HOST DATABASE_PASSWORD].include?(key) }
    raise "Remove ambient database configuration: #{forbidden.sort.join(', ')}" unless forbidden.empty?
    raise "Explicit disposable lab identity required" unless env["F0_ADMISSION_LAB"] == IDENTITY
    raise "Only isolated lab socket allowed" unless env["F0_ADMISSION_SOCKET"] == SOCKET

    { adapter: "postgresql", host: SOCKET, port: 5432, database: DATABASE,
      username: USER, password: "", passfile: "/dev/null", sslmode: "disable", pool: 8, checkout_timeout: 5,
      connect_timeout: 3, variables: { statement_timeout: "10000", lock_timeout: "5000" } }
  end

  def self.verify!(connection)
    raise "PostgreSQL required" unless connection.adapter_name == "PostgreSQL"
    row = connection.select_one(<<~SQL)
      SELECT current_database() AS db, current_user AS role,
        shobj_description(oid, 'pg_database') AS identity,
        inet_server_addr()::text AS network_address
      FROM pg_database WHERE datname = current_database()
    SQL
    unless row && row["db"] == DATABASE && row["role"] == USER &&
        row["identity"] == IDENTITY && row["network_address"].nil?
      raise "Unidentified database refused before schema creation"
    end
    true
  end
end
