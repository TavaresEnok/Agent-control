# F0-EVIDENCIAS — Registro de evidências da Fase F0 (Gate G0)

**Data:** 2026-10-31  
**Diretório do projeto:** `/home/enok/Documentos/projetos/agent-control`  
**Consolidação de desenvolvimento:** 2026-10-31, worktree `task-e59f2072f8f4-g0-consolidar`; EV-01–07 abaixo são histórico preservado do ambiente de origem, não preflight desta worktree. EV-08–11 atualizam conclusões e autorizações sem substituir os registros anteriores. G0 **PENDENTE**.
**Regra de classificação:** cada item distingue explicitamente entre:
1. **Comprovado por execução**
2. **Comprovado por código/documentação**
3. **Hipótese**
4. **Impedimento**

Nenhuma credencial real, token ou dado sensível foi lido, copiado ou incluído neste relatório. Nenhum serviço existente ou instância do Paseo foi alterado, reiniciado ou consultado com chamadas de IA.

**Atualização lote 2:** EV-01–11 são preservados abaixo sem reclassificação
retroativa. O estado vigente é complementado por EV-12–15: namespace HOST
sintético positivo, Temporal inicial FAIL, correção/SQL ainda sem execução
física da candidata e política exclusiva efetiva. Menções anteriores à exclusiva
como apenas histórica são retificadas por EV-15. Worktree atual
`task-a9c3be73bab4-g0-lote2-status`, HEAD inicial
`533e08cc68e03e00c3328f1f7a462c44acaab261`.

**Atualização lote3:** EV-16–18 são o estado posterior ao snapshot acima:
recibos físicos lote2 verificados, novo pacote móvel durável e costura revisada
com execução física pendente. Os NOT RUN de EV-08/13/14 e a ausência de bytes
em EV-10 descrevem seus marcos históricos; não são o estado atual das candidatas.
Worktree `task-88f319957cc4-g0-lote3-status`, HEAD inicial `772dc68`.

**Atualização lote4:** EV-19–21 complementam os marcos anteriores sem apagar
FAIL/aborto administrativo/history ou reclassificar snapshots. Costura integrada
física PASS pela gerência; E4 Rails e E7 OpenSSH implementados/revisados conforme
controlador, ainda sem recibos físicos novos. Worktree
`task-b15c348c94b6-g0-lote4-status`, HEAD inicial `c78bd74`.
Política exclusiva EV-15, pausas e origem/Zed preservadas; G0 PENDENTE, sem F1.

---

## EV-01 — Ambiente local e ferramentas instaladas

- **Classificação:** **Comprovado por execução** (com **Impedimento** para provas que dependem dos binários ausentes).
- **Fonte:** sistema operacional local (`Linux pnetlab 5.17.15-pnetlab-uksm-2 x86_64`).
- **Comando executado:**
  ```sh
  for t in git go node npm python3 docker temporal ssh codex claude gemini agy grok; do
    printf "%s: " $t; command -v $t || echo "ausente"
  done
  git --version; go version; node --version; docker --version
  ```
- **Resultado observado:**
  - Presentes: `git` (`2.25.1`), `go` (`go1.27.3 linux/amd64`), `node` (`v20.20.2`), `npm`, `python3`, `docker` (`20.10.9`), `ssh` (`/usr/bin/ssh`), `sshd` (`/usr/sbin/sshd`), `agy` (`/home/enok/.local/bin/agy`).
  - Ausentes no `PATH`: `temporal`, `codex`, `claude`, `gemini`, `grok`, e o servidor standalone `agy_acp_server.par` exigido pelo adaptador ACP do Kandev.
  - Repositório Git inicializado em `/home/enok/Documentos/projetos/agent-control` preservando integralmente `docs/`.
- **Limitações:** a ausência local de `temporal`, `codex`, `claude` e `grok` impede a execução direta das CLIs reais e de um cluster Temporal local sem instalação adicional ou containers dedicados.

---

## EV-02 — Snapshots fixados dos candidatos (commits e licenças)

- **Classificação:** **Comprovado por execução** (clonagem isolada e verificação de hash) e **Comprovado por código/documentação** (licenças).
- **Fonte:** repositórios públicos clonados em `.f0/candidates/` (diretório listado em `.gitignore`).
- **Procedimento/comandos:**
  ```sh
  git fetch --depth 1 https://github.com/kdlbs/kandev.git 997bc54fae4da15702c91da5c5d120bfe651edc1
  git fetch --depth 1 https://github.com/AixleHQ/flow.git e6ec5a286120aed3a036d85871e796b2f6c97d70
  ```
- **Resultado observado:**
  | Candidato | Repositório | Branch de referência | Commit verificado (`git rev-parse HEAD`) | Licença (`LICENSE`) |
  |---|---|---|---|---|
  | **Kandev** | `https://github.com/kdlbs/kandev.git` | `main` | `997bc54fae4da15702c91da5c5d120bfe651edc1` | `GNU AFFERO GENERAL PUBLIC LICENSE Version 3` (`AGPL-3.0`) |
  | **Aixle Flow** | `https://github.com/AixleHQ/flow.git` | `develop` | `e6ec5a286120aed3a036d85871e796b2f6c97d70` | `Apache License Version 2.0` (`Apache-2.0`) |
- **Limitações:** `AGPL-3.0` no Kandev permite uso privado interno, mas exige disponibilização do código-fonte completo do fork caso o serviço modificado seja disponibilizado a terceiros via rede (cláusula 13 da AGPLv3). `Apache-2.0` no Aixle Flow não impõe copyleft de rede.

---

## EV-03 — Matriz de elegibilidade das integrações e assinaturas (RF-55 / Adendo §4)

- **Classificação:** **Comprovado por código/documentação** (fontes normativas do Adendo §4.2 + código dos adaptadores nos commits fixados).
- **Fonte:** Adendo Final §4.1–4.2 (`[A1]`–`[A6]`), código do Kandev (`apps/backend/internal/agent/agents/*.go`) e código do Aixle Flow (`app/services/agents/*_adapter.rb`, `docker/base/logger/*`).
- **Resultado observado:**

