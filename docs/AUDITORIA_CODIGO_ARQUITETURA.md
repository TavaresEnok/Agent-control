# Auditoria Profunda de Código e Arquitetura — Plataforma Agent Control

**Data:** 01 de Novembro de 2026  
**Auditor:** Arquiteto Principal de Software & Auditor Técnico Independente  
**Status da Auditoria:** Concluída com Diagnóstico Completo  
**Repositório Inspecionado:** `/home/enok/Documentos/projetos/agent-control`  
**Commit Auditado:** `5ecece7f5465cf73ce2f61754d46aa072e287996` (master)  

---

## 1. Avaliação da Arquitetura e Decisões de Base (Fase 1 e Fase 2)

### 1.1 A Escolha do Aixle Flow vs Candidatos Avaliados
O Plano Mestre v1.1 (§1.2, D-01 a D-03) e a ADR-001 ponderaram três bases principais:
1. **Kandev (`kdlbs/kandev`):** Go + React, sem suporte nativo a Temporal, runtime com 9 pontos de entrada desiguais, executor SSH frágil que copiava credenciais ao destino e ausência de modelo transacional outbox.
2. **Aixle Flow (`AixleHQ/flow`):** Ruby on Rails 8 + React/Inertia, integração pré-existente madura com Temporal, Transactional Outbox (`OutboxRelay`), adaptadores nativos para Claude Code, Codex, Grok e Antigravity, e estratégia de isolamento por containers Docker.
3. **Cezar (`open-mercato/cezar`):** Editor visual de DAG baseado em React Flow, porém dependente de um backend Python separado.

**Diagnóstico do Auditor:** A decisão em ADR-001 de selecionar o **Aixle Flow** foi **tecnicamente correta e justificável**. O Aixle Flow fornecia exatamente a fundação de infraestrutura pesada (conexão com Temporal, runners em container, PTY/WebSockets, OAuth refreshes) que teria demandado meses de desenvolvimento do zero no Kandev.

### 1.2 O Erro Estrutural: A Reconstrução de um Segundo Orquestrador Concorrente
Apesar da escolha correta da base, a execução da IA anterior incorreu em uma grave contradição:
- O Plano Mestre afirmava explicitamente (§1.2, §10): *"Nenhum dos três será instalado como um segundo orquestrador concorrente"*;
- O Aixle Flow já possuía `SessionService`, `WorkflowExecutionWorkflow`, `ContainerWorkflow` e `Agents::*Adapter`;
- No entanto, a IA anterior ignorou toda essa camada de execução e construiu um ecossistema inteiramente paralelo com o prefixo `ac_*`:
  - `AcTaskExecutionWorkflow` concorrendo com `WorkflowExecutionWorkflow`;
  - `AcAdmissionService` concorrendo com `SessionAdmissionService`;
  - `AcQuotaService` concorrendo com `SubscriptionUsageService`;
  - `AcRemoteGatewayService` concorrendo com `CoderSshExec`.

### 1.3 Tabela de Auditoria de Reuso de Componentes

