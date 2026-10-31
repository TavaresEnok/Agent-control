# frozen_string_literal: true

require_relative "boot"
require "temporalio/testing"
require "digest"
require_relative "launch_evidence"

class G0Integration
  def initialize(cli)
    @cli = File.realpath(cli)
    raise "CLI not executable" unless File.executable?(@cli)
    @id = "g0-#{SecureRandom.hex(16)}"
    @root = File.join(__dir__, "artifacts", @id)
    FileUtils.mkdir_p(@root)
    @namespace = "agent-control-#{@id}"
    @queue = "agent-control-#{@id}"
    @operations = []
    @results = []
    @restarts = 0
  end

  def assert(condition, message)
    raise message unless condition
  end

  def server_start
    @env = Temporalio::Testing::WorkflowEnvironment.start_local(
      namespace: @namespace, ip: "127.0.0.1", ui: false,
      dev_server_existing_path: @cli,
      dev_server_database_filename: File.join(@root, "temporal.sqlite"),
      data_converter: TemporalService.data_converter)
    @client = @env.client
    # Existing Aixle injection seam, with a REAL client and REAL local server.
    TemporalService.connection = ->(&block) { block.call(@client) }
    worker_start
  end

  def worker_start
    allowed = %w[PATH GEM_HOME GEM_PATH BUNDLE_GEMFILE BUNDLE_PATH]
    env = ENV.to_h.select { |key, _| allowed.include?(key) }
    @worker = Process.spawn(env, RbConfig.ruby, File.join(__dir__, "worker.rb"),
      @client.connection.target_host, @namespace, @queue,
      unsetenv_others: true, close_others: true,
      out: [File.join(@root, "worker.log"), "a"], err: [:child, :out])
  end

  def worker_stop(signal = "TERM")
    return unless @worker
    Process.kill(signal, @worker)
    Process.wait(@worker)
  rescue Errno::ESRCH, Errno::ECHILD
    nil
  ensure
    @worker = nil
  end

  def wait_for
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 45
    loop do
      if @worker && (exited = Process.waitpid2(@worker, Process::WNOHANG))
        @worker = nil
        assert(exited.last.exitstatus == 86, "unexpected worker death: #{exited.last}")
        @restarts += 1
        assert(@restarts <= 4, "unexpected repeated crashes")
        worker_start
      end
      value = yield
      return value if value
      raise "assertion deadline expired (see worker.log)" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      sleep 0.1
    end
  end

  def start(operation, scenario)
    definition = Struct.new(:name, :owner).new("g0_probe_workflow", @queue)
    result = TemporalService.start_workflow(definition,
      { "root" => @root, "operation" => operation, "scenario" => scenario },
      id: operation, reject_duplicate: true, execution_timeout: 180)
    assert(result[:ok] && result[:run_id], "real Temporal start failed: #{result.inspect}")
    result
  end

  def history(handle, operation)
    events = handle.fetch_history_events.to_a
    File.write(File.join(@root, "#{operation}-history.json"),
      JSON.pretty_generate(events.map { |event| JSON.parse(event.to_json) }))
    assert(events.any? { |e| e.event_type == :EVENT_TYPE_WORKFLOW_EXECUTION_STARTED }, "missing start history")
  end

  def scenario(name)
    operation = "g0-#{SecureRandom.hex(16)}"
    @operations << operation
    probe = ProcessProbe.new(@root, operation)
    before = @restarts
    first = start(operation, name)
    handle = @client.workflow_handle(operation, run_id: first[:run_id])
    duplicate = start(operation, name)
    assert(first[:run_id] == duplicate[:run_id], "duplicate command created another run")

    if name == "uncertain"
      wait_for { TemporalService.execution_state(operation) == :closed }
      assert(handle.describe.status == Temporalio::Client::WorkflowExecutionStatus::FAILED, "uncertainty must fail workflow")
      assert(probe.observe.nil? && probe.read("handle.json").nil?, "uncertain launch spawned a process")
    else
      saved = wait_for { probe.read("handle.json") }
      wait_for { @restarts > before } unless name == "normal"
      completion = wait_for { LaunchEvidence.completed(handle.fetch_history_events.to_a) }
      LaunchEvidence.verify!(completion, saved, probe, retry_required: name == "after_handle")
      assert(probe.observe == saved, "recovery did not retain exact process")
      if name == "normal"
        # Lose both worker memory and the server process, keeping only SQLite
        # and the externally labeled child. New client and worker replay history.
        worker_stop("KILL")
        @env.shutdown
        @env = nil
        server_start
        handle = @client.workflow_handle(operation, run_id: first[:run_id])
        assert(start(operation, name)[:run_id] == first[:run_id], "server restart lost workflow identity")
        assert(probe.observe == saved, "server restart changed external process")
      end
      assert(TemporalService.cancel_workflow(operation)[:ok], "cancel request failed")
      wait_for { TemporalService.execution_state(operation) == :closed }
      assert(handle.describe.status == Temporalio::Client::WorkflowExecutionStatus::CANCELED, "cancel not acknowledged")
      assert(probe.observe.nil? && probe.read("stopped.json"), "cancel did not reconcile child termination")
      assert(start(operation, name)[:run_id] == first[:run_id], "closed ID reused")
    end
    history(handle, operation)
    assert(@restarts == before + (name == "normal" ? 0 : 1), "fault was not executed exactly once")
    @results << { scenario: name, result: "PASS", workflow_id: operation, run_id: first[:run_id],
      launch_completed_event_id: completion&.event_id,
      launch_retry: probe.read("launch-attempt-2.json") }
  end

  def run
    manifest = { ruby: RUBY_VERSION, sdk: Temporalio::VERSION,
      gems: Gem.loaded_specs.transform_values { |spec| spec.version.to_s },
      cli_version: IO.popen([@cli, "--version"], &:read).strip,
      cli_sha256: Digest::SHA256.file(@cli).hexdigest,
      upstream: JSON.parse(File.read(File.join(ROOT, "UPSTREAM.json"))),
      sources: %w[app/services/temporal_service.rb app/temporal/workflows/base.rb app/temporal/temporal_input.rb].to_h {
        |path| [path, Digest::SHA256.file(File.join(ROOT, path)).hexdigest]
      }, namespace: @namespace, queue: @queue }
    File.write(File.join(@root, "manifest.json"), JSON.pretty_generate(manifest))
    server_start
    %w[normal after_intent after_process after_handle uncertain].each { |name| scenario(name) }
    puts "PASS: real Temporal slice; evidence: #{@root}; G0 remains PENDENTE"
  ensure
    begin
      worker_stop
    ensure
      begin
        @env&.shutdown
      ensure
        begin
          @operations.each { |op| ProcessProbe.new(@root, op).stop }
        ensure
          File.write(File.join(@root, "results.json"), JSON.pretty_generate(
            { status: @results.length == 5 && $!.nil? ? "PASS" : "FAIL",
              scenarios: @results, error: $!&.message, gate: "G0 PENDENTE" }))
        end
      end
    end
  end
end

G0Integration.new(ARGV.fetch(0)).run
