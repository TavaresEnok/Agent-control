# frozen_string_literal: true

module AcCapacityIdentityFixture
  def configure_capacity_identity(credential, limit: 10)
    config = Rails.application.config
    @capacity_identity_before = [ config.try(:ac_capacity_authority_id),
      config.try(:ac_capacity_account_identities), config.try(:ac_local_capacity_accounts) ]
    key = "sha256:#{Digest::SHA256.hexdigest("fixture-#{credential.id}")}"
    config.ac_capacity_authority_id = "test-authority"
    config.ac_capacity_account_identities = {
      credential.id => { "account_key" => key, "authority_id" => "test-authority", "ownership" => "exclusive_local" }
    }
    config.ac_local_capacity_accounts = { key => { "mode" => "local", "limit" => limit } }
  end

  def restore_capacity_identity
    return unless @capacity_identity_before

    config = Rails.application.config
    config.ac_capacity_authority_id, config.ac_capacity_account_identities, config.ac_local_capacity_accounts = @capacity_identity_before
  end
end
