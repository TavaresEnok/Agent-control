# frozen_string_literal: true

class AcCapacityBrokerAuthority
  class InvalidRequest < StandardError; end

  def self.perform!(payload)
    action = payload.fetch("action")
    operation_id = payload.fetch("operation_id")
    account_key = payload.fetch("account_key")
    host_id = payload.fetch("host_id")
    authority_id = payload.fetch("authority_id")
    expected_authority = Rails.application.config.try(:ac_capacity_broker_authority_id) || Settings.agent_control.capacity_broker.authority_id
    raise InvalidRequest, "Autoridade divergente" unless authority_id.is_a?(String) && authority_id.present? && authority_id == expected_authority
    unless %w[reserve get bind release].include?(action) && operation_id.is_a?(String) &&
           operation_id.match?(/\A[a-zA-Z0-9_.:-]{1,200}\z/) && account_key.is_a?(String) &&
           account_key.match?(/\Asha256:[0-9a-f]{64}\z/) && host_id.is_a?(String) && host_id.match?(/\A[a-zA-Z0-9_.:-]{1,100}\z/)
      raise InvalidRequest, "Identidade inválida"
    end

    if action == "release"
      candidate = AcCapacityBrokerReservation.find_by(operation_id: operation_id, account_key: account_key, host_id: host_id)
      raise InvalidRequest, "Reserva ausente" unless candidate
      if %w[reserved bound].include?(candidate.state)
        verifier = Rails.application.config.try(:ac_capacity_broker_release_verifier) || AcCapacityBrokerSignedStatusVerifier
        evidence = payload["release_proof"]
        unless verifier.respond_to?(:verify!) && evidence.is_a?(Hash) && verifier.verify!(reservation: candidate, proof: evidence) == true
          raise InvalidRequest, "Término não comprovado"
        end
        verified_grant_id = candidate.grant_id
      end
    end

    SessionAdmissionService.transaction do
      limits = AcCapacityBrokerConfig.accounts
      limit = limits.respond_to?(:[]) && limits[account_key]
      raise InvalidRequest, "Conta não configurada" unless limit.is_a?(Integer) && limit.positive?

      reservation = AcCapacityBrokerReservation.find_by(operation_id: operation_id)
      raise InvalidRequest, "Operação pertence a outra conta" if reservation && (reservation.account_key != account_key || reservation.host_id != host_id || reservation.authority_id != authority_id)
      case action
      when "reserve"
        quantity = payload["quantity"]
        epoch = payload["epoch"]
        raise InvalidRequest, "Quantidade ou época inválida" unless quantity.is_a?(Integer) && quantity.positive? && epoch.is_a?(String) && epoch.match?(/\A[a-zA-Z0-9_.:-]{1,100}\z/)
        raise InvalidRequest, "Época divergente" if reservation && reservation.epoch != epoch
        raise InvalidRequest, "Quantidade divergente" if reservation && reservation.quantity != quantity
        if reservation.nil? || reservation.state == "denied"
          held = AcCapacityBrokerReservation.where(account_key: account_key, state: %w[reserved bound])
          accounted_operations = held.pluck(:operation_id).to_set
          legacy_grants = AcCapacityGrant.active_or_granted.pluck(:operation_id, :quantity).sum do |id, amount|
            accounted_operations.include?(id) ? 0 : amount
          end
          occupied = held.sum(:quantity) + legacy_grants + SessionAdmission.occupied.count
          state = occupied + quantity <= limit ? "reserved" : "denied"
          if reservation
            reservation.update!(state: state) if reservation.state != state
          else
            reservation = AcCapacityBrokerReservation.create!(operation_id: operation_id, account_key: account_key,
              quantity: quantity, host_id: host_id, authority_id: authority_id, epoch: epoch, state: state)
          end
        end
      when "bind"
        grant_id = payload["grant_id"]
        raise InvalidRequest, "Concessão inválida" unless grant_id.is_a?(String) && grant_id.match?(/\A[a-zA-Z0-9_.:-]{1,200}\z/)
        raise InvalidRequest, "Reserva ausente" unless reservation
        raise InvalidRequest, "Concessão divergente" if reservation.grant_id.present? && reservation.grant_id != grant_id
        reservation.update!(state: "bound", grant_id: grant_id) if reservation.state == "reserved"
      when "release"
        raise InvalidRequest, "Reserva ausente" unless reservation
        if %w[reserved bound].include?(reservation.state)
          raise InvalidRequest, "Identidade mudou durante verificação" unless verified_grant_id == reservation.grant_id
          reservation.update!(state: "released", release_evidence: { "verified" => true })
        end
      end
      { "action" => action, "operation_id" => operation_id, "account_key" => account_key,
        "nonce" => payload.fetch("nonce"), "host_id" => host_id, "authority_id" => authority_id, "state" => reservation&.state || "not_found",
        "quantity" => reservation&.quantity, "grant_id" => reservation&.grant_id, "epoch" => reservation&.epoch }
    end
  rescue JSON::ParserError
    raise InvalidRequest, "Limites de conta inválidos"
  rescue KeyError
    raise InvalidRequest, "Campos ausentes"
  end
end
