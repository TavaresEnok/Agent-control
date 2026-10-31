# frozen_string_literal: true

# Uses the SDK's actual handle, without Rails boot, server, or credentials.
# The client double accepts only start_workflow; any extra RPC fails the test.
require_relative "../../../tools/f0/temporal/boot"

def assert(value, message)
  raise message unless value
end

class ReceiptClient
  attr_reader :calls
  attr_accessor :response

  def initialize(response)
    @response = response
    @calls = []
  end

  def start_workflow(*args, **options)
    @calls << [args, options]
    raise @response if @response.is_a?(Exception)

    @response
  end
end

id = "g0-receipt-unit"
run = "2484f7d6-2dbb-46e2-842c-7eb2186c783f"
handle = Temporalio::Client::WorkflowHandle.new(
  client: Object.new, id: id, run_id: nil, result_run_id: run,
  first_execution_run_id: run, result_hint: nil
)
client = ReceiptClient.new(handle)
workflow = OpenStruct.new(name: "ReceiptWorkflow", owner: "g0-receipt-unit")
input = { "fixture" => true }
original_connection = TemporalService.instance_variable_get(:@connection)

begin
  TemporalService.connection = ->(&block) { block.call(client) }
  receipt = TemporalService.start_workflow(workflow, input, id: id, execution_timeout: 30)
  assert(receipt == { ok: true, workflow_id: id, run_id: run, handle: handle }, "wrong start receipt")
  assert(handle.run_id.nil? && handle.first_execution_run_id == run, "SDK start handle changed")
  assert(receipt[:handle].equal?(handle), "SDK handle replaced")
  assert(client.calls == [[[workflow.name, input], { id: id, task_queue: workflow.owner,
    execution_timeout: 30 }]], "default start options or RPC count changed")

  receipt = TemporalService.start_workflow(workflow, input, id: id, reject_duplicate: true)
  assert(receipt[:run_id] == run, "reject-duplicate start lost receipt")
  assert(client.calls.last == [[workflow.name, input], { id: id, task_queue: workflow.owner,
    id_reuse_policy: Temporalio::WorkflowIDReusePolicy::REJECT_DUPLICATE }], "reuse policy changed")

  client.response = Temporalio::Error::WorkflowAlreadyStartedError.new(
    workflow_id: id, workflow_type: workflow.name, run_id: run
  )
  duplicate = TemporalService.start_workflow(workflow, input, id: id, reject_duplicate: true)
  assert(duplicate == { ok: true, workflow_id: id, run_id: run }, "duplicate identity changed")
  rejected = TemporalService.start_workflow(workflow, input, id: id)
  assert(rejected == { ok: false, error: client.response.message }, "default duplicate error changed")

  client.response = Temporalio::Error.new("receipt unit connection failure")
  failed = TemporalService.start_workflow(workflow, input, id: id)
  assert(failed == { ok: false, error: client.response.message,
    error_class: "Temporalio::Error" }, "Temporal error contract changed")

  calls = client.calls.size
  begin
    TemporalService.start_workflow(workflow, input)
    raise "missing explicit ID accepted"
  rescue ArgumentError => e
    assert(e.message == "a workflow start needs an explicit id:", "unexpected ID error")
  end
  assert(client.calls.size == calls, "missing ID reached client")

  TemporalService.connection = ->(&_block) { nil }
  assert(TemporalService.start_workflow(workflow, input, id: id) == {
    ok: false, error: "Temporal is disabled"
  }, "disabled contract changed")
ensure
  TemporalService.connection = original_connection
end

puts "PASS: SDK handle start receipt unit assertions only; real Temporal NOT exercised"
