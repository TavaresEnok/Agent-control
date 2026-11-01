# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "base64"
require "digest"

module Workflows
  class AcRemoteOperationWorkflowTest < ActiveSupport::TestCase
    TASK_QUEUE = "ac-remote-operation-test"

    setup do
      @company = create(:company)
      @user = create(:user, company: @company)
      @project = create(:project, company: @company, owner: @user)

      @dir = Dir.mktmpdir("ac_remote_wf_test")
      @identity_path = File.join(@dir, "id_ed25519")
      @known_hosts_path = File.join(@dir, "known_hosts")
      File.write(@identity_path, "synthetic private key")

      key_blob = Base64.strict_encode64("synthetic-ed25519-public-key")
      File.write(@known_hosts_path, "f0-lab-pinned ssh-ed25519 #{key_blob}\n")
      @fingerprint = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(key_blob))).delete_suffix('=')}"

      @environment = AcRemoteEnvironment.create!(
        company: @company,
        project: @project,
        name: "Remote Target Temporal",
        environment_slug: "remote-target-temporal",
        host: "127.0.0.1",
        port: 22,
        user: "deploy",
        fingerprint: @fingerprint,
        identity_key_path: @identity_path,
        known_hosts_path: @known_hosts_path,
        authorized_directories: ["/home/enok/Documentos/projetos/nexoisp"],
        state: "active"
      )

      proxy = Object.new
      proxy.define_singleton_method(:ac_dispatch_remote_operation_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_dispatch_remote_operation_activity", TASK_QUEUE)
      end
      proxy.define_singleton_method(:ac_query_remote_operation_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_query_remote_operation_activity", TASK_QUEUE)
      end
      proxy.define_singleton_method(:ac_reconcile_remote_operation_activity) do
        TemporalWorkflowHelper::ActivityRef.new("ac_reconcile_remote_operation_activity", TASK_QUEUE)
      end

      AcRemoteOperationWorkflow.stubs(:_preloaded_activities).returns(proxy)

      @registered_activities = [
        Activities::AgentControl::AcDispatchRemoteOperationActivity.new,
        Activities::AgentControl::AcQueryRemoteOperationActivity.new,
        Activities::AgentControl::AcReconcileRemoteOperationActivity.new
      ]
    end

    teardown do
      FileUtils.remove_entry(@dir) if @dir && Dir.exist?(@dir)
    end

    test "executes AcRemoteOperationWorkflow end-to-end on success" do
      op_id = "op-wf-success-#{SecureRandom.hex(4)}"

      # Mock runner do gateway para simular retorno bem-sucedido
      mock_runner = Class.new do
        def execute(_transport, _cmd)
          { stdout: "Tests passed\n", stderr: "", exit_code: 0, success: true }
        end
      end.new

      AcRemoteGatewayService::DefaultRunner.stubs(:new).returns(mock_runner)

      result = run_workflow(
        AcRemoteOperationWorkflow,
        {
          environment_id: @environment.id,
          operation_id: op_id,
          command: "bundle exec rake test",
          working_directory: "/home/enok/Documentos/projetos/nexoisp",
          artifact_hash: "hash-wf-1"
        },
        activities: @registered_activities,
        task_queue: TASK_QUEUE
      )

      assert_equal "completed", result["status"]
      assert_equal op_id, result["operation_id"]
      assert_equal 0, result["exit_code"]

      op = AcRemoteOperation.find_by!(operation_id: op_id)
      assert_equal "completed", op.state
    end

    test "AcRemoteOperationWorkflow halts in uncertain state when remote state is unprovable (§14.3)" do
      op_id = "op-wf-uncertain-#{SecureRandom.hex(4)}"

      # Mock runner que falha no despacho e falha na verificação de status
      mock_runner = Class.new do
        def execute(_transport, _cmd)
          raise AcRemoteGatewayService::RemoteTransportError, "SSH network partition"
        end
      end.new

      AcRemoteGatewayService::DefaultRunner.stubs(:new).returns(mock_runner)

      result = run_workflow(
        AcRemoteOperationWorkflow,
        {
          environment_id: @environment.id,
          operation_id: op_id,
          command: "bundle exec rake test",
          working_directory: "/home/enok/Documentos/projetos/nexoisp",
          artifact_hash: "hash-wf-uncertain"
        },
        activities: @registered_activities,
        task_queue: TASK_QUEUE
      )

      assert_equal "uncertain", result["status"]
      assert_equal true, result["uncertain"]

      op = AcRemoteOperation.find_by!(operation_id: op_id)
      assert_equal "uncertain", op.state
    end
  end
end
