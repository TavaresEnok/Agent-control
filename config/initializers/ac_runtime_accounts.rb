# frozen_string_literal: true

Rails.application.config.after_initialize do
  path = Settings.agent_control.runtime_accounts_file.to_s
  Rails.application.config.ac_runtime_accounts = {}
  Rails.application.config.ac_worker_networks = []
  Rails.application.config.ac_runtime_configuration_status = { "ready" => false, "reason" => "not_configured", "accounts" => 0 }
  if path.present?
    begin
      loaded = AcRuntimeConfigurationLoader.load!(path)
      Rails.application.config.ac_runtime_accounts = loaded.fetch(:accounts)
      Rails.application.config.ac_worker_networks = loaded.fetch(:networks)
      Rails.application.config.ac_runtime_configuration_status = { "ready" => true, "reason" => "configured", "accounts" => loaded.fetch(:accounts).size }
    rescue AcRuntimeConfigurationLoader::InvalidConfiguration
      Rails.application.config.ac_runtime_configuration_status = { "ready" => false, "reason" => "invalid_configuration", "accounts" => 0 }
      Rails.logger.warn("Agent Control: configuração privada de runtime inválida")
    end
  end
end
