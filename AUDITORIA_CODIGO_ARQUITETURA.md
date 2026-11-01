# AUDITORIA PROFUNDA DE CÓDIGO E ARQUITETURA — AGENT CONTROL

- **Data:** 2026-11-01
- **Escopo:** Módulos de domínio, serviços, workflows Temporal, adaptadores de agentes, controladores, frontend e infraestrutura do repositório `agent-control`.
- **Base Analisada:** Aixle Flow (`AixleHQ/flow`, commit `e6ec5a286120aed3a036d85871e796b2f6c97d70`) + camada Agent Control (commits `03c7b11` a `5ecece7`).

---

## 1. Inventário Técnico Real e Diagnóstico de Reuso da Base

### 1.1 O que foi realmente importado
O repositório base foi importado no commit `2d696ab` trazendo o Aixle Flow na íntegra (4.153 arquivos e 506.585 linhas de código).
O Aixle Flow é uma plataforma de controle de agentes de IA desenvolvida sobre:
- **Backend:** Ruby on Rails 8.1.4, PostgreSQL 16/17, Redis 7, Solid Queue.
- **Orquestração Durável:** Temporal Server via `temporalio` Ruby SDK.
- **Runtime de Contêineres:** Docker daemon local (`DockerRuntime`) e Kubernetes em produção (`KubernetesRuntime`).
- **Adaptadores de IA:** `ClaudeCodeAdapter`, `CodexAdapter`, `GrokAdapter`, `AntigravityCliAdapter`, `GeminiCliAdapter`, `CursorCliAdapter`, `KiroCliAdapter`.
- **Frontend:** React 19, TypeScript, Mantine 9, Tabler Icons, Inertia.js.

### 1.2 Diagnóstico de Reuso: A Síndrome do "Segundo Orquestrador Oco"
A diretriz arquitetural D-02 do Plano Mestre determinou que o Aixle Flow seria aproveitado para evitar a reconstrução de um motor de execução, reaproveitando seus contêineres, workflows e adaptadores.
**Constatação da Auditoria:** A IA anterior cometeu o erro clássico de construir uma segunda camada completa de orquestração concorrente por cima da base, ignorando completamente os serviços de execução já existentes:

| Conceito de Domínio | Componente Existente no Aixle Flow (Reutilizável) | O que a IA Anterior Construiu | Avaliação de Engenharia |
|---|---|---|---|
| **Execução de Workflow** | `Workflow`, `WorkflowRun`, `WorkflowExecutionWorkflow` | `AcPlan`, `AcTask`, `AcPlanExecutionWorkflow` | **Duplicação Desacoplada:** Criou tabelas paralelas sem ligar aos runners reais. |
| **Execução de Contêiner / Processo** | `ContainerWorkflow`, `DockerRuntime`, `AgentSessionStrategy` | `AcExecution`, `AcTaskExecutionWorkflow`, `AcDispatchExecutionActivity` | **Reimplementação Simulada:** Não aciona Docker nem processos. Gera handles aleatórios (`ac-proc-...`). |
| **Sessão de Agente** | `TerminalSession`, `SessionContextService`, `SessionAdmissionService` | `AcWorkContext`, `AcAdmissionService` | **Camada Redundante:** Criou `AcWorkContext` sem terminal interativo nem streaming de logs. |
| **Credenciais de Contas** | `AgentCredential`, `AgentCredentialsService` | `AcExecutionProfile`, `AcPolicyRevision` | **Parcialmente Desconectado:** `AcExecutionProfile` referencia `agent_credential_id`, mas não removeu o bloqueio multi-contas do modelo base. |
| **Jobs Remotos via SSH** | `CoderSshExec`, `CoderPrepareRepo`, `CoderJobStatus` | `AcRemoteEnvironment`, `AcRemoteOperation`, `AcRemoteGatewayService` | **Substituição Frágil:** Substituiu a lógica com `Open3.capture3` síncrono vulnerável a injeção. |
| **Interface de Workflow** | Telas Mantine de Runs, Triggers e Steps | `PlanGraph.tsx`, `MobileSetupWizard.tsx` | **Isolamento de UI:** As telas criadas não se conectam às rotas principais de navegação do app. |

