# PLANO DE CORREÇÃO PRIORIZADO
## Roteiro de Engenharia para Estabilização e Conclusão do Agent Control

**Data:** 2026-11-01  
**Autor:** Auditoria Técnica Independente de Arquitetura  
**Objetivo:** Estabelecer a ordem estrita de engenharia para eliminar os bloqueadores P0, corrigir as falhas estruturais P1 e preparar a plataforma para homologação real e operação confiável.

---

## 1. Princípios de Execução e Ordem de Dependência

Para evitar retrabalho e desperdício de esforço de desenvolvimento (como corrigir um componente que será descartado ou reestruturado), o plano segue a seguinte sequência lógica:

```
[Fase 1: Fechamento de Segurança] ➔ [Fase 2: Execução Real de Processos e Git] ➔ [Fase 3: Resiliência e Ambientes Remotos] ➔ [Fase 4: Produto e Frontend Real]
```

Nenhum agente autônomo deve ser colocado para rodar em produção enquanto a API estiver exposta sem autenticação (Fase 1). Nenhuma interface visual deve ser finalizada antes de o backend saber executar tarefas reais de verdade (Fase 2).

---

## 2. Fase 1: Blindagem de Segurança e Controle de Acesso (Imediato — Bloqueador P0)

### Tarefa 1.1: Autenticação Rígida na API Agent Control ([BUG-P0-01])
- **Ação:**
  1. Alterar a herança de `Api::V1::AgentControl::ApplicationController` para `Api::V1::ApplicationController`.
  2. Implementar autenticação obrigatória via `before_action :authenticate_user!` ou validação de Bearer Token JWT assinado com chave secreta do host.
  3. Eliminar o fallback `@company ||= ::Company.first`. Se a empresa não for identificada e vinculada à sessão do usuário autenticado, retornar `401 Unauthorized` ou `403 Forbidden`.
  4. Escopar as buscas em `DagGraphsController` e `ClientCommandsController` para `current_user.company`.
- **Critérios de Aceite:**
  - Requisição sem credenciais retorna HTTP 401;
  - Requisição com credencial da Empresa A não consegue consultar nem emitir comandos na Empresa B (retorna HTTP 403);
  - Fim da atribuição automática para `Company.first`.
- **Testes de Regressão:** `test/controllers/api/v1/agent_control/security_auth_test.rb`.

