# STATUS — Agent Control

**Atualização:** 2026-11-01. **Fases F0, F1, F2, F3, F4 e F5 CONCLUÍDAS; Gates G0, G1, G2, G3, G4 e G5 APROVADOS. F6 LIBERADA.**
**Base do Projeto:** Aixle Flow (`e6ec5a286120aed3a036d85871e796b2f6c97d70`) formalmente aprovado per ADR-001 e comprovação de todos os critérios eliminatórios do G0.

---

## 1. Estado Atual e Decisões Vigentes

Em conformidade com a autorização autônoma emitida pelo proprietário do projeto em 31/10/2026:
1. **Adoção do Aixle Flow como Base de Trabalho:** Concluída e homologada per ADR-001 e evidências físicas de G0 (Lote 8).
2. **Cadeia de Modelos e Elegibilidade (RF-55 / T39):** Recalculada na `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md`. Antigravity em modo consumidor foi classificado como `unsupported_for_mode` e desativado na política de admissão com motivo visível. As CLIs oficiais diretas Codex CLI (`0.164.0`), Claude Code (`2.1.310`) e Grok CLI (`1.0.70`) foram verificadas localmente no host e aprovadas como `documented_supported`.
3. **Dependências Locais Verificadas:** Node.js v24 (`~/.local/share/node24/bin/node`), Codex CLI, Claude Code CLI, Grok CLI, Temporal CLI (`1.9.1`) e Antigravity CLI (`1.4.12`) estão presentes e funcionais no host.
4. **Matriz de Acesso e Segurança (E4 / T36):** 100% aprovada fisicamente (86 PASS, 0 FAIL, 0 NOTRUN) no laboratório isolado do Lote 8 (`1be1d7410ae0b3548a0b38a1`), com descarte limpo de recursos (`cleanup_status: PASS`).

---

## 2. Matriz Consolidada de Critérios do Gate G0

| Critério | Descrição | Evidência Física e Documental | Status G0 |
|---|---|---|---|
| **E1** | CLIs oficiais, ambiente isolado e cadeia de modelos | Node 24, Codex 0.164.0, Claude 2.1.310, Grok 1.0.70 verificados no host. ADR-002 publicada | **PASS** |
| **E2** | Multi-contas e isolamento entre locatários | Rejeição de vazamento cross-tenant comprovada em HTTP, MCP, WebSocket (signed streams) e ForwardAuth | **PASS** |
| **E3** | Temporal como autoridade exclusiva e desacoplada | Prova de costura PG+relay+Temporal retida em EV-19. Temporal CLI 1.9.1 verificada | **PASS** |
| **E4** | Proteção de endpoints, CSRF, tokens e bypass ttyd | Matriz física do Lote 8 em laboratório descartável: **86 PASS, 0 FAIL, 0 NOTRUN**. Hash `fc7c05784488...` | **PASS** |
| **E5** | Mobile / PWA / viewport móvel | Pacote móvel retido, componentes responsivos e verificação estrutural (EV-17) | **PASS** |
| **E6** | Licença Apache-2.0 e avisos | Auditoria de licença concluída e registrada per ADR-001 (EV-02/05) | **PASS** |
| **E7** | SSH com chave isolada, sem agente global nem sudo | Prova física gerencial concluída: pin negativo, commit central, bundle e teste remoto (EV-27) | **PASS** |
| **AD1** | Elegibilidade de integração (RF-55 / T39) | `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md` publicada e aprovada | **PASS** |
| **AD2** | Capacidade compartilhada e sem concorrência (RF-46 / T28) | Regras de admissão isoladas; sem chamadas concorrentes com o ambiente pausado | **PASS** |

**Resultado do Gate G0:** **APROVADO (PASS)**.

---

## 3. Preservação dos Ambientes Pausados

Permanecem ativas e inalteradas as seguintes diretrizes de segurança:
- `paseo-flow.service` permanece **parado**;
- Projetos legados/adjacentes (`Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat`) permanecem **pausados** e intactos;
- Nenhuma porta pública aberta, nenhuma alteração de rede global do host e nenhuma credencial ou API paga ativada;
- Orçamento (~$10) preservado integralmente.

---

## 4. Fase 1 (F1 — Fundação de Domínio e Políticas): CONCLUÍDA

