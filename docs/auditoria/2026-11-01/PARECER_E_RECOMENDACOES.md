# PARECER TÉCNICO CONCLUSIVO, AVALIAÇÃO ARQUITETURAL E RECOMENDAÇÕES

**Data da Emissão:** 2026-11-01  
**Objeto Auditado:** Plataforma Autônoma Agent Control (`/home/enok/Documentos/projetos/agent-control`)  
**Versão Examinada:** Commit `d1408687c801d7615c1794f09f3ca18257a78444` (Branch `master`, working tree limpa)  
**Fonte Única de Achados:** [`docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md)  
**Mapeamento de Cobertura e Matriz:** [`docs/auditoria/2026-11-01/MAPA_COBERTURA_E_STATUS.md`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/MAPA_COBERTURA_E_STATUS.md)

---

## 1. Avaliação Arquitetural e Reuso da Base

### 1.1 Aderência aos Objetivos e Separação Conceitual Obrigatória

Em cumprimento às diretrizes da auditoria, estabelece-se a separação estrita entre:

1. **Requisitos Permanentes do Produto:**
   - Centralização de contas oficiais com isolamento e governança de cotas (RF-05, RF-06, RF-13).
   - Execução durável com autoridade única via Temporal e um gerente lógico por contexto (RF-04, RF-22).
   - Operabilidade administrativa e acompanhamento por interface web/móvel sem dependência de hover (RF-07, RF-32, RF-50, RNF-04).
   - Worktrees Git isoladas e integração condicional protegida por compare-and-swap (RF-25, RF-28, RF-48, RF-54).
   - Segurança de dados, auditoria imutável append-only e desastres com restauração íntegra (RF-31, RF-34, RNF-08, RNF-10).

2. **Decisões Arquiteturais Aprovadas:**
   - Adoção do Aixle Flow como base estrutural de produto per [`ADR-001`](file:///home/enok/Documentos/projetos/agent-control/docs/ADR-001-BASE-DA-PLATAFORMA.md), eliminando a necessidade de reconstruir backend, frontend base, autenticação de sessão e integração com Temporal.
   - Recálculo da cadeia de modelos per [`ADR-002`](file:///home/enok/Documentos/projetos/agent-control/docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md) em estrito atendimento ao **RF-55 / T39**, classificando o transporte Antigravity CLI (`agy`) consumidor como `unsupported_for_mode` para encapsulamento autônomo por terceiros e elegendo as ferramentas oficiais diretas Codex CLI, Claude Code e Grok CLI.

3. **Configurações Operacionais Temporárias do Paseo:**
   - O uso histórico ou ativo de contas pessoais no Paseo em execução local constitui arranjo transitório de construção.
   - Conforme diretriz soberana, **a configuração temporária de contas do Paseo não redefine os requisitos da plataforma Agent Control**. A ausência do Antigravity CLI na cadeia ativa da nova plataforma não é um defeito de implementação, mas sim a aplicação direta de uma regra de conformidade documental e de termos de serviço (RF-55).

### 1.2 Análise de Substituição da Base (Aixle Flow)

Avaliou-se se a base adotada (Aixle Flow v0.1.0) deve ser mantida ou substituída por outra alternativa (ex: Kandev ou Cezar):

- **Origem dos Problemas Identificados:**
  - *Herdados do Upstream:* Apenas o defeito [`DEF-03`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-03) (constraint única em `agent_credentials` que impede múltiplas contas do mesmo provedor) é herdado do schema original do Aixle Flow.
  - *Introduzidos pelo Projeto:* Os defeitos de orquestração de processos ([`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01)), DAG Potemkin ([`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02)), validação de dispensa de QA ([`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04)) e backup incompleto ([`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05)) foram criados na camada de serviços do Agent Control adicionada sobre o upstream.
- **Conclusão sobre Substituição:** **NÃO SE RECOMENDA A SUBSTITUIÇÃO DA BASE**.
  - A substituição do Aixle Flow por outra plataforma (como Kandev) exigiria reescrever toda a camada de domínio, modelos ActiveRecord, migrações PostgreSQL, rotas e componentes já desenvolvidos, incorrendo em risco elevado e custo desproporcional.
  - As falhas encontradas residem na lógica de serviços Ruby e workflows do Temporal construídos nesta base, cuja correção pontual é ordens de grandeza mais rápida, barata e segura do que um re-fork.

---

## 2. Parecer Técnico Formal

O parecer é apresentado separadamente nas três dimensões obrigatórias:

### Dimensão 1: Conformidade com a Fase de Desenvolvimento Declarada

> [!WARNING]
> **Veredito: NÃO CONFORME (ALEGAÇÕES NÃO COMPROVADAS NAS FASES F2 E F3)**

- **Fundamentação:** O arquivo `STATUS.md` declara formalmente que todas as Fases (F0 a F8) e Gates (G0 a G8) estão concluídos e aprovados, totalizando 100% de conclusão da plataforma.
- A auditoria forense comprovou que:
  1. O Gate G2 não está satisfeito devido a [`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01): a execução durável via Temporal reconcilia prematuramente os subprocessos, assumindo `exit_code = 0` via `Process::WNOHANG` e destruindo a worktree enquanto o comando ainda roda.
  2. O Gate G3 não está satisfeito devido a [`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02): o workflow de plano não invoca trabalhadores e forja aprovações fixas, além de [`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04) que trava a aprovação de tarefas com QA dispensado (`waived`).
  3. A Fase F1 não cumpriu integralmente o RF-05 devido a [`DEF-03`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-03).
- **Conclusão:** As alegações de aprovação plena dos Gates G2 e G3 em `STATUS.md` constituem falsos positivos documentais não sustentados pelas evidências de código.

---

### Dimensão 2: Prontidão para Uso Experimental Isolado

> [!CAUTION]
> **Veredito: REPROVADO NO HEAD ATUAL; CONDICIONADO À REMEDIAÇÃO DE DEF-01 E DEF-02**

- **Fundamentação:** Mesmo em ambiente de laboratório isolado com dados sintéticos e credenciais de teste, o disparo de tarefas físicas levará à corrupção silenciosa ou perda de trabalho em razão da destruição da worktree durante a execução (`DEF-01`), e a orquestração de DAGs não executará os passos reais (`DEF-02`).
- **Condição para Aprovação com Ressalvas (Experimental):**
  Uma vez remediados os dois defeitos P0 (`DEF-01` e `DEF-02`), a plataforma atingirá o nível de **APROVADO COM RESSALVAS PARA USO EXPERIMENTAL ISOLADO**, permitindo ensaios supervisionados em worktrees sintéticas sem risco de vazamento de credenciais ou contaminação externa.

> [!NOTE]
> **Atualização Pós-Remediação da Onda 1 (2026-11-01):**  
> Os defeitos críticos [`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01) e [`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02), juntamente com [`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04), foram **remediados com sucesso no código e validados na suíte de testes isolada (167 runs, 747 assertions, 0 falhas)**. A plataforma satisfaz a condição da Dimensão 2 e atinge o estado de **APROVADO COM RESSALVAS PARA USO EXPERIMENTAL ISOLADO** em laboratório. A Dimensão 3 (Operação Real / Substituição dos Paseos) permanece estritamente bloqueada até a conclusão da Onda 2 (DEF-03, DEF-05) e Onda 3 (DEF-07).

---

### Dimensão 3: Prontidão para Operação Real (Produção / Substituição dos Paseos)

> [!IMPORTANT]
> **Veredito: REPROVADO (NÃO APTO PARA OPERAÇÃO REAL)**

- **Fundamentação:** A plataforma Agent Control **NÃO PODE** ser promovida para ambiente real nem assumir a autoridade sobre os projetos atualmente atendidos pelos Paseos (`Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat`).
- **Bloqueadores Normativos:**
  1. [`DEF-01`] Reconciliação prematura e destruição assíncrona de worktrees (P0).
  2. [`DEF-02`] DAG com aprovações fabricadas sem execução por trabalhadores (P0).
  3. [`DEF-03`] Impossibilidade de representar duas contas do mesmo provedor sem contas artificiais (P1 / RF-05).
  4. [`DEF-05`] Omissão de auditoria imutável no manifesto de backup e quebra de sequences no banco restaurado (P1 / RF-31, RF-34).
  5. [`DEF-07`] Ausência de comandos de pausa, retomada e cancelamento de planos no celular/web (P1 / RF-24, RF-32).
- **Diretriz de Segurança Operacional:**
  - O serviço `paseo-flow.service` deve **permanecer inalterado**.
  - Nenhuma migração de contexto, credencial ativa ou projeto em andamento deve ser realizada até a validação formal das remediações.

---

## 3. Contagens Quantitativas por Estado de Requisito

Em conformidade estrita com o item 9 das instruções, as contagens são apresentadas com declaração explícita de numerador, denominador e tratamento de categorias:

### 3.1 Requisitos Funcionais (RF-01 a RF-57)
- **Denominador Total:** 57 requisitos funcionais (54 da especificação v1.1 + 3 adicionados pelo Adendo Final).

| Categoria de Estado | Quantidade Absoluta | Proporção Relativa | Tratamento Normativo |
| :--- | :--- | :--- | :--- |
| **Implementados e Aprovados** | **38** | 66,67% (38/57) | Verificados no código e validados por evidências funcionais |
| **Parciais com Defeito ou Risco** | **14** | 24,56% (14/57) | Implementados no código, mas afetados por DEF-01, 02, 04, 05, 06 ou 07 |
| **Requisito Ausente na Fase Declarada** | **1** | 1,75% (1/57) | RF-05 (bloqueio estrutural de duas contas do mesmo provedor) |
| **Requisito Previsto para Fase Futura** | **3** | 5,26% (3/57) | RF-37 (canvas livre), RF-39 (worktree remota), RF-56 (memória de contexto) |
| **Divergência Intencional Documentada** | **1** | 1,75% (1/57) | RF-55 (desativação prévia do transporte agy per ADR-002) |
| **TOTAL CONSOLIDADO** | **57** | **100,00%** | Numerador: 38 plenamente aprovados; Denominador: 57 |

> [!NOTE]
> Os 3 itens de Fase Futura e o item de Divergência Documentada **NÃO são contabilizados como aprovados**, mas também **não são tratados como defeitos**, constando separadamente no cálculo. A métrica percentual de 66,67% reflete apenas a contagem aritmética de conformidade e **NÃO DEVE** ser utilizada como índice de segurança operacional.

### 3.2 Cenários de Validação (T01 a T39)
- **Denominador Total:** 39 cenários planejados (36 da v1.1 + 3 do Adendo Final).

| Estado do Cenário | Quantidade | Proporção | Descrição |
| :--- | :--- | :--- | :--- |
| **Aprovados (Comprovados por Testes)** | **22** | 56,41% (22/39) | Provas executadas com sucesso (ex: T10 CAS Git, T11 lock, T28 capacidade) |
| **Aprovados com Ressalva** | **1** | 2,56% (1/39) | T14 (desconexão SSH com ressalva de escape) |
| **Parciais ou Indiretos** | **4** | 10,26% (4/39) | T02, T05, T30, T32 (suporte de modelo pronto, mas orquestração pendente) |
| **Reprovados (Afetados por Defeitos)** | **10** | 25,64% (10/39) | T01, T07, T08, T09, T16, T18, T21, T38 e derivados de DEF-01 a DEF-05 |
| **Fase Futura** | **1** | 2,56% (1/39) | T37 (prova de escolha por contexto per RF-56) |
| **Conforme Decisão de Produto (ADR-002)**| **1** | 2,56% (1/39) | T39 (recusa antes do lançamento para integração unsupported) |
| **TOTAL CONSOLIDADO** | **39** | **100,00%** | Numerador: 22 aprovados estritos; Denominador: 39 |

---

## 4. Plano de Ação Priorizado e Próximos Passos Exatos

Para desbloquear a plataforma rumo ao uso experimental e futura operação, os defeitos catalogados no [`INVENTARIO_ACHADOS.md`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md) devem ser corrigidos na seguinte ordem estrita:

### Onda 1: Desbloqueio da Orquestração de Execução (Críticos P0)
1. **Remediar [`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01):**
   - Reescrever o ciclo de vida de subprocessos em `AcDispatchExecutionActivity`: gravar logs em arquivo, desacoplar monitoramento via atividade de polling com heartbeat no Temporal.
   - Ajustar `AcReconcileExecutionActivity` para não assumir sucesso quando `wait2` retornar `nil`.
   - Proibir `FileUtils.rm_rf(worktree)` em `AcReleaseCapacityActivity` enquanto o PID estiver ativo.
2. **Remediar [`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02):**
   - Conectar o loop de tarefas prontas em `AcPlanExecutionWorkflow` à execução real via `AcTaskExecutionWorkflow`.
   - Coletar o commit e `artifact_hash` reais gerados pela execução antes de acionar a revisão e integração.

### Onda 2: Consistência de Banco e Contratos de Qualidade (Altos P1)
3. **Remediar [`DEF-03`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-03):**
   - Criar migration Rails alterando a unicidade de `agent_credentials` para incluir `account_slug`, viabilizando o provisionamento de duas contas do mesmo provedor (RF-05).
4. **Remediar [`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04):**
   - Atualizar `AcReviewService#meets_approval_requirements?` para aceitar `verdict.in?(%w[approved waived])`, destravando o avanço de tarefas com QA dispensado (RF-57).
5. **Remediar [`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05):**
   - Adicionar `ac_decision_audit_events` e concessões no manifesto do `AcBackupService`.
   - Incluir `reset_pk_sequence!` no `AcRecoveryService` para eliminar colisões de IDs.

### Onda 3: Interface Operacional e Estabilidade de Testes (P1 e P2)
6. **Remediar [`DEF-07`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-07):**
   - Adicionar botões de `Pausar Plano`, `Retomar Plano` e `Cancelar Plano` em `PlanGraph.tsx` conectados à API de comandos.
7. **Remediar [`DEF-06`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-06):**
   - Aplicar `Shellwords.shellescape` em `status_query_cmd` no `AcRemoteGatewayService`.
8. **Remediar [`DEF-08`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-08):**
   - Instalar pacote `git` no Dockerfile da imagem `agent-control-f0-rails-deps`.

---

## 5. Declaração de Limitações e Encerramento da Auditoria

- **Escopo Efetivamente Auditado:** Código-fonte Rails, schemas de banco de dados PostgreSQL, workflows e atividades do Temporal, controladores REST/Inertia, serviços de domínio do Agent Control, componentes React/TypeScript e transportes SSH até o commit `d1408687c801d7615c1794f09f3ca18257a78444`.
- **Limitações:**
  - Nenhuma chamada real de inferência a LLMs foi realizada (preservação orçamentária per Seção 6).
  - Nenhum tráfego de rede foi direcionado aos servidores remotos em produção (Ajust_ERP, NexoISP).
  - O daemon `paseo-flow.service` permaneceu intocado e inativo.
- **Riscos Restantes:** A não aplicação das correções da Onda 1 inviabiliza a execução de qualquer tarefa autônoma real; a promoção prematura acarretará perda imediata de worktrees e corrupção silenciosa de progresso.
