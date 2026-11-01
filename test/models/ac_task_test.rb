# frozen_string_literal: true

require "test_helper"

class AcTaskTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-tasks-test",
      title: "Context for Tasks",
      state: :active,
      origin: :new
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "tasks-plan",
      version: 1,
      title: "Plan for Tasks",
      objective: "Test all task features",
      state: :draft
    )
  end

  test "creates valid pending task" do
    task = AcTask.new(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-infra-01",
      title: "Setup infra",
      scope: "Configure infrastructure",
      position: 1,
      state: :pending,
      risk_class: :medium,
      assigned_role: :programmer
    )
    assert task.valid?, task.errors.full_messages
    assert task.save!
  end

  test "validates task_key uniqueness within plan" do
    AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-dup",
      title: "First",
      position: 1,
      state: :pending
    )

    dup = AcTask.new(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-dup",
      title: "Duplicate",
      position: 2,
      state: :pending
    )
    assert_not dup.valid?
    assert_includes dup.errors[:task_key], "já existe neste plano"
  end

  test "requires QA for risk_class high and critical (RF-18)" do
    low_task = AcTask.new(risk_class: :low)
    med_task = AcTask.new(risk_class: :medium)
    high_task = AcTask.new(risk_class: :high)
    crit_task = AcTask.new(risk_class: :critical)

    assert_not low_task.requires_qa?
    assert_not med_task.requires_qa?
    assert high_task.requires_qa?
    assert crit_task.requires_qa?
  end

  test "enforces attempt limit (RF-21)" do
    task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-attempts",
      title: "Retry test",
      position: 1,
      state: :pending,
      attempt_count: 4
    )
    assert_not task.attempt_limit_reached?

    task.start_running!
    assert_equal 5, task.attempt_count
    assert task.attempt_limit_reached?
  end

  test "enforces approved artifact consistency (RF-19)" do
    task = AcTask.new(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-artifact",
      title: "Artifact test",
      position: 1,
      state: :approved,
      approved_commit_sha: "abc1234",
      approved_artifact_hash: nil
    )
    assert_not task.valid?
    assert_includes task.errors[:base], "approved_commit_sha e approved_artifact_hash devem ser preenchidos juntos (RF-19)"

    task.approved_artifact_hash = "def5678"
    assert task.valid?
  end

  test "reject_back_to_implementation! resets to queued and clears approval (RF-20)" do
    task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-rejection",
      title: "Rejection test",
      position: 1,
      state: :approved,
      approved_commit_sha: "sha111",
      approved_artifact_hash: "hash111",
      attempt_count: 2
    )

    task.reject_back_to_implementation!
    assert task.queued? || task.state == "needs_changes"
    assert_nil task.approved_commit_sha
    assert_nil task.approved_artifact_hash
  end

  test "dependencies_met scope filters independent tasks (RF-16)" do
    t1 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "t1-independent",
      title: "No deps",
      position: 1,
      state: :pending,
      depends_on: []
    )

    t2 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "t2-dependent",
      title: "Depends on t1",
      position: 2,
      state: :pending,
      depends_on: ["t1-independent"]
    )

    ready = AcTask.dependencies_met(@plan.id)
    assert_includes ready, t1
    assert_not_includes ready, t2

    # Agora integramos t1
    t1.update!(state: :approved, approved_commit_sha: "c1", approved_artifact_hash: "a1")
    t1.integrate!

    ready_after = AcTask.dependencies_met(@plan.id)
    assert_includes ready_after, t2
  end
end
