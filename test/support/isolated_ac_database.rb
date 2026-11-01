# frozen_string_literal: true

# These tests must commit real transactions, so ordinary transactional fixtures
# cannot contain their side effects. Each test gets a disposable database rather
# than mutating append-only audit history during cleanup.
module IsolatedAcDatabase
  def run
    raise "Isolated AC databases are test-only" unless Rails.env.test?

    original_config = ActiveRecord::Base.connection_pool.db_config
    database = "ac_isolated_test_#{Process.pid}_#{SecureRandom.hex(8)}"
    raise "Unsafe database name" unless database.match?(/\Aac_isolated_test_\d+_[0-9a-f]{16}\z/)

    created = false
    begin
      connection = ActiveRecord::Base.connection
      connection.execute("CREATE DATABASE #{connection.quote_table_name(database)}")
      created = true
      ActiveRecord::Base.establish_connection(original_config.configuration_hash.merge(database: database))
      previous_verbosity = ActiveRecord::Schema.verbose
      begin
        ActiveRecord::Schema.verbose = false
        load Rails.root.join("db/schema.rb")
        require Rails.root.join("db/migrate/20261101130104_protect_ac_decision_audit_events")
        ProtectAcDecisionAuditEvents.install(ActiveRecord::Base.connection,
          schema: ActiveRecord::Base.connection.select_value("SELECT current_schema()"), table: "ac_decision_audit_events")
      ensure
        ActiveRecord::Schema.verbose = previous_verbosity
      end
      super
    ensure
      # Restore the SAME config object. DatabaseTasks compares it by identity;
      # reconstructing it from a hash makes later migration checks replace the
      # fixture pool and silently roll back the next test's open transaction.
      ActiveRecord::Base.establish_connection(original_config)
      if created
        connection = ActiveRecord::Base.connection
        connection.execute("DROP DATABASE #{connection.quote_table_name(database)}")
      end
    end
  end
end
