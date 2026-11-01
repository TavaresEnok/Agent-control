# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "open3"

class AcIntegrationSafetyTest < ActiveSupport::TestCase
  self.use_transactional_tests = false
  include AcSafetyFixtures

  setup do
    @directory = Dir.mktmpdir("ac-integration-")
    @repo = File.join(@directory, "central")
    @source = File.join(@directory, "implementation")
    git("init", "-b", "main", @repo)
    File.write(File.join(@repo, "value.txt"), "base\n")
    commit(@repo, "Base")
    @base = git("-C", @repo, "rev-parse", "HEAD").strip
    git("clone", "--no-local", "--", @repo, @source)
    File.write(File.join(@source, "value.txt"), "candidate\n")
    commit(@source, "Candidate")
    @candidate = git("-C", @source, "rev-parse", "HEAD").strip
    @hash = AcArtifactIdentity.digest(repo: @source, commit: @candidate, base: @base)
    @context.update!(metadata: @context.metadata.merge("git_repo_path" => @repo))
    @task.update!(state: :review)
    @implementation = execution("programmer")
    @review = execution("reviewer")
    @qa = execution("qa")
    AcReviewService.submit_verdict!(task: @task, execution: @review, reviewer_role: "reviewer",
      evaluator_identity: @review.process_handle, artifact_hash: @hash, verdict: "approved",
      candidate_commit_sha: @candidate, base_commit_hash: @base)
    AcReviewService.submit_verdict!(task: @task, execution: @qa, reviewer_role: "qa",
      evaluator_identity: @qa.process_handle, artifact_hash: @hash, verdict: "approved",
      candidate_commit_sha: @candidate, base_commit_hash: @base)
    assert @task.reload.approved?
  end

  teardown do
    FileUtils.remove_entry(@directory) if @directory && File.directory?(@directory)
  end

  test "publishes exactly the independently reviewed and verified Git commit" do
    result = integrate
    assert result[:integrated]
    assert_equal @candidate, head
    assert @task.reload.integrated?
    observed = AcPilotContextService.complete_pilot_cycle!(task: @task, approved_commit_sha: @candidate, artifact_hash: @hash)
    assert_equal "pilot_cycle_completed", observed[:status]
    assert_equal "completed", AcIntegrationOperation.find_by!(ac_task: @task).state
    assert integrate[:integrated]
    assert_equal 1, AcIntegrationOperation.where(ac_task: @task).count
  end

  test "an outer SQL transaction is rejected before any Git effect" do
    AcTask.transaction do
      assert_raises(AcIntegrationService::IntegrationError) { integrate }
    end
    assert_equal @base, head
    assert_empty AcIntegrationOperation.where(ac_task: @task)
  end

  test "missing verification never moves the branch" do
    assert_raises(AcIntegrationService::InvalidVerificationEvidenceError) { integrate(verification_evidence: {}) }
    assert_equal @base, head
    assert @task.reload.approved?
  end

  test "another commit cannot borrow the approved artifact label" do
    File.write(File.join(@source, "value.txt"), "unreviewed\n")
    commit(@source, "Unreviewed")
    unreviewed = git("-C", @source, "rev-parse", "HEAD").strip
    assert_raises(AcIntegrationService::StaleArtifactError) { integrate(candidate_commit: unreviewed) }
    assert_equal @base, head
  end

  test "QA rejection cannot borrow a zero process exit code" do
    @task.ac_review_verdicts.where(reviewer_role: :qa).update_all(verdict: "needs_changes")
    assert_raises(AcIntegrationService::InvalidVerificationEvidenceError) { integrate }
    assert_equal @base, head
  end

  test "negative verification is checked before Git publication" do
    @supervisor.receipts[@qa.id]["exit_code"] = 17
    @supervisor.receipts[@qa.id]["state"] = "failed"
    assert_raises(AcReviewService::InvalidVerdictError) { integrate }
    assert_equal @base, head
  end

  test "reconciles a prepared intent after the Git effect but before the SQL result" do
    identity = Digest::SHA256.hexdigest([ @task.id, "refs/heads/main", @base, @candidate, @hash ].join(":"))
    operation = AcIntegrationOperation.create!(ac_task: @task, identity: identity, branch_ref: "refs/heads/main",
      base_commit: @base, candidate_commit: @candidate, artifact_hash: @hash)
    git("-C", @repo, "fetch", "--", @source, @candidate)
    git("-C", @repo, "update-ref", "refs/heads/main", @candidate, @base)
    assert @task.reload.approved?
    assert integrate[:integrated]
    assert_equal "completed", operation.reload.state
    assert_equal @candidate, head
  end

  test "untrusted fsmonitor never runs on the control host" do
    marker = File.join(@directory, "host-hook-ran")
    hook = File.join(@source, ".git", "malicious-monitor")
    File.write(hook, "#!/bin/sh\ntouch #{marker}\n")
    File.chmod(0o755, hook)
    git("-C", @source, "config", "core.fsmonitor", hook)
    _out, _error, status = AcSafeGit.capture("-C", @source, "status", "--porcelain")
    assert status.success?
    assert_not File.exist?(marker)
  end

  test "worker clean filters never execute on the control host" do
    marker = File.join(@directory, "host-filter-ran")
    File.write(File.join(@source, ".gitattributes"), "value.txt filter=escape\n")
    git("-C", @source, "config", "filter.escape.clean", "touch #{marker}; cat")
    File.write(File.join(@source, "value.txt"), "changed after commit\n")
    _out, _error, status = AcSafeGit.capture("-C", @source, "status", "--porcelain")
    assert status.success?
    assert_not File.exist?(marker)
  end

  test "a late review cannot approve an old artifact while programming is running" do
    @task.ac_review_verdicts.update_all(state: "invalidated")
    @task.update!(state: :running, approved_commit_sha: nil, approved_artifact_hash: nil)
    assert_raises(AcReviewService::InvalidVerdictError) do
      AcReviewService.submit_verdict!(task: @task, execution: @review, reviewer_role: "reviewer",
        evaluator_identity: @review.process_handle, artifact_hash: @hash, verdict: "approved",
        candidate_commit_sha: @candidate, base_commit_hash: @base)
    end
    assert @task.reload.running?
  end

  test "special Git metadata files cannot block a host inspection" do
    path = File.join(@source, ".git", "objects", "worker-pipe")
    assert system("mkfifo", path)
    assert_raises(ArgumentError) { AcSafeGit.capture("-C", @source, "rev-parse", "HEAD") }
  end

  test "a cancellation between runtime observation and review fence stays cancelled" do
    stale = AcTask.find(@task.id)
    @supervisor.on_status = lambda do
      @supervisor.on_status = nil
      AcTask.find(@task.id).cancel!
    end
    assert_raises(AcAdmissionService::TaskNotEligibleForAdmissionError) do
      AcReviewService.submit_verdict!(task: stale, execution: @review, reviewer_role: "reviewer",
        evaluator_identity: @review.process_handle, artifact_hash: @hash, verdict: "approved",
        candidate_commit_sha: @candidate, base_commit_hash: @base)
    end
    assert stale.reload.cancelled?
  end

  private

  def integrate(**overrides)
    AcIntegrationService.integrate_task!(**{
      task: @task, expected_base_commit: @base, candidate_commit: @candidate,
      artifact_hash: @hash, verification_evidence: { execution_id: @qa.id }, repo_path: @repo
    }.merge(overrides))
  end

  def execution(role)
    operation = SecureRandom.uuid
    profile = @profiles.fetch(role)
    grant = AcCapacityGrant.create!(company: @company, ac_task: @task, ac_execution_profile: profile,
      agent_credential: @credential, operation_id: operation, epoch: "1", state: :released,
      policy_revision_id: @policy.id, policy_revision_number: 1)
    output = { "commit_sha" => @candidate, "base_commit_sha" => @base, "artifact_hash" => @hash,
      "review" => { "artifact_hash" => @hash, "candidate_commit_sha" => @candidate,
        "base_commit_hash" => @base, "verdict" => "approved", "findings" => [] } }
    record = AcExecution.create!(company: @company, ac_task: @task, ac_work_context: @context,
      ac_execution_profile: profile, ac_capacity_grant: grant, operation_id: operation, epoch: "1",
      state: :completed, process_handle: "container-#{operation}", exit_code: 0,
      output_payload: output, worktree_path: @source)
    @supervisor.receipts[record.id] = { "operation_id" => operation, "epoch" => "1",
      "process_handle" => record.process_handle, "state" => "completed", "exit_code" => 0,
      "runtime_id" => operation, "output" => output, "error" => {} }
    record
  end

  def head
    git("-C", @repo, "rev-parse", "main").strip
  end

  def commit(path, message)
    git("-C", path, "add", ".")
    git("-C", path, "-c", "user.name=Safety", "-c", "user.email=safety@example.invalid", "commit", "-m", message)
  end

  def git(*args)
    out, err, status = Open3.capture3("git", *args)
    assert status.success?, err
    out
  end
end
