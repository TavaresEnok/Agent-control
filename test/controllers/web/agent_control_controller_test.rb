# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "base64"
require "digest"

class Web::AgentControlControllerTest < ActionDispatch::IntegrationTest
  setup do
    @company = create(:company)
    @user = create(:user, :admin, :onboarding_completed, company: @company, password: AuthHelper::TEST_PASSWORD)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context Web Test",
      external_id: "ctx-web-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "plan-web-#{SecureRandom.hex(4)}",
      title: "Plano Web",
      objective: "Testar telas Inertia",
      version: 1
    )

    @dir = Dir.mktmpdir("ac_web_env_test")
    @identity_path = File.join(@dir, "id_ed25519")
    @known_hosts_path = File.join(@dir, "known_hosts")
    File.write(@identity_path, "synthetic private key")
    key_blob = Base64.strict_encode64("synthetic-ed25519-public-key")
    File.write(@known_hosts_path, "f0-lab-pinned ssh-ed25519 #{key_blob}\n")
    @fingerprint = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(key_blob))).delete_suffix('=')}"

    @environment = AcRemoteEnvironment.create!(
      company: @company,
      project: @project,
      name: "Ambiente Web Test",
      environment_slug: "env-web-1",
      host: "localhost",
      user: "runner",
      fingerprint: @fingerprint,
      identity_key_path: @identity_path,
      known_hosts_path: @known_hosts_path,
      authorized_directories: ["/tmp/web_auth"],
      state: "active"
    )
    sign_in_as(@user)
  end

  teardown do
    FileUtils.remove_entry(@dir) if @dir && File.directory?(@dir)
  end

  test "GET /agent_control/plans/:id/graph renders Inertia component AgentControl/PlanGraph" do
    get ac_plan_graph_path(@plan), headers: { "X-Inertia" => "true" }
    assert_response :success
    assert_inertia_component "AgentControl/PlanGraph"
  end

  test "GET /agent_control/wizard renders Inertia component AgentControl/MobileSetupWizard" do
    get ac_mobile_wizard_path, headers: { "X-Inertia" => "true" }
    assert_response :success
    assert_inertia_component "AgentControl/MobileSetupWizard"
  end

  test "SEC-01: prevents IDOR when accessing plan from another company" do
    other_company = create(:company)
    other_user = create(:user, company: other_company)
    other_project = create(:project, company: other_company, owner: other_user)
    other_context = AcWorkContext.create!(
      company: other_company,
      project: other_project,
      title: "Context Other",
      external_id: "ctx-other-#{SecureRandom.hex(4)}"
    )
    other_plan = AcPlan.create!(
      company: other_company,
      project: other_project,
      ac_work_context: other_context,
      plan_key: "plan-other-1",
      title: "Plano Alheio",
      objective: "IDOR test",
      version: 1
    )

    get ac_plan_graph_path(other_plan), headers: { "X-Inertia" => "true" }
    assert_response :not_found
  end
end