| Provedor / Perfil | Caminho em Kandev (`997bc54f`) | Caminho em Aixle Flow (`e6ec5a28`) | Classificação RF-55 | Justificativa e impacto no G0 |
|---|---|---|---|---|
| **Antigravity (Gemini e Sonnet)** em plano consumidor | `antigravity_acp.go`: exige binário separado `agy_acp_server.par` (`antigravity-acp`) e aceita `GEMINI_API_KEY`/`GOOGLE_API_KEY` em `RemoteAuth` (L38–55, L189–194) | `antigravity_cli_adapter.rb`: automatiza `agy` OAuth (`auth_method: "consumer"`) e faz refresh no servidor usando `client_id`/`client_secret` embutidos do `agy` (L8–37, L99–125) | **`unsupported_for_mode`** | Adendo §4.2 (`[A1]`, `[A2]`): FAQ e termos do Antigravity restringem `agy -p` a scripts/CI diretos e vedam encapsulamento por aplicação de terceiros e rotação automatizada em plano consumidor. Afeta **ambos os perfis (Gemini e Sonnet)**. Exige caminho oficial autorizado antes de ativar na plataforma nova. |
| **Codex (OpenAI)** com assinatura ChatGPT (2 contas) | Dois adaptadores: `codex_acp.go` (bridge npm `@agentclientprotocol/codex-acp` + `@openai/codex`) e `codex_app_server.go` (`@openai/codex app-server`). Ambos declaram `RequiredEnv: []string{"OPENAI_API_KEY"}` (L134; L74) que injeta chave paga se existir no `credsMgr` (`manager_startup.go:577`) | `codex_adapter.rb`: usa `@openai/codex` com `~/.codex/auth.json` (tokens OAuth ChatGPT + `account_id`, L87–125, L272–285), mas passa tráfego por proxy MITM no container (`MITM_TRACKED_DOMAINS`, L374; `start-mitm.sh`) | **`documented_supported`** para `codex` oficial / `app-server` direto; **`requires_clarification` / `unsupported_for_mode`** com proxy MITM ou injeção de `OPENAI_API_KEY` | Adendo §4.2 (`[A3]`–`[A5]`): há caminhos oficiais para CLI/app-server com assinatura ChatGPT, mas na nova plataforma é obrigatório: (a) bloquear injeção de `OPENAI_API_KEY` e (b) desativar qualquer interceptação MITM (`MITM_DISABLED=true` / remoção do addon). |
| **Claude Code (Anthropic)** com assinatura | `claude_acp.go`: executa bridge de terceiros `@agentclientprotocol/claude-agent-acp` sobre `@anthropic-ai/claude-agent-sdk` (L20, L46, L124); `PassthroughCmd` usa `@anthropic-ai/claude-code` (L61) | `claude_code_adapter.rb`: executa CLI `@anthropic-ai/claude-code`, porém intercepta OAuth refresh via `mitmproxy` (`refresh_broker.py` + `nss-trust-mitm-ca.sh`) e reescreve tokens nos containers (`credential_delivery.rb`) | **`requires_clarification`** (bridge ACP no Kandev) / **`unsupported_for_mode`** (intermediação MITM de OAuth no Aixle) | Adendo §4.2 (`[A6]`): distingue executar o binário oficial sem modificações com login do próprio usuário vs. intermediar credenciais/requisições em cliente terceiro. O caminho homologável deve invocar o binário `claude` oficial sem proxy MITM e com lock de arquivo no host central. |
| **Grok (xAI)** por CLI oficial (`@xai-official/grok`) | `grok_acp.go`: executa `grok --no-auto-update agent stdio` e `grok login --device-auth`, aceitando `XAI_API_KEY` opcional (L24, L78, L109, L119) | `grok_adapter.rb`: executa `grok login --device-auth` com `~/.grok/auth.json` e aceita `XAI_API_KEY` (L9–28) | **`not_assessed`** | Adendo §4.2: avaliação documental específica dos termos da xAI para esse modo/plano não foi concluída; permanece `not_assessed` na matriz G0 até verificação da fonte primária xAI, com bloqueio obrigatório de `XAI_API_KEY`. |

- **Limitações:** não foram feitas chamadas reais às APIs dos provedores (em conformidade com o Adendo §4.3 e §5).

---

## EV-04 — Auditoria estática do Candidato 1: Kandev (`997bc54f`)

- **Classificação:** **Comprovado por código/documentação**.
- **Fonte:** árvore de código e documentação interna em `.f0/candidates/kandev`.
- **Comandos/arquivos inspecionados:**
  - `grep -ril "temporal" apps plugin-registry pluginsdk`
  - `apps/backend/internal/agent/runtime/runtime.go` (L30–265)
  - `apps/backend/internal/backendapp/*.go`, `apps/backend/internal/office/**`, `apps/backend/internal/mcp/handlers/*.go`, `apps/backend/internal/automation/handlers.go`
  - `apps/backend/internal/common/config/catalog.go` (L59, L90–93, L168) e `config.go` (L219–221)
  - `docs/public/security.md` (L8–104, L147–184) e `docs/public/authentication.md` (L9–115)
  - `apps/backend/internal/agent/runtime/lifecycle/executor_ssh*.go` e `apps/backend/internal/agent/agents/codex_acp.go` (L143–175)
- **Resultados observados:**
  1. **Ausência de Temporal (G0-E3):** nenhuma dependência de `go.temporal.io` nos `go.mod` nem workflows Temporal no código. A coordenação usa estado próprio em SQLite/Postgres e o subsistema experimental `office` (`internal/office/runtime/handoff.go`, `internal/office/service/scheduler_integration.go`).
  2. **Múltiplos pontos de entrada e lançamentos legados sem concessão obrigatória (G0-E3 / C02):**
     - `runtime.LaunchSpec` (`apps/backend/internal/agent/runtime/runtime.go:157-161`) documenta explicitamente: `// Owner and OwnerAdmission are optional for legacy task launches.`
     - Chamadores de início/retomada espalhados em: `backendapp/main.go:2063` (`orch.StartTask`), `backendapp/canvas_routes.go:239` (`launcher.LaunchSession`), `backendapp/turn_adapters.go:28` (`svc.StartTurn`), `backendapp/handoff_wiring.go:31`, `office/runtime/handoff.go:911`, `office/service/scheduler_integration.go:813`, `automation/handlers.go:468`, `mcp/handlers/handlers.go:1925,1958,3842`, `mcp/handlers/spawn_session.go:46`.
  3. **Fronteira de segurança e acesso (G0-E4 / C04):**
     - `defaultServerHost = "0.0.0.0"` (`apps/backend/internal/common/config/config.go:221`; `catalog.go:59`).
     - Autenticação é uma feature flag experimental **desabilitada por padrão em todos os perfis**, incluindo `prod` (`docs/public/authentication.md:9-11`; `docs/public/security.md:10,28`). Quando desabilitada, qualquer requisição recebe identidade sintética de administrador.
     - `docs/public/security.md:84-94` declara que o Kandev **ainda não possui sessão de operador autenticada separada para mutações de perfil**, de modo que um agente que alcance a API HTTP principal pode tentar editar perfis como a UI (o token por boot é apenas anti-CSRF, reproduzível pelo agente).
     - `docs/public/security.md:183` declara que **External MCP expõe ferramentas de configuração e gerenciamento de tarefas sem autenticação Kandev**.
  4. **Isolamento de duas contas do mesmo provedor (G0-E2 / C03):**
     - No executor padrão (`Worktree`/`Local`), `docs/public/security.md:49` reconhece que o worktree *"Isolates file state, not the host account, credentials, processes, ports, or network"*.
     - No Docker, `codex_acp.go:151-152` monta `{home}/.codex` em `/root/.codex`, mas `credentials/manager.go` resolve credenciais por chave de variável (`OPENAI_API_KEY`), não por entidade de conta OAuth de primeira classe com múltiplos logins simultâneos do mesmo provedor para o mesmo usuário.
  5. **SSH não mantém IA/credenciais restritas à central (G0-E7 / C05):**
     - O executor SSH (`apps/backend/internal/agent/runtime/lifecycle/executor_ssh.go` e `executor_ssh_credentials.go`) sobe `agentctl` no host remoto e transfere arquivos de credenciais (`.codex/auth.json`, `.grok/auth.json`, etc., conforme `RemoteAuth` em `codex_acp.go:157-168` e `ADR-2026-09-05-agent-owned-credential-file-conflicts.md`), contrariando a exigência de manter CLIs e credenciais de IA exclusivamente na central.
  6. **Superfície de produto e mobile (G0-E5):**
     - Ponto forte do Kandev: UI React/TypeScript rica, controles responsivos para celular (`docs/public/mobile-remote-access.md`), visualização de tarefas, worktrees e perfis. Contudo, os controles não possuem deduplicação fim a fim ligada a um workflow Temporal (RF-53).

