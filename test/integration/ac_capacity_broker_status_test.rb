# frozen_string_literal: true

require "test_helper"

class AcCapacityBrokerStatusTest < ActionDispatch::IntegrationTest
  include AcSafetyFixtures

  setup do
    @previous_status = Rails.application.config.try(:ac_capacity_broker_status)
    @status_key = "k" * 32
    @status_bearer = "b" * 32
    Rails.application.config.ac_capacity_broker_status = { "host_id" => "host", "authority_id" => "authority",
      "bearer" => @status_bearer, "signing_key" => @status_key }
    https!
  end

  teardown { Rails.application.config.ac_capacity_broker_status = @previous_status }

  test "an orphan reservation is fenced before signing proof of absence" do
    intent = AcSharedCapacityIntent.create!(company: @company, ac_task: @task, ac_execution_profile: @profiles["programmer"],
      agent_credential: @credential, operation_id: "orphan", account_key: "sha256:#{'a' * 64}", host_id: "host",
      authority_id: "authority", epoch: "1", quantity: 1, broker_grant_id: "host:grant", state: "reserved")
    payload = { "operation_id" => "orphan", "account_key" => intent.account_key, "authority_id" => "authority",
      "host_id" => "host", "epoch" => "1", "grant_id" => "host:grant", "execution_id" => nil,
      "runtime_id" => nil, "nonce" => SecureRandom.hex(16) }
    body = JSON.generate(payload)
    headers = { "CONTENT_TYPE" => "application/json", "Authorization" => "Bearer #{@status_bearer}",
      "X-AC-Signature" => OpenSSL::HMAC.hexdigest("SHA256", @status_key, body) }
    post "/v1/capacity/status", params: body, headers: headers
    assert_response :success
    assert_equal "not_started", response.parsed_body["state"]
    assert_equal "fenced", intent.reload.state
    assert_equal OpenSSL::HMAC.hexdigest("SHA256", @status_key, response.body), response.headers["X-AC-Signature"]
    post "/v1/capacity/status", params: body, headers: headers
    assert_response :bad_request
    assert_raises(AcSharedCapacityAuthorityService::Uncertain) do
      AcSharedCapacityAuthorityService.grant_atomically!(company: @company, ac_task: @task,
        ac_execution_profile: @profiles["programmer"], agent_credential: @credential, operation_id: intent.operation_id,
        epoch: intent.epoch, policy_revision_id: @policy.id, policy_revision_number: @policy.revision_number,
        quantity: 1, resource_type: :inference_slot, expires_in: 30.minutes)
    end
  end
  test "terminal status fences dispatch before issuing a signed receipt" do
    execution = AcAdmissionService.admit_execution!(task: @task, operation_id: "finished", requested_by: "test")[:execution]
    grant = execution.ac_capacity_grant
    account = "sha256:#{'a' * 64}"
    grant.update!(reconciliation_data: { "authority" => "shared", "authority_id" => "authority", "account_key" => account,
      "broker_grant_id" => "host:grant", "broker_state" => "bound" })
    AcSharedCapacityIntent.create!(company: @company, ac_task: @task, ac_execution_profile: @profiles["programmer"],
      agent_credential: @credential, operation_id: "finished", account_key: account, host_id: "host",
      authority_id: "authority", epoch: execution.epoch.to_s, quantity: 1, broker_grant_id: "host:grant", state: "bound")
    @supervisor.receipts[execution.id] = { "operation_id" => "finished", "epoch" => execution.epoch.to_s,
      "process_handle" => "worker", "state" => "completed", "exit_code" => 0, "runtime_id" => "runtime-1" }
    payload = { "operation_id" => "finished", "account_key" => account, "authority_id" => "authority",
      "host_id" => "host", "epoch" => execution.epoch.to_s, "grant_id" => "host:grant", "execution_id" => execution.id,
      "runtime_id" => "runtime-1", "nonce" => SecureRandom.hex(16) }
    body = JSON.generate(payload)
    headers = { "CONTENT_TYPE" => "application/json", "Authorization" => "Bearer #{@status_bearer}",
      "X-AC-Signature" => OpenSSL::HMAC.hexdigest("SHA256", @status_key, body) }
    environment = AcRemoteEnvironment.create!(company: @company, project: @project, name: "Remote",
      environment_slug: SecureRandom.hex(8), authorized_directories: [ "/workspace" ], state: "active",
      host: "localhost", port: 22, user: "worker", fingerprint: "SHA256:fixture",
      identity_key_path: "/tmp/fixture-key", known_hosts_path: "/tmp/fixture-hosts")
    remote = AcRemoteOperation.create!(company: @company, project: @project, ac_task: @task,
      ac_execution: execution, ac_remote_environment: environment, operation_id: "still-writing",
      command: "work", working_directory: "/workspace", state: "running")
    post "/v1/capacity/status", params: body, headers: headers
    assert_response :bad_request
    assert_equal "bound", grant.reload.reconciliation_data["broker_state"]
    assert_not grant.reconciliation_data["remote_release_claimed"]
    remote.update!(state: "completed", exit_code: 0)
    payload["nonce"] = SecureRandom.hex(16)
    body = JSON.generate(payload)
    headers["X-AC-Signature"] = OpenSSL::HMAC.hexdigest("SHA256", @status_key, body)
    @supervisor.receipts[execution.id]["state"] = "running"
    @supervisor.receipts[execution.id]["exit_code"] = nil
    post "/v1/capacity/status", params: body, headers: headers
    assert_response :conflict
    assert_equal "bound", grant.reload.reconciliation_data["broker_state"]
    @supervisor.receipts[execution.id]["state"] = "completed"
    @supervisor.receipts[execution.id]["exit_code"] = 0
    payload["nonce"] = SecureRandom.hex(16)
    body = JSON.generate(payload)
    headers["X-AC-Signature"] = OpenSSL::HMAC.hexdigest("SHA256", @status_key, body)
    post "/v1/capacity/status", params: body, headers: headers
    assert_response :success
    assert_equal "completed", response.parsed_body["state"]
    assert_equal "releasing", grant.reload.reconciliation_data["broker_state"]
    assert grant.reconciliation_data["remote_release_claimed"]
    assert_raises(AcSharedCapacityAuthorityService::Uncertain) { AcSharedCapacityAuthorityService.ensure_bound!(execution: execution.reload) }
  end
end
