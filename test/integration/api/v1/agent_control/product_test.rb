# frozen_string_literal: true

require "test_helper"

class Api::V1::AgentControl::ProductTest < ActionDispatch::IntegrationTest
  setup do
    @company = create(:company)
    @owner = create(:user, :admin, :onboarding_completed, company: @company, password: AuthHelper::TEST_PASSWORD)
    @viewer = create(:user, :viewer, :onboarding_completed, company: @company, password: AuthHelper::TEST_PASSWORD)
    @project = create(:project, company: @company, owner: @owner)
    @project.add_collaborator(@viewer)
    sign_in_as(@owner)
  end

  test "templates validate dependencies and create immutable versions" do
    definition = { tasks: [ { task_key: "a", title: "First", depends_on: [] } ] }
    post "/api/v1/agent_control/templates", params: { company_id: @company.id, template_key: "sample", title: "Example", definition: definition }, as: :json
    assert_response :created
    id = response.parsed_body["id"]
    patch "/api/v1/agent_control/templates/#{id}", params: { company_id: @company.id, title: "Updated", definition: definition }, as: :json
    assert_response :created
    assert_equal 2, response.parsed_body["version"]
    cycle = { tasks: [ { task_key: "a", title: "A", depends_on: [ "a" ] } ] }
    post "/api/v1/agent_control/templates", params: { company_id: @company.id, template_key: "cycle", title: "Invalid", definition: cycle }, as: :json
    assert_response :unprocessable_entity
    sign_in_as(@viewer)
    post "/api/v1/agent_control/templates", params: { company_id: @company.id, template_key: "denied", title: "Denied", definition: definition }, as: :json
    assert_response :forbidden
  end

  test "notifications are idempotent and scoped to the recipient" do
    params = { company_id: @company.id, project_id: @project.id, recipient_id: @viewer.id, intent_id: "one", kind: "review", title: "Review", body: "Ready" }
    2.times do
      post "/api/v1/agent_control/notifications", params: params, as: :json
      assert_response :accepted
    end
    assert_equal 1, TriggerEvent.where(company: @company, source: "agent_control.notification").count
    get "/api/v1/agent_control/notifications", params: { company_id: @company.id }, as: :json
    assert_empty response.parsed_body
    sign_in_as(@viewer)
    get "/api/v1/agent_control/notifications", params: { company_id: @company.id }, as: :json
    assert_response :success
    assert_equal 1, response.parsed_body.size
    receipt = response.parsed_body.first
    assert_equal "Review", receipt["title"]
    patch "/api/v1/agent_control/notifications/#{receipt['id']}/read", params: { company_id: @company.id }, as: :json
    assert_response :success
    assert response.parsed_body["read_at"].present?
  end
end
