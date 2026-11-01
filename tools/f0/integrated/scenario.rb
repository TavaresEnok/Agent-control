# frozen_string_literal: true

require_relative "boot"
require "temporalio/testing"
require "rbconfig"
require_relative "subprocess_environment"

class IntegratedScenario
  def initialize(root, runtime, cli, cli_hash)
    @root, @runtime, @cli = root, runtime, File.realpath(cli)
    @report = { status: "FAIL", gate: "G0 PENDENTE", scenario: "real relay start / physical death / SQL redelivery",
      boundaries: "synthetic session/registry/authorization/manifest; inert workflow; no runtime cleanup or mobile proof" }
    IntegratedLab.assert!(File.executable?(@cli), "CLI executable required")
    IntegratedLab.assert!(/\A[a-f0-9]{64}\z/.match?(cli_hash) && Digest::SHA256.file(@cli).hexdigest == cli_hash, "CLI hash mismatch")
    version = IO.popen([ @cli, "--version" ], &:read)
    IntegratedLab.assert!($?.success? && /\b1\.9\.1\b/.match?(version), "CLI 1.9.1 required")
    IntegratedLab.assert!(Temporalio::VERSION == "1.10.0", "SDK 1.10.0 required")
    IntegratedLab.assert!(File.realpath(@runtime) == "/lab-runtime" && Dir.empty?(@runtime), "exclusive empty external runtime required")
    @report.merge!(cli_sha256: cli_hash, cli_version: version.strip, ruby: RUBY_VERSION,
      sdk: Temporalio::VERSION, gems: Gem.loaded_specs.transform_values { |s| s.version.to_s })
  end

  def check(value, message) = IntegratedLab.assert!(value, message)

  def wait_for
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 45
    loop do
      if @worker && (status = Process.waitpid2(@worker, Process::WNOHANG))
        @worker = nil
        raise "worker exited unexpectedly: #{status.last}"
      end
      result = yield
      return result if result
      raise "server evidence deadline expired" if Process.clock_gettime(Process::CLOCK_MONOTONIC) >= deadline
      sleep 0.1
    end
  end

  def spawn_ruby(file, *args)
    env = IntegratedSubprocessEnvironment.build
    Process.spawn(env, RbConfig.ruby, File.join(__dir__, file), *args,
      unsetenv_others: true, close_others: true,
      out: [ File.join(@root, "#{file}.log"), "a" ], err: [ :child, :out ])
  end

  def dispatch(mode)
    pid = spawn_ruby("relay_child.rb", AdmissionLab::SCHEMA, @row.id.to_s, mode)
    status = Timeout.timeout(45) { Process.wait2(pid).last }
    check(status.exited? && status.exitstatus == (mode == "die" ? 86 : 0), "relay #{mode} wrong exit: #{status}")
    @report["#{mode}_exit"] = status.exitstatus
  ensure
    if pid
      begin
        Process.kill("KILL", pid)
        Process.wait(pid)
      rescue Errno::ESRCH, Errno::ECHILD
        nil
      end
    end
  end

  def calls
    path = ENV.fetch("F0_INTEGRATED_CALLS")
    File.exist?(path) ? File.readlines(path).map { |line| JSON.parse(line) } : []
  end

  def snapshot(name)
    @row.reload
    IntegratedLab.write(File.join(@root, "sql-#{name}.json"),
      admission: @row.attributes, session: @row.terminal_session.reload.attributes,
      occupied: SessionAdmission.occupied.count,
      ledger: @row.session_runtime_operations.order(:id).map(&:attributes))
  end

  def executions
    @client.list_workflows.to_a # Entire exclusive namespace, including wrong-ID starts.
  end

  def capture_server(name)
    events = @handle.fetch_history_events.to_a
    IntegratedLab.write(File.join(@root, "history-#{name}.json"), events.map { |e| JSON.parse(e.to_json) })
    listed = wait_for { rows = executions; rows unless rows.empty? }
    IntegratedLab.write(File.join(@root, "listing-#{name}.json"), listed.map { |e| { workflow_id: e.id, run_id: e.run_id, status: e.status.to_s } })
    check(listed.size == 1 && listed.first.id == @workflow_id && listed.first.run_id == @run_id, "server must list exactly one execution with original identity")
    starts = events.select { |e| e.event_type == :EVENT_TYPE_WORKFLOW_EXECUTION_STARTED }
    check(starts.size == 1, "exactly one start in server history required")
    check(starts.first.workflow_execution_started_event_attributes.original_execution_run_id == @run_id, "server history original chain mismatch")
    check(starts.first.workflow_execution_started_event_attributes.workflow_type.name == "integrated_idle_workflow", "wrong server workflow type")
    check(events.none? { |e| e.event_type == :EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW }, "unexpected continuation")
    events
  end

  def run
    namespace = "f0-integrated-#{SecureRandom.hex(16)}"
    ENV["F0_INTEGRATED_NAMESPACE"] = namespace
    ENV["F0_INTEGRATED_CALLS"] = File.join(@root, "calls.jsonl")
    @report[:namespace] = namespace
    AdmissionLab.prepare! # PG identity is checked before starting Temporal.
    @report[:postgres_version] = ActiveRecord::Base.connection.select_value("SHOW server_version")
    SessionAdmissionPolicy.current
    @server = Temporalio::Testing::WorkflowEnvironment.start_local(namespace: namespace,
      ip: "127.0.0.1", ui: false, dev_server_existing_path: @cli,
      dev_server_database_filename: File.join(@runtime, "temporal.sqlite"),
      data_converter: TemporalService.data_converter)
    @client = @server.client
    ENV["F0_INTEGRATED_ADDRESS"] = @client.connection.target_host
    # Existing injection seam: real SDK client connected to our own real server.
    TemporalService.connection = ->(&block) { block.call(@client) }
    IntegratedLab.connection! # Validate loopback/namespace before any relay.
    @worker = spawn_ruby("worker.rb")
    company = Company.create!
    project = Project.create!(company_id: company.id)
    session = TerminalSession.create!(user_id: 1, project_id: project.id)
    @row = SessionAdmissionService.enqueue!(session)
    check(SessionAdmissionService.drain! == [ @row.id ], "SQL permit grant required")
    @row.reload
    permit = @row.permit_token
    check(permit.present? && SessionAdmission.occupied.count == 1, "durable permit/occupancy required")
    @workflow_id = session.workflow_id
    snapshot("granted")
    dispatch("die")
    @row.reload
    first_claim = @row.claim_token
    first_claimed_at = @row.claimed_at
    check(@row.launch_state == "claimed" && first_claim.present? && @row.launch_attempts == 1, "death must leave committed claim")
    check(@row.terminal_session.reload.temporal_run_id.nil? && @row.terminal_session.temporal_workflow_id.nil?, "ack must not have committed")
    responses = calls.select { |e| e["event"] == "sdk_response" }
    check(responses.size == 1 && responses.first["run_id"].to_s.match?(/\A[0-9a-f-]{36}\z/), "nonempty SDK runID required")
    @run_id = responses.first.fetch("run_id")
    @report.merge!(workflow_id: @workflow_id, run_id: @run_id)
    @handle = @client.workflow_handle(@workflow_id, run_id: @run_id)
    check(@handle.describe.status == Temporalio::Client::WorkflowExecutionStatus::RUNNING, "server execution missing after physical relay death")
    check(TemporalService.execution_state(@workflow_id) == :running, "real service describe must confirm running execution")
    wait_for { @handle.fetch_history_events.any? { |e| e.event_type == :EVENT_TYPE_WORKFLOW_TASK_COMPLETED } }
    capture_server("after-death")
    snapshot("after-death")
    dispatch("healthy")
    @row.reload
    check(calls.count { |e| e["event"] == "sdk_call" } == 1, "healthy lease sent a second start")
    check(@row.claim_token == first_claim && @row.claimed_at == first_claimed_at && @row.launch_attempts == 1 && @row.launch_state == "claimed", "healthy claim mutated")
    snapshot("healthy")
    # Target ONLY this fixture's claimed_at. No assertion that two real minutes passed.
    c = ActiveRecord::Base.connection
    changed = c.update("UPDATE session_admissions SET claimed_at = CURRENT_TIMESTAMP - INTERVAL '3 minutes' WHERE id = #{Integer(@row.id)} AND claim_token = #{c.quote(first_claim)} AND launch_state = 'claimed'")
    check(changed == 1, "fixture lease expiration did not affect exactly one row")
    snapshot("lease-expired-by-sql")
    dispatch("retry")
    @row.reload
    check(@row.launch_state == "acknowledged" && @row.launch_attempts == 2 && @row.claim_token.present? && @row.claim_token != first_claim, "retry must reclaim and acknowledge")
    check(@row.terminal_session.reload.temporal_run_id == @run_id && @row.terminal_session.temporal_workflow_id == @workflow_id, "SQL ack has different run/workflow ID")
    check(@row.permit_token == permit && SessionAdmission.count == 1 && SessionAdmission.occupied.count == 1 && @row.released_at.nil?, "permit/reservation changed")
    check(@row.session_runtime_operations.count.zero?, "inert workflow must not fabricate runtime ledger operations")
    check(calls.count { |e| e["event"] == "sdk_response" } == 1, "second start was accepted")
    duplicate = calls.select { |e| e["event"] == "sdk_already_started" }
    check(duplicate.size == 1 && duplicate.first["run_id"] == @run_id, "real AlreadyStarted with same runID required")
    starts = calls.select { |e| e["event"] == "sdk_call" }
    check(starts.size == 2 && starts.all? { |e| e["reject_duplicate"] && e["workflow_id"] == @workflow_id }, "REJECT_DUPLICATE/identity not preserved")
    check(calls.count { |e| e["event"] == "death_after_service_response" } == 1, "physical fault missing")
    capture_server("after-retry")
    snapshot("acknowledged")
    check(TemporalService.cancel_workflow(@workflow_id)[:ok], "real cancel failed")
    wait_for { TemporalService.execution_state(@workflow_id) == :closed }
    check(@handle.describe.status == Temporalio::Client::WorkflowExecutionStatus::CANCELED, "server cancel not acknowledged")
    events = capture_server("canceled")
    check(events.any? { |e| e.event_type == :EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED }, "server canceled history missing")
    check(@row.reload.released_at.nil? && @row.session_runtime_operations.count.zero?, "cancel must not pretend runtime cleanup/release")
    snapshot("canceled-no-runtime-cleanup")
    @report[:status] = "PASS"
  ensure
    # All SQL snapshots and server histories above precede schema/server cleanup.
    # Failure also captures whatever real evidence remains, without claiming PASS.
    error = $!
    @report[:error_class] = error.class.name if error
    @report[:error] = error.message if error
    capture_failure = nil
    begin
      snapshot("final") if @row
      if @handle
        IntegratedLab.write(File.join(@root, "history-final.json"), @handle.fetch_history_events.map { |e| JSON.parse(e.to_json) })
      end
    rescue StandardError => e
      capture_failure = e
      @report[:capture_error] = e.class.name
      @report[:status] = "FAIL"
    ensure
      IntegratedLab.write(File.join(@root, "scenario.json"), @report)
    end
    raise capture_failure if capture_failure && !error
  end

  def cleanup
    errors = []
    [ -> { stop_worker }, -> { @server&.shutdown }, -> { AdmissionLab.cleanup! } ].each do |action|
      action.call
    rescue StandardError => e
      errors << e.class.name
    end
    check(errors.empty?, "cleanup failed: #{errors.join(',')}")
  end

  def stop_worker
    return unless @worker
    Process.kill("TERM", @worker)
    Timeout.timeout(10) { Process.wait(@worker) }
  rescue Timeout::Error
    Process.kill("KILL", @worker)
    Process.wait(@worker)
    raise
  rescue Errno::ESRCH, Errno::ECHILD
    nil
  ensure
    @worker = nil
  end
end
