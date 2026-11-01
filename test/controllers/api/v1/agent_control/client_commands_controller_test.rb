# frozen_string_literal: true

require "test_helper"

class Api::V1::AgentControl::ClientCommandsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @company = create(:company)
    @user = create(:user, :onboarding_completed, company: @company, password: AuthHelper::TEST_PASSWORD)
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
    sign_in_as @user
  end

  test "SEC-01: unauthenticated requests are rejected with 401 unauthorized" do
    reset!
    post "/api/v1/agent_control/client_commands", params: {
      intent_id: "intent-sec-#{SecureRandom.hex(4)}",
      command_type: "create_task"
    }, as: :json
    assert_response :unauthorized
  end

  test "SEC-01: cross-tenant access to unauthorized company is rejected with 403 forbidden" do
    other_company = create(:company)
    post "/api/v1/agent_control/client_commands", params: {
      company_id: other_company.id,
      intent_id: "intent-sec-#{SecureRandom.hex(4)}",
      command_type: "create_task",
      payload: { plan_id: @plan.id }
    }, as: :json
    assert_response :forbidden
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

  # Prova BUG-P1-03: Assistente móvel de configuração persiste projeto, contexto e plano real
  test "BUG-P1-03: setup_project_wizard persists project, work context, and initial plan" do
    intent_id = "intent-wizard-#{SecureRandom.hex(6)}"

    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id,
      intent_id: intent_id,
      command_type: "setup_project_wizard",
      payload: {
        project_name: "Projeto Criado Pelo Mobile",
        context_title: "Contexto Onboarding Mobile"
      }
    }, as: :json

    assert_response :success
    res = JSON.parse(response.body)
    assert_equal "processed", res["status"]
    assert_equal "configured", res["result"]["status"]

    created_project = Project.find(res["result"]["project_id"])
    assert_equal "Projeto Criado Pelo Mobile", created_project.name
    assert_equal @user.id, created_project.owner_id

    created_context = AcWorkContext.find(res["result"]["context_id"])
    assert_equal "Contexto Onboarding Mobile", created_context.title
    assert_equal "active", created_context.state

    created_plan = AcPlan.find(res["result"]["plan_id"])
    assert_equal "active", created_plan.state
  end

  test "returns 422 when intent_id or command_type is missing" do
    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id,
      intent_id: "",
      command_type: "create_task"
    }, as: :json

    assert_response :unprocessable_entity
  end

  # Prova DEF-07 / RF-24 / RF-44: Pausar plano via comando deduplicado, registrar auditoria e bloquear advance_dag!
  test "DEF-07 / RF-24: pause_plan pauses active plan, records human intervention audit event and blocks advance_dag" do
    task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-pause-1",
      title: "Tarefa Teste Pausa",
      scope: "Escopo",
      position: 1,
      assigned_role: "programmer",
      risk_class: "low",
      depends_on: [],
      state: "pending"
    )

    intent_id = "intent-pause-#{SecureRandom.hex(6)}"

    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id,
      intent_id: intent_id,
      command_type: "pause_plan",
      payload: {
        plan_id: @plan.id,
        reason: "Inspeção operacional urgente"
      }
    }, as: :json

    assert_response :success
    res = JSON.parse(response.body)
    assert_equal "processed", res["status"]
    assert_equal true, res["result"]["paused"]
    assert_equal "Inspeção operacional urgente", res["result"]["reason"]

    @plan.reload
    assert_equal true, @plan.paused?

    # Auditoria de intervenção humana (G1 / RF-24 / RF-31)
    audit = AcDecisionAuditEvent.where(company: @company, project: @project, event_type: "human_intervention").last
    assert_not_nil audit
    assert_equal "human", audit.actor_type
    assert_equal @user.id, audit.actor_user_id
    assert_equal "pause_plan", audit.decision_details["action"]

    # RF-44: Plano pausado não avança tarefas via advance_dag!
    ready_tasks = @plan.advance_dag!
    assert_empty ready_tasks
  end

  # Prova DEF-07 / RF-24: Retomar plano via comando deduplicado
  test "DEF-07 / RF-24: resume_plan resumes paused plan and records human intervention audit event" do
    @plan.pause!(reason: "Pausa prévia", user: @user)
    assert_equal true, @plan.paused?

    intent_id = "intent-resume-#{SecureRandom.hex(6)}"

    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id,
      intent_id: intent_id,
      command_type: "resume_plan",
      payload: {
        plan_id: @plan.id
      }
    }, as: :json

    assert_response :success
    res = JSON.parse(response.body)
    assert_equal "processed", res["status"]
    assert_equal false, res["result"]["paused"]

    @plan.reload
    assert_equal false, @plan.paused?

    # Auditoria de retomada humana
    audit = AcDecisionAuditEvent.where(company: @company, project: @project, event_type: "human_intervention").last
    assert_not_nil audit
    assert_equal "resume_plan", audit.decision_details["action"]
  end

  # Prova DEF-07 / RF-24: Cancelar plano via comando deduplicado abortando tarefas pendentes
  test "DEF-07 / RF-24: cancel_plan cancels plan, aborts pending tasks and records human intervention audit event" do
    task = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-cancel-1",
      title: "Tarefa a ser cancelada",
      scope: "Escopo",
      position: 1,
      assigned_role: "programmer",
      risk_class: "low",
      depends_on: [],
      state: "pending"
    )

    intent_id = "intent-cancel-#{SecureRandom.hex(6)}"

    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id,
      intent_id: intent_id,
      command_type: "cancel_plan",
      payload: {
        plan_id: @plan.id,
        reason: "Cancelamento solicitado pelo gestor"
      }
    }, as: :json

    assert_response :success
    res = JSON.parse(response.body)
    assert_equal "processed", res["status"]
    assert_equal true, res["result"]["cancelled"]
    assert_equal "abandoned", res["result"]["state"]

    @plan.reload
    assert_equal "abandoned", @plan.state

    task.reload
    assert_equal "cancelled", task.state

    # Auditoria de cancelamento humano
    audit = AcDecisionAuditEvent.where(company: @company, project: @project, event_type: "human_intervention").last
    assert_not_nil audit
    assert_equal "cancel_plan", audit.decision_details["action"]
  end
end
