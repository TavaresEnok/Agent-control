# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "open3"
require "fileutils"

class AcPhysicalGitTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)

    # Cria repositório Git físico real em diretório temporário
    @tmp_dir = Dir.mktmpdir("ac_git_real_repo")
    @repo_path = File.join(@tmp_dir, "repo")
    FileUtils.mkdir_p(@repo_path)

    system("git", "-C", @repo_path, "init", exception: true)
    system("git", "-C", @repo_path, "checkout", "-b", "main", exception: true)
    system("git", "-C", @repo_path, "config", "user.name", "Test Agent", exception: true)
    system("git", "-C", @repo_path, "config", "user.email", "agent@example.com", exception: true)

    # Cria commit inicial
    File.write(File.join(@repo_path, "README.md"), "# Project Initial\n")
    system("git", "-C", @repo_path, "add", "README.md", exception: true)
    system("git", "-C", @repo_path, "commit", "-m", "Initial commit", exception: true)

    out, _, _ = Open3.capture3("git", "-C", @repo_path, "rev-parse", "HEAD")
    @base_commit = out.strip

    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Physical Git Context",
      external_id: "ctx-git-#{SecureRandom.hex(4)}",
      metadata: { "git_repo_path" => @repo_path }
    )

    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "git-plan-#{SecureRandom.hex(4)}",
      title: "Plan Git Physical",
      objective: "Physical git operations",
      version: 1
    )

    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-git-01",
      title: "Task Git Physical",
      scope: "Implement feature in real git",
      position: 1,
      risk_class: :low,
      metadata: { "base_commit_sha" => @base_commit }
    )

    @execution = AcExecution.create!(
      company: @company,
      ac_work_context: @context,
      ac_task: @task,
      operation_id: "op-git-#{SecureRandom.hex(4)}",
      epoch: "1"
    )
  end

  teardown do
    FileUtils.remove_entry(@tmp_dir) if @tmp_dir && Dir.exist?(@tmp_dir)
  end

  test "physical git worktree lifecycle: add, isolate files, and release" do
    worktree_base = File.join(@tmp_dir, "worktrees")
    token = AcWorktreeManagerService.acquire_lease!(
      execution: @execution,
      base_path: worktree_base,
      repo_path: @repo_path
    )

    assert token.present?
    wt_path = @execution.reload.worktree_path
    assert Dir.exist?(wt_path), "Diretório físico da worktree deve existir"
    assert File.exist?(File.join(wt_path, "README.md")), "Worktree física deve conter os arquivos do commit base"

    # Confirma que o Git reconhece a worktree física
    wt_list, _, _ = Open3.capture3("git", "-C", @repo_path, "worktree", "list")
    assert_includes wt_list, wt_path

    # Libera a lease e confirma remoção física
    AcWorktreeManagerService.release_lease!(execution: @execution, repo_path: @repo_path)
    assert_nil @execution.reload.worktree_lease_token
    assert_not Dir.exist?(wt_path), "Diretório da worktree física deve ser removido após release"

    wt_list_after, _, _ = Open3.capture3("git", "-C", @repo_path, "worktree", "list")
    assert_not_includes wt_list_after, wt_path
  end

  test "physical git integration with atomic CAS update-ref" do
    # Cria um commit candidato no repositório
    File.write(File.join(@repo_path, "feature.txt"), "autonomous feature code\n")
    system("git", "-C", @repo_path, "add", "feature.txt", exception: true)
    system("git", "-C", @repo_path, "commit", "-m", "Feature commit", exception: true)

    cand_out, _, _ = Open3.capture3("git", "-C", @repo_path, "rev-parse", "HEAD")
    candidate_commit = cand_out.strip

    # Reseta a branch main para a base para simular estado de branch antes do merge
    system("git", "-C", @repo_path, "update-ref", "refs/heads/main", @base_commit, exception: true)

    @task.update!(
      state: :approved,
      approved_commit_sha: candidate_commit,
      approved_artifact_hash: "artifact-sha-phys"
    )

    AcReviewVerdict.create!(
      company: @company,
      project: @project,
      ac_task: @task,
      reviewer_role: :reviewer,
      verdict: :approved,
      artifact_hash: "artifact-sha-phys",
      candidate_commit_sha: candidate_commit,
      evaluator_identity: "senior-reviewer",
      state: :valid
    )

    # 1. Integração com base coincidente: CAS deve atualizar a referência física
    result = AcIntegrationService.integrate_task!(
      task: @task,
      expected_base_commit: @base_commit,
      candidate_commit: candidate_commit,
      current_branch_head: @base_commit,
      artifact_hash: "artifact-sha-phys",
      verification_evidence: { executor_identity: "ci-verifier", exit_code: 0 },
      repo_path: @repo_path
    )

    assert result[:integrated]

    # Verifica se a ref física main no Git realmente aponta para candidate_commit
    head_after, _, _ = Open3.capture3("git", "-C", @repo_path, "rev-parse", "refs/heads/main")
    assert_equal candidate_commit, head_after.strip

    # 2. Rejeição de CAS se a base esperada divergir da referência real
    @task.update!(state: :approved)
    assert_raises(AcIntegrationService::ConcurrentBranchModificationError) do
      AcIntegrationService.integrate_task!(
        task: @task,
        expected_base_commit: "stale-commit-hash",
        candidate_commit: "another-cand",
        current_branch_head: "stale-commit-hash", # CAS físico falhará pois ref atual é candidate_commit
        artifact_hash: "artifact-sha-phys",
        repo_path: @repo_path
      )
    end
  end
end
