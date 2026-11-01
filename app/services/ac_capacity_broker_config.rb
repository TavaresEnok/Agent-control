# frozen_string_literal: true

class AcCapacityBrokerConfig
  def self.identities
    Rails.application.config.try(:ac_capacity_account_identities) || JSON.parse(Settings.agent_control.capacity_broker.account_identities_json.to_s)
  rescue JSON::ParserError
    nil
  end

  def self.accounts
    Rails.application.config.try(:ac_capacity_broker_accounts) || JSON.parse(Settings.agent_control.capacity_broker.account_limits_json.to_s)
  rescue JSON::ParserError
    nil
  end

  def self.host(id)
    hosts = Rails.application.config.try(:ac_capacity_broker_hosts)
    hosts ||= JSON.parse(Settings.agent_control.capacity_broker.hosts_json.to_s)
    hosts.is_a?(Hash) ? hosts[id] : nil
  rescue JSON::ParserError
    nil
  end
end