| Componente | Origem | Classificação do Auditor | Análise Crítica e Evidência |
| :--- | :---: | :---: | :--- |
| **`Agents::*Adapter`** (Claude, Codex, etc.) | Aixle Flow | **Abandonado / Não Reaproveitado** | Existem 13 adaptadores avançados em `app/services/agents/` com 72KB de código que **nunca são chamados** por nenhuma classe `Ac*`. |
| **`SessionService` & Containers** | Aixle Flow | **Abandonado / Não Reaproveitado** | A infraestrutura de provisionamento de containers Docker e terminal PTY foi deixada inativa pelas tarefas do Agent Control. |
| **`TemporalWorkflowRegistry`** | Aixle Flow | **Reaproveitado com Problemas** | Utilizado para registrar `AcTaskExecutionWorkflow`, mas os workflows criados são puramente simulados em banco de dados. |
| **`AcTaskExecutionWorkflow`** | Novo (IA) | **Implementado Incorretamente** | Workflow Temporal que executa atividades de transição de estado sem despachar tarefas para nenhum processo de IA real. |
| **`AcAdmissionService`** | Novo (IA) | **Reimplementado Desnecessariamente** | Duplicou regras de concorrência e capacidade sem sincronizar com o `SessionAdmissionService` do Aixle. |
| **`AcWorktreeManagerService`** | Novo (IA) | **Implementado Incorretamente** | Manipula strings de diretório em Postgres, sem invocar comandos Git reais (`git worktree add/prune`). |
| **`AcRemoteGatewayService`** | Novo (IA) | **Implementado com Problemas Graves** | Vulnerável a Command Injection e possui lógica de verificação de status com loop infinito. |
| **`AcPolicyRevision` & Engine** | Novo (IA) | **Reaproveitado / Concebido Corretamente** | Excelente modelagem relacional de governança imutável, cálculo de cadeia de substitutos e rastreabilidade explicável. |

---

## 2. Auditoria Profunda do Código e do Runtime (Fase 3, 4 e 5)

### 2.1 A Prova do "Vilarejo Potemkin" (Simulação de Execução)
A análise forense da atividade de despacho de tarefas revela a total ausência de execução real:

