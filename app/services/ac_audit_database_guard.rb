# frozen_string_literal: true

class AcAuditDatabaseGuard
  class UnsafeDatabaseRole < StandardError; end
  class << self
    def enforce!
      return unless Rails.env.production?
      raise UnsafeDatabaseRole, "Proteção append-only e papel de banco restrito são obrigatórios" unless ready?
    end

    def ready?
      ActiveRecord::Base.connection.select_value(<<~SQL) == true
        WITH audit AS (
          SELECT c.oid, c.relowner, n.nspowner
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = to_regclass('ac_decision_audit_events')
        ), dangerous AS (
          SELECT 1 FROM pg_roles r, audit a, pg_database d
          WHERE d.datname = current_database()
            AND pg_has_role(current_user, r.oid, 'MEMBER')
            AND (r.rolsuper OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
              OR r.oid IN (a.relowner, a.nspowner, d.datdba)
              OR has_parameter_privilege(r.oid, 'session_replication_role', 'SET')
              OR EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
                         WHERE t.tgrelid = a.oid AND t.tgname IN ('ac_audit_no_change', 'ac_audit_no_truncate')
                           AND p.proowner = r.oid))
        ), guards AS (
          SELECT count(*) AS installed FROM pg_trigger t, audit a
          JOIN pg_proc p ON true
          WHERE t.tgrelid = a.oid AND NOT t.tgisinternal AND t.tgenabled = 'A'
            AND p.oid = t.tgfoid AND p.proname = 'ac_reject_audit_mutation'
            AND ((t.tgname = 'ac_audit_no_change' AND t.tgtype = 27)
              OR (t.tgname = 'ac_audit_no_truncate' AND t.tgtype = 34))
        )
        SELECT EXISTS (SELECT 1 FROM audit) AND NOT EXISTS (SELECT 1 FROM dangerous)
          AND (SELECT installed FROM guards) = 2
          AND NOT has_parameter_privilege(current_user, 'session_replication_role', 'SET')
      SQL
    rescue ActiveRecord::StatementInvalid
      false
    end
  end
end
