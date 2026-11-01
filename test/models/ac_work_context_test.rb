# frozen_string_literal: true

require "test_helper"

class AcWorkContextTest < ActiveSupport::TestCase
  def setup
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
  end

  test "creates valid work context" do
    ctx = AcWorkContext.new(
      company: @company,
      project: @project,
      external_id: "ctx-core-delivery-1",
      title: "Core Delivery Loop",
      state: :active,
      origin: :new
    )
    assert ctx.valid?, ctx.errors.full_messages
    assert ctx.save!
  end

  test "validates external_id format and uniqueness" do
    AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-unique-123",
      title: "Existing",
      state: :active,
      origin: :new
    )

    duplicate = AcWorkContext.new(
      company: @company,
      project: @project,
      external_id: "ctx-unique-123",
      title: "Duplicate",
      state: :active,
      origin: :new
    )
    assert_not duplicate.valid?
    assert_includes duplicate.errors[:external_id], "has already been taken"

    invalid_format = AcWorkContext.new(
      company: @company,
      project: @project,
      external_id: "ctx invalid space!",
      title: "Invalid",
      state: :active,
      origin: :new
    )
    assert_not invalid_format.valid?
  end

  test "requires pause_reason when paused (RF-24)" do
    ctx = AcWorkContext.new(
      company: @company,
      project: @project,
      external_id: "ctx-paused-test",
      title: "Pause Test",
      state: :paused,
      origin: :new
    )
    assert_not ctx.valid?
    assert_includes ctx.errors[:pause_reason], "é obrigatório ao pausar o contexto (RF-24)"

    ctx.pause_reason = "Aguardando aprovação de cota pelo operador"
    assert ctx.valid?
  end

  test "transitions state correctly with pause!, resume!, suspend!, archive!" do
    ctx = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-transitions-1",
      title: "Transitions",
      state: :active,
      origin: :new
    )

    ctx.pause!(reason: "Manutenção programada")
    assert ctx.paused?
    assert_equal "Manutenção programada", ctx.pause_reason

    ctx.resume!
    assert ctx.active?
    assert_nil ctx.pause_reason

    ctx.suspend!(reason: "Limite violado")
    assert ctx.suspended?
    assert_equal "Limite violado", ctx.pause_reason

    ctx.archive!
    assert ctx.archived?
  end

  test "active_plan returns latest active published plan" do
    ctx = AcWorkContext.create!(
      company: @company,
      project: @project,
      external_id: "ctx-plan-lookup",
      title: "Plan Lookup",
      state: :active,
      origin: :new
    )

    plan_v1 = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: ctx,
      plan_key: "feature-auth",
      version: 1,
      title: "Auth v1",
      state: :draft
    )

    plan_v2 = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: ctx,
      plan_key: "feature-auth",
      version: 2,
      title: "Auth v2",
      state: :draft
    )

    assert plan_v1.publish!
    plan_v1.update!(state: :completed)
    assert plan_v2.publish!
    assert_equal plan_v2, ctx.active_plan
  end
end