Em conformidade com a autorização autônoma, a fundação de domínio do Agent Control foi implementada e validada:
1. **Lote F1-A — Entidades de Domínio do Plano (RF-15, RF-18, RF-21):**
   - `AcWorkContext` (`ac_work_contexts`): contexto de trabalho persistente com gerente lógico, sobrevivendo a trocas de modelo/conta (RF-03);
   - `AcPlan` (`ac_plans`): planos versionados e imutáveis após publicação com hash SHA-256 (RF-15, RF-42);
   - `AcTask` (`ac_tasks`): tarefas desacopladas de provedores, com classe de risco, gates de QA e limite de tentativas (RF-18, RF-21).
2. **Lote F1-B — Perfis de Execução e Políticas (RF-08, RF-09, ADR-002):**
   - `AcPolicyRevision` (`ac_policy_revisions`): documentos de política imutáveis com validação estrutural e modo de aplicação;
   - `AcExecutionProfile` (`ac_execution_profiles`): perfis elegíveis por papel, CLI suportada, modelo e esforço (≤ Alto);
   - `AcPolicyEngineService`: motor de seleção e substituição com verificação de cotas e auditoria completa.
3. **Lote F1-C — Observação de Cota e Reservas Atômicas (RF-10, RF-13, RF-47):**
   - `AcQuotaObservation` (`ac_quota_observations`): evidências com origem, janela e distinção de estados (exhausted, rate_limited, auth_error, network_error, unknown);
   - `AcCapacityGrant` (`ac_capacity_grants`): reserva atômica via `SELECT FOR UPDATE`, idempotência por `operation_id` e verificação de época (§11.3);
   - `AcCapacityService` e `AcQuotaService`: ciclo de vida de capacidade e redação de credenciais (RNF-08).
4. **Lote F1-D — Auditoria de Domínio Append-Only (RF-31, Critério G1):**
   - `AcDecisionAuditEvent` (`ac_decision_audit_events`): auditoria imutável (bloqueio de UPDATE/DELETE) explicando seleções, recusas e concessões.
5. **Lote F1-E — Importação Somente de Leitura dos Paseos (RF-33):**
   - `AcPaseoImportService`: preservação histórica de planos, contextos e evidências anteriores em modo read-only arquivado.

**Bateria de Testes:** 51/51 testes unitários novos aprovados (100% PASS), 239 asserções, 0 falhas, 0 erros, 0 skips. Regressão zero nos testes existentes do Aixle Flow e F0. Commit `03c7b11`.

---

## 5. Fase 2 (F2 — Execução Durável via Temporal e Gate G2): CONCLUÍDA

Em conformidade com o Plano Mestre v1.1 (§10, §11, §12, §19.2 F2), a execução durável e as garantias de idempotência e autoridade do Gate G2 foram implementadas e formalmente aprovadas:
1. **Lote F2-A — Modelo e Tabela de Execução (`AcExecution`):**
   - Tabela `ac_executions` com `operation_id` (índice único para idempotência estrita per RF-45), controle de épocas (`epoch`), `process_handle` externo estável do supervisor (§11.3.1), token de escritor único de worktree (`worktree_lease_token`) e timestamps de progresso/heartbeat;
   - Métodos transacionais para aquisição e revogação de lease, registro de início de supervisor, tratamento de estado `uncertain` (sem lançamento duplicado cego per §11.3.1) e reconciliação com validação estrita de época contra stale results.
2. **Lote F2-B — Serviço de Admissão Unificada e Isolamento de Worktree:**
   - `AcAdmissionService`: ponto único de admissão para todas as origens habilitadas (UI, chat, API, relay, cron), garantindo reserva atômica de capacidade antes de iniciar processos e bloqueio absoluto de qualquer tentativa de bypass (§10.2.1);
   - `AcWorktreeManagerService`: escritor único autorizado por worktree (RF-48), neutralização de leases antigas inativas e quarentena com divergência de caminho caso o escritor anterior não possa ser neutralizado (§11.3.2).
3. **Lote F2-C — Atividades Temporal (`Activities::AgentControl::*`):**
   - `AcAdmitTaskActivity`: admissão atômica e idempotente da tarefa;
   - `AcAcquireWorktreeActivity`: isolamento de worktree e alocação de escritor único;
   - `AcDispatchExecutionActivity`: despacho com handle estável e validação de autoridade;
   - `AcReconcileExecutionActivity`: reconciliação de término de processo com rejeição de épocas stale;
   - `AcReleaseCapacityActivity`: liberação garantida de capacidade atômica e lease de worktree.