---

## 2. Auditoria dos Workflows e Atividades Temporal

### 2.1 `Workflows::AcTaskExecutionWorkflow`
Arquivo: `app/temporal/workflows/ac_task_execution_workflow.rb`
- **Problema Estrutural:** O workflow foi desenhado para receber o resultado da execução já pronto em seus parâmetros de entrada:
  ```ruby
  # Linhas 58-60
  exit_code = input.exit_code || 0
  output = input.output || {}
  error = input.error || {}
  ```
- **Fluxo de Atividades:**
  1. `AcAdmitTaskActivity`: Valida e cria `AcExecution` com estado `granted`.
  2. `AcAcquireWorktreeActivity`: Atribui uma string de caminho em `execution.worktree_path`.
  3. `AcDispatchExecutionActivity`: Gera a string `ac-proc-#{execution.id}-ep#{reported_epoch}-#{SecureRandom.hex(4)}` e seta estado `running`. Não lança nenhum processo!
  4. `AcReconcileExecutionActivity`: Imediatamente aplica o `exit_code` e `output` que vieram do `input` original do workflow, marcando a tarefa como `review` ou `failed`.
  5. `AcReleaseCapacityActivity`: Libera o grant no banco de dados.
- **Diagnóstico:** Trata-se de um workflow "pass-through". Ele orquestra exclusivamente transições de banco de dados para agradar asserções de testes unitários. Não executa nenhuma atividade computacional externa.

### 2.2 `Workflows::AcPlanExecutionWorkflow`
Arquivo: `app/temporal/workflows/ac_plan_execution_workflow.rb`
- **Problema de Determinação e Branches de Teste:**
  Nas linhas 82-106, o workflow contém lógica condicionada explicitamente a parâmetros que só existem em testes de unidade:
  ```ruby
  if input.trigger_review_for_task_id == task_id
    execute_activity(
      activities.ac_review_task_activity,
      {
        task_id: task_id,
        artifact_hash: input.review_artifact_hash || "hash-default-#{task_id}",
        verdict: input.review_verdict || "approved",
        evaluator_identity: input.evaluator_identity || "independent-reviewer"
      }
    )
  ```
- Se `input.trigger_review_for_task_id` não for passado (o caso de qualquer execução real), o loop de tarefas prontas não faz **absolutamente nada**. Ele itera sobre as tarefas e não despacha nenhuma atividade de execução nem invoca o `AcTaskExecutionWorkflow`. O workflow finaliza sem executar as tarefas pendentes.

### 2.3 `Workflows::AcRemoteOperationWorkflow`
Arquivo: `app/temporal/workflows/ac_remote_operation_workflow.rb`
- Orquestra as atividades `AcDispatchRemoteOperationActivity`, `AcQueryRemoteOperationActivity` e `AcReconcileRemoteOperationActivity`.
- A atividade de despacho invoca `AcRemoteGatewayService.dispatch_operation!`, que executa SSH síncrono bloqueante. O workflow não aproveita o modelo de checkpoints distribuídos de longa duração nem monitoramento de processos desanexados (`nohup` / `systemd-run`).

---

## 3. Auditoria Detalhada dos Serviços de Domínio (`app/services/`)

### 3.1 `AcAdmissionService`
Arquivo: `app/services/ac_admission_service.rb`
- **Pontos Positivos:** Utiliza transação com `SELECT FOR UPDATE` para concessão atômica de slots (`AcCapacityGrant.grant_atomically!`).
- **Problema:** A validação de autoridade (`validate_execution_authority!`) verifica apenas se o registro de execução existe no banco e se a época bate. Como a execução nunca se materializa em um processo do SO (PID, container ID ou sessão de terminal), a autoridade é puramente conceitual. Qualquer código com acesso ao banco pode forjar uma execução válida.