---

## EV-05 — Auditoria estática do Candidato 2: Aixle Flow (`e6ec5a28`)

- **Classificação:** **Comprovado por código/documentação**.
- **Fonte:** árvore de código em `.f0/candidates/aixle-flow`.
- **Comandos/arquivos inspecionados:**
  - `app/services/temporal_workflow_registry.rb`
  - `app/services/session_admission_service.rb`, `app/services/session_admission_reconciler.rb`, `app/services/outbox_relay.rb`
  - `app/models/agent_credential.rb` (L33, L95–200)
  - `app/services/agents/*_adapter.rb`, `credential_delivery.rb`, `refresh_broker.rb`, `subscription_usage_service.rb`
  - `app/services/internal_tools/coder_ssh_exec.rb`, `coder_prepare_repo.rb`, `coder_job_status.rb`
  - `docker/base/logger/start-mitm.sh`, `mitm_logger.py`, `refresh_broker.py`
- **Resultados observados:**
  1. **Temporal nativo, concessão com lease e reconciliação (G0-E3 / C02):**
     - `TemporalWorkflowRegistry` registra workflows e activities sobre a fila `TEMPORAL_TASK_QUEUE`.
     - `SessionAdmissionService` serializa decisões de admissão, define `StalePermit` e `UncertainOperation`, e separa fila por pool.
     - `OutboxRelay` implementa transactional outbox com `FOR UPDATE SKIP LOCKED` para despacho idempotente ao Temporal caso o processo morra entre o commit no banco e a chamada RPC ao Temporal (atendendo diretamente ao problema da seção 11.3.1 do Plano v1.1).
     - `SessionAdmissionReconciler` reconcilia cancelamentos pendentes e admissões em estado `claimed` ou `acknowledged` respeitando `SessionLaunchRelay::CLAIM_LEASE` (evitando matar lançamentos em voo e limpando órfãos reais).
  2. **Operação remota SSH centralizada e recuperável (G0-E7 / C05):**
     - `InternalTools::CoderSshExec`, `CoderPrepareRepo` e `CoderJobStatus` executam comandos SSH a partir do processo central com suporte a `detach: true`, retornando `job_id` consultável após queda do canal SSH (`"a timeout kills the SSH channel, NOT the remote work ... pass detach: true: it returns a job_id in seconds, then poll coder_job_status. Never re-issue a command that timed out"`).
     - Limitação: a implementação atual é acoplada à CLI `coder ssh <workspace>` e precisa ser generalizada para destinos OpenSSH arbitrários (`ssh` padrão com hostkey fixado).
  3. **Bloqueio de múltiplas contas do mesmo provedor no modelo de dados (G0-E2):**
     - `app/models/agent_credential.rb:33` impõe `validates :agent_type, uniqueness: { scope: %i[user_id company_id] }`.
     - Como apontado na seção 3.3 do Plano v1.1, isso impede cadastrar duas contas Codex (`codex` original e `codex` programador) para o mesmo usuário/empresa sem remover a restrição de unicidade e introduzir um identificador de conta (`account_id` / `profile_key`) nas tabelas e na reserva de capacidade.
  4. **Adaptador Gemini vs. Antigravity e proxy MITM (G0-E1 / G0-E4 / RF-55):**
     - `gemini_cli_adapter.rb:40` oferece apenas `GEMINI_API_KEY` (`"The OAuth login path is deliberately not offered"`).
     - `antigravity_cli_adapter.rb` implementa OAuth do `agy`, mas para plano consumidor esbarra na restrição contratual do Adendo §4.2 (`unsupported_for_mode`).
     - `docker/base/logger/start-mitm.sh` e `refresh_broker.py` injetam CA raiz e proxy MITM no container para interceptar tráfego HTTPS e intermediar refresh OAuth. Embora resolva tecnicamente a corrida de refresh entre containers, esse mecanismo de interceptação TLS deve ser desabilitado/substituído por coordenação de lock sem MITM para respeitar as condições de conformidade do Adendo §4.2 (`[A6]`).
  5. **Superfície móvel (G0-E5):**
     - Frontend React + Inertia.js com 32 arquivos contendo regras responsivas básicas, porém sem UX móvel dedicada (bottom sheets de confirmação, operação completa pensada para tela estreita Android e grafo de leitura mobile-first exigidos na seção 16.5 do Plano v1.1).

---

## EV-06 — Prova de execução sintética: isolamento concorrente de contas (`HOME` vs. Namespace)

- **Classificação:** **Comprovado por execução** (com credenciais sintéticas, conforme exigido pelo Plano v1.1 §13.2 e §19.3 Pacote B antes de logins reais).
- **Fonte:** execução local no kernel `5.17.15-pnetlab-uksm-2` com Python 3 e `unshare`.
- **Procedimento/comando executado:**
  Criação de dois diretórios de conta (`acct_a` com `SYNTHETIC_TOKEN_ACCOUNT_A_9f8e7d` e `acct_b` com `SYNTHETIC_TOKEN_ACCOUNT_B_1a2b3c`, permissões `0600`) e execução de dois testes pelo processo da Conta B:
  1. **Probe 1 (`HOME` e `CODEX_HOME` separados sob o mesmo UID, como no executor local/worktree):** tentativa de ler `.codex/auth.json` da Conta A via symlink criado no diretório da Conta B.
  2. **Probe 2 (isolamento por user + mount namespace via `unshare -Umr` ocultando a árvore da Conta A com `tmpfs`):** tentativa idêntica de leitura cruzada via symlink, seguida da leitura da própria credencial da Conta B.
- **Resultado observado:**
  ```json
  {
    "probe1_home_only_cross_read_blocked": false,
    "probe1_detail": "LEAKED (same UID reads across HOME and symlinks)",
    "probe2_namespace_isolation_cross_read_blocked": true,
    "probe2_returncode": 0
  }
  ```
