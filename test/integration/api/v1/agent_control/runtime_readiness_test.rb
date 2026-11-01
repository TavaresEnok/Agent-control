# frozen_string_literal: true

require "test_helper"
require "tmpdir"

class Api::V1::AgentControl::RuntimeReadinessTest < ActionDispatch::IntegrationTest
  setup do
    @old_status = Rails.application.config.try(:ac_runtime_configuration_status)
    @old_accounts = Rails.application.config.try(:ac_runtime_accounts)
    @old_networks = Rails.application.config.try(:ac_worker_networks)
    @company = create(:company)
    @user = create(:user, :onboarding_completed, company: @company, password: AuthHelper::TEST_PASSWORD)
    @credential = create(:agent_credential, company: @company, user: @user, agent_type: "claude_code")
    @directory = Dir.mktmpdir("runtime-readiness-")
    @auth = File.join(@directory, "private.json")
    File.write(@auth, "synthetic-secret")
    File.chmod(0o600, @auth)
    uid = Process.euid.zero? ? 1000 : Process.euid
    gid = Process.egid.zero? ? 1000 : Process.egid
    File.chown(uid, gid, @auth) if Process.euid.zero?
    Rails.application.config.ac_runtime_accounts = { @credential.id.to_s => {
      "image" => "sha256:#{'a' * 64}", "argv" => [ "claude", "--model", "{model}", "--effort", "{effort}", "{prompt}" ],
      "auth_files" => { @auth => "/home/agent/.claude.json" }, "uid" => "#{uid}:#{gid}", "network" => "none",
      "cli_adapter" => "claude_code", "agent_type" => "claude_code", "auth_mode" => "subscription",
      "attestation" => { "status" => "documented_supported", "mode" => "subscription", "cli_adapter" => "claude_code",
        "credential_id" => @credential.id.to_s, "source" => "https://example.invalid/evidence",
        "observed_at" => 1.minute.ago.iso8601, "valid_until" => 1.hour.from_now.iso8601 } } }
    Rails.application.config.ac_worker_networks = []
    Rails.application.config.ac_runtime_configuration_status = { "ready" => true, "reason" => "configured" }
    sign_in_as(@user)
  end

  teardown do
    Rails.application.config.ac_runtime_configuration_status = @old_status
    Rails.application.config.ac_runtime_accounts = @old_accounts
    Rails.application.config.ac_worker_networks = @old_networks
    FileUtils.remove_entry(@directory) if @directory && File.directory?(@directory)
  end

  test "reports readiness without exposing account configuration" do
    get "/api/v1/agent_control/runtime_readiness", params: { company_id: @company.id }, as: :json
    assert_response :success
    assert response.parsed_body["ready"]
    assert_equal "subscription", response.parsed_body["auth_mode"]
    assert_not_includes response.body, "synthetic-secret"
    assert_not_includes response.body, @auth
    assert_not_includes response.body, @credential.id.to_s
    File.chmod(0o644, @auth)
    get "/api/v1/agent_control/runtime_readiness", params: { company_id: @company.id }, as: :json
    assert_not response.parsed_body["ready"]
  end

  test "does not expose readiness across companies" do
    other = create(:company)
    get "/api/v1/agent_control/runtime_readiness", params: { company_id: other.id }, as: :json
    assert_response :forbidden
  end
end