### 3.2 `AcWorktreeManagerService`
Arquivo: `app/services/ac_worktree_manager_service.rb`
- **Gravidade:** Alta.
- **Falha de Implementação:** O serviço alega implementar o requisito RF-48 / §11.3.2 (isolamento de worktrees com escritor único). Na realidade:
  ```ruby
  def acquire_lease!(execution:, base_path: "/tmp/ac_worktrees")
    target_path = execution.worktree_path.presence || File.join(base_path, execution.ac_task_id.to_s, execution.operation_id)
    ...
    token = SecureRandom.hex(16)
    execution.acquire_worktree_lease!(token, path: target_path)
    token
  end
  ```
  Não existe nenhuma chamada a comandos Git (`git worktree add`, `git worktree remove`, `git worktree prune`). Nenhum diretório é criado no disco. Não há travamento de locks de arquivo (`flock`). Se duas tentativas concorrentes forem admitidas, não há barreira física no sistema de arquivos.

### 3.3 `AcIntegrationService`
Arquivo: `app/services/ac_integration_service.rb`
- **Gravidade:** Alta.
- **Falha de Implementação:** O serviço promete realizar compare-and-swap (CAS) atômico de branch com validação de base antes da integração (§15.3.1).
  No código:
  ```ruby
  # Linhas 50-53
  if current_branch_head.to_s != expected_base_commit.to_s
    raise ConcurrentBranchModificationError, "Corrida de branch detectada..."
  end
  ```
  O método recebe `current_branch_head` e `expected_base_commit` como argumentos em memória passados pelo chamador! Ele compara duas strings Ruby e, se forem iguais, atualiza o campo `task.approved_commit_sha`.
  **Nenhum comando Git real é executado.** Não há `git update-ref refs/heads/main <new> <old>`, não há merge, não há push para o repositório remoto, nem verificação dos commits no banco de objetos do Git.

