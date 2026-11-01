# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "base64"
require "digest"

module AcRemoteV1TestActivities
  class State
    attr_reader :calls

    def initialize
      @calls = []
    end
  end

  class Dispatch < Temporalio::Activity::Definition
    activity_name "ac_dispatch_remote_operation_activity"

    def initialize(state)
      super()
      @state = state
    end

    def execute(input)
      @state.calls << [ "dispatch", input ]
      { "operation_id" => input["operation_id"], "remote_job_id" => "synthetic-job", "state" => "running",
        "exit_code" => nil, "started_at" => nil, "working_directory" => input["working_directory"] }
    end
  end

  class Query < Temporalio::Activity::Definition
    activity_name "ac_query_remote_operation_activity"

    def initialize(state)
      super()
      @state = state
    end

    def execute(input)
      @state.calls << [ "query", input ]
      { "operation_id" => input["operation_id"], "remote_job_id" => "synthetic-job", "state" => "uncertain",
        "started" => true, "running" => nil, "result" => { "error" => "Estado remoto não comprovado" },
        "artifact_hash" => nil, "repeatable" => false }
    end
  end

  class UntouchedSupervisor
    attr_reader :calls

    def initialize
      @calls = []
    end

    def dispatch_operation!(**)
      calls << "dispatch"
      raise "Unexpected remote dispatch"
    end

    def query_operation_status!(**)
      calls << "query"
      raise "Unexpected remote query"
    end

    def verify_operation_receipt!(**)
      calls << "verify"
      false
    end
  end
end

module Workflows
  class AcRemoteOperationWorkflowTest < ActiveSupport::TestCase
    TASK_QUEUE = "ac-remote-operation-test"

    setup do
      @company = create(:company)
      @user = create(:user, company: @company)
      @project = create(:project, company: @company, owner: @user)
      @dir = Dir.mktmpdir("ac_remote_wf_test")
      identity_path = File.join(@dir, "id_ed25519")
      known_hosts_path = File.join(@dir, "known_hosts")
      File.write(identity_path, "synthetic private key")
      key_blob = Base64.strict_encode64("synthetic-ed25519-public-key")
      File.write(known_hosts_path, "f0-lab-pinned ssh-ed25519 #{key_blob}\n")
      fingerprint = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(key_blob))).delete_suffix('=')}"
      @environment = AcRemoteEnvironment.create!(company: @company, project: @project, name: "Remote Target Temporal",
        environment_slug: "remote-target-temporal", host: "127.0.0.1", port: 22, user: "deploy", fingerprint: fingerprint,
        identity_key_path: identity_path, known_hosts_path: known_hosts_path,
        authorized_directories: [ "/home/enok/Documentos/projetos/nexoisp" ], state: "active")
      @previous_supervisor = Rails.application.config.try(:ac_remote_supervisor)
      @supervisor = AcRemoteV1TestActivities::UntouchedSupervisor.new
      Rails.application.config.ac_remote_supervisor = @supervisor
      @previous_activities = AcRemoteOperationWorkflow._preloaded_activities
      proxy = Object.new
      %w[dispatch query].each do |action|
        name = "ac_#{action}_remote_operation_activity"
        proxy.define_singleton_method(name) { TemporalWorkflowHelper::ActivityRef.new(name, TASK_QUEUE) }
      end
      AcRemoteOperationWorkflow.instance_variable_set(:@_preloaded_activities, proxy)
    end

    teardown do
      Rails.application.config.ac_remote_supervisor = @previous_supervisor
      AcRemoteOperationWorkflow.instance_variable_set(:@_preloaded_activities, @previous_activities)
      FileUtils.remove_entry(@dir) if @dir && Dir.exist?(@dir)
    end

    test "dispatch without task and execution is rejected before the remote supervisor" do
      input = { environment_id: @environment.id, operation_id: "missing-identity-#{SecureRandom.hex(4)}",
        command: "bundle exec rake test", working_directory: "/home/enok/Documentos/projetos/nexoisp", artifact_hash: "synthetic" }
      assert_no_difference("AcRemoteOperation.count") do
        assert_raises(AcRemoteGatewayService::UnprovableRemoteStateError) do
          run_activity(Activities::AgentControl::AcDispatchRemoteOperationActivity, input)
        end
      end
      assert_empty @supervisor.calls
    end

    test "workflow returns uncertain when the activity boundary cannot prove remote state" do
      state = AcRemoteV1TestActivities::State.new
      operation_id = "op-wf-uncertain-#{SecureRandom.hex(4)}"
      result = run_workflow(AcRemoteOperationWorkflow,
        { environment_id: @environment.id, operation_id: operation_id, task_id: 42, execution_id: 43,
          command: "bundle exec rake test", working_directory: "/home/enok/Documentos/projetos/nexoisp", artifact_hash: "synthetic" },
        activities: [ AcRemoteV1TestActivities::Dispatch.new(state), AcRemoteV1TestActivities::Query.new(state) ], task_queue: TASK_QUEUE)

      assert_equal "uncertain", result["status"]
      assert result["uncertain"]
      assert_equal "Estado remoto não comprovado", result["reason"]
      assert_equal %w[dispatch query], state.calls.map(&:first)
      assert_equal operation_id, state.calls.last.last["operation_id"]
      assert_empty @supervisor.calls
      assert_not AcRemoteOperation.exists?(operation_id: operation_id)
    end
  end
end
