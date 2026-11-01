# frozen_string_literal: true

require "test_helper"

class Api::V1::AgentControl::DagGraphsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @company = create(:company)
    @user = create(:user, :onboarding_completed, company: @company, password: AuthHelper::TEST_PASSWORD)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context DAG Controller Test",
      external_id: "ctx-dag-ctrl-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "plan-dag-ctrl-#{SecureRandom.hex(4)}",
      title: "Plano do Controlador",
      objective: "API test",
      version: 1
    )
    @task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-ctrl-1",
      title: "Tarefa 1",
      position: 1,
      state: "pending"
    )
    sign_in_as @user
  end

  test "SEC-01: unauthenticated requests are rejected with 401 unauthorized" do
    # Dispara sem autenticação em sessão limpa
    reset!
    get "/api/v1/agent_control/plans/#{@plan.id}/graph", as: :json
    assert_response :unauthorized
  end

  test "SEC-01: cross-tenant access to unauthorized company is rejected with 403 forbidden" do
    other_company = create(:company)
    get "/api/v1/agent_control/plans/#{@plan.id}/graph", params: { company_id: other_company.id }, as: :json
    assert_response :forbidden
  end

  # Prova G5-E4: API serializa nós e arestas para renderização móvel e web (RF-50)
  test "G5-E4: returns DAG graph projection via JSON API" do
    get "/api/v1/agent_control/plans/#{@plan.id}/graph", params: { company_id: @company.id }, as: :json

    assert_response :success
    data = JSON.parse(response.body)

    assert_equal @plan.id, data["plan"]["id"]
    assert_equal 1, data["nodes"].size
    assert_equal "task-ctrl-1", data["nodes"].first["task_key"]
    assert_equal 1, data["summary"]["total_tasks"]
    assert_equal 1, data["summary"]["pending"]
    assert data["projection_timestamp"].present?
  end

  test "returns 404 when plan is not found" do
    get "/api/v1/agent_control/plans/999999/graph", params: { company_id: @company.id }, as: :json
    assert_response :not_found
  end
end