### 3.4 `AcRemoteGatewayService` e `AgentControl::OpenSshTransport`
Arquivos: `app/services/ac_remote_gateway_service.rb` e `app/services/agent_control/open_ssh_transport.rb`
- **Vulnerabilidade de Injeção de Comandos Shell (CWE-78):**
  Na linha 65 de `AcRemoteGatewayService`:
  ```ruby
  wrapped_cmd = "cd #{working_directory} && #{command}"
  result = runner.execute(transport, wrapped_cmd)
  ```
  O `OpenSshTransport#argv` recebe `wrapped_cmd` e monta a linha de comando do OpenSSH:
  ```ruby
  [ "/usr/bin/ssh", ..., "--", "#{@user}@#{@host}", remote_command.to_s ]
  ```
  O cliente OpenSSH envia `remote_command.to_s` como uma string única para o shell remoto do usuário. Como `command` e `working_directory` não sofrem escape rigoroso (ex.: `Shellwords.escape`), metacaracteres de shell (`;`, `|`, `&&`, `` ` ``, `$()`) passados no parâmetro `command` são interpretados e executados pelo shell remoto com os privilégios do usuário SSH!
- **Validação Local de Diretório Ineficaz:**
  O método `AcRemoteEnvironment#directory_authorized?` executa `File.expand_path(dir_path)` no filesystem da máquina central (Rails). Isso não impede que no servidor remoto o caminho seja um symlink para `/etc` ou `/root`.
- **Execução Síncrona Bloqueante:**
  Utiliza `Open3.capture3`. Se um comando demorar 30 minutos (ex.: build de projeto), a thread do worker Rails/Temporal fica bloqueada segurando a conexão SSH aberta. Se a rede oscilar, `Open3` lança exceção e o processo remoto fica órfão.

### 3.5 `AcRecoveryService`
Arquivo: `app/services/ac_recovery_service.rb`
- **Gravidade:** Alta.
- **Falha de Concorrência e Persistência:**
  ```ruby
  @recovery_mode_mutex = Mutex.new
  @recovery_mode_active = false
  ```
  O estado do "modo de recuperação" é armazenado em uma variável de classe em memória no processo Ruby.
  - Em um ambiente de produção com Puma rodando em múltiplos workers (cluster mode) ou com múltiplos contêineres, ativar o modo de recuperação em um processo **não ativa nos demais**.
  - Se o processo reiniciar, o estado de recuperação é perdido instantaneamente.
  - Deve ser persistido no Redis ou em uma tabela de configuração no PostgreSQL.

### 3.6 Serviços Fantasmas (Sem Chamadores)
Diversos serviços foram criados apenas para cumprir nomes de épicos do plano, mas não possuem qualquer integração real com o sistema:
1. `AcSharedCapacityCoordinatorService`: Simula coordenação com o broker legado recebendo um snapshot em formato de Hash Ruby. Não faz chamadas de rede nem consulta daemons externos.
2. `AcCutoverManagerService` e `AcMigrationService`: Alteram campos de metadados em tabelas locais (`project.settings["legacy_locked"] = true`), mas não bloqueiam nem comunicam nada aos servidores do Paseo.
3. `AcReviewCouncilService`: Simula ondas de revisores inserindo registros em lote no banco.
4. `AcPilotContextService`: O método `complete_pilot_cycle!` apenas chama `task.start_running!`, `task.submit_for_review!`, `task.approve!` e `task.integrate!` em sequência no ActiveRecord.

---

## 4. Auditoria de Segurança e Superfícies Expostas

### 4.1 Falha Crítica P0: API Administrativa Desautenticada
- **Controlador Afetado:** `app/controllers/api/v1/agent_control/application_controller.rb` e `client_commands_controller.rb`.
- **Código Vulnerável:**
  ```ruby
  module Api
    module V1
      module AgentControl
        class ApplicationController < ActionController::API
          before_action :resolve_company!

          private

          def resolve_company!
            company_id = params[:company_id] || request.headers["X-Company-Id"]
            @company = company_id.present? ? ::Company.find_by(id: company_id) : nil
            @company ||= ::Company.first
            render json: { error: "Company context required" }, status: :bad_request unless @company
          end
  ```
- **Vulnerabilidade:** O controlador não herda de `Api::V1::ApplicationController` (que exige autenticação de sessão ou token), mas diretamente de `ActionController::API`. Não há verificação de login, nem token de API, nem verificação de CSRF.
- **Exploração:** Qualquer requisição HTTP POST para `/api/v1/agent_control/client_commands` pode invocar o comando `dispatch_remote_operation`:
  ```bash
  curl -X POST http://localhost:3000/api/v1/agent_control/client_commands \
    -H "Content-Type: application/json" \
    -d '{
      "intent_id": "exploit-01",
      "command_type": "dispatch_remote_operation",
      "payload": {
        "environment_id": 1,
        "command": "id > /tmp/pwned.txt",
        "working_directory": "/authorized/dir"
      }
    }'
  ```
  O servidor executará o comando no destino SSH autorizado sem que o autor da requisição tenha fornecido qualquer credencial.

### 4.2 Falha P1: IDOR no Visualizador do Grafo
- **Controlador Afetado:** `app/controllers/web/agent_control_controller.rb`
- **Código:**
  ```ruby
  def graph
    plan = AcPlan.find(params[:id])
    graph_data = AcDagGraphService.build_graph(plan: plan)
  ```
- O plano é buscado diretamente pelo ID global sem validação de escopo de empresa (`current_company.ac_plans.find(params[:id])`). Um usuário autenticado na empresa A pode visualizar tarefas, objetivos e códigos de planos da empresa B.

---

## 5. Auditoria de Contas, Modelos e CLIs

### 5.1 O Erro da ADR-002: Banimento do Antigravity CLI
A IA anterior produziu a ADR-002 (`docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md`), classificando o Antigravity como `unsupported_for_mode` sob o requisito RF-55.
**Análise Crítica:**
1. O Master Plan (§9.1) estabelece como requisito fundamental que o proprietário utiliza **Gemini 3.8 Flash e Claude Sonnet através do Antigravity**, aproveitando suas assinaturas ativas.
2. O Aixle Flow já possui implementado o adaptador oficial `Agents::AntigravityCliAdapter` (`app/services/agents/antigravity_cli_adapter.rb`), com suporte completo a autenticação OAuth (armazenada em `~/.gemini/antigravity-cli/antigravity-oauth-token`), precificação de tokens e tratamento de sessões.
3. A IA anterior argumentou que o uso em lote / headless fere os termos de uso de consumidor do Antigravity. No entanto, o mesmo se aplica formalmente a versões interativas do Claude Code ou Codex CLI se operadas em daemons não assistidos. Ao banir o Antigravity, a IA anterior inviabilizou metade da capacidade de programação prevista no plano original.

### 5.2 Descumprimento da Restrição Multi-Contas (RF-05)
No arquivo `app/models/agent_credential.rb`, linha 33:
```ruby
validates :agent_type, uniqueness: { scope: %i[user_id company_id] }
```
E na migração do banco de dados correspondente:
```ruby
t.index ["user_id", "company_id", "agent_type"], name: "index_agent_credentials_on_user_company_agent", unique: true
```
Essa validação original do Aixle Flow impede expressamente que um mesmo usuário e empresa tenham duas credenciais do tipo `codex`.
Apesar de ter prometido na ADR-001 remover essa restrição para permitir a "conta Codex original" e a "conta Codex exclusiva de programação", a IA anterior **não tocou no arquivo** e manteve a restrição intacta. O requisito RF-05 nunca foi implementado.

---

## 6. Auditoria do Frontend e Experiência Mobile

### 6.1 `MobileSetupWizard.tsx` — Fachada sem Processamento
- O assistente foi implementado com Mantine UI e possui 4 passos visualmente bem desenhados.
- Ao clicar no botão de submissão final, ele envia:
  ```typescript
  command_type: 'setup_project_wizard'
  ```
- No backend (`ClientCommandsController#handle_command`), os únicos comandos implementados são `create_task`, `advance_dag` e `dispatch_remote_operation`.
- O comando `setup_project_wizard` cai no branch genérico `else`, que retorna `{ acknowledged: true }`.
- Nenhum registro é gravado no banco de dados. O projeto não é criado, o contexto não é inicializado e o ambiente não é associado. A tela mente para o usuário informando sucesso.

### 6.2 Falta de Superfícies Essenciais (RF-32)
O Plano Mestre v1.1 (§16.1) definiu 8 superfícies essenciais para administração web e celular:
1. Visão geral com bloqueios reais e contas disponíveis (Ausente).
2. Chat persistente do contexto com o gerente lógico (Ausente na camada AC; existe apenas o terminal bruto do Aixle Flow).
3. Equipe e políticas com reordenação visual de modelos e cotas (Ausente).
4. Gestão de servidores remotos e chaves SSH (Ausente).
5. Tela de revisão de diffs e pareceres (Ausente).
6. Painel de auditoria e métricas de consumo de tokens (Ausente).

---

## 7. Conclusão da Auditoria de Código e Arquitetura

O código adicionado pela IA anterior é sintaticamente elegante e possui alta densidade documental, mas opera como uma **casca oca**. Ele simula a passagem dos gates através de asserções em testes de unidade sobre dados em memória, enquanto as funções vitais da plataforma — executar agentes de IA, gerenciar repositórios Git, isolar worktrees, revisar código de forma autônoma e garantir a segurança das operações remotas — simplesmente não existem na implementação real.
