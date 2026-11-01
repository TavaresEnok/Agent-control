# INVENTÁRIO COMPLETO DE PROBLEMAS, RISCOS E DEFEITOS
## Plataforma Central Autônoma de Desenvolvimento de Software (Agent Control)

**Data da Auditoria:** 2026-11-01  
**Autor:** Auditoria Técnica Independente de Arquitetura e Segurança  
**Escala de Severidade:**
- **P0 — Crítico:** Segurança, corrupção, perda de dados, duplicação de execução, violação de autoridade ou falha estrutural que impede operação confiável.
- **P1 — Alto:** Funcionalidade essencial incorreta, falha relevante de recuperação, arquitetura problemática ou defeito grave de produção.
- **P2 — Médio:** Problemas de desempenho, manutenção, UX, consistência secundária ou oportunidades importantes de simplificação.
- **P3 — Baixo:** Melhorias menores, ajustes de estilo e pendências não urgentes.

---

## 1. Problemas de Severidade P0 (Críticos)

### [BUG-P0-01] Execução Remota de Código (RCE) e Falta Total de Autenticação na API
- **Categoria:** Segurança / Controle de Acesso
- **Componente Afetado:** `Api::V1::AgentControl::ApplicationController` e `ClientCommandsController`
- **Evidência:**
  - **Arquivo:** `app/controllers/api/v1/agent_control/application_controller.rb:6-21`
  - **Comportamento Observado:** A classe herda de `ActionController::API` sem qualquer filtro de autenticação (não há `authenticate_user!`, verificação de tokens ou sessão). O método `resolve_company!` define `@company ||= ::Company.first`. Ao chamar `POST /api/v1/agent_control/client_commands` com `command_type: "dispatch_remote_operation"`, o comando shell em `payload["command"]` é repassado sem validação para `AcRemoteGatewayService`, que o executa no servidor SSH de destino como `cd #{dir} && #{command}`.
  - **Resultado Esperado:** Apenas usuários autenticados e autorizados da empresa correspondente devem acessar a API. Comandos remotos devem ser estritamente auditados e restritos.
  - **Grau de Confiança:** 100% (Verificado diretamente no código-fonte).
- **Causa:** Herança indevida de `ActionController::API` em vez da classe base autenticada da aplicação (`Api::V1::ApplicationController`), somada a um fallback negligente para `Company.first`.
- **Consequências:** Qualquer usuário na rede pode executar comandos arbitrários com privilégios da chave SSH nos servidores remotos (`NexoISP`, `Ajust ERP`) e acessar dados de qualquer empresa (quebra de isolamento multi-tenant per RF-49).
- **Solução Recomendada:**
  1. Alterar a herança para `Api::V1::ApplicationController` ou incluir `authenticate_user!` e validação obrigatória de sessão/token JWT assinado.
  2. Remover o fallback para `Company.first`.
  3. Implementar sanitização estrita e whitelisting rígido de comandos permitidos em `AcRemoteGatewayService`.
- **Impacto e Risco:** Baixo risco de regressão; correção cirúrgica essencial para segurança mínima.

---

### [BUG-P0-02] Execução Fictícia de Agentes e Modelos de IA no Workflow Temporal
- **Categoria:** Orquestração / Autonomia
- **Componente Afetado:** `Workflows::AcTaskExecutionWorkflow` e `Activities::AgentControl::AcDispatchExecutionActivity`
- **Evidência:**
  - **Arquivo:** `app/temporal/activities/agent_control/ac_dispatch_execution_activity.rb:21-25` e `app/temporal/workflows/ac_task_execution_workflow.rb:58`
  - **Comportamento Observado:** A atividade `ac_dispatch_execution_activity` apenas gera uma string `process_handle = "ac-proc-..."` e salva no banco de dados. Nenhum binário CLI (`codex`, `claude`, `grok`) é chamado e nenhum container é criado. O workflow recebe `exit_code: 0` diretamente do payload enviado pelos testes unitários.
  - **Resultado Esperado:** O despacho deve instanciar o adapter de execução correspondente (`CodexAdapter`, `ClaudeCodeAdapter`, `GrokAdapter`), lançar o processo/container do agente, monitorar a execução via supervisor e capturar stdout/stderr e métricas de tokens reais.
  - **Grau de Confiança:** 100% (Comprovado no código).
- **Causa:** A IA anterior focou em satisfazer a máquina de estados relacional do Gate G2 em vez de integrar a camada de processos reais.
- **Consequências:** A plataforma é incapaz de escrever uma única linha de código autonomamente; todas as execuções "concluídas" são simulações alimentadas por mocks.
- **Solução Recomendada:** Conectar `AcDispatchExecutionActivity` aos adapters de agente do Aixle Flow (`app/services/agents/`) ou a um executor de subprocessos com isolamento em worktrees locais, capturando saída real.

---

