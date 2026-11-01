# Inventário Forense e Priorizado de Problemas — Agent Control

**Data da Auditoria:** 01 de Novembro de 2026  
**Auditor Responsável:** Auditor Técnico Independente  
**Metodologia:** Investigação Forense de Código-Fonte, Testes de Reprodução e Inspeção Estática  

---

## Classificação de Severidade Adotada
- **P0 — Crítico:** Falha de segurança, corrupção ou perda de dados, duplicação de execução, violação de autoridade, runtime fantasma ou falha estrutural que impede operação confiável.
- **P1 — Alto:** Funcionalidade essencial incorreta, defeito grave de recuperação, arquitetura com forte acoplamento/divergência ou defeito grave de produção.
- **P2 — Médio:** Problemas de desempenho, manutenção, contratos divergentes entre backend/frontend ou oportunidades importantes.
- **P3 — Baixo:** Ajustes cosméticos, mensagens de erro pouco claras e simplificações não urgentes.

---

### [DEF-01] Runtime de Execução Autônoma Totalmente Simulado (Ghost Runtime)
- **Categoria:** Arquitetura / Runtime Autônomo
- **Severidade:** **P0 — Crítico**
- **Componente Afetado:** `Workflows::AcTaskExecutionWorkflow`, `Activities::AgentControl::AcDispatchExecutionActivity`
- **Evidência:**
  - **Arquivo:** [`app/temporal/activities/agent_control/ac_dispatch_execution_activity.rb:21-25`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/activities/agent_control/ac_dispatch_execution_activity.rb#L21-L25) e [`app/temporal/workflows/ac_task_execution_workflow.rb:110-135`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/workflows/ac_task_execution_workflow.rb#L110-L135).
  - **Função:** `AcDispatchExecutionActivity#run` e `AcTaskExecutionWorkflow#run`.
  - **Comportamento Observado:** O método gera uma string randômica `handle = "ac-proc-#{execution.id}-ep#{reported_epoch}-#{SecureRandom.hex(4)}"`, atualiza o registro no banco para `running` e não dispara nenhum processo de IA. O workflow então chama imediatamente a reconciliação, marcando a tarefa como concluída a partir de inputs estáticos passados pelo teste.
  - **Resultado Esperado:** O workflow deve instanciar o executor real (`SessionService.create_and_start` do Aixle Flow), alocando um container Docker com a CLI configurada (Claude Code, Codex, etc.), injetando o prompt da tarefa, monitorando os logs via PTY/WebSocket e aguardando o encerramento real do processo de IA.
  - **Grau de Confiança:** **Comprovado** (100% observável no código).
- **Causa:**
  - **Causa-Raiz:** A IA anterior optou por implementar apenas a máquina de estados relacional do Temporal sem conectar os cabos de acionamento aos adaptadores nativos do Aixle Flow em `app/services/agents/`.
  - **Consequências Atuais:** O sistema é um "Vilarejo Potemkin". Ele conclui tarefas nos testes sem gerar nenhum código, sem interagir com nenhum LLM e sem alterar nenhum arquivo.
  - **Consequências Futuras:** Impossibilidade absoluta de colocar a plataforma em uso produtivo.
- **Solução:**
  - **Correção Recomendada:** Refatorar `AcDispatchExecutionActivity` para invocar o `SessionService.create_and_start` do Aixle Flow, mapeando `AcExecutionProfile` para o `configured_agent` e executando o container real.
  - **Risco de Regressão:** Baixo nas tabelas do AC; exige que o Docker host esteja disponível no ambiente de produção.
  - **Testes Necessários:** Teste de integração ponta a ponta com agente executando em container simulado (`ContainerRuntime::FakeRuntime`) gerando alteração física em worktree.

---

### [DEF-02] Falha de Autenticação e Multi-Tenancy Inseguro na API do Agent Control
- **Categoria:** Segurança / Controle de Acesso
- **Severidade:** **P0 — Crítico**
- **Componente Afetado:** `Api::V1::AgentControl::ApplicationController`
- **Evidência:**
  - **Arquivo:** [`app/controllers/api/v1/agent_control/application_controller.rb:6-21`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/api/v1/agent_control/application_controller.rb#L6-L21).
  - **Função:** `ApplicationController#resolve_company!`.
  - **Comportamento Observado:** Herda de `ActionController::API` sem incluir `authenticate_user!`. Resolve a empresa por parâmetro `?company_id=` ou header `X-Company-Id` sem checar se o usuário autenticado pertence a ela. Se nada for passado, executa: `@company ||= ::Company.first`.
  - **Resultado Esperado:** Todas as chamadas de API devem exigir sessão autenticada (`authenticate_user!`) ou token de API válido, e garantir que a empresa acessada corresponda a uma `CompanyMembership` válida do usuário chamador.
  - **Grau de Confiança:** **Comprovado**.
- **Causa:**
  - **Causa-Raiz:** Simplificação indevida para facilitar a execução de testes automatizados sem autenticação prévia.
  - **Consequências Atuais:** Qualquer atacante externo na rede pode manipular tarefas, avançar DAGs e disparar comandos remotos no tenant principal ou em qualquer outro tenant.
  - **Consequências Futuras:** Vazamento de dados cross-company e execução não autorizada de código.
- **Solução:**
  - **Correção Recomendada:** Herdar de `Api::V1::ApplicationController` do Aixle Flow, que já implementa autenticação via token/sessão e autorização via Pundit policies.
  - **Testes Necessários:** Teste de requisição anônima esperando 401 Unauthorized e teste de acesso a `company_id` alheio esperando 403 Forbidden.

---

### [DEF-03] Injeção de Comandos Shell no Gateway SSH Remoto
- **Categoria:** Segurança / Execução Remota
- **Severidade:** **P0 — Crítico**
- **Componente Afetado:** `AcRemoteGatewayService`
- **Evidência:**
  - **Arquivo:** [`app/services/ac_remote_gateway_service.rb:64-68`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb#L64-L68).
  - **Função:** `AcRemoteGatewayService.dispatch_operation!`.
  - **Comportamento Observado:** `wrapped_cmd = "cd #{working_directory} && #{command}"` é repassado ao `OpenSshTransport`, que o insere cruamente como argumento do executável `/usr/bin/ssh ... -- user@host remote_command`. O shell remoto interpreta metacaracteres.
  - **Resultado Esperado:** Os parâmetros de diretório e comando devem ser rigorosamente sanitizados com `Shellwords.escape` ou empacotados em script de execução controlada.
  - **Grau de Confiança:** **Comprovado**.
- **Causa:**
  - **Causa-Raiz:** Concatenação ingênua de strings em comandos shell.
  - **Consequências Atuais:** Risco de Remote Code Execution (RCE) no servidor de destino com escape de diretório autorizado.
- **Solução:**
  - **Correção Recomendada:** Utilizar `Shellwords.shellescape(working_directory)` e validar o comando contra uma lista de utilitários permitidos ou executá-lo via script encapsulado com permissões restritas.
  - **Testes Necessários:** Teste com diretório contendo `; rm -rf /tmp/test` garantindo que o comando não seja interpretado pelo shell.

---

### [DEF-04] Protocolo Zumbi no Monitoramento de Operações Remotas
- **Categoria:** Confiabilidade / Sistemas Distribuídos
- **Severidade:** **P1 — Alto**
- **Componente Afetado:** `AcRemoteGatewayService`
- **Evidência:**
  - **Arquivo:** [`app/services/ac_remote_gateway_service.rb:65, 109`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb#L65).
  - **Função:** `AcRemoteGatewayService.dispatch_operation!` vs `query_operation_status!`.
  - **Comportamento Observado:** A consulta de status espera que o arquivo `.ac_job_#{operation.remote_job_id}.exit` exista no destino para ler o código de saída. Porém, o despacho original jamais cria esse arquivo nem redireciona o status da execução para ele.
  - **Resultado Esperado:** O comando despachado deve salvar seu status de término no arquivo esperado: `(cd ... && ...); echo $? > .ac_job_....exit`.
  - **Grau de Confiança:** **Comprovado**.
- **Causa:**
  - **Causa-Raiz:** Discrepância na especificação do wrapper de comando entre o método de despacho e o método de consulta.
  - **Consequências Atuais:** Qualquer job que sofra desconexão ou seja consultado após o despacho fica preso no estado `running` eternamente, retornando `RUNNING` via fallback do `status_query_cmd`.
- **Solução:**
  - **Correção Recomendada:** Ajustar o wrapper de despacho para:
    `"cd #{Shellwords.escape(working_directory)} && ( #{command} ) > .ac_job_#{remote_job_id}.log 2>&1; echo $? > .ac_job_#{remote_job_id}.exit"`.
  - **Testes Necessários:** Teste de consulta de status após execução de comando de sucesso (0) e de falha (1).

---

### [DEF-05] Ausência de Comandos Git Reais em Worktrees e Integração
- **Categoria:** Git / Integridade de Código
- **Severidade:** **P1 — Alto**
- **Componente Afetado:** `AcWorktreeManagerService`, `AcIntegrationService`
- **Evidência:**
  - **Arquivo:** [`app/services/ac_worktree_manager_service.rb:15-40`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_worktree_manager_service.rb#L15-L40), [`app/services/ac_integration_service.rb:58-65`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_integration_service.rb#L58-L65).
  - **Comportamento Observado:** `AcWorktreeManagerService` apenas gera uma string de caminho e salva no banco. `AcIntegrationService` faz a verificação CAS lógica em memória e atualiza `task.state = :integrated`, mas não executa nenhum comando Git real no disco ou no repositório.
  - **Resultado Esperado:** O sistema deve executar `git worktree add` para criar o diretório de trabalho isolado para a tentativa e `git merge` / `git push` condicional na branch de integração.
  - **Grau de Confiança:** **Comprovado**.
- **Causa:**
  - **Causa-Raiz:** O desenvolvimento das Fases F2 e F3 foi focado em satisfazer asserções unitárias em banco relacional, postergando as operações de I/O de disco.
  - **Consequências Atuais:** Nenhuma worktree é de fato criada no sistema de arquivos e nenhum código é mesclado no Git.
- **Solução:**
  - **Correção Recomendada:** Integrar um runner de Git no `AcWorktreeManagerService` que execute os comandos git reais na raiz do projeto configurado.
  - **Testes Necessários:** Teste que crie uma worktree real em diretório temporário e valide a existência de `.git` e branch local.

---

### [DEF-06] Incompatibilidade de Modelo e Rota Quebrada em `Web::AgentControlController`
- **Categoria:** Backend / UX Web
- **Severidade:** **P1 — Alto**
- **Componente Afetado:** `Web::AgentControlController`
- **Evidência:**
  - **Arquivo:** [`app/controllers/web/agent_control_controller.rb:20-25`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/web/agent_control_controller.rb#L20-L25).
  - **Função:** `Web::AgentControlController#wizard`.
  - **Comportamento Observado:** Invoca `current_user&.company` e `current_user&.company_id`. O modelo `User` do Aixle Flow possui apenas `has_many :companies, through: :company_memberships`, não definindo esses métodos diretamente.
  - **Resultado Esperado:** Utilizar o padrão do Aixle Flow: `current_company` ou `current_user.companies.first`.
  - **Grau de Confiança:** **Comprovado** (e comprovado pela ausência de qualquer teste para este controller no repositório).
- **Causa:**
  - **Causa-Raiz:** Código escrito sem teste de controller correspondente.
  - **Consequências Atuais:** Erro 500 (`NoMethodError`) ou envio de dados vazios ao renderizar a tela de configuração móvel.
- **Solução:**
  - **Correção Recomendada:** Substituir `current_user&.company` por `current_company` (definido no `Web::ApplicationController`).
  - **Testes Necessários:** Criar `test/controllers/web/agent_control_controller_test.rb` cobrindo as ações `graph` e `wizard`.

---

### [DEF-07] Formulário do Mobile Setup Wizard com Backend No-Op
- **Categoria:** UX Mobile / Integração
- **Severidade:** **P1 — Alto**
- **Componente Afetado:** `Api::V1::AgentControl::ClientCommandsController`
- **Evidência:**
  - **Arquivo:** [`app/frontend/pages/AgentControl/MobileSetupWizard.tsx:53`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/MobileSetupWizard.tsx#L53) vs [`app/controllers/api/v1/agent_control/client_commands_controller.rb:35-72`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/api/v1/agent_control/client_commands_controller.rb#L35-L72).
  - **Comportamento Observado:** O frontend móvel envia `command_type: 'setup_project_wizard'`. O controller backend não possui branch para esse comando no `case` e cai no `else`, retornando `{ acknowledged: true }` sem persistir nenhum projeto, contexto ou configuração de modelo.
  - **Resultado Esperado:** O backend deve processar a carga útil, criando ou atualizando o `Project`, o `AcWorkContext` e associando o `AcExecutionProfile` escolhido pelo usuário.
  - **Grau de Confiança:** **Comprovado**.
- **Causa:**
  - **Causa-Raiz:** A IA anterior desenvolveu a tela React e a deduplicação de comando, mas esqueceu de implementar o manipulador de negócio no controller.
  - **Consequências Atuais:** Ilusão de funcionamento para o usuário, que recebe mensagem de sucesso na tela sem nenhum efeito real no sistema.
- **Solução:**
  - **Correção Recomendada:** Adicionar a branch `when "setup_project_wizard"` no `handle_command` do `ClientCommandsController`.
  - **Testes Necessários:** Teste de integração de API submetendo o comando e verificando a criação dos registros no banco.

---

### [DEF-08] Race Condition em Concorrência de Capacidade Compartilhada
- **Categoria:** Concorrência / Sistemas Distribuídos
- **Severidade:** **P2 — Médio**
- **Componente Afetado:** `AcSharedCapacityCoordinatorService`
- **Evidência:**
  - **Arquivo:** [`app/services/ac_shared_capacity_coordinator_service.rb:29-45`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_shared_capacity_coordinator_service.rb#L29-L45).
  - **Função:** `AcSharedCapacityCoordinatorService.coordinate_shared_reservation!`.
  - **Comportamento Observado:** O serviço conta os slots locais ativos e valida se a soma com os slots do broker legado respeita o teto. Contudo, não utiliza `lock("FOR UPDATE")` nem persiste imediatamente um `AcCapacityGrant` associado ao token de reserva retornado.
  - **Resultado Esperado:** A reserva compartilhada deve criar atomicamente uma concessão em banco dentro de uma transação com lock, prevenindo que duas requisições concorrentes ultrapassem o teto global.
  - **Grau de Confiança:** **Comprovado**.
- **Causa:**
  - **Causa-Raiz:** Retorno de um token efêmero em memória sem vínculo com a persistência de concessões.
  - **Consequências Atuais:** Risco de estourar a cota global da conta em momentos de alta concorrência entre o Agent Control e o broker legado.
- **Solução:**
  - **Correção Recomendada:** Persistir um registro de `AcCapacityGrant` com estado `granted` dentro de `AcSharedCapacityCoordinatorService.coordinate_shared_reservation!`.

---

### [DEF-09] Discrepância de Contrato em `PlanGraph.tsx` (`attempts_count` vs `attempt_count`)
- **Categoria:** Frontend / Consistência de Dados
- **Severidade:** **P2 — Médio**
- **Componente Afetado:** `PlanGraph.tsx`, `AcDagGraphService`
- **Evidência:**
  - **Arquivo:** [`app/frontend/pages/AgentControl/PlanGraph.tsx:17, 222`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/PlanGraph.tsx#L17) vs [`app/services/ac_dag_graph_service.rb:19`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_dag_graph_service.rb#L19).
  - **Comportamento Observado:** O backend serializa `attempt_count: task.attempt_count`. A interface TypeScript declara `attempts_count: number` e renderiza `Tentativas: {node.attempts_count}/{node.max_attempts}`. Como o campo não coincide, o valor avalia como `undefined` e a tela renderiza `Tentativas: /3`.
  - **Resultado Esperado:** Contratos de payload idênticos entre backend e frontend.
  - **Grau de Confiança:** **Comprovado**.
- **Causa:**
  - **Causa-Raiz:** Falta de sincronização no nome da propriedade (singular no modelo, plural na interface).
  - **Solução:**
  - **Correção Recomendada:** Alterar a interface e a interpolação no React para `attempt_count`.

---

### [DEF-10] Falha Silenciada via `rescue nil` em Auditoria de Cutover
- **Categoria:** Manutenção / Integridade de Auditoria
- **Severidade:** **P2 — Médio**
- **Componente Afetado:** `AcCutoverManagerService`
- **Evidência:**
  - **Arquivo:** [`app/services/ac_cutover_manager_service.rb:41-52`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_cutover_manager_service.rb#L41-L52).
  - **Função:** `AcCutoverManagerService.execute_cutover!`.
  - **Comportamento Observado:** Tenta invocar `AcDecisionAuditEvent.record_decision!(...) rescue nil`. Esse método não existe na classe `AcDecisionAuditEvent`, que define apenas fábricas específicas como `record_profile_selection!`, `record_capacity_granted!`, etc. O erro é silenciado pelo `rescue nil`.
  - **Resultado Esperado:** O evento de auditoria de cutover deve ser gravado com sucesso no log imutável.
  - **Grau de Confiança:** **Comprovado**.
- **Causa:**
  - **Causa-Raiz:** Uso de método inexistente mascarado por cláusula `rescue nil`.
  - **Consequências Atuais:** O cutover é concluído sem registrar o respectivo evento na trilha de auditoria append-only.
- **Solução:**
  - **Correção Recomendada:** Implementar `record_cutover!` em `AcDecisionAuditEvent` ou utilizar `AcDecisionAuditEvent.create!` com os atributos validados.