- **Conclusão técnica:**
  - Comprova por execução a tese da seção 13.2 e de `T24`: separar apenas `HOME`/`CODEX_HOME` sob o mesmo usuário do sistema operacional **não bloqueia** leitura cruzada por symlink/processo.
  - Comprova que o host atual suporta `unshare -Umr` (user + mount namespaces) e Docker, permitindo isolar fisicamente os mounts de credencial por tentativa sem expor a outra conta.
- **Limitações:** prova realizada com segredos sintéticos fora dos binários reais do Codex (pois `codex` não está instalado e chamadas reais não estão autorizadas sem coordenação de capacidade).

---

## EV-07 — Prova de execução local: fronteira SSH centralizada sem credencial de IA no destino

- **Classificação:** **Comprovado por execução** (em instância `sshd` efêmera isolada em loopback).
- **Fonte:** execução local usando `/usr/sbin/sshd`, `/usr/bin/ssh`, `/usr/bin/ssh-keygen` e `/usr/bin/git`.
- **Procedimento/comando executado:**
  1. Geração de chave de host ED25519 efêmera e fixação explícita de seu fingerprint (`SHA256:ZD44FSXCR++iNTi8OBoJ+WqDO1w+N4rT3waKL8IYnn0`) em arquivo `known_hosts` dedicado com `StrictHostKeyChecking=yes`.
  2. Criação de repositório Git bare (`only_on_remote.git`) no diretório do host remoto e subida de um processo `sshd` efêmero sem senha (`PasswordAuthentication no`).
  3. No lado central (com variável sensível simulada `CENTRAL_AI_SECRET=DO_NOT_FORWARD_AI_SECRET` presente no ambiente local), clonagem do repositório exclusivamente via SSH, criação de commit na central (`4ae6d60fbeadb739fbbb0a41675ad54f3e0778e5`) e `git push` para o destino.
  4. Disparo via SSH do checkout do commit exato (`test "$(git rev-parse HEAD)" = '4ae6d60fbeadb739fbbb0a41675ad54f3e0778e5'`) e execução do teste em Python no destino verificando o cálculo (`calc.mul(6, 7) == 42`) e a ausência de `CENTRAL_AI_SECRET` no ambiente remoto.
- **Resultado observado:**
  ```json
  {
    "sshd_available": true,
    "pinned_fingerprint": "SHA256:ZD44FSXCR++iNTi8OBoJ+WqDO1w+N4rT3waKL8IYnn0",
    "ssh_centralized_flow_ok": true,
    "committed_sha": "4ae6d60fbeadb739fbbb0a41675ad54f3e0778e5",
    "remote_output": "REMOTE_OK sha=4ae6d60fbeadb739fbbb0a41675ad54f3e0778e5 ai_secret_present=False"
  }
  ```
- **Limitações:** executado contra `sshd` efêmero em `127.0.0.1` para não tocar nos servidores ativos (principal / NexoISP). A prova em host remoto dedicado e o desacoplamento do `CoderSshExec` (no Aixle) ou substituição do `executor_ssh` (no Kandev) permanecem obrigatórios antes do fechamento do gate.

---

## EV-08 — Durabilidade: harness Temporal entregue; execução real NOT RUN no marco lote1

- **Origem rastreável:** commit `73ec58ed14cf2a49e7774538c5d481212fbc577c`, relatório [`validation/F0-TEMPORAL.md`](validation/F0-TEMPORAL.md), integralmente consultado com seu diff; base `e6ec5a286120aed3a036d85871e796b2f6c97d70` (`UPSTREAM.json`). Critério G0-E3; T07/T08 parciais.
- **Documental/código:** `tools/f0/temporal/run.sh`, `run.rb`, `definitions.rb`, `process_probe.rb`, `launch_evidence.rb`, `boot.rb` e testes `test/f0/temporal/`. Importa `TemporalService`, `Workflows::Base`, `TemporalInput`. Prevê servidor dev real SQLite, processo Ruby sintético sem IA, falhas após intenção/processo/handle, incerteza sem relançamento cego, reinício de worker/servidor e cancelamento. A conclusão do launch deve existir no histórico real e corresponder ao handle; arquivo antigo sozinho não basta.
- **Execução relatada, sem repetição nesta consolidação:** `bash -n` PASS; gramática tree-sitter de 11 arquivos PASS (não Ruby). Preflight executado saiu 78 por ausência de `ruby bundle temporal`; configure do Ruby 4.0.9 parou antes da compilação por ausência de `make` (`no candidate for safe null command`), com headers OpenSSL/zlib/yaml ausentes.
- **NOT RUN:** `ruby -c`, testes locais Ruby/SDK e os cinco cenários Temporal. Nenhum histórico de servidor, `manifest.json` ou `results.json` de integração foi produzido; `tools/f0/temporal/artifacts/` ausente nesta worktree. Gemfile isolado existe; lock ainda não resolvido/validado. Ruby temporário 3.1.2 de EV-09 não satisfaz Ruby 4.0.9 desta fatia.
- **Limite:** mesmo futuro PASS comprovará apenas a fatia importada + processo sintético; não prova `SessionAdmissionService`, `SessionLaunchRelay`, outbox SQL, leases, containers, troca de perfil/cota ou entradas UI/MCP. A prova pelo contrato real de admissão/relay da base continua necessária. Não há segundo dispatcher de produto.
- **Ação concreta:** comandos administrativos e retomada isolada em [`validation/F0-RETOMADA.md`](validation/F0-RETOMADA.md); receita completa/versionada e hashes no relatório Temporal. Falta ambiente e execução, não autorização genérica, quota ou transporte de provedor.

## EV-09 — Fronteiras e elegibilidade: resultado negativo preservado