### Tarefa 1.2: Sanitização e Whitelisting de Comandos Remotos ([BUG-P0-01])
- **Ação:**
  1. No `AcRemoteGatewayService`, criar uma lista de permissões (`authorized_command_patterns`) por ambiente cadastrado (ex: apenas `bundle exec rake test*`, `npm test`, `git status`, `git checkout`).
  2. Rejeitar qualquer comando que utilize metacaracteres perigosos (`|`, `;`, `&&`, `` ` ``, `$()`) a menos que explicitamente autorizado em modo restrito.
  3. Utilizar `Shellwords.escape` no caminho de diretório de trabalho antes de concatenar `cd #{escaped_dir}`.
- **Critérios de Aceite:**
  - Tentativa de injetar comandos com `; rm -rf` é abortada com `UnauthorizedRemoteCommandError`.
  - Tentativa de executar comandos fora do whitelist configurado é bloqueada.

### Tarefa 1.3: Correção de IDOR no Grafo Web ([BUG-P2-01])
- **Ação:** No `Web::AgentControlController#graph`, alterar `AcPlan.find(params[:id])` para `current_user.company.ac_plans.find(params[:id])`.
- **Critérios de Aceite:** Tentativa de acessar ID de plano alheio resulta em `ActiveRecord::RecordNotFound` (404).

---

## 3. Fase 2: Execução Real de Processos e Operações Git Físicas (Essencial — Bloqueador P0)

### Tarefa 2.1: Implementação Real do Despacho de Processos dos Agentes ([BUG-P0-02])
- **Ação:**
  1. Modificar `Activities::AgentControl::AcDispatchExecutionActivity` para não gerar apenas strings falsas.
  2. Obter o perfil de execução (`AcExecutionProfile`) e a credencial associada (`AgentCredential`).
  3. Invocar o adaptador correspondente (reaproveitando `app/services/agents/codex_adapter.rb`, `claude_code_adapter.rb` ou `grok_adapter.rb`).
  4. Lançar o subprocesso não-interativo oficial via `Open3.popen3` ou container isolado, passando as instruções da tarefa e a worktree como diretório de trabalho.
  5. Salvar o PID real ou container handle estável em `process_handle`.
  6. No `AcReconcileExecutionActivity`, ler a saída real gerada pelo processo/container (stdout, stderr, exit code, token metrics) e gravar no banco de dados.
- **Critérios de Aceite:**
  - A execução de uma tarefa de teste cria um processo físico mensurável no host/container;
  - Logs de execução contêm saída real gerada pela CLI;
  - Tokens e tempo de inferência são contabilizados a partir da execução efetiva.
- **Testes de Regressão:** Teste de integração de ponta a ponta com subprocesso simulado de CLI (usando fixture segura não paga).

### Tarefa 2.2: Isolamento Físico de Worktrees Git ([BUG-P0-04])
- **Ação:**
  1. Modificar `AcWorktreeManagerService.acquire_lease!` para executar comandos Git reais:
     `git worktree add -b <branch_task> <target_path> <base_commit>`
  2. Ao liberar a lease (`release_lease!`), executar `git worktree remove --force <target_path>` e `git worktree prune`.
  3. Garantir tratamento de exceção se o diretório já existir ou se a branch estiver em uso.
- **Critérios de Aceite:**
  - O diretório físico da worktree é criado no disco durante a execução da tarefa;
  - O diretório é limpo e removido após a conclusão reconciliada.
- **Testes de Regressão:** `test/services/ac_worktree_manager_service_real_git_test.rb`.

### Tarefa 2.3: Integração Git Atômica Real ([BUG-P0-04])
- **Ação:**
  1. No `AcIntegrationService`, além de validar se a tarefa está aprovada e se a base esperada coincide, executar o comando Git de atualização de referência:
     `git update-ref refs/heads/<branch> <candidate_commit> <expected_base_commit>`
  2. Em caso de falha no CAS do Git, abortar com `ConcurrentBranchModificationError`.
- **Critérios de Aceite:**
  - A branch do repositório Git avança fisicamente para o commit candidato aprovado;
  - Uma corrida simultânea de branch rejeita a atualização sem corromper o repositório.

### Tarefa 2.4: Remoção de Condicionais de Teste no Workflow de DAG ([BUG-P1-01])
- **Ação:**
  1. Em `Workflows::AcPlanExecutionWorkflow`, remover a cláusula `if input.trigger_review_for_task_id == task_id`.
  2. Para cada `ready_task_id`, disparar o workflow de execução de tarefa correspondente de forma assíncrona ou em lote paralelo.
  3. Conectar a transição de estado da tarefa à avaliação dos pareceres independentes.
- **Critérios de Aceite:**
  - O workflow de plano avança autonomamente pelo DAG até a conclusão de todas as tarefas prontas sem exigir intervenção de parâmetros de teste.

---

## 4. Fase 3: Resiliência, Recuperação e Gateway Remoto Persistente (P1)

### Tarefa 3.1: Supervisão Remota Persistente com Traps de Término ([BUG-P1-02])
- **Ação:**
  1. Em `AcRemoteGatewayService.dispatch_operation!`, encapsular o comando em um script shell remoto desanexado:
     ```bash
     nohup sh -c '( {COMMAND} ) > {WORK_DIR}/.ac_job_{JOB_ID}.log 2>&1 ; echo $? > {WORK_DIR}/.ac_job_{JOB_ID}.exit' > /dev/null 2>&1 &
     ```
  2. A consulta `query_operation_status!` deve verificar a existência do arquivo `.exit` para obter o status e ler `.log` para capturar a saída.
  3. Implementar limpeza programada dos arquivos temporários de job após a reconciliação.
- **Critérios de Aceite:**
  - Queda de conexão SSH durante um comando de longa duração não perde o resultado;
  - Reconexão posterior lê o arquivo `.exit` e obtém o código de término exato do processo.

### Tarefa 3.2: Reidratação Real de Banco em Restauração de Desastres ([BUG-P0-03])
- **Ação:**
  1. Em `AcRecoveryService.restore_from_manifest!`, implementar a ingestão das tabelas presentes no nó `manifest["entities"]`.
  2. Desativar temporariamente constraints de chave estrangeira durante a carga ou inserir respeitando a árvore de dependência (`companies` ➔ `ac_work_contexts` ➔ `ac_plans` ➔ `ac_tasks` ➔ `ac_executions` ➔ `ac_review_verdicts`).
  3. Chamar `reconcile_active_executions!` e `neutralize_orphan_leases!` após a carga dos dados.
- **Critérios de Aceite:**
  - Teste automatizado apaga as tabelas no banco de testes, restaura a partir de um manifesto exportado e comprova que todos os registros foram recriados com 100% de fidelidade de dados.

### Tarefa 3.3: Persistência do Modo de Recuperação ([BUG-P1-04])
- **Ação:** Substituir a variável de instância `@recovery_mode_active` por uma tabela de controle no PostgreSQL (`system_settings`) ou chave Redis com TTL.
- **Critérios de Aceite:** O modo de recuperação permanece ativo mesmo se o processo Rails reiniciar ou se múltiplos workers Puma atenderem as requisições.

### Tarefa 3.4: Eliminação de Métodos Inexistentes e `rescue nil` ([BUG-P1-05])
- **Ação:** Em `AcCutoverManagerService`, implementar explicitamente o registro de auditoria via `AcDecisionAuditEvent.record_human_intervention!` ou `create!`, eliminando a chamada fictícia e removendo o `rescue nil`.

---

## 5. Fase 4: Frontend, Mobile e Painel Administrativo Real (P1 e P2)

### Tarefa 4.1: Conexão do Assistente Móvel ao Backend ([BUG-P1-03])
- **Ação:**
  1. No `ClientCommandsController#handle_command`, adicionar o caso `setup_project_wizard`.
  2. O handler deve criar transacionalmente o `Project`, o `AcWorkContext`, vincular o `AcRemoteEnvironment` e publicar a `AcPolicyRevision` com os papéis configurados pelo celular.
- **Critérios de Aceite:**
  - Submissão pelo celular cria registros reais e navegáveis na base de dados.

### Tarefa 4.2: Tela de Gestão de Contas, Modelos e Políticas (RF-07, RF-08, RF-30)
- **Ação:**
  1. Desenvolver página Inertia React (`app/frontend/pages/AgentControl/Policies.tsx`) para permitir visualizar e alterar a cadeia de modelos por papel, nível de esforço e prioridades.
  2. Adicionar painel de observabilidade de cotas consumidas e status das contas oficiais.

### Tarefa 4.3: Rake Task Operacional de Importação dos Paseos ([BUG-P2-04])
- **Ação:** Criar `lib/tasks/ac_paseo.rake` com comando `rails ac:import_paseo[json_path]` permitindo ao operador carregar os históricos dos Paseos antigos em modo read-only de maneira assistida.

---

## 6. Matriz de Verificação e Homologação Final

Ao término da execução deste plano, a plataforma deverá ser submetida a uma re-auditoria completa:
1. **Verificação de Segurança:** Scanner de penetração nos endpoints de API sem autenticação;
2. **Prova de Execução Real:** Criação de um projeto piloto executando um teste com subprocesso CLI que altera arquivos em worktree física e gera diffs reais;
3. **Prova de Restauração:** Simulação de queda de banco com restore verificado via manifesto.
