# frozen_string_literal: true

require "test_helper"

class AcQuotaServiceTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @credential = create(:agent_credential, company: @company, user: @user, agent_type: "codex")
    @service = AcQuotaService.new(company: @company)
  end

  test "classifies error patterns correctly (RF-10)" do
    assert_equal :exhausted, @service.classify("Error: monthly usage limit reached, insufficient_quota").first
    assert_equal :rate_limited, @service.classify("Rate limit exceeded: please try again in 20s (429)").first
    assert_equal :auth_error, @service.classify("HTTP 401 Unauthorized: Invalid API key provided").first
    assert_equal :network_error, @service.classify("Connection refused: could not resolve host api.anthropic.com").first
    assert_equal :available, @service.classify("Completed with success", 0).first
    assert_equal :unknown, @service.classify("Some random warning", 1).first
  end

  test "records observation and redacts sensitive credentials (RNF-08)" do
    raw_output = "API error using key sk-1234567890abcdef1234567890 with Bearer secret_jwt_token_here: insufficient_quota"

    obs = AcQuotaService.record_from_output!(
      company: @company,
      agent_credential: @credential,
      cli_adapter: "codex_cli",
      model_scope: "gpt-5.2",
      raw_output: raw_output,
      exit_code: 1
    )

    assert_not_nil obs
    assert obs.exhausted?
    assert obs.blocking?
    assert_not_includes obs.redacted_evidence, "sk-1234567890abcdef1234567890"
    assert_not_includes obs.redacted_evidence, "secret_jwt_token_here"
    assert_includes obs.redacted_evidence, "[REDACTED"
  end
end
