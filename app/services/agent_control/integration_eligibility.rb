# frozen_string_literal: true

module AgentControl
  # F0 pre-effect seam. The caller supplies a trusted, mode-specific assessment;
  # user input or a successful login must never manufacture that assessment.
  # No quota store, fallback selector, auth reader or CLI implementation lives here.
  class IntegrationEligibility
    class Rejected < StandardError; end

    REQUIRED_EVIDENCE = %i[plan holder cli_version source assessed_at].freeze

    def self.call(profile:, executor:)
      reason = rejection(profile)
      raise Rejected, "integration_ineligible: #{reason}" if reason

      executor.call
    end

    def self.rejection(profile)
      return "not_assessed" unless profile.is_a?(Hash)
      return "#{profile[:status] || 'not_assessed'}" unless profile[:status] == "documented_supported"
      return "disabled_by_f0_policy" unless profile[:provider] == "codex"
      return "requires_clarification: exact mode" unless profile[:mode] == "local_private"
      return "unsupported_for_mode: authentication" unless profile[:authentication] == "codex_managed_chatgpt"
      return "unsupported_for_mode: interception" unless profile[:mitm] == false
      return "unsupported_for_mode: billing" unless profile[:paid_api] == false
      return "not_assessed: evidence" unless REQUIRED_EVIDENCE.all? do |key|
        profile[key].is_a?(String) && !profile[key].strip.empty?
      end

      nil
    end
    private_class_method :rejection
  end
end