### [BUG-P0-03] Falha Estrutural de Restauração de Dados pós-Desastre
- **Categoria:** Resiliência / Banco de Dados
- **Componente Afetado:** `AcRecoveryService.restore_from_manifest!`
- **Evidência:**
  - **Arquivo:** `app/services/ac_recovery_service.rb:85-108`
  - **Comportamento Observado:** O método valida criptograficamente o manifesto de backup via SHA-256, mas dentro do bloco de transação apenas chama `reconcile_active_executions!`, `neutralize_orphan_leases!` e `preserve_pauses!`. Nenhuma linha de código lê o nó `manifest["entities"]` para reinserir os registros no banco de dados.
  - **Resultado Esperado:** A restauração deve restaurar efetivamente as tabelas e entidades do banco a partir do backup exportado em caso de desastre.
  - **Grau de Confiança:** 100%.
- **Causa:** Implementação truncada que atendeu apenas aos cenários de teste unitário que testavam a rejeição de manifestos corrompidos, sem testar a reidratação do banco.
- **Consequências:** Em um cenário de recuperação de desastres real com perda de banco (RPO/RTO per RNF-10), a restauração não recupera nenhum dado.
- **Solução Recomendada:** Implementar o parser de reidratação de entidades no banco de dados respeitando constraints de chaves estrangeiras.

---

### [BUG-P0-04] Operações Git e Worktrees Puramente Virtuais (Sem Git Físico)
- **Categoria:** Engenharia de Software / Git
- **Componente Afetado:** `AcWorktreeManagerService` e `AcIntegrationService`
- **Evidência:**
  - **Arquivo:** `app/services/ac_worktree_manager_service.rb:15-40` e `app/services/ac_integration_service.rb:48-64`
  - **Comportamento Observado:** O serviço de worktrees apenas gera strings no banco com formato `/tmp/ac_worktrees/...` e tokens UUID, sem chamar `git worktree add`. O serviço de integração compara strings em memória (`current_branch_head == expected_base_commit`) e altera a coluna `state` da tarefa para `:integrated` sem executar `git merge`, `git update-ref` ou alterar referências no disco.
  - **Resultado Esperado:** Criação física de worktrees Git para isolar o espaço de trabalho dos agentes e atualização física das branches do repositório durante a integração aprovada.
  - **Grau de Confiança:** 100%.
- **Causa:** Criação de uma simulação relacional de controle de versão que não toca no executável Git.
- **Consequências:** Nenhuma branch é atualizada e nenhum arquivo de código é versionado ou integrado fisicamente.
- **Solução Recomendada:** Invocar o binário `git` ou biblioteca nativa (ex: `Rugged` / `Git CLI`) para gerenciar worktrees físicas e commits atômicos de verdade.

---

## 2. Problemas de Severidade P1 (Altos)

### [BUG-P1-01] Condicional Específico para Testes no Workflow de DAG
- **Categoria:** Orquestração
- **Componente Afetado:** `Workflows::AcPlanExecutionWorkflow`
- **Evidência:** `app/temporal/workflows/ac_plan_execution_workflow.rb:83` (`if input.trigger_review_for_task_id == task_id`).
- **Problema:** O workflow não processa tarefas prontas a menos que o chamador envie um ID específico de teste. Em execuções normais, o workflow itera em vazio até o limite de iterações sem despachar agentes.
- **Solução:** Remover a condicional de teste e disparar workflows filhos (`AcTaskExecutionWorkflow`) de forma assíncrona para todas as tarefas no estado `ready`.

---

### [BUG-P1-02] Supervisão Quebrada e Desconexão Inoperante no Gateway Remoto
- **Categoria:** Ambientes Remotos / SSH
- **Componente Afetado:** `AcRemoteGatewayService`
- **Evidência:** `app/services/ac_remote_gateway_service.rb:68` e `app/services/ac_remote_gateway_service.rb:109`.
- **Problema:** O comando é despachado síncrono com `Open3.capture3`. Se a conexão cair, a consulta de status procura por `.ac_job_<id>.exit`, arquivo que nunca foi escrito pelo comando de despacho. A consulta sempre retornará `RUNNING` indefinidamente.
- **Solução:** Modificar o wrapper de execução remota para rodar com `nohup / disown`, redirecionando saídas e capturando o código de retorno em um arquivo `.exit` ao término (`( ( ... ) > out 2> err ; echo $? > exit ) &`).

---

### [BUG-P1-03] Placebo do Assistente Móvel de Configuração
- **Categoria:** Frontend / UX
- **Componente Afetado:** `app/frontend/pages/AgentControl/MobileSetupWizard.tsx` e `ClientCommandsController`
- **Evidência:** `app/controllers/api/v1/agent_control/client_commands_controller.rb:69-71`.
- **Problema:** O assistente móvel envia `command_type: 'setup_project_wizard'`, que não é tratado pelo backend e cai no `else` (`{ acknowledged: true }`). O usuário recebe feedback de sucesso, mas nenhum projeto ou contexto é gravado.
- **Solução:** Implementar o handler real de `setup_project_wizard` no controller chamando a criação de `Project`, `AcWorkContext` e `AcRemoteEnvironment`.

