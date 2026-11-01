# frozen_string_literal: true

require "test_helper"

class AcClientCommandTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @valid_attributes = {
      company: @company,
      user: @user,
      intent_id: "intent-test-#{SecureRandom.hex(6)}",
      command_type: "create_task",
      payload: { "title" => "Nova Tarefa" },
      state: "received"
    }
  end

  test "validates required fields" do
    cmd = AcClientCommand.new(@valid_attributes)
    assert cmd.valid?, cmd.errors.full_messages.to_sentence

    %i[intent_id command_type state].each do |field|
      bad = AcClientCommand.new(@valid_attributes.merge(field => nil))
      refute_predicate bad, :valid?, "Expected #{field} to be required"
    end
  end

  test "enforces intent_id uniqueness" do
    AcClientCommand.create!(@valid_attributes)
    assert_raises(ActiveRecord::RecordNotUnique) do
      AcClientCommand.transaction(requires_new: true) { AcClientCommand.create!(@valid_attributes) }
    end
    other = create(:company)
    assert AcClientCommand.create!(@valid_attributes.merge(company: other)).persisted?
  end

  test "transitions through lifecycle states" do
    cmd = AcClientCommand.create!(@valid_attributes)
    refute_predicate cmd, :processed?

    cmd.mark_processing!
    assert_equal "processing", cmd.state

    cmd.mark_processed!(result_payload: { "task_id" => 123 })
    assert_equal "processed", cmd.state
    assert cmd.processed?
    assert_equal 123, cmd.result["task_id"]
    assert cmd.processed_at.present?

    failed_cmd = AcClientCommand.create!(@valid_attributes.merge(intent_id: "intent-fail-#{SecureRandom.hex(4)}"))
    failed_cmd.mark_failed!(error_message: "Network timeout")
    assert_equal "failed", failed_cmd.state
    assert_equal "Network timeout", failed_cmd.error_message
  end
end
