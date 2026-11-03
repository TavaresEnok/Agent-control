# Parsers de cota de provedores — 03/11/2026

Funções puras em `src/provider-collector-parsers.ts`. Não há spawn de CLI, rede, credencial, scheduler nem escrita em PostgreSQL. A observação cabe em `QuotaInput` (`Capacity.observeQuota`) e em `ProviderProbeResult` (`toQuotaInput` / `toProbeResult`). Só `status: available` corresponderia à seleção de Capacity; este teste não abre banco e não prova essa seleção.

Nenhuma conta real foi lida. O relatório operacional `evidence/grok-billing.json` não foi aberto. As fixtures são sintéticas.

## Schemas de cota

| Provedor | `parserId` | Estado | Documento aceito |
|---|---|---|---|
| codex | `codex-rate-limits-v1` | vinculado | Uma linha JSON-RPC de `account/rateLimits/read`. Forma em `upstream/cezar/packages/cezar/src/core/codex-usage-probe.ts`, `usage-windows.ts` e `__fixtures__/codex/usage-metadata.mjs`. |
| claude | `claude-rate-limit-event-v1` | vinculado | Um `rate_limit_event` com `rate_limit_info`. Forma em `usage-windows.ts` e na linha de `__fixtures__/claude/partial-messages.ndjson`. `uuid` e `session_id` são exigidos e descartados. |
| grok | `grok-billing-report-v1` | vinculado ao resumo local | Uma linha JSON no formato do resumo allowlist de `native/grok-billing.py` (`normalize_billing`, `normalize_topup`) depois dos portões de `orchestrator/grok_usage.py` `subscription_configuration_safe`. Não é stdout do CLI `grok`. |
| antigravity | `antigravity-quota-unproven-v1` | sem cota verificável | Nenhum stdout de janela foi vinculado. Ver limite abaixo. |

`grok.subscription.status` e `antigravity.quota` continuam rejeitados. Ids `grok-subscription-status-v1` e `antigravity-quota-event-v1` não são aceitos.

## Grok — contrato comprovado e limites

A prova está no código local, não numa captura de rede:

- `normalize_billing` lê `config.creditUsagePercent` (número de 0 a 100, não booleano) e devolve `used_percent` e `remaining_percent = 100 - percent`. `currentPeriod.start` e `currentPeriod.end` passam sem validação de tipo. Também devolve `unified_billing`, `prepaid_cents`, `on_demand_cap_cents` e `on_demand_enabled`.
- `normalize_topup` devolve `has_rule`, `enabled` e uma de duas frases fixas.
- `subscription_configuration_safe` exige HTTP 200, `unified_billing` verdadeiro, percentual numérico no intervalo, `prepaid_cents == 0`, `on_demand_cap_cents` nulo ou 0, `on_demand_enabled` diferente de verdadeiro, topup HTTP 200 e `enabled` falso. `safe_subscription` ainda exige `remaining_percent > 0`.
- `catalog.py` marca a conta `exhausted` quando `remaining_percent == 0` e `available` no restante seguro. A janela `weekly` guarda `resets_at = period_end` com status `known`.
- `grok_usage.current_evidence` descarta evidência com mais de 300 s ou JSON inválido.
- O processo imprime o relatório inteiro. O campo `authentication` no caminho de sucesso é só `{status, expires_at}`. Um objeto com token, `access` ou chave extra não passa no schema estrito e fica desconhecido.

Classes neste parser:

