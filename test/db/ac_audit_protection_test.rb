# frozen_string_literal: true

require "test_helper"
require Rails.root.join("db/migrate/20261101130104_protect_ac_decision_audit_events")

class AcAuditProtectionTest < ActiveSupport::TestCase
  test "database rejects direct updates deletes and truncate but permits inserts" do
    connection = ActiveRecord::Base.connection
    connection.execute("CREATE TEMP TABLE ac_audit_protection_test (id integer PRIMARY KEY, body text) ON COMMIT DROP")
    ProtectAcDecisionAuditEvents.install(connection, schema: "pg_temp", table: "ac_audit_protection_test")
    connection.execute("INSERT INTO ac_audit_protection_test (id, body) VALUES (1, 'original')")

    [ "UPDATE ac_audit_protection_test SET body = 'changed' WHERE id = 1",
      "DELETE FROM ac_audit_protection_test WHERE id = 1",
      "TRUNCATE ac_audit_protection_test" ].each do |sql|
      assert_raises(ActiveRecord::StatementInvalid) do
        ActiveRecord::Base.transaction(requires_new: true) { connection.execute(sql) }
      end
    end
    assert_equal "original", connection.select_value("SELECT body FROM ac_audit_protection_test WHERE id = 1")
    connection.execute("INSERT INTO ac_audit_protection_test (id, body) VALUES (2, 'restored')")
    assert_equal 2, connection.select_value("SELECT COUNT(*) FROM ac_audit_protection_test")
  end

  test "a superuser cannot pass audit readiness" do
    superuser = ActiveRecord::Base.connection.select_value("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
    assert_not AcAuditDatabaseGuard.ready? if superuser
  end
end
