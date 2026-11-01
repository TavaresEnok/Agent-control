# frozen_string_literal: true

require "test_helper"

module AcV2ContractFixtures
  QUEUE = "ac-v2-contract"
  class State
    attr_reader :calls, :mutex, :condition
    attr_accessor :cancelled, :programmers, :advance_count
    def initialize
      @calls = []
      @mutex = Mutex.new
      @condition = ConditionVariable.new
      @programmers = @advance_count = 0
    end
  end

  class Admit < Temporalio::Activity::Definition
    activity_name "ac_admit_task_activity"
    def initialize(state, parallel: false)
      super()
      @state, @parallel = state, parallel
    end
    def execute(input)
      return { "cancelled" => true } if @state.cancelled
      @state.mutex.synchronize do
        @state.calls << [ "admit", input.fetch("task_id"), input.fetch("role") ]
        @state.programmers += 1
        @state.condition.broadcast
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5
        while @parallel && @state.programmers < 2
          raise "Independent children did not run concurrently" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
          @state.condition.wait(@state.mutex, 0.05)
        end
      end
      { "execution_id" => input.fetch("task_id"), "state" => "granted", "reused" => false }
    end
  end

  class Acquire < Temporalio::Activity::Definition
    activity_name "ac_acquire_worktree_activity"
    def execute(_input)
      { "worktree_path" => "/isolated/test" }
    end
  end

  class Dispatch < Temporalio::Activity::Definition
    activity_name "ac_dispatch_execution_activity"
    def execute(_input)
      { "process_handle" => "trusted-test-runtime" }
    end
  end

  class Reconcile < Temporalio::Activity::Definition
    activity_name "ac_reconcile_execution_activity"
    def execute(_input)
      { "state" => "failed", "exit_code" => 17 }
    end
  end

  class Release < Temporalio::Activity::Definition
    activity_name "ac_release_capacity_activity"
    def initialize(state)
      super()
      @state = state
    end
    def execute(input)
      @state.mutex.synchronize { @state.calls << [ "release", input.fetch("execution_id") ] }
      { "grant_released" => true }
    end
  end

  class Advance < Temporalio::Activity::Definition
    activity_name "ac_advance_plan_dag_activity"
    def initialize(state)
      super()
      @state = state
    end
    def execute(_input)
      @state.advance_count += 1
      details = [ 1, 2 ].map { |id| { "id" => id, "attempt_count" => 0, "phase_generations" => {}, "state" => "pending" } }
      { "ready_task_details" => details, "all_completed" => @state.advance_count > 1 }
    end
  end
end

class AcV2ExecutionContractTest < ActiveSupport::TestCase
  include TemporalWorkflowHelper

  setup do
    @state = AcV2ContractFixtures::State.new
    @old_refs = [ Workflows::AcTaskExecutionWorkflowV2._preloaded_activities, Workflows::AcPlanExecutionWorkflowV2._preloaded_activities ]
    proxy = Object.new
    %w[admit_task acquire_worktree dispatch_execution reconcile_execution release_capacity advance_plan_dag cancel_execution cancel_plan review_task integrate_task].each do |name|
      activity = "ac_#{name}_activity"
      proxy.define_singleton_method(activity) { TemporalWorkflowHelper::ActivityRef.new(activity, AcV2ContractFixtures::QUEUE) }
    end
    Workflows::AcTaskExecutionWorkflowV2.instance_variable_set(:@_preloaded_activities, proxy)
    Workflows::AcPlanExecutionWorkflowV2.instance_variable_set(:@_preloaded_activities, proxy)
  end

  teardown do
    Workflows::AcTaskExecutionWorkflowV2.instance_variable_set(:@_preloaded_activities, @old_refs[0])
    Workflows::AcPlanExecutionWorkflowV2.instance_variable_set(:@_preloaded_activities, @old_refs[1])
  end

  test "workflow uses observed failure instead of an input exit zero" do
    result = run_workflow(Workflows::AcTaskExecutionWorkflowV2,
      { task_id: 1, operation_id: "contract-1", role: "programmer", exit_code: 0 },
      activities: task_activities, task_queue: AcV2ContractFixtures::QUEUE)
    assert_equal "failed", result["status"]
    assert_equal 17, result["exit_code"]
    assert_includes @state.calls, [ "release", 1 ]
  end

  test "cancelled task admission exits without dispatch or capacity release" do
    @state.cancelled = true
    result = run_workflow(Workflows::AcTaskExecutionWorkflowV2,
      { task_id: 1, operation_id: "contract-cancel", role: "programmer" },
      activities: task_activities, task_queue: AcV2ContractFixtures::QUEUE)
    assert_equal "cancelled", result["status"]
    assert_empty @state.calls
  end

  test "plan starts two independent child workflows concurrently" do
    env = Temporalio::Testing::WorkflowEnvironment.start_local(data_converter: TemporalService.data_converter,
      dev_server_existing_path: ENV["TEMPORAL_TEST_DEV_SERVER_PATH"].presence)
    worker = Temporalio::Worker.new(client: env.client, task_queue: AcV2ContractFixtures::QUEUE,
      workflows: [ Workflows::AcPlanExecutionWorkflowV2, Workflows::AcTaskExecutionWorkflowV2 ],
      activities: task_activities(parallel: true) + [ AcV2ContractFixtures::Advance.new(@state) ],
      workflow_failure_exception_types: [ Exception ])
    result = worker.run do
      env.client.execute_workflow(Workflows::AcPlanExecutionWorkflowV2, { plan_id: 1 },
        id: "ac-v2-#{SecureRandom.uuid}", task_queue: AcV2ContractFixtures::QUEUE, execution_timeout: 30)
    end
    assert_equal "completed", result["status"]
    assert_equal 2, @state.programmers
    assert_includes @state.calls, [ "release", 1 ]
    assert_includes @state.calls, [ "release", 2 ]
  ensure
    env&.shutdown
  end

  private

  def task_activities(parallel: false)
    [ AcV2ContractFixtures::Admit.new(@state, parallel: parallel), AcV2ContractFixtures::Acquire.new,
      AcV2ContractFixtures::Dispatch.new, AcV2ContractFixtures::Reconcile.new, AcV2ContractFixtures::Release.new(@state) ]
  end
end
