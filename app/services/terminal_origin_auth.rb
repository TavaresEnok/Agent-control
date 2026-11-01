# frozen_string_literal: true

require "base64"
require "openssl"

# Shared only by the application and its trusted reverse proxy. The proxy proof
# is never sent to the agent container; each terminal surface gets a distinct key.
class TerminalOriginAuth
  class ConfigurationError < StandardError; end

  class << self
    def configured!
      master = Settings.terminal_origin_auth.origin_key.to_s
      proof = Settings.terminal_origin_auth.proxy_proof.to_s
      unless master.match?(/\A[0-9a-f]{64}\z/) && proof.match?(/\A[0-9a-f]{64}\z/) && master != proof
        raise ConfigurationError, "TTYD_ORIGIN_KEY and TERMINAL_PROXY_PROOF must be distinct 256-bit hex secrets"
      end
      true
    end

    def proxy_authorized?(value)
      configured!
      expected = Settings.terminal_origin_auth.proxy_proof.to_s
      value.is_a?(String) && value.bytesize == expected.bytesize && ActiveSupport::SecurityUtils.secure_compare(value, expected)
    end

    def credentials(session, surface)
      configured!
      raise ArgumentError, "Invalid terminal surface" unless %w[tty view].include?(surface)

      password = OpenSSL::HMAC.hexdigest("SHA256", [ Settings.terminal_origin_auth.origin_key.to_s ].pack("H*"),
        "terminal-origin-v1:#{session.id}:#{session.route_token}:#{surface}")
      "terminal:#{password}"
    end

    def authorization(session, surface)
      "Basic #{Base64.strict_encode64(credentials(session, surface))}"
    end
  end
end
