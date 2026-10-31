# ADR-001 — Escolha da base da plataforma e avaliação do Gate G0

- **Data:** 2026-10-31
- **Status da ADR:** Aixle Flow aprovado como candidato de desenvolvimento pelo pedido de continuação; decisão técnica e comparação preservadas, adoção definitiva condicionada ao G0. Consolidação encaminhada à revisão independente.
- **Status do Gate G0:** **PENDENTE** (há critérios eliminatórios de execução bloqueados por pré-requisitos externos e de conformidade; proibido declarar aprovado sem essas evidências)
- **Candidatos avaliados nos commits fixados:**
  - **Kandev:** `kdlbs/kandev` — commit `997bc54fae4da15702c91da5c5d120bfe651edc1` (`main`), licença `AGPL-3.0`
  - **Aixle Flow:** `AixleHQ/flow` — commit `e6ec5a286120aed3a036d85871e796b2f6c97d70` (`develop`), licença `Apache-2.0`
- **Referências normativas:** `docs/PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md` (§1.2, §3.4, §19.3, §27.2) e `docs/ADENDO_FINAL_PLANO_v1.1_G0_2026-10-31.md` (§1, §4, §5, §7).

---

## 1. Resumo executivo e recomendação

### 1.1 Constatação central da F0
A inspeção do código-fonte nos commits fixados revelou uma assimetria estrutural decisiva entre os dois candidatos exatamente na condição de reversão definida em **D-02** do Plano Mestre v1.1 (§1.2):

> *"D-02 — Alternativa estrutural: Aixle Flow. A integração existente entre workflows, Temporal e containers é um argumento técnico forte. Se o Kandev não permitir que Temporal controle os workflows autônomos sem duplicar lançamento/retomada, ou exigir reescrever a maior parte do runtime, o Gate G0 deve recomendar Aixle Flow antes de investir em personalização extensa."*

1. **No Kandev (`997bc54f`):**
   - **Não existe integração com Temporal** (zero referências a `go.temporal.io` nos `go.mod` ou na árvore `apps/`).
   - O ciclo de vida de execução possui um coordenador próprio em Go (`internal/office/runtime/handoff.go`, `internal/office/service/scheduler_integration.go`, `internal/agent/runtime/durable_delivery.go`, `delivery_recovery.go`) e permite lançamentos legados sem proprietário/concessão (`LaunchSpec.Owner` e `OwnerAdmission` são opcionais em `runtime.go:157-161`).
   - Os pontos de disparo estão espalhados por pelo menos **9 superfícies distintas** (`backendapp/main.go`, `canvas_routes.go`, `turn_adapters.go`, `handoff_wiring.go`, `office/runtime/handoff.go`, `office/service/scheduler_integration.go`, `automation/handlers.go`, `mcp/handlers/handlers.go`, `mcp/handlers/spawn_session.go`).
   - A fronteira de segurança padrão vem com autenticação desabilitada (`opt-in`), bind em `0.0.0.0`, MCP externo sem autenticação e ausência de sessão de operador separada para mutações de perfil (`docs/public/security.md:10,28,84-94,183`).
   - O executor SSH nativo sobe `agentctl` no destino e copia arquivos de credenciais (`.codex/auth.json`, `.grok/auth.json`) para o servidor remoto (`codex_acp.go:157-168`), exatamente o oposto do requisito de manter CLIs e credenciais apenas na central.