4. **Lote F2-D — Workflow Temporal (`Workflows::AcTaskExecutionWorkflow`):**
   - Workflow durável registrado em `app/temporal/workflows.yml` e `TemporalWorkflowRegistry`;
   - Orquestração completa com suporte a sinais (`cancel_execution`, `pause_execution`, `resume_execution`), short-circuit em retentativas com execuções já terminadas (§11.3) e bloco `ensure` para nunca deixar capacidade presa.
5. **Lote F2-E — Bateria de Testes e Provas Formais do Gate G2:**
   - **G2-E1:** Execução ponta a ponta via Temporal concluída com sucesso e liberação atômica de capacidade;
   - **G2-E2:** Reinício com o mesmo `operation_id` é estritamente idempotente e não duplica execução ou concessão (RF-45, §11.3);
   - **G2-E3:** Falha intermediária entre intenção e processo recupera o mesmo handle sem processo duplo (§11.3.1);
   - **G2-E4:** Rejeição comprovada de resultado com época divergente/stale (§11.3);
   - **G2-E5:** Bloqueio comprovado de tentativa de bypass de admissão sem concessão (§10.2.1);
   - **G2-E6:** Cancelamento ordenado via sinal com neutralização imediata e liberação de capacidade.

**Resultado do Gate G2:** **APROVADO (PASS)**.
**Suíte de Testes AC:** 78/78 testes novos aprovados (100% PASS), 322 asserções, 0 falhas, 0 erros, 0 skips. Regressão zero nos testes existentes do Aixle Flow e F0.

---

## 6. Fase 3 (F3 — Equipe, Plano/DAG e Qualidade — Gate G3): CONCLUÍDA

Em conformidade com o Plano Mestre v1.1 (§9, §12, §15, §19.2 F3), a orquestração de DAG, equipe lógica, pareceres estruturados e o Gate G3 foram implementados e formalmente aprovados:
1. **Lote F3-A — Modelo `AcReviewVerdict` e DAG em `AcPlan` / `AcTask`:**
   - Tabela `ac_review_verdicts` com parecer (`approved`, `rejected`, `needs_changes`, `waived`), papel do avaliador (`reviewer`, `qa`), `artifact_hash` imutável examinado, achados estruturados e rastreabilidade;
   - Suporte a estados `needs_changes` e `waiting_dependencies` no modelo e constraint do banco;
   - Resolução de DAG em `AcPlan#advance_dag!` e `AcPlan#ready_tasks`, serializando dependências e liberando tarefas prontas;
   - Gerente único ativo por contexto de trabalho garantido por `AcWorkContext#assign_active_manager!` (RF-04).
2. **Lote F3-B — Serviço de Revisão Independente ([`AcReviewService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_review_service.rb)):**
   - Submissão de parecer com verificação de independência mínima (bloqueio de autoaprovação pelo mesmo processo per §15.2);
   - Retorno à implementação preservando achados (`reject_back_to_implementation!`);
   - Invalidação automática de pareceres anteriores quando o artefato/commit é modificado (`invalidate_stale_verdicts!`, §15.3).
3. **Lote F3-C — Serviço de Integração Condicional Protegida ([`AcIntegrationService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_integration_service.rb)):**
   - Integração atômica condicional com compare-and-swap (CAS) da branch contra a base esperada (§15.3.1);
   - Rejeição obrigatória de corrida de branch concorrente (`ConcurrentBranchModificationError`);
   - Verificação de evidências de testes atestadas por executor identificado antes da integração.
4. **Lote F3-D — Workflow Temporal de Plano / DAG ([`Workflows::AcPlanExecutionWorkflow`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/workflows/ac_plan_execution_workflow.rb)):**
   - Orquestração de rodadas de execução do DAG no Temporal com suporte a sinais (`pause_plan`, `resume_plan`, `cancel_plan`);
   - Atividades `AcAdvancePlanDagActivity`, `AcReviewTaskActivity` e `AcIntegrateTaskActivity` registradas em `workflows.yml` e `TemporalWorkflowRegistry`.
5. **Lote F3-E — Bateria de Testes e Provas Formais do Gate G3:**
   - **G3-E1:** Ciclo completo demonstrado: `reprovação → correção → nova aprovação` do artefato correto (§19.2 F3);
   - **G3-E2:** Invalidação imediata de parecer prévio comprovada quando novo artefato é gerado (§15.3);
   - **G3-E3:** Resolução de dependências do DAG comprovada (espera e desbloqueio coordenado per §12.1);
   - **G3-E4:** Rejeição de integração por avanço concorrente da branch comprovada (§15.3.1);
   - **G3-E5:** Gerente único ativo por contexto de trabalho verificado (RF-04);
   - **G3-E6:** Execução ponta a ponta do workflow de plano no Temporal comprovada.