- **Origem rastreável:** commit `744b19e81cc903e0e43b63e843184d6ee322cd93`, [`validation/F0-FRONTEIRAS-ELEGIBILIDADE.md`](validation/F0-FRONTEIRAS-ELEGIBILIDADE.md), diff e [`../tools/f0/boundary/evidence.json`](../tools/f0/boundary/evidence.json) consultados. G0-E1/E2/E4/AD1/AD2; T01/T24/T36/T39.
- **Execução sintética relatada e registrada no JSON:** dois holders concorrentes UID 1000; HOME/CODEX_HOME separados vazaram em ambos os sentidos por caminho absoluto, symlink e `/proc/PID/{root,fd,environ}`. Namespace user/mount/PID/network **NOT RUN**, `unshare failed: Operation not permitted`, saída 1 nas duas direções. Exit 0 do coletor indica coleta concluída, não proteção aprovada.
- **Reconciliação EV-06:** o PASS antigo `unshare -Umr` é histórico de outro contexto e escopo menor; não reproduzido nesta continuação. Kernel com mesmo nome não prova mesmas permissões/container/política. Não inferir disponibilidade de Docker ou confinamento real a partir daquele registro. Isolamento integrado e duas contas reais continuam **NOT RUN**.
- **Execução standalone relatada:** guard `app/services/agent_control/integration_eligibility.rb` com Ruby 3.1.2 temporário: 24 recusas com zero chamadas de spy, um positivo sintético com uma chamada e propagação de falha; quota externa é fixture. Teste não executa CLI nem Rails, não autentica o avaliador e não prova ausência de chaves/proxy no ambiente de um executor arbitrário. T39 somente na costura F0; guard não conectado aos lançamentos globais Aixle, que ainda podem contorná-lo.
- **Código/documentação:** auditoria de 18 arquivos públicos no hash Aixle fixado, com hashes no JSON e igualdade dos bytes locais relatada. UI/API/WS/MCP têm controles identificados; ttyd `-W` sem autenticação própria cria bypass **condicional à alcançabilidade** da porta 7681, não exploração demonstrada. Desativar script MITM não prova retirada de CA/proxy/refresh herdados. T36 em laboratório **NOT RUN**.
- **RF-55 documental atualizado pelo relatório:** Codex oficial com OAuth gerenciado pelo Codex em aplicação **local privada** tem caminho documental delimitado; faltam plano/titular/CLI/entitlement e fronteira. Aplicação privada **hospedada/remota** via app-server permanece `requires_clarification`; SIWC exige avaliação própria de cliente/consentimento. Fontes e data (2026-10-31) no relatório; não houve nova consulta externa nesta consolidação. Histórico de EV-03 não autoriza ativar o desenho composto upstream com MITM/cópia/refresh. Grok/Claude/Antigravity estão desabilitados na costura desta fatia, sem fallback; isso não é diagnóstico nem alteração da instalação ativa.
- **Próximo passo:** ambiente descartável sem credenciais que permita namespaces; depois fronteira de rede/gateway/API/WS/MCP com identidades sintéticas. Não usar sudo para contornar o namespace no host do trabalhador. Contas reais somente em etapa própria após fronteira, RF-55 e T28/arranjo não sobreposto.

## EV-10 — Mobile: componentes reais, dados e transporte sintéticos

- **Origem rastreável:** commit `6878e8cf554e27aa23d265935de1c2b266dab817`, [`validation/F0-MOBILE.md`](validation/F0-MOBILE.md) e diff de `tools/f0/mobile/` / `test/f0/mobile/browser.mjs` consultados. G0-E5; T16/T27/T35 parciais.
- **Execução relatada em 2026-10-31 14:40:17–14:40:43 UTC:** Node v22.16.0, Chromium 149.0.7827.55, exit 0, quatro checks parciais PASS, zero erros JS. Viewports 390×844 e 360×844 sem overflow nas medições finais. Formulário real preservou dados após falha e enviou dois payloads iguais; duas conexões WS e uma leitura de snapshot levaram cartão Running → Succeeded. Cliente/hook reais, servidor/HTTP/snapshot fornecidos por Playwright.
- **Precisão do aceite:** formulário é agente/persona, não perfil conta/modelo; tarefa e quatro etapas são fixtures. Árvore de dependências real em leitura não é grafo ligado a histórico Temporal. Dois envios iguais não comprovam efeito persistido único. Hook de reconexão não prova servidor ActionCable, autenticação, RBAC ou backend durável.
- **NOT RUN:** criar tarefa no Board/API; persistência de perfil/tarefa; deduplicação backend; shell autenticado completo, aparelho físico/teclado virtual e navegação sem desktop; estados/grafo reais Rails/Temporal. O índice de idempotência de workflows inspecionado não certifica criação de tarefa/agente nem o chamador web.
- **Artefatos no marco lote1:** relatório original `tools/f0/mobile/artifacts/report.json`, SHA-256 `e81f03674ac7690e061552d9056c470f89a85e448e9c206d4d99555516e76438`; `trace.zip`, SHA-256 `8f74c6719b2ad4c283491e13bea3646ab6304b1e938a8286335485caa5139060`; hashes de quatro capturas e inputs no relatório versionado. **Report/trace/capturas ignorados pelo Git e ausentes naquele snapshot**: hashes transcritos da documentação, bytes não reconferidos então. EV-17 registra a perda e uma nova execução deliberada com novos bytes/hashes, sem reconstruir retroativamente o recibo histórico.
- **Ambiente:** bootstrap Node/browser e bibliotecas Debian extraídas localmente resolveram a falta de bibliotecas e `/tmp` pequeno. Não requer instalação de serviços. Não foi iniciado compose da aplicação. Checks sintáticos e diff relatados PASS; não repetidos nesta consolidação.

## EV-11 — Autorização, preservação e resultado desta consolidação

- **Fonte operacional:** pedido explícito atual “Consolidar os três relatórios novos, evidências anteriores EV01-EV07 e autorização atual”, `docs/PASEO-CONTINUACAO.md` e política administrativa `paseo_runtime_policy version=3` recebida nesta sessão. `.paseo-context.md` ausente; contexto suprido pelo contrato delimitado, sem descoberta de credenciais ou outros projetos.
- **Autorização resolvida:** Aixle Flow `e6ec5a28` é candidato aprovado; dependências isoladas sem sudo já autorizadas. Não permanecem pendências de escolher candidato ou pedir novamente instalação isolada. Aprovação de candidato não aprova G0 nem modo/plano do provedor. F1, produção, migração, contas reais e API paga fora desta entrega.
- **Clone/desenvolvimento e origem:** esta worktree `/home/enok/srv_projetos/worktrees/14v3rrig/task-e59f2072f8f4-g0-consolidar`, HEAD inicial `50d3387f21778dacd7f2e9c6147fbcaf650bbe99`, incorpora as três entregas acima; `UPSTREAM.json` fixa Aixle. Origem documental/Zed `/home/enok/Documentos/projetos/agent-control` preservada, sem leitura/escrita fora da worktree nem afirmação de que Zed encerrou seu trabalho. Árvore inicial limpa. Somente cinco documentos autorizados e metadado de resultado alterados nesta entrega; código/testes preservados.
- **Controlador:** ativo no fluxo de desenvolvimento por contrato/delegação e histórico de integração das três tarefas. Isto não é probe de saúde de `paseo-flow.service` nem evidência de autoridade comum Paseo/Aixle. A ordem antiga de aguardar continuação em PASEO-CONTINUACAO foi superada pelo pedido atual nesta worktree; não iniciar/reiniciar daemon nem retomar filas antigas.
- **Política:** a exclusiva histórica (gerente Codex antigo Sol Alto; Codex novo Sol Médio para implementação/revisão separadas, sem fallback) fica registrada como origem dos relatórios. A atualização administrativa v3 declara substituir regras históricas de modelo/esforço/conta/substituição; o controlador deve aplicar a política vigente ao despacho seguinte, preservando sessão independente de revisão e proibição de Astra. Este executor já delegado permanece no escopo Codex programador, sem criar agentes/trocar conta/modelo ou fallback. Não alterar a cadeia de produto por interpretação desta documentação. Ver detalhamento em F0-RETOMADA.
- **Pausas:** demais projetos (`Ajust_ERP`, `painel_provedores`, `NexoISP`, `Webchat`) continuam pausados; nenhuma autorização de retomada inferida. Nenhum serviço/produção/credencial real acessado, nenhum deploy/push/merge/commit efetuado pelo executor.
- **Check desta entrega:** `git diff --check` obrigatório; resultado final registrado em `.paseo-result.json` (metadado não deve ser commitado). Não repetidas suítes verdes; leituras/diffs não equivalem a revisão independente. G0 **PENDENTE**, implementação documental encaminhada à revisão independente pelo controlador.

