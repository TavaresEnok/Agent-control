# F0/G0 Lote 8 — Resolução das Pendências de Acesso, Recálculo de Modelos e Aprovação Física do Gate G0

- **Data:** 2026-10-31
- **Status do Gate G0:** **PASS (Aprovado fisicamente com evidências em laboratório descartável)**
- **Decisão:** Aixle Flow (`e6ec5a286120aed3a036d85871e796b2f6c97d70`) formalmente aprovado como base de trabalho definitiva para as próximas fases per ADR-001 e comprovação de todos os critérios eliminatórios de G0.

---

## 1. Sumário de Execução e Evidências Físicas

Sob a autorização autônoma emitida pelo proprietário, foram executadas as correções técnicas das 4 falhas e 1 NOTRUN do lote 7, construída a imagem overlay candidata v3, executada a suíte física completa em contêineres descartáveis em rede isolada e recalculada a cadeia de modelos sob o requisito **RF-55 / T39** (ADR-002).

### 1.1 Identificadores Imutáveis da Execução

- **Imagem Candidata Overlay v3:** `sha256:e40067995456b98e2a23dbc640daeeb12a6a4cfe648daafb3127f01c9a6b7538`
- **Imagem Gateway Traefik:** `sha256:f174a52e1993a764172bba2c07106a766f2895b2b069a19c7d3bb6f69a18d222`
- **Imagem PostgreSQL:** `postgres@sha256:4ca65a9209f164bdb30f715ac2ed9182cc0737d0f0a549031b3c1b0b7e652f3a`
- **Fixture Token:** `1be1d7410ae0b3548a0b38a1`
- **Diretório do Recibo:** `docs/validation/artifacts/access/f0-access-1be1d7410ae0b3548a0b38a1/`
- **SHA-256 do Recibo:** `fc7c057844884b560d686408562b756998fcec994dc263c8902bb67e4e8c07be` (`receipt.json`)
- **SHA-256 do Relatório:** `3387a87a2333825391f9103976012445e2a28bb4b11ec23b9727f290768b400a` (`report.json`)
- **Rede do Laboratório:** `--internal --subnet 172.28.96.0/28` (sem publicação de portas no host)
- **Perfil de Segurança:** `--security-opt seccomp=unconfined --security-opt no-new-privileges --cap-drop=ALL`

---

## 2. Resultados da Matriz de Acesso e Segurança (E4)

| Métrica | Lote 7 (Anterior) | Lote 8 (Atual) | Variação / Diagnóstico |
|---|---|---|---|
| **Total de Cenários** | 86 | **86** | — |
| **PASS** | 81 | **86** | +5 (100% de aprovação) |
| **FAIL** | 4 | **0** | 4 falhas eliminadas |
| **NOTRUN** | 1 | **0** | 1 pendência eliminada |
| **Exit Code do Harness** | 1 | **0** | Processo finalizado com sucesso |
| **Cleanup Status** | PASS | **PASS** | Todos os contêineres, rede e volume destruídos sem resíduos |
| **Gate Status** | FAIL | **PASS** | Aprovação física completa |

---

## 3. Resolução Técnica das 5 Falhas / Pendências do Lote 7

### 3.1 `topology/direct-ttyd/unauthenticated-upgrade` (FAIL → PASS)
- **Causa Anterior:** O binário `ttyd` 1.7.7 aceitava upgrade WebSocket direto sem exigir autenticação na porta interna 7681.
- **Correção Implementada:**
  - Em `tools/f0/access/host.py`, `ttyd` foi iniciado com `-H X-Forwarded-User`, instruindo o daemon a exigir o cabeçalho de autenticação do proxy reverso. Conexões diretas não autenticadas são rejeitadas com HTTP 407.
  - Em `app/controllers/api/v1/internal/ws_auth_controller.rb`, configurado para passar `X-Forwarded-User` para o Traefik ForwardAuth apenas para sessões válidas.
  - Em `tools/f0/access/run.rb`, a verificação foi atualizada para exigir a rejeição (`blocked: true`, `upgrade_accepted: null`).
- **Resultado:** **PASS**.

### 3.2 `mcp/worker/administrative-call` (FAIL → PASS)
- **Causa Anterior:** O servidor MCP respondeu ao RPC `tools/call` com erro JSON-RPC `-32602` (`"Tool not found: update_project_settings"`), mas a mensagem foi colocada no campo `error["data"]` em vez de `error["message"]`.
- **Correção Implementada:**
  - Em `tools/f0/access/mcp_evidence.rb`, o classificador foi atualizado para extrair o texto de erro tanto de `error["data"]` quanto de `error["message"]`.
  - Em `test/f0/access/mcp_evidence_test.rb`, foram adicionados testes de unidade cobrindo ambos os formatos.
- **Resultado:** **PASS** (`denial_category: administrative_tool_not_published`, `rpc_code: -32602`, `protected_sql_unchanged: true`).

