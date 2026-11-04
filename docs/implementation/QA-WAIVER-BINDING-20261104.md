# Vínculo explícito da dispensa de QA — 04/11/2026

Fatia de RF-57/T38. O grafo nativo não mudou: o artefato managed continua `high` e o nó de QA continua executando. Esta fatia não aceita o requisito.

## Contrato

O owner registra `ac_qa_waiver_authorizations` antes da dispensa. A linha é imutável e única por projeto, revisão de política, template, revisão de template e tarefa. A regra só pode ser `explicit-low`. A política precisa permitir `allowLowRiskQaWaiver`. O digest da política e o digest do template saem das linhas já gravadas, não do pedido.

`waiveQaInTransaction` continua exigindo owner, artefato `low` e a mesma permissão. Sem a autorização correspondente a recusa é `QA_WAIVER_AUTHORIZATION_REQUIRED`. A dispensa grava revisão e digest da política, template, regra, tarefa, digest do artefato e a autorização. A mesma combinação é idempotente. Outro motivo, outro owner ou outro vínculo é `QA_WAIVER_CONFLICT`. Não nasce recibo de QA.

`assertReady` usa `evaluateQaWaiverGate`. QA `passed` satisfaz a condição. `failed`, `canceled`, `missing_result` e `stale` continuam `VERIFICATION_NOT_PASSED`, mesmo com dispensa. Sem QA e sem vínculo completo, a resposta é `QA_MISSING`. Vínculo ausente, digest divergente ou template que não confere é `QA_WAIVER_STALE`. Outro commit é outro artefato e não herda a linha. Revisão independente continua obrigatória. Risco `medium` ou `high` não vira `not_required`.

Uma linha antiga de `ac_qa_waivers`, sem os campos novos, não satisfaz o gate.

## Nó de QA

`expectedArtifactRisk` devolve `low` só quando a intenção managed tem tarefa, a tentativa não é correção e existe uma única autorização `explicit-low` para o projeto, a revisão da política e essa tarefa. `Quality.register` recusa risco diferente com `ARTIFACT_RISK_MISMATCH`. O supervisor nativo usa a mesma função. Sem autorização, o risco continua `high`.

No nó `qa`, `settleExplicitQaWaiver` aplica a autorização do owner ao artefato. Sem evidência de QA, o estágio termina com recibo `{ qaWaiver: { basis: 'not_required' } }`. Não há recibo `passed`, assinatura, concessão nem processo. Se a evidência de QA não passou, a disposição é `blocked` e nada é gravado. Se já existe QA `passed`, o verificador segue o caminho anterior. A retomada reconhece o recibo e não chama `quality.record`.

## Limites

O programador não escolhe a dispensa. Correção não herda a classificação baixa. Duas autorizações da mesma tarefa não dispensam. A prova PostgreSQL chama o assentamento e o `assertReady`; não abre uma sessão inteira de `EngineeringStages` com worktree. Não há conta real, inferência, deploy nem migração. RF-57 e T38 permanecem `not_accepted`.

## Checks

Neste processo, em 04/11/2026, depois de ligar o nó:

- `npm run typecheck` saiu 0.
- Com `AC_TEST_DATABASE_URL` apontando para um Postgres descartável em `127.0.0.1`, sem publicar o banco de laboratório já em execução, `node --import tsx --test --test-concurrency=1 tests/qa-waiver-binding.test.ts tests/qa-waiver-stage.test.ts tests/quality-gate-integrity.test.ts` saiu 0: 10 testes, 0 falhas, 0 skips. A suíte de estágio provou `not_required`, a ausência de recibo de QA, o bloqueio de evidência falha, cancelada, ausente ou obsoleta, e que outro commit não nasce dispensado. O container descartável não é o `ac-implementation-db-1` e foi removido depois.