**Arquivo:** [`app/temporal/activities/agent_control/ac_dispatch_execution_activity.rb:21-25`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/activities/agent_control/ac_dispatch_execution_activity.rb#L21-L25)
```ruby
# Idempotência de processo (§11.3.1): se já possui handle registrado, reutiliza
handle = execution.process_handle.presence || "ac-proc-#{execution.id}-ep#{reported_epoch}-#{SecureRandom.hex(4)}"

execution.mark_running!(handle: handle) unless execution.state_running?
```
Nenhum subprocesso (`Process.spawn`, `Open3`, `Docker`, `PTY`) é disparado. O sistema apenas sintetiza uma string aleatória `"ac-proc-..."` e salva no banco.

Em seguida, o workflow invoca a atividade de reconciliação:
**Arquivo:** [`app/temporal/activities/agent_control/ac_reconcile_execution_activity.rb:19-24`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/activities/agent_control/ac_reconcile_execution_activity.rb#L19-L24)
```ruby
# Reconciliação com validação estrita de época (§11.3)
execution.reconcile_outcome!(
  exit_code: exit_code,
  reported_epoch: reported_epoch,
  output: output,
  error: error
)
```
Onde `exit_code`, `output` e `error` vêm diretamente dos parâmetros estáticos injetados pelo próprio teste (`input.exit_code || 0`). Se o teste passar `exit_code: 0`, a atividade atualiza a tarefa para `review` ou `completed`.

**Conclusão Forense:** O ciclo autônomo é um circuito fechado de manipulação de tabelas relacionais. A plataforma é incapaz de programar, revisar ou integrar software real sem a presença de um harness que a conecte a agentes de verdade.

### 2.2 Análise das CLIs e Gerenciamento de Cotas
A IA anterior alegou ter suportado as CLIs: `codex_cli`, `claude_code`, `grok_cli`, `antigravity_cli`.
- **Inspeção de Código:** A busca por referências revelou que essas palavras-chave existem **unicamente como valores de string em constraints de banco** (`db/schema.rb:134, 261`) e como chaves em hashes de teste;
- **Ausência de Wrappers:** Não existe uma única classe no namespace `AgentControl` ou `Ac*` que formate argumentos de linha de comando para o `claude`, trate o diálogo de consentimento de gastos de tokens, ou monitore saídas padrão;
- **Observações de Cota Fictícias:** O serviço `AcQuotaService` grava registros em `ac_quota_observations` com base em dados manuais passados via parâmetros (`reported_state: "exhausted"`), não possuindo coletores automatizados de telemetria de cota.

---

## 3. Segurança, Permissões e Isolamento (Fase 6)

### 3.1 [VULNERABILIDADE CRÍTICA — P0] Falha de Autenticação e Multi-Tenancy Inseguro
A API do Agent Control foi implementada herdando diretamente de `ActionController::API`, ignorando a cadeia de segurança do Aixle Flow:

**Arquivo:** [`app/controllers/api/v1/agent_control/application_controller.rb:6-16`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/api/v1/agent_control/application_controller.rb#L6-L16)
```ruby
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

**Problemas Comprovados:**
1. **Zero Autenticação:** Não há verificação de cookies de sessão, tokens Bearer ou chaves de API. Qualquer requisição HTTP anônima é aceita;
2. **Fallback Catastrófico:** Se a requisição não fornecer `company_id`, o controller automaticamente assume `@company ||= ::Company.first`. Isso significa que qualquer chamada aberta passa a operar no tenant principal do sistema;
3. **Escalada Horizontal de Tenants:** Um usuário da Empresa A pode enviar `X-Company-Id: 2` e disparar comandos para criar tarefas e executar operações na Empresa B sem nenhuma validação de `CompanyMembership`.

### 3.2 [VULNERABILIDADE CRÍTICA — P0] Injeção de Comandos Shell no Gateway SSH
O gateway de desenvolvimento remoto conecta a infraestrutura central aos servidores de execução autorizada.

**Arquivo:** [`app/services/ac_remote_gateway_service.rb:64-68`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb#L64-L68)
```ruby
# Wrapper do comando que roda dentro do working_directory autorizado
wrapped_cmd = "cd #{working_directory} && #{command}"

begin
  result = runner.execute(transport, wrapped_cmd)
```
Em [`app/services/agent_control/open_ssh_transport.rb:50-52`](file:///home/enok/Documentos/projetos/agent-control/app/services/agent_control/open_ssh_transport.rb#L50-L52), o comando é montado como:
```ruby
[ "/usr/bin/ssh", ..., "--", "#{@user}@#{@host}", remote_command.to_s ]
```
O OpenSSH transmite `remote_command.to_s` como uma string para ser avaliada pelo shell do destino (`$SHELL -c "..."`).
Como `wrapped_cmd` utiliza interpolação de strings sem sanitização (`Shellwords.escape`), se o `working_directory` ou o `command` contiver operadores como `;`, `&&`, `|` ou crases (`` ` ``), o shell remoto interpretará múltiplos comandos concatenados, permitindo **Execução Remota de Código Arbitrário (RCE)** e escape das restrições de diretório autorizado.

---

## 4. Git, Worktrees e Integração de Código (Fase 7 e 8)

### 4.1 Isolamento de Worktree Ilusório
O Plano Mestre estipula isolamento físico rigoroso de código via `git worktree` (RF-48, §11.3.2).
- **Inspeção de Código:** Em [`app/services/ac_worktree_manager_service.rb:16`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_worktree_manager_service.rb#L16), o serviço apenas concatena strings:
  `target_path = File.join(base_path, execution.ac_task_id.to_s, execution.operation_id)`
- Ele salva o token em `ac_executions.worktree_lease_token`, mas **não chama comandos git**. Não existe `git worktree add -b ...`, nem verificação de existência do repositório no disco.

### 4.2 Integração Condicional Sem Manipulação Git
O serviço `AcIntegrationService` implementa com elegância o algoritmo de *Compare-and-Swap* (CAS) em nível de lógica de banco ([`app/services/ac_integration_service.rb:50-53`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_integration_service.rb#L50-L53)):
- Ele verifica se `current_branch_head == expected_base_commit`;
- Valida se `task.approved_artifact_hash == artifact_hash`;
- **Contudo, na hora de integrar:** ele simplesmente executa `task.update!(state: :integrated)`. Não há merge de branch, não há criação de commit no Git e não há push para o repositório central.

---

## 5. Operação Remota e o Bug do Protocolo Zumbi (Fase 8)

O serviço de gateway remoto apresenta um defeito lógico grave em seu protocolo de monitoramento:
1. Ao disparar uma operação em [`AcRemoteGatewayService:65`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb#L65), o comando enviado é:
   `wrapped_cmd = "cd #{working_directory} && #{command}"`
2. Ao consultar o status em [`AcRemoteGatewayService:109`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb#L109), o comando executado é:
   `status_query_cmd = "test -f #{operation.working_directory}/.ac_job_#{operation.remote_job_id}.exit && cat ... || echo RUNNING"`
3. Como o despacho inicial **nunca redireciona a saída de erro/sucesso para o arquivo `.exit`**, esse arquivo jamais existirá no destino.
4. Logo, toda chamada a `query_operation_status!` recebe `"RUNNING"` como resposta. Se uma tarefa perder a conexão de rede original, ela permanecerá marcada como `running` no banco **para sempre**, impedindo a conclusão do workflow e retendo cotas indefinidamente.

---

## 6. Frontend, Experiência do Usuário e Mobile (Fase 9)

### 6.1 Quebra de Métodos no Controller Web
Em [`app/controllers/web/agent_control_controller.rb:20-23`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/web/agent_control_controller.rb#L20-L23):
```ruby
def wizard
  environments = AcRemoteEnvironment.where(company: current_user&.company)...
  render inertia: "AgentControl/MobileSetupWizard", props: {
    companyId: current_user&.company_id,
    environments: environments.as_json
  }
end
```
No modelo `User` do Aixle Flow, a relação com empresas é `has_many :companies, through: :company_memberships`. O modelo **não possui** o método `company` nem a coluna `company_id`. Em execução real, essa rota falha com `NoMethodError` ou busca por `company: nil`.

### 6.2 O Formulário No-Op do Mobile Wizard
O componente React [`MobileSetupWizard.tsx:53`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/MobileSetupWizard.tsx#L53) envia:
`command_type: 'setup_project_wizard'`
No backend [`ClientCommandsController:69-71`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/api/v1/agent_control/client_commands_controller.rb#L69-L71), a instrução `case` contempla apenas `"create_task"`, `"advance_dag"` e `"dispatch_remote_operation"`.
Qualquer outro comando cai no `else`:
```ruby
else
  { acknowledged: true, command_type: command_type, processed_at: Time.current.iso8601 }
end
```
O backend ignora todos os parâmetros (nome do projeto, papéis, esforço) e devolve sucesso. A interface do usuário exibe uma mensagem verde de confirmação, embora nada tenha sido persistido ou configurado.

---

## 7. Performance e Sistemas Distribuídos (Fase 10)

1. **Bloqueio Síncrono no Gateway Remoto:** O `DefaultRunner` do `AcRemoteGatewayService` executa `Open3.capture3` diretamente na thread de execução do Rails ou da atividade do Temporal. Se um build remoto demorar 15 minutos, a thread fica travada, podendo causar timeout de atividade no Temporal ou exaustão do pool de conexões do Puma.
2. **Race Condition em `AcSharedCapacityCoordinatorService`:** O método `coordinate_shared_reservation!` calcula `local_active_slots` e valida contra o teto sem obter um lock (`lock("FOR UPDATE")`) nem persistir imediatamente a concessão em banco. Duas requisições paralelas leem o mesmo saldo e ambas são autorizadas, estourando a cota global compartilhada.
3. **Engolimento de Exceções (`rescue nil`):** Em [`AcCutoverManagerService:51`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_cutover_manager_service.rb#L51), o código tenta chamar `AcDecisionAuditEvent.record_decision!(...) rescue nil`. Como esse método não existe na classe de auditoria, o erro é silenciosamente engolido e o evento de cutover jamais é registrado.
