# frozen_string_literal: true

# AcSharedCapacityCoordinatorService — Autoridade Comum de Capacidade Compartilhada (RF-46, C08, §21.5, T28)
#
# T28: Antigo e novo usam a mesma conta durante piloto, falha e reversão.
# Uma autoridade de reservas/refresh; soma global dentro do teto;
# sem conceder vaga por snapshot divergente.
class AcSharedCapacityCoordinatorService
  class CoordinatorError < StandardError; end
  class SharedCapacityExceededError < CoordinatorError; end
  class StaleBrokerSnapshotError < CoordinatorError; end
  class UncertainReservationError < CoordinatorError; end

  # Tolerância máxima de idade para snapshot de cota de broker externo (segundos)
  MAX_SNAPSHOT_AGE_SECONDS = 60

  class << self
    def coordinate_shared_reservation!(company:, account_key:, operation_id:, requested_slots: 1, external_broker_snapshot:)
      raise ArgumentError, "company é obrigatório" if company.blank?
      raise ArgumentError, "account_key é obrigatório" if account_key.blank?
      raise ArgumentError, "operation_id é obrigatório" if operation_id.blank?
      raise ArgumentError, "requested_slots inválido" unless requested_slots.is_a?(Integer) && requested_slots.positive?
      raise ArgumentError, "external_broker_snapshot é obrigatório" if external_broker_snapshot.blank?

      validate_broker_snapshot!(external_broker_snapshot, account_key)
      authority = Rails.application.config.try(:ac_capacity_authority)
      unless authority && authority.respond_to?(:reserve_shared!) && authority.respond_to?(:verify_shared_receipt!)
        raise CoordinatorError, "Autoridade compartilhada verificável não configurada"
      end
      begin
        receipt = authority.reserve_shared!(company: company, account_key: account_key, operation_id: operation_id,
          requested_slots: requested_slots, snapshot: external_broker_snapshot)
        valid = receipt.is_a?(Hash) && receipt["operation_id"] == operation_id &&
                receipt["account_key"] == account_key && receipt["quantity"] == requested_slots &&
                receipt["state"] == "granted" &&
                authority.verify_shared_receipt!(company: company, receipt: receipt) == true
        raise UncertainReservationError, "Recibo de reserva inválido" unless valid

        receipt
      rescue StandardError => e
        raise e if e.is_a?(UncertainReservationError)

        raise UncertainReservationError, "Resultado de reserva incerto para operação #{operation_id}; reconciliação necessária"
      end
    end

    private

    def validate_broker_snapshot!(snapshot, expected_account)
      unless snapshot.is_a?(Hash)
        raise StaleBrokerSnapshotError, "Snapshot do broker legado deve ser um Hash"
      end

      if snapshot["account_key"].to_s != expected_account.to_s
        raise StaleBrokerSnapshotError, "Snapshot pertence a conta divergente: #{snapshot['account_key']} != #{expected_account}"
      end

      snapshot_time = Time.zone.parse(snapshot["snapshot_timestamp"].to_s) rescue nil
      if snapshot_time.nil? || snapshot_time > Time.current || (Time.current - snapshot_time) > MAX_SNAPSHOT_AGE_SECONDS
        raise StaleBrokerSnapshotError, "Snapshot do broker legado expirado ou desatualizado (> #{MAX_SNAPSHOT_AGE_SECONDS}s): recusa por segurança (T28)"
      end

      if snapshot["authority_mode"] != "shared_coordinated"
        raise StaleBrokerSnapshotError, "Broker externo não configurado com autoridade coordenada comum (RF-46)"
      end
    end
  end
end
