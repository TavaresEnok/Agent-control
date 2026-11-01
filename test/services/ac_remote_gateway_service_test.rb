# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "base64"
require "digest"

class AcRemoteGatewayServiceTest < ActiveSupport::TestCase
  include AcTemporalFixture

  class RecordingRunner
    attr_reader :commands

    def initialize
      @commands = []
    end

    def execute(_transport, command)
      @commands << command
      raise "remote execution was not authorized"
    end
  end

  setup do
    setup_ac_temporal_fixture
    @previous_remote_supervisor = Rails.application.config.try(:ac_remote_supervisor)
    Rails.application.config.ac_remote_supervisor = nil
    @dir = Dir.mktmpdir("ac-ssh-fixture-")
    identity = File.join(@dir, "identity")
    known_hosts = File.join(@dir, "known_hosts")
    File.write(identity, "synthetic key fixture")
    blob = Base64.strict_encode64("synthetic public key fixture")
    File.write(known_hosts, "f0-lab-pinned ssh-ed25519 #{blob}\n")
    fingerprint = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(blob))).delete_suffix('=')}"
    @environment = AcRemoteEnvironment.create!(company: @company, project: @project, name: "Test environment",
      environment_slug: "test-target", host: "127.0.0.1", port: 22, user: "worker", fingerprint: fingerprint,
      identity_key_path: identity, known_hosts_path: known_hosts, authorized_directories: [ "/srv/project" ], state: "active")
    @runner = RecordingRunner.new
  end

  teardown do
    Rails.application.config.ac_remote_supervisor = @previous_remote_supervisor
    teardown_ac_temporal_fixture
    FileUtils.remove_entry(@dir) if @dir && Dir.exist?(@dir)
  end

  test "transport pins a host key and does not inherit agent credentials" do
    transport = @environment.build_transport(lab_opt_in: true)
    assert_equal({ "PATH" => "/usr/bin:/bin", "HOME" => "/nonexistent", "LANG" => "C" }, transport.environment)
    assert_equal({ unsetenv_others: true }, transport.spawn_options)
    assert_raises(ArgumentError) { transport.validate_job_env!("OPENAI_API_KEY" => "synthetic") }
    File.write(@environment.known_hosts_path, "f0-lab-pinned ssh-ed25519 #{Base64.strict_encode64('other fixture')}\n")
    assert_raises(ArgumentError) { transport.argv("true") }
  end

  test "no remote operation is dispatched without an authorized execution" do
    assert_no_difference "AcRemoteOperation.count" do
      assert_raises(AcRemoteGatewayService::UnprovableRemoteStateError) { dispatch }
    end
    assert_empty @runner.commands
  end

  test "valid admission is insufficient without a durable remote supervisor" do
    execution = admit_ac_execution
    assert_no_difference "AcRemoteOperation.count" do
      assert_raises(AcRemoteGatewayService::UnprovableRemoteStateError) { dispatch(execution: execution) }
    end
    assert_empty @runner.commands
  end

  test "an incomplete remote adapter is refused before its dispatch method runs" do
    execution = admit_ac_execution
    incomplete = Class.new do
      attr_reader :called
      def dispatch_operation!(**)
        @called = true
      end
    end.new
    Rails.application.config.ac_remote_supervisor = incomplete
    assert_raises(AcRemoteGatewayService::UnprovableRemoteStateError) { dispatch(execution: execution) }
    assert_not incomplete.called
    assert_empty @runner.commands
  end

  test "an unverifiable or misbound status receipt leaves the operation uncertain" do
    execution = admit_ac_execution
    operation = AcRemoteOperation.create!(company: @company, project: @project, ac_remote_environment: @environment,
      ac_task: @task, ac_execution: execution, operation_id: SecureRandom.uuid,
      command: "true", working_directory: "/srv/project", state: "running", remote_job_id: "fixture",
      metadata: { "execution_epoch" => execution.epoch })
    supervisor = FakeAcRemoteSupervisor.new
    supervisor.receipt = { "operation_id" => operation.operation_id, "company_id" => @company.id,
      "environment_id" => @environment.id, "task_id" => @task.id, "execution_id" => execution.id,
      "epoch" => execution.epoch, "state" => "completed", "remote_job_id" => "fixture", "exit_code" => 0 }
    Rails.application.config.ac_remote_supervisor = supervisor
    result = AcRemoteGatewayService.query_operation_status!(operation: operation)
    assert_equal "uncertain", operation.reload.state
    assert result[:result][:uncertain]
    supervisor.verified = true
    supervisor.receipt["execution_id"] = execution.id + 1
    AcRemoteGatewayService.query_operation_status!(operation: operation)
    assert_equal "uncertain", operation.reload.state
    assert_nil operation.exit_code
  end

  test "the committed intent is revalidated under the fence before the remote call" do
    execution = admit_ac_execution
    AcAdmissionService.validate_execution_authority!(execution_id: execution.id,
      operation_id: execution.operation_id, reported_epoch: execution.epoch)
    operation = AcRemoteOperation.create!(company: @company, project: @project, ac_remote_environment: @environment,
      ac_task: @task, ac_execution: execution, operation_id: SecureRandom.uuid, command: "true",
      working_directory: "/srv/project", state: "pending", metadata: { "execution_epoch" => execution.epoch })
    execution.ac_capacity_grant.update!(expires_at: 1.minute.ago)
    supervisor = FakeAcRemoteSupervisor.new
    called = false
    assert_raises(AcAdmissionService::UnauthorizedExecutionBypassError) do
      AcRemoteGatewayService.send(:dispatch_under_fence!, operation: operation, environment: @environment,
        task: @task, execution: execution, supervisor: supervisor, metadata: {}, runner: @runner) { called = true }
    end
    assert_not called
    assert_equal 0, supervisor.dispatch_calls
    assert_empty @runner.commands
  end

  test "later unverified observations do not downgrade a verified terminal result" do
    execution = admit_ac_execution
    operation = AcRemoteOperation.create!(company: @company, project: @project, ac_remote_environment: @environment,
      ac_task: @task, ac_execution: execution, operation_id: SecureRandom.uuid,
      command: "true", working_directory: "/srv/project", state: "running", remote_job_id: "fixture",
      metadata: { "execution_epoch" => execution.epoch })
    supervisor = FakeAcRemoteSupervisor.new
    supervisor.receipt = { "operation_id" => operation.operation_id, "company_id" => @company.id,
      "environment_id" => @environment.id, "task_id" => @task.id, "execution_id" => execution.id,
      "epoch" => execution.epoch, "state" => "completed", "remote_job_id" => "fixture", "exit_code" => 0 }
    supervisor.verified = true
    Rails.application.config.ac_remote_supervisor = supervisor
    AcRemoteGatewayService.query_operation_status!(operation: operation)
    assert_equal "completed", operation.reload.state
    assert_equal 0, operation.exit_code
    finished_at = operation.finished_at

    supervisor.receipt["state"] = "failed"
    supervisor.receipt["exit_code"] = 1
    AcRemoteGatewayService.query_operation_status!(operation: operation)
    assert_equal "completed", operation.reload.state
    assert_equal 0, operation.exit_code
    assert_equal finished_at, operation.finished_at
    assert operation.metadata["last_observation_error"].present?

    Rails.application.config.ac_remote_supervisor = nil
    AcRemoteGatewayService.query_operation_status!(operation: operation)
    assert_equal "completed", operation.reload.state
    assert_equal 0, operation.exit_code
  end

  test "expired grant or a path outside the allowed directory cannot dispatch" do
    execution = admit_ac_execution
    [ "/etc", "/srv/project/../../etc", "/srv/project-other" ].each do |directory|
      assert_raises(AcRemoteGatewayService::UnauthorizedRemoteDirectoryError) do
        dispatch(execution: execution, working_directory: directory)
      end
    end
    execution.ac_capacity_grant.update!(expires_at: 1.minute.ago)
    assert_raises(AcAdmissionService::UnauthorizedExecutionBypassError) { dispatch(execution: execution) }
    assert_empty @runner.commands
  end

  test "a missing supervisor leaves an existing operation uncertain" do
    execution = admit_ac_execution
    operation = AcRemoteOperation.create!(company: @company, project: @project, ac_remote_environment: @environment,
      ac_task: @task, ac_execution: execution, operation_id: SecureRandom.uuid,
      command: "true", working_directory: "/srv/project", state: "running", remote_job_id: "fixture")
    result = AcRemoteGatewayService.query_operation_status!(operation: operation, runner: @runner)
    assert_equal "uncertain", operation.reload.state
    assert result[:result][:uncertain]
    assert_not result[:running]
    assert_empty @runner.commands
  end

  private

  def dispatch(execution: nil, working_directory: "/srv/project")
    AcRemoteGatewayService.dispatch_operation!(environment: @environment, operation_id: SecureRandom.uuid,
      command: "true", working_directory: working_directory, task: execution && @task,
      execution: execution, runner: @runner)
  end
end
