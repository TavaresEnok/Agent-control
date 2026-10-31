# STATUS — Agent Control

**Atualização:** 2026-10-31. **Fase: F0 CONCLUÍDA; Gate G0 APROVADO. F1 LIBERADA.**
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

## 5. Próximos Passos (F2 — Orquestração Temporal e Execução de Tarefas)

Avançar para a **Fase 2 (F2 — Orquestração e Execução)**:
1. Workflows duráveis do Temporal mapeando o ciclo de vida do `AcPlan` e `AcTask` (`AcTaskExecutionWorkflow`);
2. Atividades Temporal para reserva atômica de capacidade, invocação de runner/CLI isolada e coleta de evidências;
3. Reconciliação de estados e heartbeat de tarefas.

