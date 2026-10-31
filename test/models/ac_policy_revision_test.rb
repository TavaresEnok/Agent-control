# frozen_string_literal: true

require "test_helper"

class AcPolicyRevisionTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
  end

  test "creates valid draft policy revision" do
    policy = AcPolicyRevision.new(
      company: @company,
      revision_number: 1,
      content_hash: "hash_test_1",
      content: {
        "model_chain" => ["claude-sonnet-4.6", "gpt-5.2"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: { "valid" => true, "errors" => [] },
      state: :draft,
      apply_mode: :next_attempts
    )
    assert policy.valid?, policy.errors.full_messages
    assert policy.save!
  end

  test "blocks prohibited models and effort levels in content (ADR-002)" do
    policy = AcPolicyRevision.new(
      company: @company,
      revision_number: 1,
      content_hash: "hash_blocked",
      content: {
        "model_chain" => ["ultra-model-prohibited"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :draft,
      apply_mode: :next_attempts
    )
    assert_not policy.valid?
    assert_includes policy.errors[:content].to_s, "ultra"
  end

  test "publish! supersedes previously published policies" do
    p1 = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_p1",
      content: {
        "model_chain" => ["claude-sonnet-4.6"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :draft,
      apply_mode: :next_attempts
    )
    assert p1.publish!(by_user: @user)
    assert p1.published?

    p2 = AcPolicyRevision.create!(
      company: @company,
      revision_number: 2,
      content_hash: "hash_p2",
      content: {
        "model_chain" => ["gpt-5.2"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :draft,
      apply_mode: :next_attempts
    )
    assert p2.publish!(by_user: @user)
    assert p2.published?

    p1.reload
    assert p1.superseded?
  end

  test "enforces immutability once published (RF-42)" do
    policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_immut",
      content: {
        "model_chain" => ["claude-sonnet-4.6"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :draft,
      apply_mode: :next_attempts
    )
    policy.publish!(by_user: @user)

    policy.content = { "model_chain" => ["tampered"] }
    assert_not policy.save
    assert_includes policy.errors[:base], "Política publicada é imutável (RF-42). Crie uma nova revisão."
  end

  test "revoke! allows emergency revocation (§11.4)" do
    policy = AcPolicyRevision.create!(
      company: @company,
      revision_number: 1,
      content_hash: "hash_revokable",
      content: {
        "model_chain" => ["claude-sonnet-4.6"],
        "effort_limits" => { "max" => "high" },
        "active_accounts" => [],
        "chain_rules" => []
      },
      validation_result: {},
      state: :draft,
      apply_mode: :immediate_revoke
    )
    policy.publish!(by_user: @user)

    assert policy.revoke!(by_user: @user, reason: "Incidente de segurança")
    assert policy.revoked?
    assert_equal "Incidente de segurança", policy.revoked_reason
    assert_equal @user, policy.revoked_by_user
  end
end