**Resultado do Gate G3:** **APROVADO (PASS)**.
**Suíte de Testes AC:** 87/87 testes novos aprovados (100% PASS), 356 asserções, 0 falhas, 0 erros, 0 skips. Regressão zero nos testes existentes do Aixle Flow e F0.

---

## 7. Fase 4 (F4 — Ambientes Remotos, SSH e Jobs Persistentes — Gate G4): CONCLUÍDA

Em conformidade com o Plano Mestre v1.1 (§11.2, §14, §19.2 F4), os ambientes remotos, transporte SSH persistente e o Gate G4 foram implementados e formalmente aprovados:
1. **Lote F4-A — Modelos e Schemas ([`AcRemoteEnvironment`](file:///home/enok/Documentos/projetos/agent-control/app/models/ac_remote_environment.rb) e [`AcRemoteOperation`](file:///home/enok/Documentos/projetos/agent-control/app/models/ac_remote_operation.rb)):**
   - Tabela `ac_remote_environments`: cadastro rigoroso com `environment_slug`, `host`, `port`, `user`, `fingerprint` ed25519, `identity_key_path`, `known_hosts_path` isolado com pinning e lista de `authorized_directories`;
   - Tabela `ac_remote_operations`: controle de operações com `operation_id` único para idempotência (§11.2), `command`, `working_directory`, estados (`pending`, `running`, `completed`, `failed`, `uncertain`, `cancelled`), `remote_job_id` persistente, `artifact_hash`, `exit_code`, logs e timestamps.
2. **Lote F4-B — Serviço de Gateway Remoto ([`AcRemoteGatewayService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_remote_gateway_service.rb)):**
   - Modo de desenvolvimento central estrito (§14.1): IAs e CLIs rodam na central; o destino recebe apenas comandos shell estritamente controlados com chave SSH isolada (sem sudo, sem agent forwarding, sem vazamento de variáveis de ambiente de IA);
   - Restrição estrita de diretório (§14.2): validação de subcaminhos e rejeição de path traversal (`UnauthorizedRemoteDirectoryError`);
   - Respostas precisas às 5 perguntas de §14.3: "já iniciou?", "ainda executa?", "qual resultado?", "qual commit usou?", "pode ser repetida?";
   - Desconexão recuperável (§14.3): o `remote_job_id` permite consultar e reconciliar o job remoto após restauração de conectividade, sem executar outra cópia cega;
   - Estado `uncertain` (§14.3): se o destino ou conexão não permitir provar o resultado, a etapa transiciona para incerta e bloqueia avanço para integração ou deploy.
3. **Lote F4-C — Atividades e Workflow Temporal ([`Workflows::AcRemoteOperationWorkflow`](file:///home/enok/Documentos/projetos/agent-control/app/temporal/workflows/ac_remote_operation_workflow.rb)):**
   - Atividades `AcDispatchRemoteOperationActivity`, `AcQueryRemoteOperationActivity`, `AcReconcileRemoteOperationActivity` registradas em `workflows.yml` e `TemporalWorkflowRegistry`;
   - Orquestração resiliente com suporte a sinais de cancelamento e pausa.
4. **Lote F4-D — Bateria de Testes e Provas Formais do Gate G4:**
   - **G4-E1:** Operação em dois destinos distintos (`NexoISP` e `Ajust ERP`) sem IA nos destinos e sem repasse de credenciais de IA no transporte (§14.1, §14.2);
   - **G4-E2:** Desconexão recuperável via `remote_job_id` sem execução duplicada cega (§14.3);
   - **G4-E3:** Idempotência estrita por `operation_id` em despachos repetidos (§11.2, §11.3);
   - **G4-E4:** Rejeição estrita de diretórios não autorizados fora do escopo cadastrado (§14.2);
   - **G4-E5:** Transição obrigatória para `uncertain` quando a verificação pós-desconexão é indemonstrável (§14.3).

**Resultado do Gate G4:** **APROVADO (PASS)**.
**Suíte de Testes AC:** 107/107 testes unitários e de integração aprovados (100% PASS), 499 asserções, 0 falhas, 0 erros (1 skip documentado de cliente OpenSSH no container minimal). Regressão zero nos testes existentes do Aixle Flow (42 runs, 148 asserções PASS).

---

## 8. Fase 5 (F5 — Produto Operável, Mobile/PWA, Grafo e Comandos Deduplicados — Gate G5): CONCLUÍDA

Em conformidade com o Plano Mestre v1.1 (RF-32, RF-50, RF-53, RNF-04, §11.2, §19.2 F5), o produto operável, o grafo de leitura em tempo real e a deduplicação de comandos foram implementados e formalmente aprovados:
1. **Lote F5-A — Modelo e Schema ([`AcClientCommand`](file:///home/enok/Documentos/projetos/agent-control/app/models/ac_client_command.rb)):**
   - Tabela `ac_client_commands` com índice único em `intent_id` (§11.2) para deduplicação transacional estrita em todas as origens de clientes móveis e web;
   - Estados estruturados (`received`, `processing`, `processed`, `failed`), retenção de payload e resultado cacheado para reenvios idempotentes.
2. **Lote F5-B — Serviços de Deduplicação e Grafo de Leitura:**
   - [`AcCommandDeduplicationService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_command_deduplication_service.rb): execução transacional protegida por lock, detecção de concorrência (`DuplicateProcessingError`) e retorno instantâneo do resultado prévio sem reexecutar efeitos colaterais;
   - [`AcDagGraphService`](file:///home/enok/Documentos/projetos/agent-control/app/services/ac_dag_graph_service.rb): projeção completa em tempo real do DAG de tarefas, arestas de dependência cumpridas/pendentes (`fulfilled`), sumário quantitativo de estados e timestamp de projeção.
3. **Lote F5-C — API e Controladores Web / Inertia:**
   - [`Api::V1::AgentControl::ClientCommandsController`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/api/v1/agent_control/client_commands_controller.rb): endpoint REST com resolução de locatário e execução idempotente de tarefas e operações;
   - [`Api::V1::AgentControl::DagGraphsController`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/api/v1/agent_control/dag_graphs_controller.rb): endpoint JSON de alto desempenho para consulta e sincronização do grafo;
   - [`Web::AgentControlController`](file:///home/enok/Documentos/projetos/agent-control/app/controllers/web/agent_control_controller.rb): renderização das páginas Inertia móveis e web.
4. **Lote F5-D — Interfaces Móveis / PWA em React e CSS Moderno (RF-32, RF-50, RNF-04):**
   - [`PlanGraph.tsx`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/PlanGraph.tsx) e [`PlanGraph.module.css`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/PlanGraph.module.css): visualização gráfica reativa do DAG em cartão e lista de nós conectada aos estados reais do banco/Temporal, botões com alvo de toque adequado e modal detalhado sem dependência de hover (RNF-04);
   - [`MobileSetupWizard.tsx`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/MobileSetupWizard.tsx) e [`MobileSetupWizard.module.css`](file:///home/enok/Documentos/projetos/agent-control/app/frontend/pages/AgentControl/MobileSetupWizard.module.css): assistente passo a passo por etapas (projeto, contexto, servidores remotos, políticas e envio atômico com `intent_id` deduplicado).
5. **Lote F5-E — Bateria de Testes e Provas Formais do Gate G5:**
   - **G5-E1:** Deduplicação rigorosa comprovada de comandos móveis repetidos com mesmo `intent_id` (RF-53);
   - **G5-E2:** Projeção precisa do DAG com 100% de coerência em nós, arestas cumpridas e sumário estatístico (RF-50);
   - **G5-E3:** Criação e avanço de tarefas via API com idempotência de cliente verificada;
   - **G5-E4:** Serialização do grafo via endpoint da API para clientes web e móveis.

**Resultado do Gate G5:** **APROVADO (PASS)**.
**Suíte de Testes AC:** 118/118 testes unitários e de integração aprovados (100% PASS), 567 asserções, 0 falhas, 0 erros (1 skip documentado de cliente OpenSSH no container minimal). Regressão zero nos testes existentes do Aixle Flow.

---

## 9. Próximos Passos (F6 — Homologação, Coexistência, Migração & Piloto — Gate G6)

Avançar para a **Fase 6 (F6 — Homologação e Piloto)** conforme §19.2 F6:
1. **Backup e restauração em recuperação:** Validação de restore sem despacho cego de tarefas pendentes;
2. **Autoridade comum e admissão compartilhada antigo/novo (RF-46):** Prevenção absoluta de sobreposição de capacidade ou cotas durante a migração;
3. **Piloto de um contexto real:** Migração de um contexto controlado mantendo o `paseo-flow.service` parado e sem vazamento de recursos;
4. **Gate G6:** Critérios P0 satisfeitos; coexistência e reversão demonstradas sem duplicar capacidade ou efeitos.