---

### [BUG-P1-04] Modo de Recuperação em Memória Volátil
- **Categoria:** Resiliência / Concorrência
- **Componente Afetado:** `AcRecoveryService`
- **Evidência:** `app/services/ac_recovery_service.rb:12-25` (`@recovery_mode_active = false`).
- **Problema:** A flag de recuperação reside na memória de um único processo Ruby. Não protege contra concorrência em múltiplos workers Puma ou containers, e é zerada caso o processo reinicie.
- **Solução:** Persistir o estado de modo de recuperação no PostgreSQL ou Redis compartilhado com chave atômica e expiração explícita.

---

### [BUG-P1-05] Método Inexistente em Cutover Mascarado com `rescue nil`
- **Categoria:** Manutenibilidade / Qualidade
- **Componente Afetado:** `AcCutoverManagerService`
- **Evidência:** `app/services/ac_cutover_manager_service.rb:42-51` (`AcDecisionAuditEvent.record_decision! rescue nil`).
- **Problema:** O método `record_decision!` não existe na classe `AcDecisionAuditEvent`. A falha foi ocultada com `rescue nil`, impedindo a auditoria do cutover.
- **Solução:** Implementar o método correspondente ou utilizar `record_human_intervention!` / `create!`.

---

## 3. Problemas de Severidade P2 (Médios)

### [BUG-P2-01] IDOR na Visualização do Grafo de Leitura
- **Categoria:** Segurança
- **Componente Afetado:** `Web::AgentControlController#graph`
- **Evidência:** `app/controllers/web/agent_control_controller.rb:10` (`AcPlan.find(params[:id])`).
- **Problema:** Falta de escopo por locatário; qualquer usuário autenticado pode ver o plano de outra empresa.
- **Solução:** Escopar a busca: `current_user.company.ac_plans.find(params[:id])`.

---

### [BUG-P2-02] Ausência de Bloqueio Transacional em Capacidade Compartilhada
- **Categoria:** Concorrência
- **Componente Afetado:** `AcSharedCapacityCoordinatorService`
- **Evidência:** `app/services/ac_shared_capacity_coordinator_service.rb:29-33`.
- **Problema:** Não usa `SELECT FOR UPDATE` para contar vagas ativas, permitindo condições de corrida onde dois pedidos simultâneos ultrapassam o teto compartilhado. Além disso, conta todos os slots da empresa sem filtrar pela conta de IA solicitada.
- **Solução:** Adicionar lock pessimista e filtrar por `agent_credential_id` ou `account_key`.

---

### [BUG-P2-03] Grafo de Leitura é Apenas Lista de Cards sem Visualização Gráfica
- **Categoria:** UX / Frontend
- **Componente Afetado:** `PlanGraph.tsx`
- **Evidência:** `app/frontend/pages/AgentControl/PlanGraph.tsx:205-220`.
- **Problema:** O grafo de tarefas não renderiza linhas, nós ou diagramas; é apenas uma lista vertical de cartões HTML com badges.
- **Solução:** Integrar visualizador baseado em Canvas / SVG ou biblioteca de grafos leve (React Flow / Cytoscape) conforme planejado em P1.

---

### [BUG-P2-04] Serviço de Importação dos Paseos sem Chamador Operacional
- **Categoria:** Migração / Operações
- **Componente Afetado:** `AcPaseoImportService`
- **Evidência:** O serviço é chamado apenas no teste unitário; não há rake task, endpoint ou UI para dispará-lo.
- **Solução:** Criar uma tarefa Rake (`bin/rails ac:import_paseo[number]`) para permitir o uso operacional pelo administrador.

---

## 4. Problemas de Severidade P3 (Baixos)

### [BUG-P3-01] Teste OpenSSH Pulado no Container Minimal
- **Categoria:** Testes
- **Componente Afetado:** `test/services/agent_control/open_ssh_transport_test.rb`
- **Evidência:** 1 teste ignorado (skip) devido à ausência do cliente `ssh` na imagem Docker de dependências.
- **Solução:** Adicionar `openssh-client` ao `Dockerfile` da imagem `agent-control-f0-rails-deps`.

### [BUG-P3-02] Hardcoding de Diretório Temporário em Worktrees
- **Categoria:** Manutenção
- **Componente Afetado:** `AcWorktreeManagerService` e `AcExecution`
- **Evidência:** `/tmp/ac_worktrees` hardcoded como fallback.
- **Solução:** Mover para variável de configuração `Rails.application.config.ac_worktree_base_dir`.
