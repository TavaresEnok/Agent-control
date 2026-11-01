# frozen_string_literal: true

require "test_helper"

class AcRemoteLaunchServiceTest < ActiveSupport::TestCase
  include AcTemporalFixture

  setup do
    setup_ac_temporal_fixture
    AcMigrationService.assign_plan_manager!(plan: @plan, new_manager_identity: "manager", expected_epoch: 0)
    @execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid,
      requested_by: "test", execution_profile: @profile, epoch: "1", manager_identity: "manager", manager_epoch: 1)[:execution]
    @environment = AcRemoteEnvironment.create!(company: @company, project: @project, name: "Fixture",
      environment_slug: "fixture", host: "localhost", user: "worker", fingerprint: "fixture",
      identity_key_path: "/fixture/key", known_hosts_path: "/fixture/hosts", authorized_directories: [ "/lab" ])
    @payload = { "execution_id" => @execution.id, "environment_id" => @environment.id,
      "command" => "true", "working_directory" => "/lab" }
  end

  teardown { teardown_ac_temporal_fixture }

  test "command deduplication commits one pending remote operation and one relay event" do
    block = ->(command) {
      event = AcRemoteLaunchService.record!(company: @company, actor: @user, command_record: command, payload: @payload)
      { "operation_id" => event.data.fetch("operation_id"), "event_id" => event.id }
    }
    args = { intent_id: "remote-test", company: @company, user: @user,
      command_type: "execute_remote_operation", payload: @payload }
    first = AcCommandDeduplicationService.execute_idempotent!(**args, &block)
    second = AcCommandDeduplicationService.execute_idempotent!(**args, &block)
    assert second[:deduplicated]
    assert_equal first[:result], second[:result]
    event = TriggerEvent.find(first[:result]["event_id"])
    operation = AcRemoteOperation.find_by!(operation_id: first[:result]["operation_id"])
    assert_equal "pending", event.relay_state
    assert_equal "pending", operation.state
    assert_not operation.metadata["dispatch_claimed"]
    assert_equal @execution.id, operation.ac_execution_id
    assert_equal "manager", event.data["manager_identity"]
  end

  test "relay cancels an unclaimed intent when authorization expires" do
    event = AcRemoteLaunchService.record!(company: @company, actor: @user, command_record: command_record, payload: @payload)
    operation = AcRemoteOperation.find_by!(operation_id: event.data["operation_id"])
    @execution.ac_capacity_grant.update!(expires_at: 1.minute.ago)
    assert_raises(AcAdmissionService::UnauthorizedExecutionBypassError) { AcRemoteLaunchService.dispatch_event(event) }
    assert_equal "cancelled", operation.reload.state
    assert_not operation.metadata["dispatch_claimed"]
    assert_empty AcRemoteLaunchService.dispatch_event(event)
  end

  test "a precreated intent may be claimed only once" do
    command = command_record
    event = AcRemoteLaunchService.record!(company: @company, actor: @user, command_record: command, payload: @payload)
    operation = AcRemoteOperation.find_by!(operation_id: event.data["operation_id"])
    args = { environment: @environment, task: @task, execution: @execution, operation_id: operation.operation_id,
      command: operation.command, working_directory: operation.working_directory, artifact_hash: nil, metadata: {} }
    first, created = AcRemoteGatewayService.send(:create_intent!, **args)
    assert created
    second, created_again = AcRemoteGatewayService.send(:create_intent!, **args)
    assert_not created_again
    assert_equal first.id, second.id
  end

  test "pending or uncertain remote operations prevent capacity and worktree release" do
    event = AcRemoteLaunchService.record!(company: @company, actor: @user, command_record: command_record, payload: @payload)
    operation = AcRemoteOperation.find_by!(operation_id: event.data["operation_id"])
    @execution.update!(worktree_lease_token: "fixture-lease")
    %w[pending running uncertain].each do |state|
      operation.update!(state: state)
      assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) { @execution.revoke_worktree_lease! }
      assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) { @execution.ac_capacity_grant.release! }
      assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) do
        @execution.reconcile_outcome!(exit_code: 0, reported_epoch: @execution.epoch)
      end
      assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) { @execution.cancel! }
      assert_raises(AcRuntimeSupervisorService::UnverifiedReceiptError) do
        Activities::AgentControl::AcReleaseCapacityActivity.new.execute(execution_id: @execution.id)
      end
      assert_equal "fixture-lease", @execution.reload.worktree_lease_token
      assert @execution.ac_capacity_grant.reload.granted?
    end
  end

  test "a different tenant or unauthorized actor cannot queue an operation" do
    outsider = create(:user, company: @company)
    command = AcClientCommand.create!(company: @company, user: outsider, intent_id: SecureRandom.uuid,
      command_type: "execute_remote_operation", state: "processing", payload: @payload)
    assert_raises(Pundit::NotAuthorizedError) do
      AcRemoteLaunchService.record!(company: @company, actor: outsider, command_record: command, payload: @payload)
    end
    foreign = create(:company)
    assert_raises(Pundit::NotAuthorizedError) do
      AcRemoteLaunchService.record!(company: foreign, actor: @user, command_record: command_record, payload: @payload)
    end
    assert_empty AcRemoteOperation.where(ac_execution_id: @execution.id)
  end

  private

  def command_record
    AcClientCommand.create!(company: @company, user: @user, intent_id: SecureRandom.uuid,
      command_type: "execute_remote_operation", state: "processing", payload: @payload)
  end
end
