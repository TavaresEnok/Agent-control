# frozen_string_literal: true

require "test_helper"

class AcPolicyPublicationInvariantsTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @credential = create(:agent_credential, company: @company, user: @user, agent_type: "claude_code")
    @policy = AcPolicyRevision.create!(company: @company, revision_number: 1, content_hash: SecureRandom.hex(32),
      state: :draft, content: { "model_chain" => [ "synthetic-model" ], "active_accounts" => [],
        "chain_rules" => [], "effort_limits" => { "max" => "high" } })
    @profile = AcExecutionProfile.create!(company: @company, ac_policy_revision: @policy, profile_key: "test-profile",
      role: :programmer, cli_adapter: :claude_code, model_id: "synthetic-model", effort_level: :medium,
      agent_credential: @credential, chain_position: 1)
  end

  test "new revisions cannot be created already published" do
    revision = AcPolicyRevision.new(company: @company, revision_number: 2, content_hash: SecureRandom.hex(32),
      state: :published, published_at: Time.current, content: @policy.content)
    assert_not revision.valid?
    assert_includes revision.errors[:state], "revisões novas devem começar em rascunho"
  end

  test "publication needs a current attestation and does not supersede on failure" do
    assert_not @policy.update(state: :published)
    @policy.reload
    assert_not @policy.update(state: :superseded, published_at: Time.current)
    @policy.reload
    assert_not @policy.publish!(by_user: @user)
    assert @policy.reload.draft?
    @profile.update!(selection_criteria: { "eligibility" => { "status" => "documented_supported", "model_id" => "synthetic-model",
      "cli_adapter" => "claude_code", "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 } })
    assert @policy.publish!(by_user: @user)
    assert @policy.reload.published?
    assert_not @profile.update(model_id: "different-model")
    @profile.reload
    assert_not @profile.destroy
    assert_not AcExecutionProfile.new(company: @company, ac_policy_revision: @policy, profile_key: "late",
      role: :programmer, cli_adapter: :claude_code, model_id: "synthetic-model", effort_level: :medium,
      agent_credential: @credential, chain_position: 2).valid?
    @profile.reload
    assert @profile.update(state: :disabled, ineligibility_reason: "Operator disabled")
    assert @policy.revoke!(by_user: @user, reason: "Emergency")
    assert_not @policy.update(state: :draft)
  end

  test "unsupported, expired and mismatched attestations do not authorize publication" do
    %w[expired mismatch].each do |condition|
      evidence = { "status" => "documented_supported", "model_id" => "synthetic-model", "cli_adapter" => "claude_code",
                   "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 }
      evidence["valid_until"] = 1.hour.ago.iso8601 if condition == "expired"
      evidence["model_id"] = "different" if condition == "mismatch"
      @profile.update!(selection_criteria: { "eligibility" => evidence })
      assert_not @policy.publish!(by_user: @user)
    end
  end
end