2. **No Aixle Flow (`e6ec5a28`):**
   - **Possui na fonte os mecanismos centrais candidatos ao reuso (EV-05; operação não homologada nesta F0):**
     - Orquestração via **Temporal** (`TemporalWorkflowRegistry`).
     - Autoridade única de admissão (`SessionAdmissionService`) com tratamento explícito de `StalePermit` e `UncertainOperation`.
     - **Transactional Outbox** (`OutboxRelay` com `FOR UPDATE SKIP LOCKED`) para evitar perda ou duplicação quando o processo falha entre o commit no banco e o início do workflow no Temporal (requisito exato da seção 11.3.1 / `T07`).
     - **Reconciliador com lease de reivindicação** (`SessionAdmissionReconciler` + `SessionLaunchRelay::CLAIM_LEASE`) que resolve exatamente a falha entre intenção, pré-voo e registro da execução no Temporal (`T08`).
     - Coleta de janelas de cota com cache/throttling (`SubscriptionUsageService`) e ferramentas SSH centralizadas com execução destacada (`detach: true` + `job_id` em `CoderSshExec` / `CoderPrepareRepo` / `CoderJobStatus`).
   - Suas lacunas são **localizadas e cirúrgicas**:
     - Remover a restrição `validates :agent_type, uniqueness: { scope: %i[user_id company_id] }` em `AgentCredential` para suportar múltiplas contas do mesmo provedor (ex.: duas contas Codex).
     - Desativar o proxy MITM nos containers (`MITM_DISABLED=true` / remoção da interceptação TLS em `docker/base/logger/`) e usar coordenação de credencial sem interceptação de tráfego para cumprir **RF-55** (Adendo §4.2).
     - Desacoplar `CoderSshExec` da CLI `coder` para usar OpenSSH padrão com hostkey fixado.
     - Reforçar a interface móvel (percursos compactos e grafo de leitura mobile-first na P0).

### 1.2 Recomendação
- **Recomendação técnica de engenharia (gatilho D-02 do Plano v1.1), aceita como candidato:** trabalhar sobre **Aixle Flow (`e6ec5a28`)**, pois a fonte contém **Temporal, admissão, transactional outbox, leases de reconciliação e jobs SSH destacados**, com menor custo estimado de adaptação. A inspeção estática não comprova funcionamento em produção nem cumprimento desses contratos na integração escolhida.
- **Caminho alternativo caso o proprietário priorize a stack Go + UI móvel imediata (D-01):** manter **Kandev (`997bc54f`)** somente se o proprietário aceitar o custo alto de escrever do zero tutta a camada Temporal + Outbox + Reconciliação + Serviço de Contas/Cotas e fechar os 9 pontos de entrada legados e as brechas de autenticação/MCP antes de qualquer login real.
- **Situação do Gate G0:** **PENDENTE** para ambas as bases até a conclusão das provas de execução bloqueadas (Seção 5).

---

## 2. Distinção obrigatória das constatações (Adendo §7)

### 2.1 Evidência documental e de código concluída
1. **Commits e licenças verificados (`EV-02`):** Kandev em `997bc54fae4da15702c91da5c5d120bfe651edc1` (`AGPL-3.0`); Aixle Flow em `e6ec5a286120aed3a036d85871e796b2f6c97d70` (`Apache-2.0`).
2. **Inventário das fronteiras críticas (`EV-04`, `EV-05`):** mapeados todos os adaptadores de CLI, modelos de credencial, pontos de entrada de execução, mecanismos de recuperação/Temporal, configuração de segurança e executores SSH nos dois repositórios.
3. **Auditoria de elegibilidade contratual RF-55 (`EV-03`):** classificados os modos de autenticação e transporte de Codex, Claude Code, Grok e Antigravity frente às fontes primárias do Adendo §4.2.

### 2.2 Provas técnicas executadas e seus resultados
Os itens EV-06/07 abaixo são registros históricos preservados. EV-09 não
reproduziu o namespace positivo: o ambiente negou `unshare`. EV-12 acrescenta
nova execução HOST positiva bidirecional, preservando a falha anterior, sem
provar isolamento integrado. EV-13/14 preservam o snapshot inicial FAIL/SQL
pendente. EV-16 acrescenta execução da gerência: Temporal corrigido cinco
cenários PASS e PG real 9 testes/67 assertions/0skip, guard 2/16 e preflights
PASS. São fatias isoladas; execução física da costura permanece pendente.

1. **Isolamento concorrente de contas com segredos sintéticos (`EV-06` — `T24` parcial):**
   - **Executado:** dois ambientes de conta simulados (`acct_a` e `acct_b`) sob o mesmo UID no Linux `5.17.15`.
   - **Resultado histórico:** HOME/CODEX_HOME permitiram leitura da fixture alheia via symlink; `unshare -Umr` com tmpfs bloqueou aquela tentativa mantendo leitura própria (`probe2_namespace_isolation_cross_read_blocked: true`). Esse teste limitado não prova bloqueio de todos os ataques de processo/filesystem. EV-09 ampliou os ataques e não conseguiu executar namespaces no ambiente da continuação.
