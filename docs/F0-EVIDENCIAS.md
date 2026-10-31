# F0-EVIDENCIAS — Registro de evidências da Fase F0 (Gate G0)

**Data:** 2026-10-31  
**Diretório do projeto:** `/home/enok/Documentos/projetos/agent-control`  
**Regra de classificação:** cada item distingue explicitamente entre:
1. **Comprovado por execução**
2. **Comprovado por código/documentação**
3. **Hipótese**
4. **Impedimento**

Nenhuma credencial real, token ou dado sensível foi lido, copiado ou incluído neste relatório. Nenhum serviço existente ou instância do Paseo foi alterado, reiniciado ou consultado com chamadas de IA.

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
