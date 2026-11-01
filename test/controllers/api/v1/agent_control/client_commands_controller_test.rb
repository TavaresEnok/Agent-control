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

  test "cookie-authenticated commands require a CSRF token" do
    controller = Api::V1::AgentControl::ClientCommandsController
    previous = controller.allow_forgery_protection
    controller.allow_forgery_protection = true
    assert_no_difference -> { AcClientCommand.count } do
      post "/api/v1/agent_control/client_commands", params: {
        company_id: @company.id, intent_id: SecureRandom.uuid, command_type: "create_task", payload: { plan_id: @plan.id }
      }, as: :json
    end
    assert_response :unprocessable_entity
    assert_equal "Invalid or missing CSRF token", response.parsed_body["error"]
  ensure
    controller.allow_forgery_protection = previous
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
    refute data1["deduplicated"]
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
        title: "Tarefa Via API",
        task_key: "task-http-1"
      }
    }, as: :json

    assert_response :success
    data2 = JSON.parse(response.body)
    assert data2["deduplicated"]
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
    assert_equal "draft", created_plan.state
    assert_nil created_plan.published_at
    assert_nil created_plan.content_hash
  end

  test "draft plans require validated publication and a published policy before launch" do
    AcTask.create!(company: @company, project: @project, ac_plan: @plan, task_key: "first", title: "First")
    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id, intent_id: "start-draft", command_type: "start_plan", payload: { plan_id: @plan.id }
    }, as: :json
    assert_response :unprocessable_entity
    assert_nil @plan.reload.published_at

    credential = create(:agent_credential, company: @company, user: @user, agent_type: "claude_code")
    policy = AcPolicyRevision.create!(company: @company, revision_number: 1, content_hash: SecureRandom.hex(32),
      state: :draft, content: { "model_chain" => [ "test-model" ], "active_accounts" => [], "chain_rules" => [], "effort_limits" => {} })
    AcExecutionProfile.create!(company: @company, ac_policy_revision: policy, agent_credential: credential,
      profile_key: "test", role: :programmer, cli_adapter: :claude_code, model_id: "test-model", effort_level: :medium,
      chain_position: 1, selection_criteria: { "eligibility" => { "status" => "documented_supported", "model_id" => "test-model",
        "cli_adapter" => "claude_code", "efforts" => [ "medium" ], "valid_until" => 1.hour.from_now.iso8601 } })
    assert policy.publish!(by_user: @user)
    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id, intent_id: "publish-plan", command_type: "publish_plan",
      payload: { plan_id: @plan.id, policy_revision_id: policy.id }
    }, as: :json
    assert_response :success
    assert @plan.reload.published?
    assert_equal policy.id, @plan.policy_revision_id

    post "/api/v1/agent_control/client_commands", params: {
      company_id: @company.id, intent_id: "start-published", command_type: "start_plan", payload: { plan_id: @plan.id }
    }, as: :json
    assert_response :success
    assert TriggerEvent.exists?(company: @company, event_type: AcPlanLaunchService::EVENT_TYPE)
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
    AcTask.create!(
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
    assert res["result"]["paused"]
    assert_equal "Inspeção operacional urgente", res["result"]["reason"]

    @plan.reload
    assert @plan.paused?

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
    assert @plan.paused?

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
    refute res["result"]["paused"]

    @plan.reload
    refute_predicate @plan, :paused?

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
    assert res["result"]["cancelled"]
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
  test "unsupported commands do not create a receipt" do
    assert_no_difference "AcClientCommand.count" do
      post "/api/v1/agent_control/client_commands", params: {
        company_id: @company.id, intent_id: "unknown", command_type: "unknown"
      }, as: :json
    end
    assert_response :unprocessable_entity
    assert_equal "unsupported_command", response.parsed_body["error"]
  end

  test "viewer cannot issue commands" do
    @user.company_memberships.find_by!(company: @company).update!(role: "viewer")
    assert_no_difference "AcClientCommand.count" do
      post "/api/v1/agent_control/client_commands", params: {
        company_id: @company.id, intent_id: "viewer", command_type: "create_task"
      }, as: :json
    end
    assert_response :forbidden
  end
end
