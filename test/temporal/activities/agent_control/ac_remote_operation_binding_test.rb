# frozen_string_literal: true

require "test_helper"
require Rails.root.join("app/temporal/activities/agent_control/ac_remote_operation_binding")

class AcRemoteOperationBindingTest < ActiveSupport::TestCase
  include AcTemporalFixture

  class BindingProbe
    include Activities::AgentControl::AcRemoteOperationBinding
    public :bound_execution!, :bound_operation!
  end

  setup do
    setup_ac_temporal_fixture
    AcMigrationService.assign_plan_manager!(plan: @plan, new_manager_identity: "manager", expected_epoch: 0)
    @execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid,
      requested_by: "test", execution_profile: @profile, epoch: "1", manager_identity: "manager", manager_epoch: 1)[:execution]
    @environment = AcRemoteEnvironment.create!(company: @company, project: @project, name: "Fixture",
      environment_slug: "fixture", host: "localhost", user: "worker", fingerprint: "fixture",
      identity_key_path: "/fixture/key", known_hosts_path: "/fixture/hosts", authorized_directories: [ "/lab" ])
    @operation = AcRemoteOperation.create!(company: @company, project: @project, ac_remote_environment: @environment,
      ac_task: @task, ac_execution: @execution, operation_id: SecureRandom.uuid, command: "true",
      working_directory: "/lab", state: "pending", metadata: { "execution_epoch" => "1" })
    @binding = { company_id: @company.id, task_id: @task.id, execution_id: @execution.id, environment_id: @environment.id,
      operation_id: @operation.operation_id, epoch: "1", manager_identity: "manager", manager_epoch: 1 }
  end

  teardown { teardown_ac_temporal_fixture }

  test "operation is resolved only for its company execution epoch and manager" do
    probe = BindingProbe.new
    operation, execution = probe.bound_operation!(TemporalInput.wrap(@binding))
    assert_equal @operation.id, operation.id
    assert_equal @execution.id, execution.id
    assert_raises(ActiveRecord::RecordNotFound) do
      probe.bound_operation!(TemporalInput.wrap(@binding.merge(company_id: @company.id + 100_000)))
    end
    [ { epoch: "2" }, { manager_identity: "other" }, { manager_epoch: 2 } ].each do |invalid|
      assert_raises(AcAdmissionService::UnauthorizedExecutionBypassError) do
        probe.bound_operation!(TemporalInput.wrap(@binding.merge(invalid)))
      end
    end
  end
  test "pre-dispatch cancellation clears a pending intent after plan cancellation without an SSH call" do
    @operation.update!(metadata: @operation.metadata.merge("dispatch_claimed" => false))
    @plan.cancel!(reason: "Cancelled while queued")
    # Force the local cleanup to prove it never asks the gateway for an RPC.
    forbidden_rpc = ->(**) { flunk "Unclaimed intent must not contact SSH" }
    AcRemoteGatewayService.stub(:cancel_operation!, forbidden_rpc) do
      result = Activities::AgentControl::AcCancelRemoteOperationV2Activity.new.execute(@binding.merge(reason: "Queued cancel"))
      assert_equal "cancelled", result["state"]
      assert_equal "cancelled", @operation.reload.state
      assert_not @operation.metadata["dispatch_claimed"]
      assert_nil @operation.remote_job_id
      assert_nil @operation.exit_code
      assert_nothing_raised { @execution.assert_no_unsettled_remote_operations! }
      # Retries remain local and idempotent after losing the activity response.
      assert_equal "cancelled", Activities::AgentControl::AcCancelRemoteOperationV2Activity.new.execute(@binding)["state"]
    end
  end

  test "pre-dispatch cleanup refuses a foreign binding and preserves the pending intent" do
    @operation.update!(metadata: @operation.metadata.merge("dispatch_claimed" => false))
    assert_raises(ActiveRecord::RecordNotFound) do
      Activities::AgentControl::AcCancelRemoteOperationV2Activity.new.run(TemporalInput.wrap(@binding.merge(company_id: @company.id + 100_000)))
    end
    assert_equal "pending", @operation.reload.state
  end
end
