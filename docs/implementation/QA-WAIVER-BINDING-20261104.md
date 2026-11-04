# Vínculo explícito da dispensa de QA — 04/11/2026

Fatia de RF-57/T38. O grafo nativo não mudou: o artefato managed continua `high` e o nó de QA continua executando. Esta fatia não aceita o requisito.

## Contrato

O owner registra `ac_qa_waiver_authorizations` antes da dispensa. A linha é imutável e única por projeto, revisão de política, template, revisão de template e tarefa. A regra só pode ser `explicit-low`. A política precisa permitir `allowLowRiskQaWaiver`. O digest da política e o digest do template saem das linhas já gravadas, não do pedido.

`waiveQaInTransaction` continua exigindo owner, artefato `low` e a mesma permissão. Sem a autorização correspondente a recusa é `QA_WAIVER_AUTHORIZATION_REQUIRED`. A dispensa grava revisão e digest da política, template, regra, tarefa, digest do artefato e a autorização. A mesma combinação é idempotente. Outro motivo, outro owner ou outro vínculo é `QA_WAIVER_CONFLICT`. Não nasce recibo de QA.

`assertReady` usa `evaluateQaWaiverGate`. QA `passed` satisfaz a condição. `failed`, `canceled`, `missing_result` e `stale` continuam `VERIFICATION_NOT_PASSED`, mesmo com dispensa. Sem QA e sem vínculo completo, a resposta é `QA_MISSING`. Vínculo ausente, digest divergente ou template que não confere é `QA_WAIVER_STALE`. Outro commit é outro artefato e não herda a linha. Revisão independente continua obrigatória. Risco `medium` ou `high` não vira `not_required`.

Uma linha antiga de `ac_qa_waivers`, sem os campos novos, não satisfaz o gate.

## Limites

O programador não escolhe a dispensa. O grafo ainda não consulta a autorização ao registrar o artefato nem deixa de lançar o QA. Não há conta real, inferência, deploy nem migração. RF-57 e T38 permanecem `not_accepted`.

## Checks

Neste processo, em 04/11/2026:

- `npm run typecheck` saiu 0.
- `node --import tsx --test --test-concurrency=1 tests/qa-waiver-binding.test.ts` saiu 0: 5 testes, 0 falhas, 0 skips. Não abre PostgreSQL e não prova a migração 060.
- `node --import tsx --test --test-concurrency=1 tests/quality-gate-integrity.test.ts` saiu 0 porque a suíte foi ignorada: `AC_TEST_DATABASE_URL` ausente. Nenhum caso de autorização, dispensa ou `assertReady` rodou. Isso não é prova.