- `available`: configuração segura, restante maior que 0, `subscription_only_evidence` verdadeiro, `timestamp_utc` no máximo 300 s antes de `observedAt`, `expires_at` pelo menos 60 s à frente. `period_end`, se vier, precisa ser instante ISO em segundo cheio e reset futuro dentro de 7 dias. A fixture usa 35% usado e 65% restante.
- `exhausted`: restante 0, usado 100, `period_end` nulo. Sem instante de reset não há recuperação.
- `recovery`: restante 0, usado 100 e `period_end` futuro, em segundo cheio, no máximo 7 dias à frente. Vira `rate_limited` para conservar o reset. `catalog.py` ainda chamaria a conta de `exhausted` e só guardaria `period_end` na janela. Esta classe não existe como status no coletor Paseo; é a projeção para o formato de Capacity, que separa esgotamento sem reset de janela cheia com reset. Reset anterior, além de 7 dias ou com milissegundos fica desconhecido, não esgotado.
- `unknown`: contrato inventado, campo extra, autenticação `refresh_failed`, HTTP diferente de 200, topup ligado, crédito pré-pago, sob demanda, percentuais que não somam 100, carimbo velho, versão ou texto livre.

O portão `transport == grok-cli` de `subscription_configuration_safe` depende de `model-limits.json` e fica fora deste parser. `credential_source` aceita `grok_cli` ou `opencode`, que são os dois valores que o coletor grava.

## Antigravity — cota não verificável

Não há parser de disponível, esgotado ou recuperação.

- `agy` 1.4.0 emite `stream-json` com `usage` de tokens do turno (`antigravity-turn-usage.json`). Isso não é janela de assinatura.
- `orchestrator/gemini_usage.py` declara que não inventa percentual. `quota.windows` fica `[]`. O status vem de uma linha `health` e a mensagem de esgotamento cai em texto, com o fallback `quota exhausted`.
- `usage_dashboard.py` para `antigravity2` mostra “Saldo não informado pelo CLI” e não preenche janelas. `available` nesse diagnóstico significa última execução concluída, não saldo restante.
- `policy_runtime._classify_model` trata `source == official agy response` com status `available`, janelas vazias e custo verificado como disponível, e texto que casa `explicit_quota_text` como esgotado. Esse atalho não traz percentual nem reset exato. `recovery_after` lê “resets in …” do texto ou usa 3600 s por omissão. O próprio código de diagnóstico do `agy` zera `resetsAtMs` quando a frase é “Usage Limit Reached”.
- `retrieveUserQuotaSummary` é corpo HTTPS OAuth, não stdout de `agy`.

As fixtures `antigravity-health-available.json` e `antigravity-health-exhausted.json` repetem esse formato local e o teste exige `unknown`. Texto “quota exhausted” não vira esgotado. Isso é o limite real: a origem não fornece cota verificável.

## Regras comuns

`resetsAt` em milissegundos no Codex ou Claude, chave não nomeada, JSON quebrado, segunda linha, `exitCode` diferente de 0, stdout acima de 8192, `truncated: true` ou `parserId` de outra versão ficam `unknown` / `invalid_response`. `secondary: null` no Codex é perda de conhecimento. Reset anterior a `observedAt` ou além de 7 dias não vira esgotamento nem recuperação. `isUsingOverage: true` é desconhecido. Texto livre não é cota. Erro de transporte ou autenticação no envelope (`transport_error` / `auth_error`) não é lido como stdout e não vira `available` nem `exhausted`.

TTL: 120 s disponível, 120 s esgotado, até 3600 s na recuperação, 30 s desconhecido. Percentual só sai nesses três status de cota.

Isto não homologa assinatura, custódia nem ativação. Não promove os 111 requisitos. Revisão independente continua necessária.

## Prova

Substituto em memória: o teste confere `QuotaInput.parse` e que somente a classe `available` produz `status: available`. Não há `INSERT` em `ac_quota_observations`. Essa persistência exigiria PostgreSQL e fica sem prova.

Node `v24.22.1` (`/home/app/.local/share/node24/bin`). `node_modules` da raiz já existia. `npm ci` e `npm --prefix upstream/cezar run build:server` não foram repetidos. O parser não importa `upstream/cezar/dist`. A rodada anterior registrou `build:server` com exit 2 em `packages/cezar/src/webhooks/transport.ts` (`maxRedirections`), fora destes arquivos.

- `npm run typecheck` — exit 0.
- `node --import tsx --test --test-concurrency=1 tests/provider-collector-parsers.test.ts` — exit 0, 2 testes, 0 falhas, 0 skips.
