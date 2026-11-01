# frozen_string_literal: true

require "openssl"
require "digest"

class AcCapacityBrokerStatusController < ActionController::API
  def create
    override = Rails.application.config.try(:ac_capacity_broker_status)
    settings = Settings.agent_control.capacity_broker
    bearer = (override.is_a?(Hash) ? override["bearer"] : settings.status_bearer_token).to_s
    key = (override.is_a?(Hash) ? override["signing_key"] : settings.status_signing_key).to_s
    host_id = (override.is_a?(Hash) ? override["host_id"] : settings.installation_id).to_s
    authority_id = (override.is_a?(Hash) ? override["authority_id"] : settings.authority_id).to_s
    return head :unauthorized unless request.ssl? && bearer.bytesize >= 32 && key.bytesize >= 32 && host_id.present?
    return head :unauthorized unless secure_equal?(request.headers["Authorization"].to_s, "Bearer #{bearer}")
    body = request.raw_post
    return head :bad_request if body.bytesize > 65_536
    return head :unauthorized unless secure_equal?(request.headers["X-AC-Signature"].to_s, OpenSSL::HMAC.hexdigest("SHA256", key, body))

    payload = JSON.parse(body)
    return head :bad_request unless payload.is_a?(Hash) && payload["host_id"] == host_id && authority_id.present? && payload["authority_id"] == authority_id &&
      payload["nonce"].is_a?(String) && payload["nonce"].match?(/\A[0-9a-f]{32}\z/)
    AcCapacityBrokerNonce.create!(digest: Digest::SHA256.hexdigest("status:#{payload['nonce']}"), created_at: Time.current)
    state = if payload["execution_id"].nil? && payload["runtime_id"].nil?
      intent = AcSharedCapacityIntent.find_by(operation_id: payload["operation_id"])
      return head :not_found unless intent
      intent.with_lock do
        valid = intent.host_id == host_id && intent.authority_id == authority_id && intent.account_key == payload["account_key"] &&
          intent.epoch == payload["epoch"].to_s && intent.broker_grant_id == payload["grant_id"] &&
          !AcCapacityGrant.exists?(operation_id: intent.operation_id) && !AcExecution.exists?(operation_id: intent.operation_id)
        next nil unless valid

        intent.update!(state: "fenced") unless %w[fenced released].include?(intent.state)
        "not_started"
      end
    else
      execution = AcExecution.find_by(id: payload["execution_id"], operation_id: payload["operation_id"])
      return head :not_found unless execution
      AcExecutionFence.synchronize(execution, validate: false) do
        grant = execution.ac_capacity_grant
        next nil unless grant
        grant.lock!
        valid = execution.epoch.to_s == payload["epoch"].to_s && grant.operation_id == payload["operation_id"] &&
          grant.reconciliation_data["account_key"] == payload["account_key"] &&
          grant.reconciliation_data["broker_grant_id"] == payload["grant_id"] &&
          grant.reconciliation_data["authority_id"] == authority_id && grant.reconciliation_data["authority"] == "shared" &&
          %w[reserved bound releasing].include?(grant.reconciliation_data["broker_state"])
        next nil unless valid

        execution.assert_no_unsettled_remote_operations!
        receipt = AcRuntimeSupervisorService.status!(execution: execution)
        next nil unless %w[completed failed not_started].include?(receipt["state"]) && receipt["runtime_id"] == payload["runtime_id"] &&
          (receipt["state"] == "not_started" || receipt["runtime_id"].present?)

        grant.update!(reconciliation_data: grant.reconciliation_data.merge("broker_state" => "releasing", "remote_release_claimed" => true))
        receipt["state"]
      end
    end
    return head :conflict unless state

    response_body = JSON.generate(payload.merge("state" => state))
    response.set_header("X-AC-Signature", OpenSSL::HMAC.hexdigest("SHA256", key, response_body))
    render body: response_body, content_type: "application/json", status: :ok
  rescue JSON::ParserError, ActiveRecord::RecordNotUnique, AcRuntimeSupervisorService::UnavailableError,
         AcRuntimeSupervisorService::UnverifiedReceiptError
    head :bad_request
  end

  private

  def secure_equal?(left, right)
    left.bytesize == right.bytesize && ActiveSupport::SecurityUtils.secure_compare(left, right)
  end
end
