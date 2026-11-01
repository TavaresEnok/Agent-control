# frozen_string_literal: true

require "test_helper"
require "timeout"

module AcRemoteV2TestActivities
  QUEUE = "ac-remote-v2-contract"

  class State
    attr_reader :calls, :cancel_state

    def initialize(cancel_state: "uncertain")
      @cancel_state = cancel_state
      @calls = []
      @queries = 0
    end

    def query
      @queries += 1
      @queries < 3 ? "uncertain" : "completed"
    end
  end

  class Dispatch < Temporalio::Activity::Definition
    activity_name "ac_dispatch_remote_operation_v2_activity"

    def initialize(state)
      super()
      @state = state
    end

    def execute(input)
      @state.calls << [ "dispatch", input ]
      { "state" => "running", "remote_job_id" => "fixture-unit", "result" => {} }
    end
  end

  class BlockingDispatch < Dispatch
    activity_name "ac_dispatch_remote_operation_v2_activity"
    def initialize(state, started, release)
      super(state)
      @started, @release = started, release
    end

    def execute(input)
      @started << true
      @release.pop
      super
    end
  end

  class Query < Temporalio::Activity::Definition
    activity_name "ac_query_remote_operation_v2_activity"

    def initialize(state)
      super()
      @state = state
    end

    def execute(input)
      @state.calls << [ "query", input ]
      { "state" => @state.query, "remote_job_id" => "fixture-unit", "result" => { "exit_code" => 0 } }
    end
  end

  class Cancel < Temporalio::Activity::Definition
    activity_name "ac_cancel_remote_operation_v2_activity"

    def initialize(state)
      super()
      @state = state
    end

    def execute(input)
      @state.calls << [ "cancel", input ]
      { "state" => @state.cancel_state, "result" => {} }
    end
  end
end

class AcRemoteOperationWorkflowV2Test < ActiveSupport::TestCase
  include TemporalWorkflowHelper

  setup do
    @previous_refs = Workflows::AcRemoteOperationWorkflowV2._preloaded_activities
    proxy = Object.new
    %w[dispatch query cancel].each do |action|
      name = "ac_#{action}_remote_operation_v2_activity"
      proxy.define_singleton_method(name) { TemporalWorkflowHelper::ActivityRef.new(name, AcRemoteV2TestActivities::QUEUE) }
    end
    Workflows::AcRemoteOperationWorkflowV2.instance_variable_set(:@_preloaded_activities, proxy)
  end

  teardown do
    Workflows::AcRemoteOperationWorkflowV2.instance_variable_set(:@_preloaded_activities, @previous_refs)
  end

  test "running and uncertain results are polled until a terminal receipt" do
    state = AcRemoteV2TestActivities::State.new
    binding = { company_id: 1, task_id: 2, execution_id: 3, environment_id: 4, operation_id: "op",
      epoch: "1", manager_identity: "manager", manager_epoch: 5, command: "true", working_directory: "/lab" }
    result = run_workflow(Workflows::AcRemoteOperationWorkflowV2, binding,
      activities: [ AcRemoteV2TestActivities::Dispatch.new(state), AcRemoteV2TestActivities::Query.new(state),
        AcRemoteV2TestActivities::Cancel.new(state) ], task_queue: AcRemoteV2TestActivities::QUEUE)
    assert_equal "completed", result["status"]
    assert_equal 0, result["exit_code"]
    assert_equal 3, state.calls.count { |name, _| name == "query" }
    state.calls.each do |_name, input|
      assert_equal "manager", input["manager_identity"]
      assert_equal 5, input["manager_epoch"]
      assert_equal 3, input["execution_id"]
    end
  end
  test "cancel signal calls the supervisor activity and waits for a terminal observation" do
    state = AcRemoteV2TestActivities::State.new
    started, release = Queue.new, Queue.new
    environment = Temporalio::Testing::WorkflowEnvironment.start_time_skipping(data_converter: TemporalService.data_converter,
      test_server_download_dest_dir: ENV["TEMPORAL_TEST_SERVER_DIR"].presence)
    worker = Temporalio::Worker.new(client: environment.client, task_queue: AcRemoteV2TestActivities::QUEUE,
      workflows: [ Workflows::AcRemoteOperationWorkflowV2 ],
      activities: [ AcRemoteV2TestActivities::BlockingDispatch.new(state, started, release),
        AcRemoteV2TestActivities::Query.new(state), AcRemoteV2TestActivities::Cancel.new(state) ],
      workflow_failure_exception_types: [ Exception ])
    result = worker.run do
      handle = environment.client.start_workflow(Workflows::AcRemoteOperationWorkflowV2,
        { company_id: 1, task_id: 2, execution_id: 3, environment_id: 4, operation_id: "cancel-op",
          epoch: "1", manager_identity: "manager", manager_epoch: 5, command: "true", working_directory: "/lab" },
        id: "ac-remote-cancel-#{SecureRandom.uuid}", task_queue: AcRemoteV2TestActivities::QUEUE, execution_timeout: 30)
      Timeout.timeout(10) { started.pop }
      handle.signal("cancel_operation", "operator")
      release << true
      handle.result
    end
    assert_equal "completed", result["status"]
    assert result["cancel_requested"]
    assert_equal 1, state.calls.count { |name, _| name == "cancel" }
    assert_equal 3, state.calls.count { |name, _| name == "query" }
  ensure
    release << true if release
    environment&.shutdown
  end

  test "a cancellation queued before the worker starts persists cleanup without dispatch" do
    state = AcRemoteV2TestActivities::State.new(cancel_state: "cancelled")
    environment = Temporalio::Testing::WorkflowEnvironment.start_time_skipping(data_converter: TemporalService.data_converter,
      test_server_download_dest_dir: ENV["TEMPORAL_TEST_SERVER_DIR"].presence)
    handle = environment.client.start_workflow(Workflows::AcRemoteOperationWorkflowV2,
      { company_id: 1, task_id: 2, execution_id: 3, environment_id: 4, operation_id: "queued-cancel-op",
        epoch: "1", manager_identity: "manager", manager_epoch: 5, command: "true", working_directory: "/lab" },
      id: "ac-remote-queued-cancel-#{SecureRandom.uuid}", task_queue: AcRemoteV2TestActivities::QUEUE, execution_timeout: 30)
    handle.signal("cancel_operation", "queued operator")
    worker = Temporalio::Worker.new(client: environment.client, task_queue: AcRemoteV2TestActivities::QUEUE,
      workflows: [ Workflows::AcRemoteOperationWorkflowV2 ],
      activities: [ AcRemoteV2TestActivities::Dispatch.new(state), AcRemoteV2TestActivities::Query.new(state),
        AcRemoteV2TestActivities::Cancel.new(state) ], workflow_failure_exception_types: [ Exception ])
    result = worker.run { handle.result }
    assert_equal "cancelled", result["status"]
    assert result["cancel_requested"]
    assert_equal [ "cancel" ], state.calls.map(&:first)
    assert_equal "queued operator", state.calls.first.last["reason"]
  ensure
    environment&.shutdown
  end
end
