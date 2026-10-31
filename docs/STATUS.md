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

## 4. Próximos Passos (Transição para F1)

Com o Gate G0 aprovado, o desenvolvimento autônomo avança para a **Fase 1 (F1 — Fundação de Domínio e Workflows)**, conforme o cronograma do Plano Mestre v1.1:
1. **Domínio e Modelagem Central:** Estruturação dos modelos de agentes, perfis, capacidades e admissão;
2. **Workflows Temporal Base:** Implementação das definições de workflows de orquestração no Temporal;
3. **Integração de Workers:** Adaptação dos workers isolados para consumo de tarefas via Temporal.