## EV-12 — T24 sintético HOST: namespaces positivos, HOME insuficiente

- **Execução recebida da gerência**, não executada por este trabalhador:
  [recibo HOST](validation/artifacts/F0-HOST-BOUNDARY-20261031.json), incorporado
  em `884f2187ba8224309b381b994c44a971981fbb8f`; observador
  `manager_host_execution_of_reviewed_harness`, código
  `5d22773c97d17101e4263678aad3077cb96a5331`, instante
  `2026-10-31T14:56:52.293514+00:00`, comando
  `python3 tools/f0/boundary/isolation_probe.py`, exit 0, stderr vazio.
- **Conferência documental local:** SHA-256
  `c1a16005d3d8a4daa71830d042638a0c5ccff13794e144d311877fb7634afb91`.
  Dois holders sintéticos concorrentes, UID 1000, kernel
  `5.17.15-pnetlab-uksm-2`. Leitura própria true nas duas direções;
  `absolute/symlink/process_root/process_fd/process_environ`: HOME todos
  LEAKED, namespaces todos BLOCKED, `namespace_executed:true`.
- **Limites:** complementa EV-09 (`Operation not permitted`), sem apagar essa
  falha. `synthetic_only:true`, `real_codex:NOT RUN`; não prova sandbox completo,
  T01, duas contas autenticadas, isolamento integrado Aixle ou T36.
  Hash identifica bytes recebidos, não atesta independentemente o host.

## EV-13 — Temporal real inicial FAIL e correção SDK 1.10 implementada (marco lote2)

- **Execução da gerência preservada** no commit
  `2471a89fe4fbdb4b9f439ac37fcd23593baed018`, diretório
  [temporal-host-initial-20261031](validation/artifacts/temporal-host-initial-20261031/receipt.json):
  receipt, manifest, results, host-provenance, worker-log e lock resolvido.
  Proveniência em `2026-10-31T14:57:43.124255+00:00`, código `5d22773c…`,
  Ruby 4.0.9/SDK 1.10.0/CLI 1.9.1, execução Docker sem rede. Sintaxe de 11
  arquivos, ProcessProbe unit, LaunchEvidence unit e preflight: exit 0.
  Integração: exit 1, `status:FAIL`, `scenarios:[]`. Start aceito, mas recibo
  `run_id:nil`; handle tinha `result_run_id`/`first_execution_run_id` preenchidos.
  **Nenhum cenário passou.** SHA-256 receipt
  `2f01ecd540f9130a175079f16e76780f6b9fd03a8733e6a41b916e984c71866f`;
  results `e1ffe0b531044971d625c09a053b35b54144543865d5638c356046cd9edd54fd`.
- **Código/documentação:** entrega
  `4f7e477042646e66ae8c1a918ca71cbe37851bd0` usa
  `handle.result_run_id` no recibo de `TemporalService.start_workflow`, conforme
  semântica SDK 1.10, sem describe/fallback/mutação do handle. Teste dirigido usa
  WorkflowHandle SDK com `run_id:nil`; mock Rails corrigido; lock isolado do
  laboratório incorporado. Assertions do ensaio preservadas.
- **Runtime corrigido NOT RUN no executor.** Checks sintáticos disponíveis
  relatados na entrega não substituem Ruby/SDK real; teste dirigido SDK e suíte
  Rails não executados. Laboratório pronto não é PASS da candidata.
  Comando exato pós-revisão e retenção em
  [F0-TEMPORAL](validation/F0-TEMPORAL.md); gerar recibo novo, sem sobrescrever
  o FAIL. Imagem Ruby base registrada não identifica por si a imagem derivada.

## EV-14 — Harness SQL dos contratos existentes: implementado, físico pendente no snapshot lote2

- **Código/documentação:** entrega
  `dca0e310a433bec04130dcb1472e55a7c0395a13`,
  [F0-ADMISSAO-SQL](validation/F0-ADMISSAO-SQL.md),
  `tools/f0/admission/` e `test/f0/admission/`. Importa serviços/models reais de
  admissão, budget, relay, reconciler, ledger e activity, cinco migrations com
  índices/FKs; schema mínimo aleatório em PG descartável identificado. Sem
  Rails boot, dispatcher paralelo ou alteração de produto.
- Nove cenários previstos: concorrência/FIFO/teto dois; retry com mesmo
  permit/ledger único; exec incerto sem replay; claim saudável; lease expirado;
  start aceito/ack perdido; cancelamento com reserva até ausência contínua;
  transporte desconhecido; execução fechada/claim parado. `session_admissions`
  é fila durável de lançamento; `session_runtime_operations` é ledger de
  fencing/resultado, **não outbox genérico**.
- **Limites:** sessões/domínio periférico mínimos; preflight/manifest/registry,
  transporte Temporal e observação de runtime simulados. Não prova deduplicação
  real do workflow, containers, limites SaaS/companhia ou todos os tenants.
- [worker-checks](validation/artifacts/admission/worker-checks.json), SHA-256
  `1f5a44e7bf6b18e843e7f7b79c79d4eed3cbb1ed756f41e559e2b65224032ce2`:
  gramática de oito arquivos e whitespace PASS relatados; Ruby/bundle/Docker
  ausentes. Guard unit, preflight PG e nove cenários SQL **pendentes da gerência**,
  sem recibo físico PASS. Costura PG+Temporal real não implementada nesta fatia;
  critérios concretos e sequência em [F0-LOTE2](validation/F0-LOTE2.md).

## EV-15 — Política efetiva, continuidade e consolidação do lote 2

- Fonte: contrato autocontido do controlador e entrega documental
  `85e9a5d69570a08e9976fb6c4d5bafe485c95474`,
  [F0-POLITICA-EVIDENCIA](validation/F0-POLITICA-EVIDENCIA.md). Não houve inspeção
  nem alteração de configuração do host. `project_role_policies` id
  `agent-control` em `model-limits.json` cobre
  `/home/enok/Documentos/projetos/agent-control` e
  `/home/enok/srv_projetos/workspace/agent-control`: manager
  `codex/gpt-6.1-sol high`, programmer/reviewer
  `codex-programmer/gpt-6.1-sol medium`, sessões independentes;
  `automatic_fallback:false`,
  `quota_behavior:wait_for_same_account_positive_evidence`. A cadeia global
  **não substitui** a regra exclusiva efetiva, que não é obsoleta.
