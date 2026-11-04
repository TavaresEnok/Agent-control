# Adaptador de coleta de cota — 03/11/2026

`createProviderCollectorAdapter` em `src/provider-collector-adapter.ts` devolve um `ProviderAdapter` (`probe({accountId, signal}) => ProviderProbeResult`). O runner é injetado e só entrega o texto bruto do CLI. Este módulo não importa `child_process` e não foi ligado a nenhum runner real, scheduler, conta ou processo de provedor. Um runner real depende de autorização de contas e fica fora deste lote.

## Contrato

O manifesto é sintético: `id` `collector-<provedor>`, `version` igual ao `parserId` atual, `mode: synthetic`, `eligibility: documented_supported`, `source` `synthetic://collector/<provedor>/<parserId>`, `timeoutMs` entre 10 e 30000 (padrão 5000). `bind`/`collect` em `ProviderCollectors` continuam sendo a única borda com o banco. Este adaptador não abre PostgreSQL e não chama `observeQuota`.

`accountId` segue só para o runner. O resultado tem apenas `status`, `ttlSeconds`, `remainingPercent` e `resetAt`.

| Saída do runner | `status` | Cota |
|---|---|---|
| Fixture `available` de codex, claude ou grok billing | `available` | 65%, TTL 120 s, reset da fixture |
| Fixture `exhausted` desses provedores | `exhausted` | 0%, TTL 120 s, sem reset |
| Fixture `recovery` desses provedores | `rate_limited` | 0%, TTL até 3600 s, reset da fixture |
| Antigravity, qualquer rótulo de fixture | `unknown` | sem percentual |
| Versão desconhecida, JSON malformado, stdout vazio, `exitCode` diferente de 0 | `unknown` | nunca disponível nem esgotado |
| Runner lança, rejeita, ou o `AbortSignal` aborta | `unreachable` | transporte, TTL 30 s |

Sinal já abortado não chama o runner. Abort durante a espera descarta stdout tardio, inclusive se o runner resolver no próprio evento de abort. Relógio de captura é `now` (testes fixam `2026-11-03T12:00:00.000Z`) e só é lido depois que o stdout passa no teto de bytes.

`timeoutMs` fica só no manifesto. Quem arma o prazo é `ProviderCollectors.collect`: no vencimento marca `timedOut`, aborta o sinal e mantém a quarentena (`probe_uncertain`). O probe não arma um segundo relógio e não resolve enquanto o runner segue pendente. Um `unreachable` devolvido por um timer interno seria conclusão normal, deixaria `timedOut` falso e liberaria o lease com a coleta ainda em voo.

## Limites

O teto é 8192 bytes UTF-8 (`Buffer.byteLength`). `stdout.length` conta unidades UTF-16 e não decide o corte: uma cadeia multibyte pode passar de 8192 bytes com `length` menor ou igual a 8192 e não é enviada ao parser. 8192 bytes exatos ainda podem ser parseados. Mensagem de erro do runner não entra no resultado. Antigravity permanece sem cota verificável (`antigravity-quota-unproven-v1`). Nada de credencial, conta real, inferência, deploy ou migração.

## Comandos

Sem banco e sem skips. Node em `/home/app/.local/share/node24/bin`. Nenhum runner real é executado.

- `npm --prefix upstream/cezar run build:server` — exit 2. Erro pré-existente em `packages/cezar/src/webhooks/transport.ts` (`maxRedirections`). O `tsc` emitiu `dist`. `npm ci` não rodou: `node_modules` já existia.
- `npm run typecheck` — exit 0.
- `node --import tsx --test --test-concurrency=1 tests/provider-collector-adapter.test.ts` — exit 0, 2 testes, 0 falhas, 0 skips.
- `node --import tsx --test --test-concurrency=1 tests/provider-collector-parsers.test.ts` — exit 0, 2 testes, 0 falhas, 0 skips.

Isto não homologa assinatura nem promove os 111 requisitos. Revisão independente continua necessária.
