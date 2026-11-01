# INVENTÁRIO CONSOLIDADO DE ACHADOS, VULNERABILIDADES E DEFEITOS

**Data da Auditoria:** 2026-11-01  
**Repositório:** `/home/enok/Documentos/projetos/agent-control`  
**Commit Auditado:** `d1408687c801d7615c1794f09f3ca18257a78444` (HEAD -> master)  
**Especificação de Referência:**
- `docs/PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md` (RF-01 a RF-54, T01 a T36)
- `docs/ADENDO_FINAL_PLANO_v1.1_G0_2026-10-31.md` (RF-55 a RF-57, T37 a T39)
- `docs/ADR-001-BASE-DA-PLATAFORMA.md` & `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md`

Este documento é a **ÚNICA FONTE DE VERDADE** para os achados desta auditoria. Todos os demais documentos e relatórios referenciam os itens aqui catalogados por seus respectivos IDs únicos.

---

## 1. Sumário Executivo dos Achados

| ID | Tipo Normativo | Severidade | Requisito / Garantia Afetada | Componente / Arquivo Principal | Descrição Sucinta |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DEF-01** | Defeito comprovado | **P0 (Crítico)** | RF-22, RF-23, RF-47, RF-54, RNF-01, T07, T08 | `AcTaskExecutionWorkflow` / `AcReconcileExecutionActivity` | Reconciliação prematura de processos: exit 0 assumido com `Process::WNOHANG` e remoção da worktree enquanto processo roda |
| **DEF-02** | Defeito comprovado | **P0 (Crítico)** | RF-15, RF-16, RF-18, RF-25, G3-E1 | `AcPlanExecutionWorkflow` | DAG Potemkin: avanço de plano sem invocar trabalhador, gerando hashes fictícios e aprovação automática |
| **DEF-03** | Requisito ausente na fase | **P1 (Alto)** | RF-05, RNF-03, T01 | `db/schema.rb` (`agent_credentials`) | Bloqueio estrutural de duas contas do mesmo provedor por índice único upstream `(user_id, company_id, agent_type)` |
| **DEF-04** | Defeito comprovado | **P1 (Alto)** | RF-57, T38 | `AcReviewService#meets_approval_requirements?` | Dispensa de QA (`waived`) não é aceita como condição de aprovação, bloqueando avanço legítimo per Adendo Final §3 |
| **DEF-05** | Defeito comprovado | **P1 (Alto)** | RF-31, RF-34, RF-52, T18, T30 | `AcBackupService` / `AcRecoveryService` | Omissão de auditoria e concessões no manifesto de backup; colisão de sequences de PK após reidratação no PostgreSQL |
| **DEF-06** | Risco fundamentado | **P2 (Médio)** | RF-26, RF-27, RNF-08 | `AcRemoteGatewayService#query_operation_status!` | Ausência de `Shellwords.shellescape` em `working_directory` durante consulta de status de jobs SSH |
| **DEF-07** | Requisito ausente na fase | **P1 (Alto)** | RF-07, RF-24, RF-32, RF-44, RNF-04, T16, T27 | `PlanGraph.tsx` / `MobileSetupWizard.tsx` | Ausência de botões e fluxos para pausar, retomar ou cancelar planos na UI web/móvel e sem gestão de políticas/cotas |
| **DEF-08** | Risco fundamentado | **P2 (Médio)** | RNF-06, RNF-09 | `agent-control-f0-rails-deps:4.0.9` / `ac_physical_git_test.rb` | Imagem Docker base de dependências não inclui o binário `git`, gerando `Errno::ENOENT` se não montado externamente |
| **REQ-FUT-01** | Requisito de fase futura | **P2 (Médio)** | RF-56, T37 | `AcWorkContext` / `AcPolicyEngineService` | Seleção regular preservada por contexto de trabalho (previsto no Adendo Final §2 para fechar antes de G1) |
| **DIV-INT-01** | Divergência documentada | **Informativo** | RF-55, T39, ADR-002 | `ADR-002` / `AcExecutionProfile` | Desativação prévia do transporte Antigravity CLI consumidor para encapsulamento autônomo per Adendo Final §4 |

---

## 2. Fichas Detalhadas dos Problemas e Riscos

---

### [DEF-01] Reconciliação Prematura de Processos com Destruição Assíncrona de Worktree (Falso Positivo de Execução e Perda de Dados)