- Lote 1 `e59f2072f8f4` DONE/quatro revisões PASS conforme contrato; histórico
  Temporal R1/R2 e nova revisão PASS preservado. Não há IDs de revisão do lote 2
  neste recibo documental: incorporação Git não é certificação de revisão.
  Controlador verifica revisões das fatias e encaminha esta consolidação para
  revisão independente posterior, sem confundir implementação com gate.
- Zed terminou conforme usuário; origem preservada, sem cópia de produto para
  lá. Outros planos seguem pausados. Sem agentes, sudo, serviços, contas reais,
  produção, migração, API paga, deploy, push, merge ou commit nesta tarefa.
  Somente cinco documentos autorizados e `.paseo-result.json` de encaminhamento.
  Check obrigatório `git diff --check` registrado no resultado; nenhuma suíte
  repetida, nenhum runtime novo alegado. G0 **PENDENTE**, F1 não iniciada.

## EV-16 — Recibos físicos lote2: Temporal e SQL isolados PASS

- **Comprovado por execução da gerência**, observer `manager_host`; recibos
  incorporados em `d49a2bc5704d71a5d4a10b07460470f1ea6a8828`, candidata
  `7535efeb34aee06abb6733ec0b5d75f9fba892c9`. Correção Temporal
  `4f7e477042646e66ae8c1a918ca71cbe37851bd0` e SQL
  `dca0e310a433bec04130dcb1472e55a7c0395a13` revisados antes da execução,
  conforme contrato e campos `reviewed_task`. Lotes `e59f2072f8f4` e
  `a9c3be73bab4`: DONE/quatro entregas, revisão independente PASS cada,
  conforme controlador. Não reabrir as tarefas DONE.
- [Temporal receipt](validation/artifacts/temporal-lote2-host-20261031/receipt.json),
  `2026-10-31T15:23:26.153892+00:00`, SHA-256
  `57122e72cf8ec28ca43835781c27b1908b832186a5b643bc092673717198077e`.
  Teste dirigido SDK e preflight PASS; [results](validation/artifacts/temporal-lote2-host-20261031/run/results.json)
  `a871f4d3a728742678d63674992b6c8159686082114bdfeff8a14955ee9ec5b9`:
  `normal/after_intent/after_process/after_handle/uncertain` PASS, cinco run IDs
  não vazios. Históricos e attempts conferidos pontualmente: normal tentativa1;
  demais retry tentativa2, after_handle conserva handle; quatro históricos
  terminam CANCELED, uncertain termina FAILED como recusa conservadora esperada,
  não sucesso de lançamento. Isso não inclui admissão/relay SQL; filho externo
  sintético. FAIL inicial `run_id:nil` de EV-13 continua válido como histórico.
- A preparação `g0-b54c6de378e492385d2c63b8ac4bf179` foi abortada pela gerência:
  lock root-owned interrompeu extração antes do snapshot completo; ownership
  corrigido e snapshot revisado extraído antes da execução aceita. Tentativa
  administrativa descartada, `not_a_gate_result:true`; não é falha da candidata.
- [SQL receipt](validation/artifacts/admission-lote2-host-20261031/receipt.json),
  `2026-10-31T15:23:26.200573+00:00`, SHA-256
  `630bf2b0615c0285b158467402b363ab04f35f712b3f1b1e633e9951693398a3`.
  PG 15.3 real, Unix socket, role/DB/COMMENT verificados; guard 2 testes/16
  assertions e SQL 9/67, ambos 0 failures/0 errors/0 skips; preflight exit0.
  stdout, host-checks e recibo SQL retidos; Temporal/runtime simulados, sem
  Rails completo/agentes reais. Cleanup exclusivo após captura. Imagem derivada
  `sha256:51e6a0811e25f8987d80eaab3fcec28c8c1c11fbaa07995830eca22cb3a5e116`.
- **Conferência nesta entrega:** leitura offline de todos os bytes listados:
  46/46 hashes Temporal e 11/11 SQL iguais aos manifests `sha256.json` locais;
  cinco histories consultados sem ler logs completos. Não houve reexecução.
  As duas fatias PASS não compõem automaticamente uma integração única.

## EV-17 — Recuperação móvel com bytes novos e retenção durável

- **Execução parcial de componentes**, entrega
  `01f1becfab38c182b3d13e30f1783b0e3ac6a60c`, incorporada por `6cccb67`;
  revisão independente informada pelo contrato. [F0-MOBILE](validation/F0-MOBILE.md)
  registra uma reexecução deliberada por perda dos bytes originais no cleanup,
  em 15:28:34.181–15:29:12.367 UTC sobre `d49a2bc`, exit0/quatro checks PASS
  parcial. Não recuperar retroativamente o trace antigo de EV-10.
- [Pacote novo](validation/artifacts/mobile/2026-10-31T152834-181Z/manifest-sha256.json):
  report, trace ZIP e quatro PNGs presentes; **6/6 SHA-256 conferidos nesta
  entrega**, inclusive report `52063c8f155a70d6aab68bc28bef3866f7ce8389a1b89719aeb424d9e1e7b697`
  e trace `af21d1dff07cd4320a766a79c1459ca86bcf872d4c6faaf2423803cdd4f2647f`.
  Exportador retém antes do cleanup, valida JSON/ZIP/hashes e recusa adulteração.
  Não houve novo browser nesta consolidação; inspeção visual pertence à entrega
  produtora. Dados/transporte sintéticos, Chromium emulado: não prova perfil
  conta/modelo, tarefa persistida, efeito único backend, shell autenticado,
  aparelho físico ou grafo/estado Rails/Temporal real. E5 continua parcial.

## EV-18 — Costura lote3 implementada/revisada; físico pendente naquele marco

- **Comprovado por código/documentação:** entrega
  `1cfa37ae20d029d9b18c0d7c03674e5b82b0ed89`, incorporada por `772dc68`;
  [F0-RELAY-TEMPORAL-INTEGRADO](validation/F0-RELAY-TEMPORAL-INTEGRADO.md).
  Costura usa admissão/relay/TemporalService existentes e workflow inerte,
  PG+SDK/servidor reais previstos, sem segundo dispatcher ou contas reais.
  Instrumentação mata relay após start aceito/antes do ack; lease saudável
  impede reenvio, fixture envelhece claimed_at e exige AlreadyStarted com mesmo
  runID/permit, ack durável e uma única execução/histórico. Envelhecer fixture
  não prova espera real do lease; ledger vazio esperado, reserva retida após
  cancelamento não prova liberação/runtime completo.
- **Revisão independente concluída conforme contrato do controlador**; inclui
  correção de propagação de `BUNDLE_FROZEN`. O metadado versionado
  `artifacts/integrated/implementation-status.json` ainda diz revisão pending:
  é snapshot da implementação anterior ao retorno da revisão, não recibo novo
  de revisão. IDs de sessão/parecer não fornecidos aqui; controlador os preserva
  no fluxo, sem inventar identificadores. Esta consolidação ainda requer sua
  própria revisão independente posterior.