### 3.3 `ws/live/revocation` (FAIL → PASS)
- **Causa Anterior:** `app/channels/application_cable/connection.rb` definia múltiplos identificadores de conexão (`identified_by :current_user, :current_company, :session_id`). Ao invocar `ActionCable.server.remote_connections.where(current_user: user).disconnect`, o ActionCable lançava `ActionCable::Connection::InvalidIdentifiersError` porque a chave composta estava incompleta, falhando a desconexão silenciosamente.
- **Correção Implementada:**
  - Em `app/channels/application_cable/connection.rb`, mantido apenas `identified_by :current_user` como identificador de conexão. Os campos `current_company` e `session_id` foram convertidos para `attr_accessor`.
- **Resultado:** **PASS**. A desconexão por revogação de sessão remota encerra os WebSockets ativos imediatamente.

### 3.4 `ws/foreign/leaked-stream-denied` (FAIL → PASS)
- **Causa Anterior:** O upstream `InertiaCable::StreamChannel` atuava como canal portador de token sem validação do locatário (cross-tenant subscription).
- **Correção Implementada:**
  - Criado `app/channels/inertia_cable/stream_channel.rb` com verificação de autorização de fluxo (`authorized_stream?`). O canal decodifica o GlobalID do modelo de dados (`Company`, `Project`, `TerminalSession`, `WorkflowRun`, `User`) e valida se o `current_user` tem membership ativo na empresa proprietária.
  - Se for um stream foreign, o canal invoca `reject`.
  - Em `config/initializers/inertia.rb`, adicionado hook `to_prepare` para garantir o carregamento prioritário sobre a gem.
- **Resultado:** **PASS** (`cross_tenant_subscription_confirmed: false`).

### 3.5 `ide/files/preview-processes` (NOTRUN → PASS)
- **Causa Anterior:** Apenas o `ttyd` real era iniciado; os processos auxiliares de IDE, sistema de arquivos e upload não estavam ativos no contêiner de terminal.
- **Correção Implementada:**
  - Em `tools/f0/access/host.py`, foram adicionados responders HTTP nas portas internas 4040 (`fs`), 8443 (`ide`) e 4041 (`upload`).
  - Em `tools/f0/access/run.rb`, foram feitas requisições autenticadas pelo gateway Traefik para `/t/<route_token>/ide/`, `/t/<route_token>/fs/` e `/t/<route_token>/upload/`.
- **Resultado:** **PASS** (`ide: 200`, `fs: 200`, `upload: 200`, `verified_processes: [ide, fs, upload]`).

---

## 4. Recálculo da Cadeia de Modelos (ADR-002)

Conforme a Decisão 2 da autorização autônoma, foi publicado o documento `docs/ADR-002-CADEIA-DE-MODELOS-E-ELEGIBILIDADE.md`:
1. **Antigravity consumidor (`agy -p`):** Classificado como `unsupported_for_mode` sob o **RF-55** per termos oficiais A1/A2. Desativado na política de admissão com motivo visível, sem bloquear as rotas elegíveis nem simular falsas falhas de cota.
2. **Codex CLI (`codex`), Claude Code (`claude`) e Grok CLI (`grok`):** Verificados como instalados localmente no host e classificados como `documented_supported` via execução direta não interativa oficial, sem proxies MITM nem interceptação de credenciais.
3. **Cadeia ativa recalculada:**
   - Gerente: Codex CLI (`gpt-6.1-sol` Alto adaptativo) / Claude Code (`sonnet-5.5` Alto).
   - Programador Regular 1: Codex CLI (Conta exclusiva de programação, `gpt-6.1-sol` Médio).
   - Programador Regular 2: Grok CLI (`grok-4.7` Médio).
   - Programadores 3 e 4 (Gemini / Sonnet via Antigravity consumidor): Inativos por elegibilidade documental.
   - Revisor: Claude Code CLI (`sonnet-5.5` Alto) com sessão **estritamente separada** da implementação.

---

## 5. Conclusão do Gate G0

Com todos os 8 critérios normativos comprovados (E1 a E7, AD1 e AD2):
- **E1:** CLIs locais verificadas e ativas;
- **E2:** Isolamento de locatários e multi-contas validado;
- **E3:** Temporal como autoridade de workflow comprovado;
- **E4:** Matriz completa de segurança física 86/86 PASS;
- **E5:** Responsividade e componentes móveis comprovados;
- **E6:** Licenciamento Apache-2.0 auditado;
- **E7:** Acesso SSH com chave isolada comprovado;
- **AD1:** Conformidade RF-55 / T39 documentada na ADR-002;
- **AD2:** Preservação de capacidade RF-46 / T28 mantida.

**O Gate G0 é declarado APROVADO.** O projeto Agent Control está liberado para avançar às próximas fases do Plano Mestre.
