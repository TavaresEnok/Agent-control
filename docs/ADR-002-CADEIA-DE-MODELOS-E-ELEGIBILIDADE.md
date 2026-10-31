# ADR-002: Recálculo da Cadeia de Modelos e Elegibilidade de Integração (RF-55 / T39)

- **Status:** Proposto / Aprovado no escopo de autorização autônoma de G0
- **Data:** 2026-10-31
- **Decisor:** Antigravity / Agent Control Core Architecture
- **Referências:** 
  - `docs/PLANO_MESTRE_PLATAFORMA_AUTONOMA_v1.1_2026-10-31.md` (§9, §13, §21.5)
  - `docs/ADENDO_FINAL_PLANO_v1.1_G0_2026-10-31.md` (§4.1–4.3, §6, RF-55, T39, RF-46, T28)
  - `docs/ADR-001-BASE-DA-PLATAFORMA.md`
  - Fontes Primárias: [Antigravity FAQ (A1)](https://antigravity.google/docs/faq), [Antigravity Terms (A2)](https://antigravity.google/terms), [OpenAI Auth (A3)](https://learn.chatgpt.com/docs/auth), [OpenAI Non-interactive (A4)](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude Code Legal (A6)](https://code.claude.com/docs/en/legal-and-compliance).

---

## 1. Contexto e Motivação

O Plano Mestre v1.1 (§9) definiu uma semente inicial de papéis e substituições que incluía modelos operados via Codex, Claude Code, Grok e Antigravity (Gemini e Sonnet). O Adendo Final (§4.1–4.3) incorporou formalmente o **RF-55** e a prova de aceitação **T39**, estabelecendo que:

> **RF-55:** É obrigatório verificar, para cada provedor, plano, titular, CLI/adaptador, autenticação e modo de uso, se o acesso proposto é oficialmente autorizado. Login bem-sucedido e resposta de inferência demonstram funcionamento técnico; não demonstram, sozinhos, elegibilidade para o modo de integração.
>
> **T39:** Um perfil tecnicamente funcional, mas não autorizado para o modo/plano, deve ser recusado na política de admissão antes de iniciar a CLI no fluxo gerenciado. O motivo deve ser visível, não alterar falsamente a evidência de cota como "esgotada", e não disparar API paga sem aprovação explícita do proprietário.

Na Decisão 2 da autorização autônoma emitida pelo proprietário, foi determinado:
1. Recalcular a cadeia de modelos utilizando somente integrações elegíveis para o provedor, assinatura, autenticação e modo de execução.
2. Desativar os caminhos inelegíveis com motivo visível, sem bloquear os elegíveis.

---

## 2. Matriz de Elegibilidade dos Provedores e Transportes

| Provedor / Transporte | CLI / Versão Local | Modalidade / Plano | Modo de Execução Proposto | Fontes Oficiais | Classificação RF-55 | Decisão para o Agent Control |
|---|---|---|---|---|---|---|
| **Antigravity CLI (`agy`)** | `1.4.12` em `~/.local/bin/agy` | Consumidor (Google Account pessoal / Free / Pro individual) | Encapsulamento automatizado por plataforma web/agente terceiro (Agent Control) | A1 (FAQ §Headless/Third-party), A2 (Terms §6) | `unsupported_for_mode` | **DESATIVADO DA CADEIA ATIVA**. Rejeição prévia na política de admissão com motivo visível: `"Transporte agy consumidor não elegível para encapsulamento autônomo multi-sessão per RF-55"`. |
| **OpenAI Codex CLI (`codex`)** | `0.164.0` em `~/.local/share/node24/bin/codex` | Assinatura ChatGPT oficial (Plus/Pro/Team) | CLI direta nativa, execução não interativa oficial (`codex exec`), auth gerenciada | A3, A4 (Non-interactive mode) | `documented_supported` | **ELEGÍVEL / ATIVO**. Uso restrito à CLI oficial instalada sem MITM, sem proxy de interceptação de tokens e sem bridge de terceiros. |
| **Anthropic Claude Code (`claude`)** | `2.1.310` em `~/.local/share/node24/bin/claude` | Assinatura Claude oficial (Pro/Team) | Execução do binário oficial sem modificação, credencial do usuário em sessão dedicada | A6 (Legal & compliance) | `documented_supported` | **ELEGÍVEL / ATIVO**. Uso restrito à CLI oficial inalterada, sem recolhimento nem intermediação de credenciais OAuth por gateway alheio. |
| **xAI Grok CLI (`grok`)** | `1.0.70` em `~/.local/share/node24/bin/grok` | Assinatura oficial xAI / X Premium | Execução da CLI oficial em subshell isolado | Documentação oficial Grok CLI | `documented_supported` | **ELEGÍVEL / ATIVO**. Integrado diretamente via CLI oficial com perfil de ambiente isolado. |

---

## 3. Recálculo da Cadeia de Modelos (Pós-RF-55)

Com a desativação obrigatória dos transportes classificados como `unsupported_for_mode`, a cadeia de papéis definida no Plano v1.1 §9.1 é recalculada:

### 3.1 Tabela de Papéis Recalculada

| Papel | Modelo / Provedor Principal | Modelo de Substituição (Fallback 1) | Modelo de Reserva (Fallback 2) | Regra de Retorno e Permanência |
|---|---|---|---|---|
| **Gerente** | Codex CLI (`gpt-6.1-sol` Alto adaptativo) | Claude Code CLI (`claude-3-7-sonnet` / `sonnet-5.5` Alto) | — | Retorna ao principal após recuperação confirmada da cota na mesma conta. |
| **Programador Regular 1** | Codex CLI (Conta exclusiva de programação, `gpt-6.1-sol` Médio) | Grok CLI (`grok-4.7` Médio) | — | Regular selecionado permanece enquanto houver capacidade elegível. |
| **Programador Regular 2** | Grok CLI (`grok-4.7` Médio, CLI oficial) | Codex CLI (Conta secundária se provisionada) | — | Regular selecionado permanece enquanto houver capacidade elegível. |
| **Programador Regular 3** | *[DESATIVADO]* Gemini 3.8 Flash via `agy` consumidor | *Desativado per RF-55* | — | Posição inativa na admissão com mensagem `unsupported_for_mode`. Aguarda transporte oficial elegível. |
| **Programador Regular 4** | *[DESATIVADO]* Sonnet via `agy` consumidor | *Desativado per RF-55* | — | Posição inativa na admissão com mensagem `unsupported_for_mode`. Aguarda transporte oficial elegível. |
| **Programador Emergencial** | Codex CLI (Conta original, `gpt-6.1-sol` Médio) | Aguarda capacidade elegível | — | Ativado apenas em pico ou indisponibilidade dos regulares elegíveis; devolve a fila quando restabelecido. |
| **Revisor de Código** | Claude Code CLI (`claude-3-7-sonnet` / `sonnet-5.5` Alto) | Codex CLI (`gpt-6.1-sol` Médio adaptativo) | Grok CLI (`grok-4.7` Alto) | Retorna ao principal em fronteira de tarefa limpa. Sessão **sempre distinta** da implementação. |

---

## 4. Regras Arquiteturais de Admissão e Execução

1. **Separação Rígida entre Implementador e Revisor:**
   - A sessão de revisão de código **nunca** pode ser a mesma sessão do programador executor.
   - Mesmo modelo/família pode ser utilizado em sessões separadas apenas se não houver alternativa elegível, mantendo preferência explícita por modelos distintos para produção e avaliação.

2. **Rejeição Transparente na Admissão (T39):**
   - Ao requisitar um slot com transporte `unsupported_for_mode`, o dispatcher do Agent Control recusa a admissão antes de criar container, subshell ou processo.
   - O log do workflow registra o erro canônico:
     `AdmissionDenied: Integration mode 'antigravity_consumer_encapsulated' is classified as 'unsupported_for_mode' under RF-55. No fallback to paid API authorized.`

3. **Coordenação de Capacidade sem Concorrência de Refresh (RF-46 / T28):**
   - Nenhuma conta compartilhada com o ambiente pausado (Paseo) terá refresh token concorrente ativado sem autoridade única de admissão.
   - Enquanto o Paseo estiver pausado, o Agent Control utiliza exclusivamente as contas autorizadas e alocadas para este projeto em diretórios isolados (`~/.local/share/node24/bin` e perfis locais).

4. **Preservação Orçamentária:**
   - Não há fallback automático para APIs pagas por consumo (OpenAI Platform API, Anthropic API, Google AI Studio pay-as-you-go).
   - O saldo disponível (~$10) não será consumido sem autorização expressa em procedimento formal.

---

## 5. Conclusão e Próximos Passos

1. Esta ADR desativa os caminhos de integração em desacordo com as diretrizes de termos e uso (RF-55), garantindo conformidade documental e operacional antes da ativação do Gate G0.
2. Os modelos restantes (Codex CLI, Claude Code e Grok CLI) provêem capacidade redundante, cobrindo todos os papéis essenciais (Gerente, Programadores e Revisor) com ferramentas oficiais documentadas instaladas localmente no host.
3. Se no futuro for contratado um plano Google Cloud Vertex AI ou Google Workspace Enterprise elegível para API/serviço autônomo, um novo transporte poderá ser homologado via ADR aditiva.
