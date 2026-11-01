# frozen_string_literal: true

require "test_helper"

class SessionCompanyCredentialTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @first = create(:agent_credential, user: @user, company: @company, agent_type: "claude_code", account_slug: "one")
    @second = create(:agent_credential, user: @user, company: @company, agent_type: "claude_code", account_slug: "two")
    @session = create(:terminal_session, user: @user, company_id: @company.id, agent_type: "claude_code",
      session_config: { "agent_credential_id" => @second.id })
  end

  test "session selects and updates the named account only" do
    assert_equal @second, @session.session_credential
    AgentCredential.from_artifacts(@user.id, @company.id, "claude_code", { "api_key" => "updated" },
      account_slug: @session.session_credential.account_slug)
    assert_equal "updated", @second.reload.config_data["api_key"]
    assert_not_equal "updated", @first.reload.config_data["api_key"]
  end

  test "missing or invalid identity cannot select another account" do
    @session.session_config = {}
    assert_nil @session.session_credential
    @session.session_config = { "agent_credential_id" => @second.id + 100_000 }
    assert_nil @session.session_credential
    @session.session_config = { "agent_credential_id" => nil }
    assert_nil @session.session_credential
  end

  test "identity is constrained by user company and agent type" do
    other_company = create(:company)
    other_user = create(:user, company: other_company)
    foreign = create(:agent_credential, user: other_user, company: other_company, agent_type: "claude_code")
    @session.session_config = { "agent_credential_id" => foreign.id }
    assert_nil @session.session_credential
    @session.session_config = { "agent_credential_id" => @second.id }
    assert_nil SessionCompany.credential_for(@session, agent_type: "grok")
  end

  test "legacy session resolves only an unambiguous account" do
    @session.session_config = {}
    @first.destroy!
    assert_equal @second, @session.session_credential
  end
  test "refresh fan-out only targets sessions that selected that account" do
    @session.update!(state: "running")
    assert_includes @second.live_holder_sessions, @session
    assert_not_includes @first.live_holder_sessions, @session
  end
end
