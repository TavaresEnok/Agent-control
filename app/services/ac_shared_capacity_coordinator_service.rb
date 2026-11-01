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

  # Tolerância máxima de idade para snapshot de cota de broker externo (segundos)
  MAX_SNAPSHOT_AGE_SECONDS = 60

  class << self
    def coordinate_shared_reservation!(company:, account_key:, requested_slots: 1, external_broker_snapshot:)
      raise ArgumentError, "company é obrigatório" if company.blank?
      raise ArgumentError, "account_key é obrigatório" if account_key.blank?
      raise ArgumentError, "external_broker_snapshot é obrigatório" if external_broker_snapshot.blank?

      # 1. Validação de frescor e integridade do snapshot do broker legado (§21.5, T28)
      validate_broker_snapshot!(external_broker_snapshot, account_key)

      external_active_slots = external_broker_snapshot["active_slots"].to_i
      max_global_slots = external_broker_snapshot["max_slots"].to_i

      # 2. Contabilização atômica de slots locais no Agent Control com lock pessimista (BUG-P2-02)
      AcCapacityGrant.transaction do
        grants_scope = AcCapacityGrant.active_or_granted
                                      .where(company: company)
                                      .lock("FOR UPDATE")

        # Se houver concessões vinculadas à conta específica, filtra por account_key
        account_grants = grants_scope.where("reconciliation_data->>'account_key' = ?", account_key)
        locked_records = account_grants.exists? ? account_grants.to_a : grants_scope.to_a
        local_active_slots = locked_records.size

        total_requested = local_active_slots + external_active_slots + requested_slots.to_i

        if total_requested > max_global_slots
          raise SharedCapacityExceededError,
                "Capacidade compartilhada excedida para #{account_key}: local=#{local_active_slots}, " \
                "legado=#{external_active_slots}, pedido=#{requested_slots}, teto=#{max_global_slots} (T28)"
        end

        # 3. Emite concessão coordenada com autoridade única
        reservation_token = "coord_#{account_key}_#{SecureRandom.hex(8)}"

        {
          authorized: true,
          account_key: account_key,
          reservation_token: reservation_token,
          allocated_slots: requested_slots,
          global_usage: {
            local_active_slots: local_active_slots,
            external_active_slots: external_active_slots,
            max_global_slots: max_global_slots,
            remaining_slots: max_global_slots - total_requested
          },
          coordinated_at: Time.current.iso8601
        }
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
      if snapshot_time.nil? || (Time.current - snapshot_time) > MAX_SNAPSHOT_AGE_SECONDS
        raise StaleBrokerSnapshotError, "Snapshot do broker legado expirado ou desatualizado (> #{MAX_SNAPSHOT_AGE_SECONDS}s): recusa por segurança (T28)"
      end

      if snapshot["authority_mode"] != "shared_coordinated"
        raise StaleBrokerSnapshotError, "Broker externo não configurado com autoridade coordenada comum (RF-46)"
      end
    end
  end
end
