# frozen_string_literal: true

class AuditReadinessController < ActionController::API
  def show
    head(AcAuditDatabaseGuard.ready? ? :ok : :service_unavailable)
  end
end
