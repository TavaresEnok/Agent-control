# Versões de workflow fixadas — 04/11/2026

Fatia de RF-52/T32. Os dois requisitos continuam `not_accepted`.

## O que entrou

- `src/workflow-versions.ts` registra, por nome, a versão `v1` atual e a versão `v0` retida de `baseline-synthetic-v1`, `engineering-synthetic-v1`, `engineering-native-v1` e `semantic-proposal-v1`. Cada entrada tem digest canônico e política `pinned`. `workflowForAdmission` recusa qualquer versão que não seja a atual. Não existe caminho de auto-upgrade.
- A definição atual em `src/workflows.ts` não foi alterada. A retida é a mesma definição com `description: retained-v0`, só para provar uma mudança de digest sem editar o workflow de produção.
- A migração `058_workflow_versions.sql` cria `ac_workflow_version_pins`. Não altera migrações anteriores nem reescreve `ac_frozen_plans`. O pino é imutável.
- `CezarRuntime.dispatch` e `recoverManaged` resolvem o plano congelado. Digest retido e idêntico continua com esse snapshot. Digest desconhecido ou divergente permanece estacionado, grava no máximo uma auditoria `workflow.version_retired` por intenção e motivo, e não reserva concessão, não despacha outbox, não lança processo e não muda pausa, mensagem, operação ou deduplicação.
- `authorizeStart` só aceita a definição já reconciliada para aquela execução, ou o workflow dinâmico da receita managed. Não há fallback para `workflowFor` da definição atual.
- Execução nova congela a versão atual. Se o plano ainda não tinha pino, o mesmo despacho grava o pino na transação que confirma o snapshot. `workflowForAdmission` recusa versão que não seja a atual.
- Execução sem pino (congelada antes da 058) é legada: o digest do catálogo define a versão. A primeira reconciliação compatível grava o pino. Ausência de pino não significa aposentadoria.
- `ContextDiagnostics.workflowVersions` e `Control.view(...).workflowVersions` mostram, só para o contexto autorizado, o catálogo, as versões em uso e os bloqueios `WORKFLOW_VERSION_RETIRED`. Não devolvem prompt, descrição, `messageRef` nem corpo do snapshot. `ContextDiagnostics.read()` permanece no schema fechado já consumido pela API.

## Continue-As-New e workers

O Cezar não implementa Continue-As-New. Não há transferência de pendências para uma execução nova, nem Worker Versioning do Temporal. A fixação do snapshot é a equivalência limitada desta fatia. O diagnóstico informa quais digests ainda têm execução aberta; isso não liga, não drena e não homologa um worker antigo. Build registrada: `agent-control-0.1.0` / `cezar-pinned-058`. Não é atestado de deploy.

## Prova neste runner

Retomada de 04/11/2026, ainda sem `AC_TEST_DATABASE_URL` no ambiente do processo. Não há `psql` e nenhuma escuta PostgreSQL em localhost. A variável não foi inventada.

- `npm run typecheck` — saída 0.
- `node --import tsx --test --test-concurrency=1 tests/workflow-versioning.test.ts` — saída 0. Passou 1 teste de catálogo. A suíte `pinned recovery keeps the frozen snapshot and a retired version stays parked` foi ignorada com `AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado`.
- `node --import tsx --test --test-concurrency=1 tests/completed-node-recovery.test.ts` — saída 1. Os nove casos lançaram `ISOLATED_DATABASE_REQUIRED` antes de migrar ou retomar. O arquivo de teste não foi alterado.

A ausência da URL não prova recuperação com definição alterada, auditoria idempotente, concessão intacta nem a retomada já existente. O `dist` do servidor Cezar já estava presente; produto e testes não foram editados por causa desse artefato.

Nenhuma conta real, inferência, deploy ou migração de produção foi executada.
