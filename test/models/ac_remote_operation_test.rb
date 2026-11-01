# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "base64"
require "digest"

class AcRemoteOperationTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)

    @dir = Dir.mktmpdir("ac_remote_op_test")
    @identity_path = File.join(@dir, "id_ed25519")
    @known_hosts_path = File.join(@dir, "known_hosts")
    File.write(@identity_path, "synthetic private key")

    key_blob = Base64.strict_encode64("synthetic-ed25519-public-key")
    File.write(@known_hosts_path, "f0-lab-pinned ssh-ed25519 #{key_blob}\n")
    @fingerprint = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(key_blob))).delete_suffix('=')}"

    @environment = AcRemoteEnvironment.create!(
      company: @company,
      project: @project,
      name: "Target Env",
      environment_slug: "target-env-#{SecureRandom.hex(4)}",
      host: "127.0.0.1",
      port: 22,
      user: "deploy",
      fingerprint: @fingerprint,
      identity_key_path: @identity_path,
      known_hosts_path: @known_hosts_path,
      authorized_directories: [ "/home/enok/Documentos/projetos/nexoisp" ],
      state: "active"
    )

    @valid_attributes = {
      company: @company,
      project: @project,
      ac_remote_environment: @environment,
      operation_id: "op-test-#{SecureRandom.hex(6)}",
      command: "bundle exec rake test",
      working_directory: "/home/enok/Documentos/projetos/nexoisp",
      state: "pending"
    }
  end

  teardown do
    FileUtils.remove_entry(@dir) if @dir && Dir.exist?(@dir)
  end

  test "validates required fields" do
    op = AcRemoteOperation.new(@valid_attributes)
    assert op.valid?, op.errors.full_messages.to_sentence

    %i[operation_id command working_directory state].each do |field|
      bad_op = AcRemoteOperation.new(@valid_attributes.merge(field => nil))
      refute_predicate bad_op, :valid?, "Expected #{field} to be required"
    end
  end

  test "enforces operation_id uniqueness" do
    AcRemoteOperation.create!(@valid_attributes)
    dup = AcRemoteOperation.new(@valid_attributes)
    refute_predicate dup, :valid?
    assert_includes dup.errors[:operation_id], "has already been taken"
  end

  test "transitions through execution states and answers terminal status" do
    op = AcRemoteOperation.create!(@valid_attributes)
    refute_predicate op, :terminal?

    # 1. Running
    op.mark_running!(remote_job_id: "remote-job-123")
    assert_equal "running", op.state
    assert_equal "remote-job-123", op.remote_job_id
    assert op.started_at.present?
    refute_predicate op, :terminal?

    # 2. Completed
    op.mark_completed!(exit_code: 0, output: "All tests passed", error: nil)
    assert_equal "completed", op.state
    assert_equal 0, op.exit_code
    assert_equal "All tests passed", op.output_log
    assert op.finished_at.present?
    assert op.terminal?
  end

  test "mark_uncertain! records reason and preserves uncertainty" do
    op = AcRemoteOperation.create!(@valid_attributes.merge(state: "running", remote_job_id: "rj-99"))
    op.mark_uncertain!(reason: "SSH connection dropped during test execution", error: "Connection reset by peer")

    assert_equal "uncertain", op.state
    assert op.terminal?
    assert_includes op.error_log, "UNCERTAIN: SSH connection dropped"
    assert_equal "SSH connection dropped during test execution", op.metadata["uncertain_reason"]
  end

  test "mark_cancelled! updates state and records cancellation reason" do
    op = AcRemoteOperation.create!(@valid_attributes.merge(state: "running"))
    op.mark_cancelled!(reason: "User cancelled via UI")

    assert_equal "cancelled", op.state
    assert op.terminal?
    assert_equal "User cancelled via UI", op.metadata["cancellation_reason"]
  end
end
