# frozen_string_literal: true

require "test_helper"

class AcDagGraphServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)
    @context = AcWorkContext.create!(
      company: @company,
      project: @project,
      title: "Context DAG Graph Test",
      external_id: "ctx-graph-#{SecureRandom.hex(4)}"
    )
    @plan = AcPlan.create!(
      company: @company,
      project: @project,
      ac_work_context: @context,
      plan_key: "plan-graph-#{SecureRandom.hex(4)}",
      title: "Plano do Grafo",
      objective: "Validar projeção de nós e arestas",
      version: 1
    )

    # Tarefa 1 (Root, integrada)
    @task1 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-1",
      title: "Fundação",
      position: 1,
      state: "integrated",
      approved_commit_sha: "commit-root-123",
      approved_artifact_hash: "hash-root-123"
    )

    # Tarefa 2 (Depende de 1, em execução)
    @task2 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-2",
      title: "Módulo Alpha",
      position: 2,
      depends_on: [ "task-1" ],
      state: "running"
    )

    # Tarefa 3 (Depende de 1, em revisão)
    @task3 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-3",
      title: "Módulo Beta",
      position: 3,
      depends_on: [ "task-1" ],
      state: "review"
    )

    # Tarefa 4 (Depende de 2 e 3, em espera)
    @task4 = AcTask.create!(
      company: @company,
      project: @project,
      ac_plan: @plan,
      task_key: "task-4",
      title: "Integração Final",
      position: 4,
      depends_on: [ "task-2", "task-3" ],
      state: "waiting_dependencies"
    )
  end

  # Prova G5-E2: Projeção correta de nós, arestas e estados do grafo de leitura para DAGs complexos (RF-50)
  test "G5-E2: build_graph projects nodes, edges, states and fulfilled dependencies accurately" do
    graph = AcDagGraphService.build_graph(plan: @plan)

    assert_equal @plan.id, graph[:plan][:id]
    assert_equal @plan.plan_key, graph[:plan][:plan_key]

    # 1. Validação de Nós
    assert_equal 4, graph[:nodes].size
    node1 = graph[:nodes].find { |n| n[:task_key] == "task-1" }
    assert_equal "integrated", node1[:state]
    assert_equal "commit-root-123", node1[:approved_commit_sha]
    assert node1[:flags][:integrated]
    assert node1[:flags][:terminal]

    node4 = graph[:nodes].find { |n| n[:task_key] == "task-4" }
    assert_equal "waiting_dependencies", node4[:state]
    assert node4[:flags][:waiting_dependencies]
    assert_equal [ "task-2", "task-3" ], node4[:depends_on]

    # 2. Validação de Arestas
    # task-1 -> task-2, task-1 -> task-3, task-2 -> task-4, task-3 -> task-4 = 4 arestas
    assert_equal 4, graph[:edges].size

    edge1_2 = graph[:edges].find { |e| e[:source_key] == "task-1" && e[:target_key] == "task-2" }
    assert edge1_2.present?
    assert edge1_2[:fulfilled], "Aresta originada em tarefa integrada deve estar cumprida"

    edge2_4 = graph[:edges].find { |e| e[:source_key] == "task-2" && e[:target_key] == "task-4" }
    assert edge2_4.present?
    assert_not edge2_4[:fulfilled], "Aresta originada em tarefa running NÃO deve estar cumprida"

    # 3. Validação do Sumário de Estados
    assert_equal 4, graph[:summary][:total_tasks]
    assert_equal 1, graph[:summary][:integrated]
    assert_equal 1, graph[:summary][:running]
    assert_equal 1, graph[:summary][:review]
    assert_equal 1, graph[:summary][:waiting_dependencies]
    assert_equal 0, graph[:summary][:pending]
    assert_not graph[:summary][:all_completed]

    # 4. Projeção temporal
    assert graph[:projection_timestamp].present?
  end
end
