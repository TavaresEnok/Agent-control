# frozen_string_literal: true

require "test_helper"

class AcWorktreeManagerServiceTest < ActiveSupport::TestCase
  include AcSafetyFixtures

  setup do
    @test_dir = Dir.mktmpdir("ac-worktree-test")
    @repo = File.join(@test_dir, "repo")
    FileUtils.mkdir_p(@repo)
    git!("init", @repo)
    File.write(File.join(@repo, "file.txt"), "first")
    git!("-C", @repo, "add", "file.txt")
    git!("-C", @repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "first")
    @first_commit = git!("-C", @repo, "rev-parse", "HEAD").strip
    File.write(File.join(@repo, "file.txt"), "second")
    git!("-C", @repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-am", "second")
    @second_commit = git!("-C", @repo, "rev-parse", "HEAD").strip
    @execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid,
      requested_by: "test", execution_profile: @profiles.fetch("programmer"))[:execution]
  end

  teardown do
    FileUtils.remove_entry(@test_dir) if @test_dir && Dir.exist?(@test_dir)
  end

  test "acquires lease for solitary execution" do
    token = AcWorktreeManagerService.acquire_lease!(execution: @execution, base_path: @test_dir, repo_path: @repo)

    assert token.present?
    @execution.reload
    assert_equal token, @execution.worktree_lease_token
    assert_equal "preparing", @execution.state
  end

  test "preserves an unverified writer and isolates the next worktree" do
    old_execution = AcExecution.create!(company: @company, ac_work_context: @context, ac_task: @task,
      operation_id: "old-#{SecureRandom.hex(4)}", epoch: "1", state: :cancelled,
      worktree_lease_token: "old-lease")

    AcWorktreeManagerService.acquire_lease!(execution: @execution, base_path: @test_dir, repo_path: @repo)

    assert_equal "old-lease", old_execution.reload.worktree_lease_token
    assert_not_nil @execution.reload.worktree_lease_token
  end

  test "operation identifier cannot escape the worktree root" do
    Dir.mktmpdir do |root|
      @execution.update!(operation_id: "../../outside-#{SecureRandom.hex(4)}")
      AcWorktreeManagerService.acquire_lease!(execution: @execution, base_path: root, repo_path: @repo)
      assert @execution.reload.worktree_path.start_with?("#{File.realpath(root)}/")
      assert Dir.exist?(@execution.worktree_path)
    end
  end

  test "release refuses an unverified writer and retains its artifacts" do
    Dir.mktmpdir do |root|
      AcWorktreeManagerService.acquire_lease!(execution: @execution, base_path: root, repo_path: @repo)
      path = @execution.reload.worktree_path
      File.write(File.join(path, "result.txt"), "result")
      previous = Rails.application.config.try(:ac_runtime_supervisor)
      Rails.application.config.ac_runtime_supervisor = FakeAcRuntimeSupervisor.new
      begin
        assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) do
          AcWorktreeManagerService.release_lease!(execution: @execution)
        end
        assert_equal "result", File.read(File.join(path, "result.txt"))
        assert_not_nil @execution.reload.worktree_lease_token
      ensure
        Rails.application.config.ac_runtime_supervisor = previous
      end
    end
  end
  test "clone has independent Git storage and checks out the requested commit" do
    @execution.update!(metadata: { "base_commit_sha" => @first_commit })
    AcWorktreeManagerService.acquire_lease!(execution: @execution, base_path: @test_dir, repo_path: @repo)
    clone = @execution.reload.worktree_path
    assert Dir.exist?(File.join(clone, ".git"))
    assert_not File.exist?(File.join(clone, ".git", "objects", "info", "alternates"))
    assert_equal "first", File.read(File.join(clone, "file.txt"))
    assert_equal @first_commit, @execution.metadata["base_commit_sha"]
    assert_equal @first_commit, git!("-C", clone, "rev-parse", "HEAD").strip
    git!("-C", clone, "update-ref", "refs/heads/clone-only", @first_commit)
    assert_equal @second_commit, git!("-C", @repo, "rev-parse", "HEAD").strip
    _out, _err, status = Open3.capture3("git", "-C", @repo, "show-ref", "--verify", "--quiet", "refs/heads/clone-only")
    assert_not status.success?
  end

  test "reviewer checks out the exact implementation artifact" do
    @execution.update!(state: :completed, exit_code: 0, worktree_path: @repo,
      output_payload: { "artifact_hash" => AcArtifactIdentity.digest(repo: @repo, commit: @first_commit, base: @first_commit),
                        "commit_sha" => @first_commit, "base_commit_sha" => @first_commit })
    @execution.ac_capacity_grant.update!(state: :released)
    @task.update!(state: :review)
    @execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid,
      requested_by: "test", role: "reviewer", execution_profile: @profiles.fetch("reviewer"))[:execution]
    AcWorktreeManagerService.acquire_lease!(execution: @execution, base_path: @test_dir, repo_path: @repo)
    assert_equal @first_commit, git!("-C", @execution.reload.worktree_path, "rev-parse", "HEAD").strip
    assert_equal @first_commit, @execution.metadata["base_commit_sha"]
  end

  test "rejects a missing repository before starting a writer" do
    assert_raises(AcWorktreeManagerService::GitError) do
      AcWorktreeManagerService.acquire_lease!(execution: @execution, base_path: @test_dir, repo_path: File.join(@test_dir, "missing"))
    end
    assert_nil @execution.reload.worktree_lease_token
  end

  private

  def git!(*args)
    out, err, status = Open3.capture3("git", *args)
    raise "git failed: #{err}" unless status.success?
    out
  end
end