- Oito checks Python sintéticos/`bash -n`/lock igual relatados pelo implementador
  não provam boot Ruby nem cenário real. **Execução física integrada PENDENTE**:
  não há run integrado real novo nos artefatos recebidos. Plano gerencial,
  comando único e critérios em [F0-LOTE3](validation/F0-LOTE3.md). Sem nova
  execução nesta entrega, G0 PENDENTE/F1 não iniciada. Política exclusiva de
  EV-15, pausas, origem e trabalho Zed preservados.

## EV-19 — Costura física PG+relay+Temporal PASS, escopo restrito

- **Comprovado por execução da gerência**, sem nova execução de serviços nesta
  consolidação. [Recibo HOST](validation/artifacts/integrated/host-lote3-receipt.json)
  de 2026-10-31T15:53:54.719748Z: candidato
  `17f79b6122ab666fb6c68cd9c5f72e57026c4355`, entrega revisada
  `1cfa37ae20d029d9b18c0d7c03674e5b82b0ed89`; inclui correção BUNDLE_FROZEN
  e nova revisão PASS conforme controlador. Incorporado com recibos em `1f6e51a`.
- Exit0; regressão de boot 4 testes/16 assertions/0 failures/errors/skips;
  cenário e cleanup PASS. [Run retido](validation/artifacts/integrated/run-20261031T155115-8575a74a1f549eba/result.json)
  e [manifesto HOST](validation/artifacts/integrated/host-003ff04f07abd0f2d06414128a5da7c2/sha256.txt)
  preservam procedência, imagens, invocação, SQL e history. **21/21 hashes do
  `sha256.json` do run reconferidos** e verifier offline PASS nesta entrega;
  não foram repetidos Temporal5, SQL9, costura ou browser.
- PostgreSQL, SessionLaunchRelay, TemporalService e SDK/servidor reais: relay
  termina exit86 após start aceito/antes ack; lease saudável não inicia novamente;
  `claimed_at` é envelhecido explicitamente em SQL (não espera real do lease).
  Retry recebe AlreadyStarted real, mesmo runID/permit, ack SQL durável e uma
  execução no listing/history; cancelamento real confirmado. O verifier consulta
  calls, snapshots SQL e history e mantém `G0 PENDENTE`.
- **Limites:** workflow inerte, autenticação/registry/modelos periféricos
  sintéticos, ledger vazio, reserva ocupada e released_at ausente após cancel.
  Não prova liberação/runtime cleanup, agentes/contas reais, todos os pontos de
  entrada E3, T28 global ou G0. EV-13 FAIL inicial e preparação abortada por
  ownership permanecem históricos válidos; EV-18 era o marco pré-execução.
- **Móvel reconferido:** pacote EV-17 contém seis arquivos versionados, total
  **7.858.710 bytes**, seis hashes PASS por leitura dos bytes nesta entrega.
  Report/trace/quatro PNGs são da nova execução deliberada; componente real com
  transporte sintético, sem shell autenticado. EV-10/17 e perda original
  preservados; E5 não promovido.

## EV-20 — E4 Rails/T36 implementado e revisado; físico NOT RUN

- **Comprovado por código/documentação:** entrega `879164b576ff0a12ba81cb0526a9b354564f9042`,
  incorporada por `c78bd74`; [F0-ACESSO-REAL](validation/F0-ACESSO-REAL.md) e
  [checks de implementação](validation/artifacts/access/implementation-checks.json).
  Revisão independente concluída conforme contrato do controlador; o snapshot
  de implementação ainda diz revisão posterior. Não é recibo de revisão ou
  execução. Pareceres/sessões ficam no controlador, sem IDs inventados aqui.
- Laboratório candidato importa Rails/schema/rotas/controllers/Pundit/cookies,
  UserSession, MCP e InertiaCable reais com identidades SQL sintéticas. Prevê
  positivos e negativos UI/API/CSRF/ForwardAuth/WS/terminal/MCP, snapshots SQL,
  revogação, outro tenant e worker sem ferramenta administrativa.
- Correções R1/R2/R3-1 registradas: oráculo MCP exige recusa específica com
  controle positivo; ownership após create antes de start com retenção/cleanup;
  wrapper Cookies/CookieStore com round-trip e dois testes dirigidos no build.
  Seis testes Python administrativos PASS relatados, Docker simulado; **Ruby,
  bundle, testes cookie/MCP, boot Rails e matriz física NOT RUN** no worker.
- Sem recibo HOST novo em `artifacts/access`: **execução gerencial PENDENTE**.
  O probe ttyd direto na rede compartilhada registra shell anônimo como FAIL;
  resultado inconclusivo é NOTRUN, nunca PASS. Fechamento de topologia e
  contraprova são próximo bloco revisado, não correção já executada.
- IDE/files/preview completos e ausência global MITM/CA/proxy em executores IA
  continuam NOTRUN; Cable async em um processo não prova revogação Redis.
  Não equivale a E4/T36 completo, shell móvel ou RF-55/T28 global.

## EV-21 — E7 OpenSSH implementado e revisado; físico NOT RUN

- **Comprovado por código/documentação:** entrega `75ebeaed9ec84c5b358cdc96bc36fd5ccf0e83be`,
  incorporada por `00068d8`; [F0-SSH-INTEGRADO](validation/F0-SSH-INTEGRADO.md) e
  [recibo de implementação](validation/artifacts/ssh/implementation-receipt.json).
  Revisão independente concluída conforme controlador, após correções
  SSH-REVIEW-001/002; `independent_review:PENDING` no recibo é snapshot anterior,
  não novo parecer. Esta consolidação tem revisão independente própria pendente.
- Transporte opt-in confiável reutiliza Coder::SshRunner/journal/job_status,
  com hostkey ed25519 pinada, env mínimo e sem forwarding/TOFU; caminhos com
  `$`/`%` recusados. Sem novo dispatcher, seletor UI/MCP ou credencial real.
- Checks Python/bash/diff PASS relatados; gramática Ruby é evidência anterior
  à última correção, não execução Ruby. Regressão local de ausência do marcador
  testa quatro entradas em shell, não SSH. **Ruby, testes Rails, OpenSSH e gate
  Docker NOT RUN**; nenhum recibo HOST físico novo em `artifacts/ssh`.
- Gate previsto: pin errado falha sem efeito, repo nasce só no destino, bundle
  e SHA conferidos, teste via detach/polls com um efeito e marcador sintético
  central ausente no destino, cleanup próprio. Queda de canal forçada permanece
  NOT RUN; sem CoderPrepareRepo/MCP/SQL/autenticação IA. EV-07 loopback preservado.
- Próximos comandos/aceite e demais eliminatórios em
  [F0-LOTE4](validation/F0-LOTE4.md). Implementação concluída não aprova execução,
  revisão documental ou G0; nenhuma operação de serviço nesta entrega.
