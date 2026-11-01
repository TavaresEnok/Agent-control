# frozen_string_literal: true

require "test_helper"

class Api::V1::AgentControl::ClientCommandsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context API Test",
      external_id: "ctx-api-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "plan-api-#{SecureRandom.hex(4)}",
      title: "Plano API",
      objective: "Testar endpoints",
      version: 1
    )
  end

  # Prova G5-E3: Criação de tarefa via comando do cliente com deduplicação (RF-53)
  test "G5-E3: posts client command and deduplicates identical intent_id" do
    intent_id = "intent-http-#{SecureRandom.hex(6)}"

    # 1. Primeiro envio
    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id,
      intent_id: intent_id,
      command_type: "create_task",
      payload: {
        plan_id: @plan.id,
        title: "Tarefa Via API",
        task_key: "task-http-1"
      }
    }, as: :json

    assert_response :success
    data1 = JSON.parse(response.body)
    assert_equal false, data1["deduplicated"]
    assert_equal "processed", data1["status"]
    assert data1["result"]["task_id"].present?

    assert_equal 1, @plan.ac_tasks.count

    # 2. Segundo envio com mesmo intent_id (simulando reconexão móvel ou reenvio)
    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id,
      intent_id: intent_id,
      command_type: "create_task",
      payload: {
        plan_id: @plan.id,
        title: "Tarefa Via API (Retry)",
        task_key: "task-http-1"
      }
    }, as: :json

    assert_response :success
    data2 = JSON.parse(response.body)
    assert_equal true, data2["deduplicated"]
    assert_equal data1["result"]["task_id"], data2["result"]["task_id"]

    # Não deve criar segunda tarefa no banco
    assert_equal 1, @plan.ac_tasks.count
  end

  test "returns 422 when intent_id or command_type is missing" do
    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id,
      intent_id: "",
      command_type: "create_task"
    }, as: :json

    assert_response :unprocessable_entity
  end
end
