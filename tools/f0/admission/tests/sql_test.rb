# frozen_string_literal: true

require "minitest/test"
require "mocha/minitest"

class AdmissionSQLTest < Minitest::Test
  def setup
    c = ActiveRecord::Base.connection
    raise "Wrong schema" unless c.select_value("SELECT current_schema()") == AdmissionLab::SCHEMA
    tables = c.tables.map { |table| "#{AdmissionLab::SCHEMA}.#{table}" }
    # All tables in this isolated schema are truncated together, satisfying
    # their foreign keys without cascading into tables outside the lab.
    c.truncate_tables(*tables)
    tables.each { |table| c.reset_pk_sequence!(table) }
    SessionAdmissionPolicy.current
    @company = Company.create!
    @project = Project.create!(company_id: @company.id)
  end

  def admission(grant: true)
    session = TerminalSession.create!(user_id: 1, project_id: @project.id)
    row = SessionAdmissionService.enqueue!(session)
    SessionAdmissionService.drain! if grant
    row.reload
  end

  def allow_preflight
    SessionService.stubs(:revalidate_admission!).returns(true)
  end

  def closed_transport
    TemporalService.stubs(:enabled?).returns(true)
    handle = mock("closed Temporal execution")
    handle.stubs(:describe).returns(OpenStruct.new(status: Temporalio::Client::WorkflowExecutionStatus::COMPLETED))
    client = mock("Temporal client boundary")
    client.stubs(:workflow_handle).returns(handle)
    TemporalService.stubs(:client).returns(client)
  end

  def cleanup_transport(present: false)
    runtime = mock("runtime observation boundary")
    runtime.stubs(:session_absent?).with("lab-runtime").returns(!present)
    runtime.stubs(:cleanup_session).with("lab-runtime")
    ContainerRuntime.stubs(:build).returns(runtime)
    runtime
  end

  def cleanup(row)
    Activities::Container::AdmittedPhaseActivity.new.run(TemporalInput.wrap(phase: "cleanup", admission_id: row.id))
  end

  def test_capacity_boundary_refuses_nonisolated_agent_control_tables
    session = TerminalSession.create!(user_id: 1, project_id: @project.id)
    assert AcLocalCapacityAuthorityService.permit_legacy_session?(session)
    assert_equal({}, AcCapacityGrant.active_or_granted.joins(:ac_task).group("ac_tasks.project_id").sum(:quantity))
    assert_equal 0, AcCapacityGrant.active_or_granted.joins(:ac_task).where(ac_tasks: { project_id: @project.id.to_s }).sum(:quantity)
    assert_raises(ArgumentError) { AcCapacityGrant.active_or_granted.joins(:other) }
    assert_raises(ArgumentError) { AcCapacityGrant.active_or_granted.joins(:ac_task).where(ac_tasks: { project_id: "0" }) }
    ActiveRecord::Base.connection.execute("CREATE TABLE ac_capacity_grants (id bigint)")
    assert_raises(RuntimeError) { AcLocalCapacityAuthorityService.permit_legacy_session?(session) }
    assert_raises(RuntimeError) { AcCapacityGrant.active_or_granted.joins(:ac_task).group("ac_tasks.project_id").sum(:quantity) }
    assert_raises(RuntimeError) { AcCapacityGrant.active_or_granted.joins(:ac_task).where(ac_tasks: { project_id: @project.id.to_s }).sum(:quantity) }
  ensure
    ActiveRecord::Base.connection.execute("DROP TABLE IF EXISTS ac_capacity_grants")
  end

  def test_competing_postgresql_connections_grant_only_two_fifo_permits
    rows = 6.times.map { admission(grant: false) }
    gate = Queue.new
    ready = Queue.new
    threads = 3.times.map do
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do |c|
          pid = c.select_value("SELECT pg_backend_pid()")
          ready << pid
          gate.pop
          [ pid, SessionAdmissionService.drain! ]
        end
      end
    end
    Timeout.timeout(15) { 3.times { ready.pop } }
    3.times { gate << true }
    results = threads.map(&:value) # propagates thread failures
    assert_equal 3, results.map(&:first).uniq.size, "independent PostgreSQL sessions required"
    assert_equal rows.first(2).map(&:id), results.flat_map(&:last).sort
    assert_equal 2, SessionAdmission.occupied.count
    assert_equal 4, SessionAdmission.where(admitted_at: nil).count
    tokens = SessionAdmission.occupied.pluck(:permit_token)
    assert tokens.all?(&:present?)
    assert_equal 2, tokens.uniq.size
  ensure
    3.times { gate << true } if gate
    threads&.each(&:join)
  end

  def test_operation_retry_keeps_permit_and_unique_sql_ledger_row
    row = admission
    token = row.permit_token
    op = SessionAdmissionService.begin_operation!(row.id, token, "create_container")
    op.update!(state: "uncertain")
    replay = SessionAdmissionService.begin_operation!(row.id, token, "create_container")
    assert_equal op.id, replay.id
    assert_equal "in_flight", replay.reload.state
    replay.update!(state: "completed", result: { "container_id" => "lab-runtime" })
    again = SessionAdmissionService.begin_operation!(row.id, token, "create_container")
    assert_equal op.id, again.id
    assert_equal({ "container_id" => "lab-runtime" }, again.result)
    assert_equal token, row.reload.permit_token
    assert_equal 1, row.session_runtime_operations.count
    assert_raises(ActiveRecord::RecordNotUnique) do
      row.session_runtime_operations.create!(phase: "create_container")
    end
    assert_raises(SessionAdmissionService::StalePermit) do
      SessionAdmissionService.begin_operation!(row.id, "wrong-lab-permit", "start_container")
    end
  end

  def test_uncertain_exec_is_not_repeated
    row = admission
    op = SessionAdmissionService.begin_operation!(row.id, row.permit_token, "exec")
    op.update!(state: "uncertain")
    assert_raises(SessionAdmissionService::UncertainOperation) do
      SessionAdmissionService.begin_operation!(row.id, row.permit_token, "exec")
    end
    assert_equal "uncertain", op.reload.state
    assert_equal 1, row.session_runtime_operations.count
    assert_equal 0, row.session_runtime_operations.pinning.count
  end

  def test_healthy_claim_is_preserved_by_relay_and_reconciler
    row = admission
    row.update!(launch_state: "claimed", claimed_at: Time.current, claim_token: "healthy", launch_attempts: 1)
    TemporalService.expects(:start_workflow).never
    TemporalService.expects(:client).never
    ContainerRuntime.expects(:build).never
    SessionLaunchRelay.dispatch(row)
    SessionAdmissionReconciler.run
    assert_nil row.reload.released_at
    assert_equal "healthy", row.claim_token
    assert_equal 1, row.launch_attempts
    assert_nil row.stop_requested_at
  end

  def test_expired_claim_is_reclaimed_and_acknowledged
    row = admission
    token = row.permit_token
    row.update!(launch_state: "claimed", claimed_at: 5.minutes.ago, claim_token: "expired", launch_attempts: 1)
    allow_preflight
    TemporalService.expects(:start_workflow).with(
      TemporalWorkflowRegistry.container_workflow_v2,
      { session_id: row.terminal_session_id, admission_id: row.id, permit_token: token, manifest: { lab: true } },
      id: row.terminal_session.workflow_id, execution_timeout: TerminalSession::WORKFLOW_TIMEOUT, reject_duplicate: true
    ).returns(ok: true, run_id: "lab-run")
    SessionLaunchRelay.dispatch(row)
    assert_equal "acknowledged", row.reload.launch_state
    refute_equal "expired", row.claim_token
    assert_equal 2, row.launch_attempts
    assert_equal token, row.permit_token
    assert_equal "lab-run", row.terminal_session.reload.temporal_run_id
  end

  def test_lost_start_ack_retries_same_identity_after_lease_only
    row = admission
    token = row.permit_token
    allow_preflight
    expected = [ TemporalWorkflowRegistry.container_workflow_v2,
      { session_id: row.terminal_session_id, admission_id: row.id, permit_token: token, manifest: { lab: true } } ]
    options = { id: row.terminal_session.workflow_id, execution_timeout: TerminalSession::WORKFLOW_TIMEOUT, reject_duplicate: true }
    sequence = sequence("lost receipt then redelivery")
    # Simulates a server accepting start followed by a lost response. This mock
    # proves retry inputs/SQL state ONLY, never server-side deduplication.
    TemporalService.expects(:start_workflow).with(*expected, **options).in_sequence(sequence).raises(IOError, "lab lost start receipt")
    TemporalService.expects(:start_workflow).with(*expected, **options).in_sequence(sequence).returns(ok: true, run_id: "same-lab-run")
    SessionLaunchRelay.dispatch(row)
    assert_equal "claimed", row.reload.launch_state
    assert_match(/lost start receipt/, row.last_error)
    assert_nil row.terminal_session.reload.temporal_run_id
    SessionLaunchRelay.dispatch(row) # no transport call while lease is healthy
    assert_equal 1, row.reload.launch_attempts
    row.update!(claimed_at: 5.minutes.ago)
    # A reconstructed relay reads the durable queue row, not the prior object.
    ActiveRecord::Base.connection_pool.with_connection do
      SessionLaunchRelay.dispatch(SessionAdmission.find(row.id))
    end
    assert_equal "acknowledged", row.reload.launch_state
    assert_equal 2, row.launch_attempts
    assert_equal token, row.permit_token
    assert_equal "same-lab-run", row.terminal_session.reload.temporal_run_id
    assert_equal 1, SessionAdmission.count
  end

  def test_uncertain_creation_retains_reservation_until_continuous_absence
    row = admission
    row.update!(launch_state: "acknowledged", runtime_id: "lab-runtime", phase_state: { cleanup_collected: true })
    op = row.session_runtime_operations.create!(phase: "create_container", state: "uncertain")
    SessionAdmissionService.cancel!(row.terminal_session)
    assert row.reload.stop_requested_at
    assert_nil row.released_at
    assert_raises(SessionAdmissionService::UncertainOperation) { SessionAdmissionService.release!(row) }
    cleanup_transport
    cleanup(row)
    assert_nil row.reload.released_at
    assert op.reload.absent_since
    assert_equal "uncertain", op.state
    # Simulate a prior observation window without sleeping five minutes.
    op.update!(absent_since: 10.minutes.ago)
    cleanup_transport(present: true)
    cleanup(row)
    assert_nil op.reload.absent_since, "reappearance must reset continuous absence"
    assert_nil row.reload.released_at
    cleanup_transport
    cleanup(row)
    assert op.reload.absent_since
    assert_nil row.reload.released_at
    op.update!(absent_since: 10.minutes.ago)
    cleanup(row)
    assert row.reload.released_at
    assert_equal "closed", row.launch_state
    assert_equal SessionRuntimeOperation::ABANDONED, op.reload.state
    assert_match(/No workload existed/, op.error)
  end

  def test_expired_stopped_claim_reconciles_but_unknown_transport_does_not_release
    row = admission
    row.update!(launch_state: "claimed", claimed_at: 5.minutes.ago, stop_requested_at: Time.current)
    TemporalService.stubs(:enabled?).returns(true)
    client = mock("unreachable client")
    client.stubs(:workflow_handle).raises(IOError, "lab transport unavailable")
    TemporalService.stubs(:client).returns(client)
    ContainerRuntime.expects(:build).never
    SessionAdmissionReconciler.run
    assert_nil row.reload.released_at
    assert_match(/transport unavailable/, row.last_error)
  end

  def test_closed_execution_strands_creation_and_stopped_claim_can_be_cleaned
    row = admission
    row.update!(launch_state: "claimed", claimed_at: 5.minutes.ago, stop_requested_at: Time.current,
      runtime_id: "lab-runtime", phase_state: { cleanup_collected: true })
    op = row.session_runtime_operations.create!(phase: "create_container")
    closed_transport
    cleanup_transport
    SessionAdmissionReconciler.run
    assert_equal "uncertain", op.reload.state
    assert op.absent_since
    assert_nil row.reload.released_at
    op.update!(absent_since: 10.minutes.ago)
    SessionAdmissionReconciler.run
    assert row.reload.released_at
    assert_equal "abandoned", op.reload.state
  end
end