- **ID Único:** `DEF-01`
- **Tipo:** Defeito comprovado
- **Severidade:** **P0 (Crítico)**
- **Requisito ou Garantia Afetada:** RF-22 (workflow durável), RF-23 (reconciliação sem repetição), RF-47 (liberação segura de recursos), RF-54 (escritor único de worktree), RNF-01 (continuidade sem perda de comandos), Cenários T07 e T08.
- **Versão, Arquivo e Localização:**
  - Commit: `d1408687c801d7615c1794f09f3ca18257a78444`
  - [`app/temporal/workflows/ac_task_execution_workflow.rb:110-139`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/workflows/ac_task_execution_workflow.rb#L110-L139)
  - [`app/temporal/activities/agent_control/ac_dispatch_execution_activity.rb:29-42`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/activities/agent_control/ac_dispatch_execution_activity.rb#L29-L42)
  - [`app/temporal/activities/agent_control/ac_reconcile_execution_activity.rb:19-27`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/activities/agent_control/ac_reconcile_execution_activity.rb#L19-L27)
  - [`app/services/ac_worktree_manager_service.rb:72-83`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_worktree_manager_service.rb#L72-L83)
- **Condições em que o Problema Ocorre:** Execução de qualquer tarefa física onde um comando real é despachado via `Open3.popen3`.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Demonstrado por Inspeção de Código e Análise de Fluxo)**.
  1. Em `AcDispatchExecutionActivity` (linhas 30-34):
     ```ruby
     stdin, stdout, stderr, wait_thr = Open3.popen3(cmd, chdir: worktree)
     stdin.close
     pid = wait_thr.pid
     handle = "pid-#{pid}"
     ```
     Os descritores `stdout` e `stderr` não são consumidos em background nem fechados. Se o comando produzir mais de 64 KB de output (tamanho padrão do pipe buffer do Linux), o subprocesso é bloqueado indefinidamente.
  2. Em `AcTaskExecutionWorkflow` (linhas 110-125):
     O workflow executa `ac_dispatch_execution_activity` e, imediatamente na sequência (sem nenhum loop de polling, wait de condição ou timer), executa `ac_reconcile_execution_activity`.
  3. Em `AcReconcileExecutionActivity` (linhas 22-26):
     ```ruby
     _, status = Process.wait2(pid, Process::WNOHANG)
     exit_code = status ? (status.exitstatus || 0) : 0
     ```
     Como o processo acabou de ser iniciado milissegundos antes, `Process.wait2(pid, Process::WNOHANG)` retorna `nil`. A expressão ternária avalia `status ? ... : 0`, assumindo **`exit_code = 0`**!
  4. Na sequência do workflow (linhas 136-139), é chamada `ac_release_capacity_activity`, que invoca:
     ```ruby
     AcWorktreeManagerService.release_lease!(execution: execution)
     # que executa:
     FileUtils.rm_rf(target_path) if target_path.present? && Dir.exist?(target_path)
     ```
     O diretório da worktree é **deletado fisicamente do disco** enquanto o processo filho ainda está executando dentro dele!
- **Impacto:** Catastrófico. O sistema relata à orquestração que a tarefa concluiu com sucesso (`exit_code = 0`) e avança para a fase de revisão, enquanto o código não foi compilado ou gerado, o processo filho é abruptamente corrompido ou deixado órfão escrevendo em um diretório apagado, e os dados são perdidos.
- **Causa-raiz:** Implementação sincrônica simplista de atividades no Temporal que misturou lançamento (`popen3`) com reconciliação imediata não bloqueante (`WNOHANG`), sem desacoplar a atividade em um padrão assíncrono real de supervisão com heartbeats (Activity Completion Token ou Polling supervisionado).
- **Correção Proposta:**
  1. Em `AcDispatchExecutionActivity`, redirecionar `stdout` e `stderr` para arquivo em disco (`.ac_execution.log`) usando spawn desacoplado com processo supervisor ou `Process.spawn(cmd, out: log_file, err: log_file)`.
  2. Implementar atividade de polling/espera no Temporal (`AcObserveExecutionActivity`) com heartbeat periódico informando se o PID ainda existe (`Process.kill(0, pid)`).
  3. Em `AcReconcileExecutionActivity`, somente assumir conclusão quando o processo tiver efetivamente terminado e o exit code real for colhido.
  4. Proibir a liberação da worktree enquanto o processo estiver em estado de execução.
- **Critério Verificável de Encerramento:** Teste automatizado executando `sleep 3 && touch success.txt`, demonstrando que: (a) o workflow aguarda os 3 segundos; (b) a worktree permanece intacta até o encerramento do processo; (c) o arquivo `success.txt` é validado antes de qualquer liberação de lease.

---

### [DEF-02] DAG Potemkin: Avanço de Plano sem Invocar Trabalhador com Hashes Fictícios e Aprovação Automática

- **ID Único:** `DEF-02`
- **Tipo:** Defeito comprovado
- **Severidade:** **P0 (Crítico)**
- **Requisito ou Garantia Afetada:** RF-15 (planos versionados), RF-16 (paralelismo e serialização), RF-18 (revisão independente), RF-25 (integrar somente artefato aprovado), Gate G3 (G3-E1).
- **Versão, Arquivo e Localização:**
  - Commit: `d1408687c801d7615c1794f09f3ca18257a78444`
  - [`app/temporal/workflows/ac_plan_execution_workflow.rb:78-121`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/workflows/ac_plan_execution_workflow.rb#L78-L121)
- **Condições em que o Problema Ocorre:** Execução normal do workflow de plano `AcPlanExecutionWorkflow`.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Demonstrado por Inspeção de Código)**.
  No loop de tarefas prontas do DAG:
  ```ruby
  ready_task_ids.each do |task_id|
    ...
    artifact_hash = (input.trigger_review_for_task_id == task_id && input.review_artifact_hash.presence) ||
                    "hash-default-#{task_id}"
    verdict = (input.trigger_review_for_task_id == task_id && input.review_verdict.presence) ||
              "approved"
    evaluator = (input.trigger_review_for_task_id == task_id && input.evaluator_identity.presence) ||
                "independent-reviewer"

    execute_activity(activities.ac_review_task_activity, { ... })
    if verdict == "approved"
      execute_activity(activities.ac_integrate_task_activity, {
        task_id: task_id,
        expected_base_commit: input.expected_base_commit || "main-base",
        candidate_commit: input.candidate_commit || "cand-commit-#{task_id}",
        current_branch_head: input.current_branch_head || "main-base",
        artifact_hash: artifact_hash
      })
    end
  end
  ```
  O workflow **nunca invoca** `AcTaskExecutionWorkflow` ou qualquer trabalhador de programação para as tarefas prontas. Ele fabrica hashes fictícios (`hash-default-...`), autoemite parecer `approved` de um suposto `independent-reviewer`, e imediatamente comita e integra commits artificiais (`cand-commit-...`) sem nenhuma verificação de código.
- **Impacto:** O orquestrador de planos é uma casca oca ("efeito Potemkin"). Nenhuma tarefa de plano é efetivamente desenvolvida por agentes; os planos transitam para `completed` de forma fraudulenta perante os requisitos do Plano Mestre.
- **Causa-raiz:** Implementação do workflow voltada unicamente a satisfazer testes unitários sintéticos de transição de estado da máquina de estados, sem conexão com a infraestrutura real de execução.
- **Correção Proposta:**
  Substituir o bloco de geração estática de aprovação pelo despacho de child workflow `AcTaskExecutionWorkflow` para cada tarefa pronta, coletar o `artifact_hash` real gerado pela execução do trabalhador, e somente após isso despachar a atividade de revisão com sessão independente.
- **Critério Verificável de Encerramento:** Execução de workflow de plano com 2 tarefas encadeadas onde a tarefa 2 só inicia após a tarefa 1 ter sido fisicamente executada por um worker e aprovada com hash criptográfico de um commit real no Git.

---

### [DEF-03] Bloqueio Estrutural de Múltiplas Contas do Mesmo Provedor por Índice Único Upstream

- **ID Único:** `DEF-03`
- **Tipo:** Requisito ausente na fase em que já deveria existir
- **Severidade:** **P1 (Alto)**
- **Requisito ou Garantia Afetada:** RF-05 ("Representar duas contas do mesmo provedor sem usuários/empresas artificiais"), RNF-03, Cenário T01.
- **Versão, Arquivo e Localização:**
  - Commit: `d1408687c801d7615c1794f09f3ca18257a78444`
  - [`db/schema.rb:429`](file:///home/enok/Documentos/projetos/agent-control/db/schema.rb#L429)
  - [`app/models/agent_credential.rb`](file:///home/enok/Documentos/projetos/agent-control/app/models/agent_credential.rb)
- **Condições em que o Problema Ocorre:** Tentativa de provisionar duas contas de assinatura do mesmo provedor (ex: duas contas OpenAI Codex, sendo uma para o gerente e outra exclusiva para programação, conforme o plano §9.1 e T01) para a mesma empresa e usuário.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Verificação de Schema de Banco)**.
  No schema herdado do Aixle Flow upstream:
  ```ruby
  t.index ["user_id", "company_id", "agent_type"], name: "index_agent_credentials_on_user_company_agent", unique: true
  ```
  Não foi criada nenhuma migração nas fases F0 ou F1 para permitir contas adicionais do mesmo `agent_type`. A tentativa de salvar uma segunda credencial com `agent_type: "codex"` lança:
  `ActiveRecord::RecordNotUnique: PG::UniqueViolation: ERROR: duplicate key value violates unique constraint "index_agent_credentials_on_user_company_agent"`.
- **Impacto:** O sistema é estruturalmente incapaz de cumprir o RF-05 e o Cenário T01 na camada de persistência. A única forma de contornar seria cadastrar empresas ou usuários falsos, violando expressamente a especificação.
- **Causa-raiz:** Deficiência herdada do modelo de dados upstream que não foi adaptada pelo projeto Agent Control durante a Fase F1.
- **Correção Proposta:**
  Criar migration Rails:
  1. Adicionar coluna `account_slug` (string, default: "default") em `agent_credentials`.
  2. Remover o índice único `index_agent_credentials_on_user_company_agent`.
  3. Adicionar novo índice único: `add_index :agent_credentials, [:user_id, :company_id, :agent_type, :account_slug], unique: true, name: "index_agent_credentials_on_user_company_agent_slug"`.
- **Critério Verificável de Encerramento:** Teste criando duas instâncias de `AgentCredential` com `agent_type: "codex"` vinculadas ao mesmo `user` e `company` com slugs `codex-manager` e `codex-programmer`, e vinculação correspondente em dois `AcExecutionProfile` distintos.

---

### [DEF-04] Parecer de Dispensa de QA (`waived`) Bloqueia Aprovação da Tarefa em `AcReviewService`

- **ID Único:** `DEF-04`
- **Tipo:** Defeito comprovado
- **Severidade:** **P1 (Alto)**
- **Requisito ou Garantia Afetada:** RF-57 ("Modelar dispensa de QA como resultado explícito de política, separado de ausência, falha e cancelamento"), Cenário T38, Adendo Final §3.
- **Versão, Arquivo e Localização:**
  - Commit: `d1408687c801d7615c1794f09f3ca18257a78444`
  - [`app/services/ac_review_service.rb:111-116`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_review_service.rb#L111-L116)
- **Condições em que o Problema Ocorre:** Quando uma tarefa com classe de risco que exige QA (`requires_qa? == true`) recebe um parecer legítimo de dispensa de QA (`verdict: :waived`) emitido conforme as regras de política do template.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Demonstrado por Inspeção de Código)**.
  Em `AcReviewService.meets_approval_requirements?`:
  ```ruby
  if task.requires_qa?
    qa_approved = task.ac_review_verdicts
                      .where(state: :valid, verdict: :approved, reviewer_role: :qa, artifact_hash: artifact_hash)
                      .exists?
    return false unless qa_approved
  end
  ```
  O método consulta estritamente `verdict: :approved`. Mesmo que exista um registro válido com `verdict: :waived` (que é um valor permitido na constraint do banco de `ac_review_verdicts`), a expressão retorna `false`.
- **Impacto:** O Refinamento B do Adendo Final (RF-57 / T38) é descumprido no caminho crítico: uma dispensa válida de QA não permite avançar a entrega, travando o pipeline.
- **Causa-raiz:** Falta de suporte ao valor `:waived` na cláusula `where` de verificação de aprovação.
- **Correção Proposta:**
  Atualizar a verificação para:
  ```ruby
  if task.requires_qa?
    qa_satisfied = task.ac_review_verdicts
                       .where(state: :valid, verdict: %w[approved waived], reviewer_role: :qa, artifact_hash: artifact_hash)
                       .exists?
    return false unless qa_satisfied
  end
  ```
- **Critério Verificável de Encerramento:** Teste unitário em `AcReviewServiceTest` submetendo parecer de QA com `verdict: :waived` e parecer de revisão de código com `verdict: :approved` para a mesma tarefa, verificando que a tarefa transiciona com sucesso para `approved`.

---

### [DEF-05] Omissão de Auditoria e Concessões no Manifesto de Backup com Risco de Colisão de Sequências no PostgreSQL

- **ID Único:** `DEF-05`
- **Tipo:** Defeito comprovado
- **Severidade:** **P1 (Alto)**
- **Requisito ou Garantia Afetada:** RF-31 (auditoria imutável append-only), RF-34 (backup e restauração), RF-52 (modo de recuperação), Cenários T18 e T30.
- **Versão, Arquivo e Localização:**
  - Commit: `d1408687c801d7615c1794f09f3ca18257a78444`
  - [`app/services/ac_backup_service.rb:27-36`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_backup_service.rb#L27-L36)
  - [`app/services/ac_recovery_service.rb:130-138, 158-170`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_recovery_service.rb#L130-L138)
- **Condições em que o Problema Ocorre:** Ao realizar backup via `AcBackupService.export_manifest` e restaurar o estado via `AcRecoveryService.restore_from_manifest!`.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Demonstrado por Inspeção de Código)**.
  1. Em `AcBackupService.export_manifest`:
     As tabelas `ac_decision_audit_events`, `ac_capacity_grants` e `ac_quota_observations` não fazem parte do dicionário `entities`. Todo o log de auditoria exigido pelo RF-31 é descartado no backup.
  2. Em `AcRecoveryService.rehydrate_entity`:
     Os registros são inseridos com IDs explícitos via `find_or_initialize_by(id: attrs["id"])` e `save!(validate: false)`. O PostgreSQL não avança o ponteiro das sequences (`bigserial`/`identity`). Novas inserções que dependem do autoincremento disparam `PG::UniqueViolation`.
  3. Em `AcRecoveryService.reconcile_active_executions!`:
     O método tenta revogar `execution.ac_capacity_grant`, mas como `ac_capacity_grants` não foi restaurada, a concessão é nula, deixando capacidade órfã em bases onde ela existia.
- **Impacto:** Perda irreversível de trilha de auditoria em backups de desastre e colapso operacional da base de dados restaurada na primeira tentativa de criação de novos registros.
- **Causa-raiz:** Implementação incompleta da lista de tabelas a exportar e ausência de chamada a `reset_pk_sequence!` no adaptador do PostgreSQL.
- **Correção Proposta:**
  1. Incluir `ac_decision_audit_events`, `ac_capacity_grants` e `ac_quota_observations` no hash de entidades e checksums do manifesto.
  2. Ao final de `rehydrate_entity`, executar `ActiveRecord::Base.connection.reset_pk_sequence!(model_class.table_name)` para sincronizar os ponteiros das sequences.
- **Critério Verificável de Encerramento:** Teste exportando manifesto de uma company com 5 eventos de auditoria e 2 concessões, restaurando em banco de teste e executando `create!` com sucesso em todas as tabelas afetadas sem erro de sequence.

---

### [DEF-06] Injeção de Shell Potencial por Ausência de Escape em `status_query_cmd` do Gateway SSH

- **ID Único:** `DEF-06`
- **Tipo:** Risco fundamentado
- **Severidade:** **P2 (Médio)**
- **Requisito ou Garantia Afetada:** RF-26 (operações autorizadas em destinos remotos), RF-27 (preservação de identidade SSH), RNF-08 (segurança).
- **Versão, Arquivo e Localização:**
  - Commit: `d1408687c801d7615c1794f09f3ca18257a78444`
  - [`app/services/ac_remote_gateway_service.rb:121`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb#L121)
- **Condições em que o Problema Ocorre:** Consulta de status de operação remota via `query_operation_status!` quando o `working_directory` cadastrado contém espaços, aspas ou caracteres especiais de shell.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 95% (Demonstrado por Inspeção de Código)**.
  Na linha 121:
  ```ruby
  status_query_cmd = "test -f #{operation.working_directory}/.ac_job_#{operation.remote_job_id}.exit && cat #{operation.working_directory}/.ac_job_#{operation.remote_job_id}.exit || echo RUNNING"
  ```
  Ao contrário de `build_wrapped_command` (onde `escaped_dir = Shellwords.shellescape(working_directory)` foi implementado no commit `85573e4`), na consulta de status a interpolação foi mantida crua.
- **Impacto:** Falha na detecção de término de jobs legítimos em diretórios com espaços (ex: `/var/www/meu projeto`), fazendo com que o job seja erroneamente marcado como `uncertain`.
- **Causa-raiz:** Remediação parcial de sanitização no commit `85573e4`.
- **Correção Proposta:**
  Aplicar `Shellwords.shellescape` em `operation.working_directory` antes de montar a string `status_query_cmd`.
- **Critério Verificável de Encerramento:** Teste unitário passando `working_directory: "/opt/app dir with spaces"` e validando que o comando montado escapa corretamente os caminhos.

---

### [DEF-07] Ausência de Controles Operacionais no Frontend Móvel/Web (Pausar, Retomar, Cancelar e Gestão de Políticas)

- **ID Único:** `DEF-07`
- **Tipo:** Requisito ausente na fase em que já deveria existir
- **Severidade:** **P1 (Alto)**
- **Requisito ou Garantia Afetada:** RF-07 (configurar papel/modelo visualmente), RF-24 (pausar/retomar/cancelar visíveis), RF-32 (percursos essenciais no celular), RF-44 (preservação de pausas), RNF-04 (experiência móvel).
- **Versão, Arquivo e Localização:**
  - Commit: `d1408687c801d7615c1794f09f3ca18257a78444`
  - [`app/frontend/pages/AgentControl/PlanGraph.tsx`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/PlanGraph.tsx)
  - [`app/frontend/pages/AgentControl/MobileSetupWizard.tsx`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/MobileSetupWizard.tsx)
- **Condições em que o Problema Ocorre:** Uso da interface web ou móvel pelo operador para gerenciar o ciclo de vida de planos em andamento.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Inspeção de Código React/TypeScript)**.
  1. Em `PlanGraph.tsx`:
     Apenas uma ação é oferecida: `executeDeduplicatedAdvance` (dispara `command_type: 'advance_dag'`). Não existem botões para Pausar, Retomar ou Cancelar o plano.
  2. Não há telas ou componentes no namespace `AgentControl` para:
     - Visualizar e alterar as cadeias de substituição de modelos (RF-07);
     - Acompanhar cota e renovação por conta (RF-30);
     - Gerenciar a autoridade e cutover (RF-46).
- **Impacto:** O produto é inoperável para os fluxos essenciais de governança autônoma (pausa humana de emergência) pelo celular sem o uso de chamadas de API manuais ou console.
- **Causa-raiz:** Escopo de frontend da Fase F5 foi reduzido à renderização visual estática do DAG e a um assistente de criação simplificado.
- **Correção Proposta:**
  1. Adicionar botões `Pausar Plano`, `Retomar Plano` e `Cancelar Plano` em `PlanGraph.tsx`, emitindo comandos `pause_plan`, `resume_plan` e `cancel_plan` via `ClientCommandsController`.
  2. Implementar página ou aba `Policies` no celular para inspeção da cadeia de substituição ativa.
- **Critério Verificável de Encerramento:** Demonstração visual e funcional de acionamento do botão de pausa no celular, com mudança imediata do badge de estado para `paused` e bloqueio de novos disparos no backend.

---

### [DEF-08] Dependência Oculta de Ambiente para Testes de Git Físico na Imagem Docker de Dependências

- **ID Único:** `DEF-08`
- **Tipo:** Risco fundamentado
- **Severidade:** **P2 (Médio)**
- **Requisito ou Garantia Afetada:** RNF-06 (manutenibilidade), RNF-09 (reprodutibilidade das baterias de testes).
- **Versão, Arquivo e Localização:**
  - Imagem Docker: `agent-control-f0-rails-deps:4.0.9`
  - Arquivo de Teste: [`test/services/ac_physical_git_test.rb:19`](file:///home/enok/Documentos/projetos/agent-control/test/services/ac_physical_git_test.rb#L19)
- **Condições em que o Problema Ocorre:** Execução da suíte de testes dentro do contêiner Docker isolado `agent-control-f0-rails-deps:4.0.9` sem bind-mount explícito dos binários de Git do host.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Comprovado por Execução Real em Terminal)**.
  Ao executar:
  `docker run --rm agent-control-f0-rails-deps:4.0.9 bin/rails test test/services/ac_physical_git_test.rb`
  A execução falha imediatamente com 2 erros: `Errno::ENOENT: No such file or directory - git` porque a imagem base do contêiner não possui o utilitário `git` instalado em seu sistema de arquivos interno.
- **Impacto:** Ambientes de CI ou contêineres autônomos que não montem o binário do host quebram na validação das garantias de Git físico.
- **Causa-raiz:** A imagem de suporte `agent-control-f0-rails-deps:4.0.9` foi construída sem o pacote `git` no Dockerfile.
- **Correção Proposta:**
  Atualizar o Dockerfile da imagem de teste para incluir `RUN apt-get update && apt-get install -y git` e regerar a tag de imagem.
- **Critério Verificável de Encerramento:** Execução de `bin/rails test test/services/ac_physical_git_test.rb` dentro do contêiner sem volumes de `/usr/bin/git`, com 100% PASS.

---

### [REQ-FUT-01] Seleção Regular Preservada por Contexto de Trabalho (RF-56 / T37)

- **ID Único:** `REQ-FUT-01`
- **Tipo:** Requisito previsto para fase futura / Ausente para G1
- **Severidade:** **P2 (Médio)**
- **Requisito ou Garantia Afetada:** RF-56, Cenário T37 (Adendo Final §2).
- **Versão, Arquivo e Localização:**
  - [`app/models/ac_work_context.rb`](file:///home/enok/Documentos/projetos/agent-control/app/models/ac_work_context.rb)
  - [`app/services/ac_policy_engine_service.rb`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_policy_engine_service.rb)
- **Condições em que o Problema Ocorre:** Operação concorrente de dois contextos de trabalho/chats que utilizam seleções regulares distintas.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Inspeção Documental e de Código)**.
  O Adendo Final v1.1 registrou no §2 que a persistência da escolha regular pertence ao contexto de trabalho/chat e orienta suas novas admissões, não sendo uma variável global única. Atualmente, `AcWorkContext` não possui persistência própria de perfil regular selecionado, e o `AcPolicyEngineService` avalia a política sempre no nível da company.
- **Impacto:** Dois chats que disputam capacidade não preservam escolhas regulares independentes caso ocorra reinicialização do sistema.
- **Causa-raiz:** Funcionalidade classificada no Adendo como "proposta de semântica a fechar antes de G1; não bloqueia F0".
- **Correção Proposta:**
  Adicionar coluna `selected_regular_profile_id` em `ac_work_contexts` e parametrizar o `AcPolicyEngineService` para respeitar a preferência local do contexto antes de recorrer à cadeia global.
- **Critério Verificável de Encerramento:** Execução do cenário T37 comprovando que dois contextos mantêm suas escolhas preservadas após reinicialização.

---

### [DIV-INT-01] Desativação Prévia do Transporte Antigravity CLI sob RF-55 / T39

- **ID Único:** `DIV-INT-01`
- **Tipo:** Divergência intencional documentada (Aprovada)
- **Severidade:** **Informativo**
- **Requisito ou Garantia Afetada:** RF-06, RF-55, Cenário T39, Decisão de Produto do Adendo Final §4.
- **Versão, Arquivo e Localização:**
  - [`docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md`](file:///home/enok/Documentos/projetos/agent-control/docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md)
  - [`app/models/ac_execution_profile.rb:31`](file:///home/enok/Documentos/projetos/agent-control/app/models/ac_execution_profile.rb#L31)
- **Condições em que o Problema Ocorre:** Avaliação da elegibilidade do transporte Antigravity CLI (`agy`) em contas de planos de consumidor.
- **Evidência e Grau de Confiança:** **Grau de Confiança: 100% (Análise Normativa e Contratual)**.
  O Adendo Final (§4.2) e a ADR-002 registraram expressamente que a FAQ e os Termos do Antigravity restringem o uso headless e encapsulado por ferramentas de terceiros no plano de consumidor. Por essa razão, a ADR-002 classificou formalmente esse transporte como `unsupported_for_mode` e o desativou na admissão com motivo legível, preservando como elegíveis as CLIs oficiais diretas Codex CLI, Claude Code e Grok CLI.
- **Impacto:** Conforme exigido pelo RF-55 e T39, o sistema recusa a ativação desse caminho antes do lançamento, sem que isso constitua defeito de cota.
- **Causa-raiz:** Decisão arquitetural homologada pelo proprietário na autorização autônoma de 31/10/2026.
- **Conclusão:** Não é um defeito, mas sim uma divergência intencional documentada e aderente às regras de produto.