2. **Fronteira SSH centralizada sem IA no destino (`EV-07` — `T25` parcial):**
   - **Executado:** instância `sshd` efêmera em loopback com chave host ED25519 fixada (`SHA256:ZD44FSXCR++iNTi8OBoJ+WqDO1w+N4rT3waKL8IYnn0`), repositório Git bare existente inicialmente apenas no lado remoto, clone/commit/push pela central (`4ae6d60fbeadb739fbbb0a41675ad54f3e0778e5`) e execução de teste via SSH no destino.
   - **Resultado:** artefato exato verificado e testado remotamente (`calc.mul(6, 7) == 42`) com confirmação de que o segredo de IA da central (`CENTRAL_AI_SECRET`) **não atravessou a fronteira SSH** (`ai_secret_present=False`).

### 2.3 Integrações não elegíveis para o plano/modo atual (RF-55)
1. **Antigravity (perfis Gemini e Sonnet) em plano de consumidor encapsulado por plataforma de terceiros:**
   - Classificação: **`unsupported_for_mode`** (Adendo §4.2 `[A1]`, `[A2]`).
   - Afeta tanto o adaptador `antigravity-acp` do Kandev quanto o `antigravity_cli_adapter.rb` do Aixle Flow (que ainda realiza refresh de token no servidor usando `client_id`/`client_secret` do `agy`).
   - Consequência: **não ativar nem testar com conta real** esse modo na nova plataforma. Perfis históricos ficam desabilitados nesta costura F0; não há pedido pendente de habilitá-los para concluir esta consolidação. Eventual ativação futura exige caminho oficial avaliado e etapa própria, sem confundir despacho do controlador com RF-55.
2. **Interceptação TLS via proxy MITM dentro dos containers de agentes (Aixle Flow):**
   - Classificação: **`unsupported_for_mode`** frente às restrições de não intermediar requisições/credenciais do Claude Code e demais CLIs (Adendo §4.2 `[A6]`).
   - Consequência: o mecanismo `docker/base/logger/start-mitm.sh` + `refresh_broker.py` do Aixle deve ser desativado (`MITM_DISABLED=true`) e substituído por controle de concorrência/renovação fora do caminho TLS antes de logins reais.
