# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "open3"

class AcPhysicalGitTest < ActiveSupport::TestCase
  include AcTemporalFixture

  setup do
    setup_ac_temporal_fixture
    @directory = Dir.mktmpdir("ac-git-")
    @repo = File.join(@directory, "source")
    git("init", "-b", "main", @repo)
    File.write(File.join(@repo, "README.md"), "base\n")
    git("-C", @repo, "add", "README.md")
    git("-C", @repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Base")
    @base = git("-C", @repo, "rev-parse", "HEAD").strip
    @context.update!(metadata: @context.metadata.merge("git_repo_path" => @repo))
    @execution = admit_ac_execution
  end

  teardown do
    teardown_ac_temporal_fixture
    FileUtils.remove_entry(@directory) if @directory && Dir.exist?(@directory)
  end

  test "isolated Git checkout persists after verified release" do
    token = AcWorktreeManagerService.acquire_lease!(execution: @execution, base_path: File.join(@directory, "work"), repo_path: @repo)
    assert token.present?
    path = @execution.reload.worktree_path
    assert_equal @base, git("-C", path, "rev-parse", "HEAD").strip
    assert_path_exists File.join(path, "README.md")
    assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) do
      AcWorktreeManagerService.release_lease!(execution: @execution)
    end
    assert_equal token, @execution.reload.worktree_lease_token

    @task.cancel!
    Rails.application.config.ac_runtime_supervisor.receipts[@execution.id] = {
      "state" => "not_started", "operation_id" => @execution.operation_id,
      "epoch" => @execution.epoch, "process_handle" => "fake-runtime-handle"
    }
    AcWorktreeManagerService.release_lease!(execution: @execution)
    assert_nil @execution.reload.worktree_lease_token
    assert File.directory?(path)
    assert_equal @base, git("-C", @repo, "rev-parse", "main").strip
  end

  private

  def git(*args)
    output, error, status = Open3.capture3("git", *args)
    assert status.success?, error
    output
  end
end
