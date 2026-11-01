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

> [!TIP]
> **Veredito: APROVADO PARA USO EXPERIMENTAL ISOLADO (ONDAS 1, 2 E 3 CONCLUÍDAS)**

- **Fundamentação:** Com a remediação comprovada de todos os achados críticos P0 ([`DEF-01`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-01) e [`DEF-02`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-02)), altos P1 ([`DEF-03`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-03), [`DEF-04`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-04), [`DEF-05`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-05) e [`DEF-07`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-07)) e médios P2 ([`DEF-06`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-06) e [`DEF-08`](file:///home/enok/Documentos/projetos/agent-control/docs/auditoria/2026-11-01/INVENTARIO_ACHADOS.md#def-08)), a plataforma atinge plena estabilidade de execução em laboratório e atende integralmente aos critérios de G0 a G5.
- **Validação Automatizada:** Suíte integral do Agent Control executada com **175 runs, 794 assertions, 0 failures, 0 errors, 1 skip** (skip exclusivo de integração direta com Paseo desativado).

---

### Dimensão 3: Prontidão para Operação Real (Piloto Supervisionado G0)

> [!IMPORTANT]
> **Veredito: APROVADO COM SALVAGUARDAS PARA PILOTO G0 SUPERVISIONADO**

- **Fundamentação:** Todos os 8 defeitos e riscos catalogados pela auditoria forense foram eliminados na raiz do código e do schema. A plataforma Agent Control está tecnicamente capacitada para iniciar a operação piloto G0 supervisionada.
- **Salvaguardas de Transição Operacional:**
  1. O serviço `paseo-flow.service` e as bases ativas de produção (`Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat`) permanecem protegidos e inalterados até o protocolo formal de cutover assistido por humanos.
  2. O piloto deve iniciar com uma worktree piloto controlada antes de assumir o fluxo de projetos críticos.
  3. Controles móveis de pausa, retomada e cancelamento validados no backend e na UI (`PlanGraph.tsx`) viabilizam intervenção humana instantânea de emergência (G1 / RF-24).

---

## 3. Contagens Quantitativas por Estado de Requisito (Pós-Remediação)

### 3.1 Requisitos Funcionais (RF-01 a RF-57)
- **Denominador Total:** 57 requisitos funcionais (54 da especificação v1.1 + 3 adicionados pelo Adendo Final).

| Categoria de Estado | Quantidade Absoluta | Proporção Relativa | Tratamento Normativo |
| :--- | :--- | :--- | :--- |
| **Conformes / Aprovados e Remediados** | **53** | 92,98% (53/57) | Verificados no código, corrigidos e validados por evidências funcionais |
| **Requisito Previsto para Fase Futura** | **3** | 5,26% (3/57) | RF-37 (canvas livre), RF-39 (worktree remota), RF-56 (memória de contexto) |
| **Divergência Intencional Documentada** | **1** | 1,75% (1/57) | RF-55 (desativação prévia do transporte agy per ADR-002) |
| **Defeitos ou Bloqueios Restantes** | **0** | 0,00% (0/57) | 100% dos achados da auditoria forense remediados |
| **TOTAL CONSOLIDADO** | **57** | **100,00%** | Numerador: 53 conformes; Denominador: 57 |

### 3.2 Cenários de Validação (T01 a T39)
- **Denominador Total:** 39 cenários planejados (36 da v1.1 + 3 do Adendo Final).

| Estado do Cenário | Quantidade | Proporção | Descrição |
| :--- | :--- | :--- | :--- |
| **Aprovados (Comprovados por Testes)** | **37** | 94,87% (37/39) | Provas executadas com sucesso (incluindo T01 múltiplas contas, T07/08 processos, T16 mobile, T18/30 backup, T38 QA waived) |
| **Fase Futura** | **1** | 2,56% (1/39) | T37 (prova de escolha por contexto per RF-56 / Adendo Final §2) |
| **Conforme Decisão de Produto (ADR-002)**| **1** | 2,56% (1/39) | T39 (recusa antes do lançamento para integração unsupported) |
| **Reprovados ou com Falhas Restantes** | **0** | 0,00% (0/39) | 0 cenários pendentes |
| **TOTAL CONSOLIDADO** | **39** | **100,00%** | Numerador: 37 aprovados estritos; Denominador: 39 |

---

## 4. Registro de Execução das Ondas de Remediação

Todas as 3 ondas de remediação recomendadas no plano de ação foram executadas e commitadas:

- **Onda 1 (Commit `a292f65`):**
  - `DEF-01` (P0): Desacoplamento de processos via `Process.spawn`, logs físicos, reconciliação com timeout e proteção de worktrees ativas.
  - `DEF-02` (P0): Erradicação de aprovações cegas e hashes simulados no `AcPlanExecutionWorkflow`, integrando orquestração durável real.
  - `DEF-04` (P1): Suporte à dispensa fundamentada de QA (`verdict: :waived`) em `AcReviewService` per RF-57 e T38.
  - Resultado: 167 testes, 747 asserções, 0 falhas.

- **Onda 2 (Commit `d19acd4`):**
  - `DEF-03` (P1): Migration Rails e suporte a `account_slug` em `AgentCredential`, permitindo múltiplas contas do mesmo provedor sob o mesmo usuário/tenant.
  - `DEF-05` (P1): Inclusão de auditoria imutável (`AcDecisionAuditEvent`), concessões e observações de cota no `AcBackupService` e redefinição de sequences (`reset_pk_sequence!`) em `AcRecoveryService`.
  - Resultado: 171 testes, 766 asserções, 0 falhas, 1 skip.

- **Onda 3 (Commit Atual):**
  - `DEF-06` (P2): Sanitização e escape seguro de comandos SSH em `AcRemoteGatewayService#query_operation_status!` via `Shellwords.shellescape`.
  - `DEF-07` (P1): Controles de ciclo de vida de plano (`pause_plan`, `resume_plan`, `cancel_plan`) no `ClientCommandsController`, modelo `AcPlan`, serviço de grafo e botões dinâmicos com confirmação em `PlanGraph.tsx`.
  - `DEF-08` (P2): Atualização da camada base do `Dockerfile` oficial incluindo `git` e `openssh-client`.
  - Resultado: 175 testes, 794 asserções, 0 falhas, 1 skip.

---

## 5. Declaração de Limitações e Encerramento da Auditoria

- **Escopo Auditado e Remediado:** Código-fonte Rails, schemas de banco de dados PostgreSQL, workflows e atividades do Temporal, controladores REST/Inertia, serviços de domínio do Agent Control, componentes React/TypeScript e transportes SSH.
- **Garantias Operacionais Cumpridas:**
  - Nenhuma chamada real de inferência a LLMs foi disparada durante a auditoria (custo financeiro zero).
  - Nenhum tráfego de rede foi direcionado aos servidores remotos em produção.
  - O daemon `paseo-flow.service` permaneceu intocado, inativo e preservado.
- **Conclusão:** A auditoria forense e a remediação das vulnerabilidades e lacunas normativas foram **concluídas com êxito total**. A plataforma Agent Control está formalmente apta para ensaios experimentais e inicialização de piloto assistido.
