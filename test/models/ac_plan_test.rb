# frozen_string_literal: true

require "test_helper"

class AcPlanTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-plan-testing",
      title: "Context for Plan",
      state: :active,
      origin: :new
    )
  end

  test "creates valid draft plan" do
    plan = AcPlan.new(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "f1-domain",
      version: 1,
      title: "Plano F1",
      objective: "Implementar domínio do Agent Control",
      state: :draft
    )
    assert plan.valid?, plan.errors.full_messages
    assert plan.save!
  end

  test "enforces version uniqueness per plan_key" do
    AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "shared-key",
      version: 1,
      title: "Original",
      state: :draft
    )

    duplicate = AcPlan.new(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "shared-key",
      version: 1,
      title: "Duplicate version",
      state: :draft
    )
    assert_not duplicate.valid?
    assert_includes duplicate.errors[:version], "já existe para este plan_key"
  end

  test "publish! calculates content hash and marks active (RF-15, RF-42)" do
    plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "publishable-plan",
      version: 1,
      title: "Plano Publicável",
      objective: "Objetivo claro de entrega",
      state: :draft
    )

    AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: plan,
      task_key: "task-01",
      title: "Primeira entrega",
      scope: "Escopo inicial",
      position: 1,
      state: :pending
    )

    assert plan.publish!
    assert plan.active?
    assert plan.published?
    assert_not_nil plan.published_at
    assert_not_nil plan.content_hash
    assert_equal 64, plan.content_hash.length
  end

  test "new_version increments version and preserves plan_key" do
    plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "evolving-feature",
      version: 1,
      title: "Feature v1",
      objective: "Primeira versão",
      state: :draft
    )

    next_plan = plan.new_version
    assert_equal "evolving-feature", next_plan.plan_key
    assert_equal 2, next_plan.version
    assert_equal "Feature v1", next_plan.title
    assert next_plan.draft?
  end
end
