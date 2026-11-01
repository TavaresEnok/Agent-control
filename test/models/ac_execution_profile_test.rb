# frozen_string_literal: true

require "test_helper"

class AcExecutionProfileTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_rev_1",
      content: {
        "model_chain" => [ "claude-sonnet-4.6", "gpt-5.2" ],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: { "valid" => true, "errors" => [] },
      state: :draft,
      apply_mode: :next_attempts
    )
  end

  test "creates valid active execution profile" do
    profile = AcExecutionProfile.new(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-prog-codex",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :medium,
      chain_position: 1,
      state: :active
    )
    assert profile.valid?, profile.errors.full_messages
    assert profile.save!
  end

  test "blocks unsupported CLIs (ADR-002)" do
    profile = AcExecutionProfile.new(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-unsupported-cli",
      role: :programmer,
      cli_adapter: :some_unsupported_cli,
      model_id: "custom-model",
      effort_level: :medium,
      chain_position: 1
    )
    assert_not profile.valid?
    assert_includes profile.errors[:cli_adapter], "is not included in the list"
  end

  test "blocks ultra and excessive effort levels (ADR-002 §9.1)" do
    profile = AcExecutionProfile.new(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prof-excessive-effort",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :ultra,
      chain_position: 1
    )
    assert_not profile.valid?
    assert_includes profile.errors[:effort_level], "is not included in the list"
  end

  test "eligibility_verdict produces explainable verdict" do
    user = create(:user, company: @company)
    credential = create(:agent_credential, company: @company, user: user, agent_type: "claude_code")
    @policy.update!(content: @policy.content.merge("model_chain" => [ "claude-sonnet-4.6" ]))
    profile = AcExecutionProfile.create!(company: @company, ac_policy_revision: @policy,
      profile_key: "prof-verdict-test", role: :programmer, cli_adapter: :claude_code,
      model_id: "claude-sonnet-4.6", effort_level: :high, chain_position: 1, state: :active,
      agent_credential: credential, selection_criteria: { "eligibility" => {
        "status" => "documented_supported", "model_id" => "claude-sonnet-4.6", "cli_adapter" => "claude_code",
        "efforts" => [ "high" ], "valid_until" => 1.hour.from_now.iso8601 } })
    assert @policy.publish!(by_user: user)
    verdict = profile.eligibility_verdict
    assert verdict[:eligible]
    assert_empty verdict[:reasons]
    assert_equal "prof-verdict-test", verdict[:profile_key]
    assert_equal 1, verdict[:policy_revision_number]

    profile.update!(state: :disabled, ineligibility_reason: "Depreciado por política de segurança")
    disabled_verdict = profile.eligibility_verdict
    assert_not disabled_verdict[:eligible]
    assert_includes disabled_verdict[:reasons].first, "Perfil não está ativo"
  end

  test "substitution_chain orders active profiles by position" do
    p2 = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prog-pos-2",
      role: :programmer,
      cli_adapter: :codex_cli,
      model_id: "gpt-5.2",
      effort_level: :low,
      chain_position: 2,
      state: :active
    )

    p1 = AcExecutionProfile.create!(
      company: @company,
      ac_policy_revision: @policy,
      profile_key: "prog-pos-1",
      role: :programmer,
      cli_adapter: :claude_code,
      model_id: "claude-sonnet-4.6",
      effort_level: :medium,
      chain_position: 1,
      state: :active
    )

    chain = AcExecutionProfile.where(ac_policy_revision: @policy).substitution_chain(:programmer)
    assert_equal [ p1, p2 ], chain.to_a
  end
end
