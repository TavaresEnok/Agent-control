# frozen_string_literal: true

require "test_helper"

class AcPlanPublicationInvariantsTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(company: @company, project: @project, external_id: SecureRandom.uuid, title: "Context")
    @plan = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Plan", version: 1, state: :draft)
    @task = AcTask.create!(company: @company, project: @project, ac_plan: @plan, task_key: "first", title: "First",
      metadata: { "target_branch" => "main", "effort_level" => "medium" })
  end

  test "new plans cannot be created active or with a publication timestamp" do
    plan = AcPlan.new(company: @company, project: @project, ac_work_context: @context,
      plan_key: "bypass", title: "Bypass", version: 1, state: :active,
      content_hash: SecureRandom.hex(32), published_at: Time.current)
    assert_not plan.valid?
    assert_includes plan.errors[:state], "planos novos devem começar em rascunho"
  end

  test "publication rejects missing dependencies and cycles" do
    @task.update!(depends_on: [ "missing" ])
    assert_not @plan.publish!
    assert_nil @plan.reload.published_at
    other = AcTask.create!(company: @company, project: @project, ac_plan: @plan, task_key: "second", title: "Second", depends_on: [ "first" ])
    @task.update!(depends_on: [ "second" ])
    assert_not @plan.publish!
    assert_nil @plan.reload.published_at
    other.update!(depends_on: [])
    assert @plan.publish!
  end

  test "publication rejects tasks from another company or project" do
    other_company = create(:company)
    other_user = create(:user, company: other_company)
    other_project = create(:project, company: other_company, owner: other_user)
    @task.update!(company: other_company, project: other_project)
    assert_not @plan.publish!
    assert_nil @plan.reload.published_at
  end

  test "published task set and contract metadata are immutable while runtime metadata can change" do
    assert_not @plan.update(published_at: Time.current)
    @plan.reload
    assert @plan.publish!
    assert_not @plan.update(published_at: nil)
    @plan.reload
    assert_not AcTask.new(company: @company, project: @project, ac_plan: @plan, task_key: "late", title: "Late").valid?
    assert_not @task.destroy
    @task.reload
    %w[target_branch execution_profile_id effort_level base_commit_sha].each do |key|
      assert_not @task.update(metadata: @task.metadata.merge(key => "changed")), key
      @task.reload
    end
    assert_not @task.update(metadata: @task.metadata.merge(target_branch: "bypass"))
    @task.reload
    assert @task.update(metadata: @task.metadata.merge("phase_generations" => { "programmer" => 1 }))
    assert_equal "main", @task.reload.metadata["target_branch"]
  end
end
