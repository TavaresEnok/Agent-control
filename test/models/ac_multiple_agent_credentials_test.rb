# frozen_string_literal: true

require "test_helper"

class AcMultipleAgentCredentialsTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
  end

  # Prova RF-05 / T01: Representar duas contas do mesmo provedor sem empresas artificiais
  test "RF-05 / T01: allows multiple credentials of the same provider with distinct account_slugs" do
    # Cria conta 1 para o gerente
    cred_manager = AgentCredential.create!(
      company: @company,
      user: @user,
      agent_type: "codex",
      account_slug: "codex-manager",
      encrypted_config_data: { "apiKey" => "key-manager" }.to_json
    )

    # Cria conta 2 para o programador sob o mesmo usuário e empresa
    cred_programmer = AgentCredential.create!(
      company: @company,
      user: @user,
      agent_type: "codex",
      account_slug: "codex-programmer",
      encrypted_config_data: { "apiKey" => "key-programmer" }.to_json
    )

    assert_not_equal cred_manager.id, cred_programmer.id
    assert_equal "codex-manager", cred_manager.account_slug
    assert_equal "codex-programmer", cred_programmer.account_slug
    assert_equal "codex", cred_manager.agent_type
    assert_equal "codex", cred_programmer.agent_type

    # Vincula a dois perfis de execução distintos (ADR-002, §9.1)
    policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_multi_cred_1",
      content: {
        "model_chain" => ["gpt-5.2"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => ["codex-manager", "codex-programmer"],
        "chain_rules" => []
      },
      validation_result: { "valid" => true, "errors" => [] },
      state: :published,
      apply_mode: :next_attempts
    )

    profile_mgr = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: policy,
      profile_key: "prof-mgr",
      role: :manager,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :medium,
      agent_credential: cred_manager,
      chain_position: 1,
      state: :active
    )

    profile_prog = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: policy,
      profile_key: "prof-prog",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :high,
      agent_credential: cred_programmer,
      chain_position: 2,
      state: :active
    )

    assert_equal cred_manager, profile_mgr.agent_credential
    assert_equal cred_programmer, profile_prog.agent_credential
  end

  test "RF-05 / T01: blocks duplicate account_slug for the same agent_type, user and company" do
    AgentCredential.create!(
      company: @company,
      user: @user,
      agent_type: "codex",
      account_slug: "codex-primary",
      encrypted_config_data: { "apiKey" => "key-1" }.to_json
    )

    assert_raises(ActiveRecord::RecordInvalid) do
      AgentCredential.create!(
        company: @company,
        user: @user,
        agent_type: "codex",
        account_slug: "codex-primary", # Conflito de slug
        encrypted_config_data: { "apiKey" => "key-2" }.to_json
      )
    end
  end
end
