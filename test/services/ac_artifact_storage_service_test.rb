# frozen_string_literal: true

require "test_helper"
require "tmpdir"

class AcArtifactStorageServiceTest < ActiveSupport::TestCase
  include AcSafetyFixtures

  setup do
    @storage_root = Dir.mktmpdir("ac-storage-test")
    @storage = AcArtifactStorageService.new(root: @storage_root, config: { gc_enabled: true, retention_days: 1 })
    @artifact_path = File.join(@storage_root, @task.id.to_s, "a" * 64)
    FileUtils.mkdir_p(@artifact_path)
    File.write(File.join(@artifact_path, "result"), "retained evidence")
    @task.update_columns(state: "failed")
    @artifact_execution = AcExecution.create!(company: @company, ac_work_context: @context, ac_task: @task,
      ac_execution_profile: @profiles.fetch("programmer"), operation_id: SecureRandom.uuid,
      epoch: "1", state: "failed", finished_at: 3.days.ago, worktree_path: @artifact_path)
    @storage.mark_owned!(execution: @artifact_execution, path: @artifact_path)
  end

  teardown do
    FileUtils.remove_entry(@storage_root) if File.directory?(@storage_root)
  end

  test "dry run is default and retained terminal artifact is deleted only with verified proof" do
    AcRuntimeSupervisorService.stub(:status!, { "state" => "failed" }) do
      assert_equal "would_delete", @storage.collect!.first.fetch(:action)
      assert File.directory?(@artifact_path)
      assert_equal "deleted", @storage.collect!(dry_run: false).first.fetch(:action)
    end
    assert_not File.exist?(@artifact_path)
    assert @artifact_execution.reload.metadata["artifact_collected_at"].present?
  end

  test "uncertain runtime or any active lease preserves evidence" do
    AcRuntimeSupervisorService.stub(:status!, { "state" => "running" }) do
      assert_empty @storage.collect!(dry_run: false)
    end
    @artifact_execution.update!(worktree_lease_token: "still-owned")
    AcRuntimeSupervisorService.stub(:status!, { "state" => "failed" }) do
      assert_empty @storage.collect!(dry_run: false)
    end
    assert File.directory?(@artifact_path)
  end

  test "backup and integration journal references block deletion" do
    pin = AcArtifactRetentionReference.create!(ac_execution: @artifact_execution, backup_id: "backup", manifest_digest: "digest")
    assert_empty @storage.collect!(dry_run: false)
    pin.destroy!
    AcIntegrationOperation.create!(ac_task: @task, identity: SecureRandom.hex(32), branch_ref: "refs/heads/main",
      base_commit: "a" * 40, candidate_commit: "b" * 40, artifact_hash: "c" * 64)
    assert_empty @storage.collect!(dry_run: false)
    assert File.directory?(@artifact_path)
  end

  test "an unowned source repository is never a collection candidate" do
    @artifact_execution.update!(worktree_path: @storage_root)
    assert_empty @storage.collect!(dry_run: false)
    assert File.directory?(@artifact_path)
  end

  test "destructive collection requires explicit enabling" do
    disabled = AcArtifactStorageService.new(root: @storage_root)
    assert_raises(AcArtifactStorageService::StorageError) { disabled.collect!(dry_run: false) }
  end

  test "preflight refuses clone when reserved free space would be consumed" do
    @storage.stub(:free_bytes, 1) do
      assert_raises(AcArtifactStorageService::StorageError) do
        @storage.preflight!(company: @company, source: @artifact_path)
      end
    end
  end
end
