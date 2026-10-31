# frozen_string_literal: true

require "test_helper"

class AcQuotaObservationTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @credential = create(:agent_credential, company: @company, user: @user, agent_type: "codex")
  end

  test "creates valid quota observation" do
    obs = AcQuotaObservation.new(
      company: @company,
      agent_credential: @credential,
      cli_adapter: "codex_cli",
      model_scope: "gpt-5.2",
      quota_state: :available,
      confidence_level: :high,
      origin: :cli_output,
      observed_at: Time.current
    )
    assert obs.valid?, obs.errors.full_messages
    assert obs.save!
  end

  test "distinguishes blocking from non-blocking states (RF-10)" do
    exhausted = AcQuotaObservation.new(quota_state: :exhausted)
    auth_err = AcQuotaObservation.new(quota_state: :auth_error)
    rate_limited = AcQuotaObservation.new(quota_state: :rate_limited)
    available = AcQuotaObservation.new(quota_state: :available)

    assert exhausted.blocking?
    assert auth_err.blocking?
    assert_not rate_limited.blocking?
    assert_not available.blocking?
  end

  test "blocks unredacted secrets in evidence (RNF-08)" do
    obs = AcQuotaObservation.new(
      company: @company,
      agent_credential: @credential,
      cli_adapter: "codex_cli",
      model_scope: "gpt-5.2",
      quota_state: :exhausted,
      observed_at: Time.current,
      redacted_evidence: "Error with token: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZa1b2c3d4e5"
    )
    assert_not obs.valid?
    assert_includes obs.errors[:redacted_evidence], "parece conter credenciais não redigidas (RNF-08)"
  end

  test "latest_for returns newest still-valid observation" do
    AcQuotaObservation.create!(
      company: @company,
      agent_credential: @credential,
      cli_adapter: "codex_cli",
      model_scope: "gpt-5.2",
      quota_state: :available,
      confidence_level: :low,
      origin: :cli_output,
      observed_at: 10.minutes.ago,
      valid_until: 1.hour.from_now
    )

    newest = AcQuotaObservation.create!(
      company: @company,
      agent_credential: @credential,
      cli_adapter: "codex_cli",
      model_scope: "gpt-5.2",
      quota_state: :exhausted,
      confidence_level: :high,
      origin: :cli_output,
      observed_at: 1.minute.ago,
      valid_until: 2.hours.from_now
    )

    result = AcQuotaObservation.latest_for(
      agent_credential: @credential,
      cli_adapter: "codex_cli",
      model_scope: "gpt-5.2"
    )
    assert_equal newest, result
  end
end
