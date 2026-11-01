# frozen_string_literal: true

class ProtectAcDecisionAuditEvents < ActiveRecord::Migration[8.1]
  FUNCTION_BODY = <<~SQL.freeze
    BEGIN
      RAISE EXCEPTION 'ac decision audit events are append-only' USING ERRCODE = '55000';
    END;
  SQL

  def self.install(connection, schema:, table:)
    qualified_table = "#{connection.quote_table_name(schema)}.#{connection.quote_table_name(table)}"
    qualified_function = "#{connection.quote_table_name(schema)}.ac_reject_audit_mutation"
    connection.execute <<~SQL
      CREATE OR REPLACE FUNCTION #{qualified_function}() RETURNS trigger
      LANGUAGE plpgsql AS $audit$#{FUNCTION_BODY}$audit$
    SQL
    connection.execute <<~SQL
      CREATE TRIGGER ac_audit_no_change BEFORE UPDATE OR DELETE ON #{qualified_table}
      FOR EACH ROW EXECUTE FUNCTION #{qualified_function}()
    SQL
    connection.execute <<~SQL
      CREATE TRIGGER ac_audit_no_truncate BEFORE TRUNCATE ON #{qualified_table}
      FOR EACH STATEMENT EXECUTE FUNCTION #{qualified_function}()
    SQL
    connection.execute "ALTER TABLE #{qualified_table} ENABLE ALWAYS TRIGGER ac_audit_no_change"
    connection.execute "ALTER TABLE #{qualified_table} ENABLE ALWAYS TRIGGER ac_audit_no_truncate"
  end

  def up
    self.class.install(connection, schema: connection.select_value("SELECT current_schema()"), table: "ac_decision_audit_events")
  end

  def down
    execute "DROP TRIGGER IF EXISTS ac_audit_no_change ON ac_decision_audit_events"
    execute "DROP TRIGGER IF EXISTS ac_audit_no_truncate ON ac_decision_audit_events"
    execute "DROP FUNCTION IF EXISTS ac_reject_audit_mutation()"
  end
end