3. **Injeção automática de chaves de API pagas (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`):**
   - Ambos os candidatos aceitam ou injetam variáveis de chave de API (no Kandev, `RequiredEnv: []string{"OPENAI_API_KEY"}` em `codex_acp.go:134` e `codex_app_server.go:74`).
   - Consequência: deve ser bloqueado por política antes de qualquer lançamento para impedir cobrança por uso acidental.

### 2.4 Consolidação das três provas novas e lacunas reais

| Critério G0 | Origem da prova | Estado da integração / custo remanescente |
|---|---|---|
| E1 CLIs/assinaturas | EV-03 histórico, EV-09 RF-55 atualizado | **NOT RUN** real. Guard só aceita o caminho Codex local privado avaliado; modo privado hospedado/remoto `requires_clarification`. Titular/plano/versão/entitlement ainda não demonstrados; perfis históricos não são fallback ativo desta fatia |
| E2 duas contas | EV-05/06/09 histórico; EV-12 recibo HOST | HOME vazou; namespaces bloquearam cinco ataques bidirecionais com leitura própria mantida. **Parcial sintético**, contas reais/isolamento Aixle NOT RUN; unicidade de conta exige adaptação. Falha unshare do trabalhador preservada |
| E3 autoridade/durabilidade | EV-13/14 históricos; EV-16 físico; EV-18 costura | FAIL inicial nil preservado; correção revisada executada pela gerência: Temporal5 PASS, PG9/67/0skip e guard2/16/preflights PASS. Duas fatias isoladas. Costura PG+relay+Temporal implementada/revisada conforme contrato, execução física PENDENTE, sem segundo motor |
| E4 acesso/isolamento | EV-09 auditoria de 18 arquivos fixos | T36 **NOT RUN**. ttyd direto é bypass condicional; MITM/CA/proxy, RBAC/gateway/rede e acesso worker à central ainda por fechar/provar. Guard não integrado globalmente |
| E5 móvel | EV-10 histórico; EV-17 pacote novo retido | Quatro checks parciais, transporte/dados sintéticos; seis hashes de bytes novos conferidos. Perfil conta/modelo, criação de tarefa, persistência/deduplicação e grafo/estado real **NOT RUN**. Reuso da árvore/timeline viável, shell completo ainda por exercer |
| E6 licença | EV-02/05 documental | **Concluído documentalmente**: Apache-2.0 e operação privada; preservar avisos/licença |
| E7 SSH | EV-07 execução histórica loopback | **Parcial**; adapter/destino dedicado Aixle **NOT RUN**. Generalizar `coder ssh` para OpenSSH com fingerprint sem mover IA/credencial ao destino |
| AD1 elegibilidade | EV-03 e EV-09 fontes + guard standalone | 24 recusas/um positivo sintético; T39 global **NOT RUN**. Não autoriza MITM/cópia/refresh nem modo hospedado por presunção |
| AD2 capacidade comum | EV-11 procedimento sem contas | Preservado por não realizar chamadas; T28 real **NOT RUN**. Controlador ativo não comprova admissão/refresh comuns com Aixle |
| COMP comparação | EV-02/04/05, §3 desta ADR | **Concluída documentalmente**: notas estáticas preservadas, sem compensar eliminatórios |

Os relatórios e diffs de `g0-temporal` (`73ec58e`), `g0-boundary` (`744b19e`)
e `g0-mobile` (`6878e8c`) foram consultados. EV-08–11 registram commits completos,
causas e artefatos. A ausência histórica de report/trace/capturas móveis foi
tratada no lote3 com uma nova execução deliberada e pacote durável, não com
recuperação retroativa do trace antigo: EV-17, seis hashes conferidos. Continua
parcial de componentes sintéticos, sem shell real. Não houve execução de suítes
nesta consolidação.

O lote 2 acrescenta `4f7e477` (recibo Temporal), `85e9a5d` (política/host) e
`dca0e31` (harness SQL), incorporados ao clone. Hashes completos e limites em
EV-12–15 e [F0-LOTE2](validation/F0-LOTE2.md). Ambos os lotes DONE/quatro revisões
PASS cada conforme contrato; EV-16–18/[F0-LOTE3](validation/F0-LOTE3.md) registram
os marcos posteriores e seus recibos. Integração Git sozinha não certifica
revisão ou execução. Esta consolidação exige revisão independente posterior.
As notas comparativas permanecem estáticas, sem homologação operacional.

O custo comparativo da §3 permanece uma estimativa pelo snapshot, não afirmação
de que basta remover uma constraint ou definir `MITM_DISABLED=true`: é necessário
provar identidade/admissão de contas, ausência de interceptação e bypass e o
percurso real. Notas não foram recalculadas sem nova execução/material técnico.

---

## 3. Comparação detalhada das fronteiras críticas e custo de adaptação

### 3.1 Matriz de fronteiras e classificação de reuso (Pacote A — Plano v1.1 §19.3)

| Fronteira / Componente | Kandev (`997bc54f`) | Custo em Kandev | Aixle Flow (`e6ec5a28`) | Custo em Aixle Flow |
|---|---|---|---|---|
| **Orquestração durável (Temporal) e reconciliação de falhas (`T07`/`T08`)** | **Não possui Temporal.** Possui `office` experimental e `runtime.LaunchSpec` onde `Owner` e `OwnerAdmission` são opcionais em lançamentos legados (`runtime.go:157`). **Classificação:** *Substituir / Construir do zero*. | **Muito Alto** (introduzir Temporal Go SDK, criar Outbox, interceptar 9 pontos de entrada e desativar retries concorrentes do `office`). | **Possui Temporal nativo** (`TemporalWorkflowRegistry`), `OutboxRelay` (`FOR UPDATE SKIP LOCKED`), `SessionAdmissionService` (`StalePermit`, `UncertainOperation`) e `SessionAdmissionReconciler` com lease (`CLAIM_LEASE`). **Classificação:** *Reutilizar com adaptação leve*. | **Baixo** (ajustar regras da cadeia de perfis e estados específicos do plano). |
| **Contas múltiplas do mesmo provedor e isolamento (`T01`/`T24`)** | Credenciais resolvidas por nome de env var (`OPENAI_API_KEY`); executor `Worktree` compartilha UID/filesystem; `RemoteAuth` copia arquivos. **Classificação:** *Substituir modelo de contas + adaptar runtime*. | **Alto** (criar entidade de conta OAuth multi-instância e forçar namespace/container isolado por tentativa). | Possui `AgentCredential` criptografada, `SubscriptionUsageService` e containers por sessão, mas trava 1 credencial por `agent_type`/`user_id`/`company_id` (`agent_credential.rb:33`) e usa proxy MITM. **Classificação:** *Adaptar*. | **Médio** (remover constraint de unicidade por `agent_type`, adicionar `account_key`/`profile_id` e desligar MITM). |
| **Catálogo de CLIs e proteção contra API paga (`RF-08`/`RF-55`)** | Usa bridges ACP de terceiros para Claude e Codex (`@agentclientprotocol/*`), exige `agy_acp_server.par` e declara `OPENAI_API_KEY` em `RequiredEnv`. **Classificação:** *Adaptar / Substituir adaptadores*. | **Médio-Alto** (trocar para invocação direta/oficial onde exigido por `RF-55` e bloquear injeção de API keys). | Invoca CLIs diretamente (`claude`, `codex`, `grok`, `agy`), lê `account_id` do JWT do ChatGPT (`codex_adapter.rb:107`), mas `gemini_cli_adapter` só aceita API key e há MITM. **Classificação:** *Adaptar*. | **Médio** (bloquear chaves de API pagas, remover MITM e aplicar bloqueio `T39` para perfis `unsupported_for_mode`). |
| **Fronteira de segurança (UI, API, WS, Terminal, MCP) (`T15`/`T23`/`T36`)** | Bind padrão `0.0.0.0`, auth `opt-in` desabilitada por padrão, External MCP sem auth (`security.md:183`) e agente consegue alcançar a API HTTP para mutar perfis (`security.md:84-94`). **Classificação:** *Adaptar profundamente*. | **Alto** (fechar bind/auth por padrão, autenticar MCP externo e isolar API administrativa do alcance dos agentes). | Autenticação de usuários/empresas ativa no Rails, sessões isoladas em containers e tokens de sincronização por sessão (`SessionKey`). **Classificação:** *Reutilizar com endurecimento*. | **Baixo-Médio** (revisar escopo das `InternalTools` expostas ao container e desativar CA MITM). |
| **Execução remota via SSH com IA central (`T14`/`T25`)** | Executor SSH sobe `agentctl` no host remoto e copia credenciais de IA (`.codex/auth.json`) para o destino (`executor_ssh_credentials.go`). **Classificação:** *Não utilizar / Substituir*. | **Alto** (construir executor de jobs SSH remotos que mantenha o agente na central). | Possui `CoderSshExec`, `CoderPrepareRepo` e `CoderJobStatus` rodando comandos e clones remotos a partir do processo Rails com `detach: true` e `job_id`. **Classificação:** *Adaptar*. | **Baixo-Médio** (trocar transporte `coder ssh` por `ssh` padrão com fingerprint fixado, mantendo a estrutura de `job_id`). |
| **Experiência Web e Mobile (`T16`/`T27`/`T35`)** | UI React/TS madura, folhas móveis dedicadas (`mobile-remote-access.md`), gestão visual de tarefas e worktrees. Falta deduplicação por `command_id` no Temporal e grafo P0 ligado ao Temporal. **Classificação:** *Reutilizar e adaptar*. | **Baixo-Médio** (conectar comandos ao Temporal com `command_id` idempotente). | UI React + Inertia.js com telas de workflows, triggers, gates e credenciais, mas responsividade móvel apenas básica (32 arquivos com media queries). **Classificação:** *Adaptar / Expandir UI móvel*. | **Médio-Alto** (construir/refinar navegação mobile-first para Android, confirmação compacta e grafo de leitura responsivo). |
| **Licença e manutenção de fork (`G0-E6`)** | `AGPL-3.0`. Uso interno privado é permitido; distribuição ou exposição de serviço em rede a terceiros aciona copyleft. | **Baixo** (para uso exclusivamente pessoal). | `Apache-2.0`. Licença permissiva sem restrições de copyleft de rede. | **Muito Baixo**. |

---

### 3.2 Pontuação comparativa ponderada (Plano v1.1 §3.4)

Critério de notas (0 a 5, fundamentado apenas no código inspecionado nos commits fixados):
- `0` = inexistente ou incompatível; exige construção completa.
- `1` = muito distante do contrato; exige reescrita pesada.
- `2` = parcial com defeitos/acoplamentos importantes.
- `3` = base funcional que exige adaptação moderada e localizada.
- `4` = atende à maior parte do contrato com ajustes pequenos.
- `5` = atende integralmente sem alterações invasivas.

| Dimensão (Plano v1.1 §3.4) | Peso | Nota Kandev (`997bc54f`) | Justificativa verificável (Kandev) | Nota Aixle Flow (`e6ec5a28`) | Justificativa verificável (Aixle Flow) |
|---|---:|---:|---|---:|---|
| **1. Contas e CLIs** | **20%** | **2.0 / 5** | Tem adaptadores para as 4 famílias, mas usa bridges ACP terceiros, exige `OPENAI_API_KEY` em `RequiredEnv` e não modela múltiplas contas OAuth do mesmo provedor nem janelas de cota. | **3.0 / 5** | Tem adaptadores diretos para `codex` (com leitura de `account_id` do ChatGPT), `claude`, `grok` e `agy` + `SubscriptionUsageService`, mas exige remover a constraint `uniqueness` de `agent_type` e desligar o MITM. |
| **2. Durabilidade e consistência** | **25%** | **1.0 / 5** | Não usa Temporal; possui 9 pontos de entrada de lançamento e `OwnerAdmission` opcional em caminhos legados (`runtime.go:157`). Exige reescrever o núcleo de coordenação (gatilho **D-02**). | **4.5 / 5** | Já possui Temporal, `SessionAdmissionService` (`StalePermit`, `UncertainOperation`), `OutboxRelay` (`FOR UPDATE SKIP LOCKED`) e `SessionAdmissionReconciler` com lease (`CLAIM_LEASE`). |
| **3. Produto e mobile** | **25%** | **4.0 / 5** | Forte superfície React/TS, percursos móveis documentados e desenhados (`mobile-remote-access.md`), quadros, chat e worktrees prontos. | **2.5 / 5** | Possui UI de workflows, gates e sessões em React/Inertia, mas requer adaptação relevante para experiência mobile-first completa no Android. |
| **4. Extensibilidade e manutenção** | **15%** | **2.5 / 5** | Go + React bem estruturados, porém sob `AGPL-3.0` e com grande superfície experimental (`office`) que precisaria ser contornada ou removida para não competir com o Temporal. | **3.5 / 5** | Rails + React sob `Apache-2.0`, código conciso e focado exatamente em workflows Temporal + containers de agentes, reduzindo conflitos de merge em updates. |
| **5. Execução remota e isolamento** | **15%** | **1.5 / 5** | Executor padrão (`Worktree`) não isola credenciais no host; executor SSH move o agente e copia credenciais para o destino; API HTTP e External MCP têm brechas documentadas em `security.md`. | **3.5 / 5** | Isola sessões em containers e já possui `CoderSshExec` / `CoderPrepareRepo` / `CoderJobStatus` com `detach: true` na central; requer apenas trocar `coder ssh` por OpenSSH e desativar o MITM. |
| **Média Ponderada Final** | **100%** | **2.25 / 5.00** | Custo concentrado em **reescrever o motor durável (Temporal/Outbox/Admissão), o isolamento/segurança e o SSH**. | **3.40 / 5.00** | Custo concentrado em **adaptar multi-conta no banco, desligar o MITM, generalizar o SSH e melhorar a UI mobile**. |

---

## 4. Estimativa relativa do trabalho de adaptação nas fases seguintes (F1–F5)

| Pacote de adaptação | Se a base for **Aixle Flow (`e6ec5a28`)** (Recomendado) | Se a base for **Kandev (`997bc54f`)** |
|---|---|---|
| **F1 — Domínio, contas e políticas (`E02`–`E05`)** | **Pequeno/Médio:** migração SQL removendo índice único `(user_id, company_id, agent_type)` em `agent_credentials`, adição de `profile_key`/regras de substituição e guarda `RF-55` (`T39`). | **Alto:** modelar tabelas de contas OAuth, estados de cota (`available`, `exhausted`, `unknown`, etc.), probes serializados e bloquear `RequiredEnv` de API paga. |
| **F2 — Execução durável Temporal (`E06`–`E07`)** | **Pequeno:** estender workflows Temporal existentes, `SessionAdmissionService` e `OutboxRelay` já prontos. | **Muito Alto:** introduzir Temporal Go SDK do zero, implementar Outbox, leases e refatorar 9 pontos de entrada + desativar `office` scheduler. |
| **F3 — Equipe, QA, revisão e worktrees (`E08`–`E11`)** | **Médio:** ajustar steps do workflow para gerente único, QA (`RF-57` / `not_required`) e revisão independente com `git update-ref` atômico. | **Médio/Alto:** integrar steps de revisão/QA do `office` ao novo motor Temporal e isolar escritores de worktree. |
| **F4 — SSH centralizado (`E12`)** | **Pequeno:** adaptar `CoderSshExec` / `CoderPrepareRepo` / `CoderJobStatus` para chamar `ssh` com fingerprint fixado em vez de `coder ssh`. | **Alto:** criar executor de comandos/testes remotos por SSH sem subir `agentctl` nem copiar credenciais ao destino. |
| **F5 — Produto e Mobile (`E13`–`E14`)** | **Médio/Alto:** adaptar telas React/Inertia para operação móvel fluida (bottom sheets, grafo de leitura responsivo e `command_id` idempotente). | **Pequeno/Médio:** aproveitar UI móvel existente, adicionando o grafo de leitura P0 ligado ao Temporal e `command_id`. |

---

## 5. Situação do Gate G0 e decisões necessárias do proprietário

### 5.1 Declaração formal do Gate G0
**Gate G0: PENDENTE.**  
Em cumprimento estrito às instruções da F0 (*"Não declare aprovação enquanto houver critério obrigatório sem evidência. Quando o critério exigir execução, documentação sozinha não o satisfaz"*), o G0 **não está aprovado** nesta data.

### 5.2 Autorizações resolvidas e encaminhamento técnico

Aixle candidato e instalação isolada já autorizados pelo pedido atual e por
PASEO-CONTINUACAO; não pedir novamente escolha D-01/D-02 ou permissão genérica
para dependências. A autorização não homologa G0, não concede direitos do
provedor nem autoriza contas reais nesta entrega documental.

Clone de desenvolvimento e worktree desta consolidação identificados em STATUS
e EV-15; origem/Zed preservada. Controlador ativo para o fluxo de tarefas, sem
probe/reinício de serviço nesta entrega; demais projetos continuam pausados.
A exclusiva é a política EFETIVA `project_role_policies` id `agent-control`
em `model-limits.json`, para as raízes de origem/workspace de EV-15: manager
`codex/gpt-6.1-sol high`; programmer/reviewer
`codex-programmer/gpt-6.1-sol medium`, sessões independentes;
`automatic_fallback:false`, `quota_behavior:wait_for_same_account_positive_evidence`.
A cadeia global não a substitui. Fonte: contrato do controlador, sem inspeção
de configuração de host por este executor. Zed terminou conforme usuário;
outros planos seguem pausados. Isso não homologa perfis/contas da futura Aixle.

Próximo bloco: revisão independente desta consolidação e uma execução física
da costura candidata revisada pela gerência, conforme comando único/aceite de
[F0-LOTE3](validation/F0-LOTE3.md). Não repetir Temporal5/PG9 já verdes: seus
recibos físicos foram conferidos offline em EV-16, sem promover duas fatias a
integração única. O FAIL inicial continua preservado; preparação descartada por
ownership antes do snapshot completo não é falha de candidata. Nenhum comando
administrativo foi executado pelo trabalhador nesta consolidação.

Em seguida fechar fronteira OS/rede/T36 e contrato de admissão/outbox da base,
percurso móvel integrado e SSH de laboratório. Modo/plano RF-55 e coordenação
T28/contas não sobrepostas precedem qualquer etapa própria de conta real. São
lacunas de ambiente/implementação/elegibilidade, sem evidência de bloqueio por
quota ou transporte nesta consolidação. **Não iniciar F1 nem promover G0**
enquanto faltar eliminatório; revisão independente continua obrigatória.
