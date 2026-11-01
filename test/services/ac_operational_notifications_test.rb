# frozen_string_literal: true

require "test_helper"

class AcOperationalNotificationsTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @owner = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @owner)
    @context = AcWorkContext.create!(company: @company, project: @project, external_id: SecureRandom.uuid, title: "Context")
    @plan = AcPlan.create!(company: @company, project: @project, ac_work_context: @context,
      plan_key: SecureRandom.uuid, title: "Plan", version: 1, state: :draft)
    @task = AcTask.create!(company: @company, project: @project, ac_plan: @plan, task_key: "task", title: "Task")
    raise "Plan publication failed" unless @plan.publish!
  end

  test "pause and cancellation create one durable notification per transition" do
    @plan.pause!
    @plan.pause!
    @plan.update!(metadata: @plan.metadata.merge("other" => "changed"))
    assert_equal [ "plan_paused" ], kinds
    @plan.resume!
    @plan.pause!
    @plan.cancel!
    assert_equal %w[plan_paused plan_paused plan_cancelled], kinds
    assert_equal 3, AcNotificationReceipt.where(user: @owner, trigger_event: events).count
    assert_equal %w[pending], events.reorder(nil).distinct.pluck(:relay_state)
  end

  test "queued task is ready only while the plan is active" do
    @task.update!(state: :queued)
    assert_includes @plan.ready_tasks, @task
    @plan.pause!
    assert_empty @plan.ready_tasks
  end

  test "task notifications follow transitions and roll back with the task" do
    @task.update!(state: :needs_changes)
    @task.update!(metadata: @task.metadata.merge("other" => "changed"))
    @task.update!(state: :approved, approved_commit_sha: "commit", approved_artifact_hash: "artifact")
    @task.update!(state: :integrated)
    @task.update!(state: :failed)
    assert_equal %w[task_needs_changes task_approved task_integrated task_failed], kinds
    AcTask.transaction(requires_new: true) do
      @task.update!(state: :needs_changes)
      raise ActiveRecord::Rollback
    end
    assert_equal %w[task_needs_changes task_approved task_integrated task_failed], kinds
  end

  private

  def events
    TriggerEvent.where(company: @company, source: "agent_control.notification").order(:id)
  end

  def kinds
    events.map { |event| event.data.fetch("kind") }
  end
end
