# frozen_string_literal: true

require "test_helper"

class Api::V1::AgentControl::RemoteCommandsTest < ActionDispatch::IntegrationTest
  include AcTemporalFixture

  setup do
    setup_ac_temporal_fixture
    @user.update!(password: AuthHelper::TEST_PASSWORD)
    AcMigrationService.assign_plan_manager!(plan: @plan, new_manager_identity: "manager", expected_epoch: 0)
    @execution = AcAdmissionService.admit_execution!(task: @task, operation_id: SecureRandom.uuid,
      requested_by: "test", execution_profile: @profile, epoch: "1", manager_identity: "manager", manager_epoch: 1)[:execution]
    @environment = AcRemoteEnvironment.create!(company: @company, project: @project, name: "Fixture",
      environment_slug: "fixture", host: "localhost", user: "worker", fingerprint: "fixture",
      identity_key_path: "/fixture/key", known_hosts_path: "/fixture/hosts", authorized_directories: [ "/lab" ])
    sign_in_as @user
  end

  teardown { teardown_ac_temporal_fixture }

  test "queues one authorized remote operation and deduplicates the client intent" do
    params = { company_id: @company.id, intent_id: "remote-api", command_type: "execute_remote_operation",
      payload: { execution_id: @execution.id, environment_id: @environment.id, command: "true", working_directory: "/lab" } }
    assert_difference "AcRemoteOperation.count", 1 do
      post "/api/v1/agent_control/client_commands", params: params, as: :json
    end
    assert_response :success
    result = response.parsed_body.fetch("result")
    assert_equal "queued", result["status"]
    assert_equal "pending", TriggerEvent.find(result["event_id"]).relay_state
    post "/api/v1/agent_control/client_commands", params: params, as: :json
    assert_response :success
    assert response.parsed_body["deduplicated"]
    assert_equal result["operation_id"], response.parsed_body.dig("result", "operation_id")
  end
end
