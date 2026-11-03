# Correções nativas limitadas — 03/11/2026

## Contrato

Depois do plano nativo de várias tarefas, uma reprovação autenticada de QA ou revisão dispara uma correção nativa limitada. A receita de referência continua a ser a v2/v3 sintética: cada revisão de 0 até `maxCorrections` tem intenção, execução, operação e tentativa próprias; os portos `.failed` vão ao fim com falha; os portos `.reject` lançam a unidade seguinte ou, na última revisão, também vão ao fim com falha. O modo nativo não herda a capability sintética nem os aceites e o caminho único do executor sintético.

`nativeExecutionRecipe` continua a recusar `maxCorrections > 0` com `NATIVE_PLAN_CORRECTION_UNAVAILABLE`. O plano nativo sem correção permanece o contrato anterior. Quando o plano nativo pede correção, `freezeManagedExecution` usa `nativeCorrectionExecutionRecipe`: `schemaVersion` 2, `mode: 'native'`, nome `engineering-native-plan-` mais a intenção pai, `taskId` e `correctionRevision` em cada unidade de tarefa, `acceptanceRefs` e `writePaths` reais do plano. Sobreposição continua `NATIVE_PLAN_SCOPE_OVERLAP`. Especialista continua `NATIVE_PLAN_SPECIALIST_UNAVAILABLE`. Ciclo continua `PLAN_DEPENDENCY_CYCLE`. Um plano nativo com correção zero nessa receita também recusa `NATIVE_PLAN_CORRECTION_UNAVAILABLE`. O teto de cinco correções já existente permanece.

O despacho e `recoverManagedGraph` só exigem a autorização sintética quando a receita não é `native`. O caminho sintético e `authorizeSyntheticManagedCorrections` ficam como estavam.

A reprovação autenticada já existente em `qualityVerdict` só grava decisão quando o estágio é QA ou revisão, o erro é `VERIFICATION_FAILED`, a receita é schema 2 e existe a unidade seguinte. O marcador `CEZ:VERDICT reject` segue o porto de reprovação. Erro que não é veredito segue `.failed`. Sem unidade seguinte, o último `.reject` termina em `failed` e não cria decisão extra. `recordManagedCorrection` exige a identidade da unidade seguinte, grants liberados e `assertCorrectionFailures`.

Falha de infraestrutura não é reprovação e não consome tentativa. Um erro que não seja `VERIFICATION_FAILED`, ou evidência inválida, falha o nó sem decisão. Intenções de correção pré-alocadas podem ficar `registered`, sem grant, sessão ou job; isso não é tentativa consumida.

A evidência nativa de QA continua no ramo já existente de `assertCorrectionFailures`: recibo físico com `synthetic: false`, `modelInference: false`, contentor de 64 hexadecimais e `finishedAt` real. `src/quality.ts` não foi alterado. O turno do revisor termina com `exitCode` 0 no recibo físico e no payload, enquanto o recibo de verificação traz `exitCode` maior que zero. `EngineeringStages` instala, na mesma instância de `Quality`, o reconhecimento dessa reprovação: `nativeReviewCorrectionEvidenceAccepted` exige kind `review`, `workerExitCode` e `exitCode` físicos iguais a zero, `synthetic: false`, contentores de worker e de ferramentas em 64 hexadecimais, `finishedAt` real, sessão, grant, intenção e job coincidentes, assinatura de execução de 128 hexadecimais e digest físico igual ao payload. Saída de contentor diferente de zero não é veredito e não abre correção. O juiz não autoriza correção. Uma chamada direta a `Quality.assertCorrectionFailures`, sem essa instalação, continua a recusar o recibo de revisão nativa. QA nativo, o verificador sintético local e o job isolado permanecem os ramos anteriores.

O commit reprovado fica no histórico e na ref `refs/agent-control/correction-source`. A base da correção é `decision.base_id`, a mesma base do lote, e não o commit reprovado. `assertNativeCorrectionDistinct` recusa `NATIVE_CORRECTION_REUSED_COMMIT` quando o commit ou a árvore repetem o artefato anterior. A checagem ocorre depois de registrar o artefato e antes de materializar o commit managed, em `start` e em `prepareRecovery`. O JSON da tarefa ganha o bloco `correction` só quando `readManagedInput().correction` existe. Se `ac_native_task_inputs` já existe e a base diverge da entrada managed, a recusa é `NATIVE_TASK_INPUT_CONFLICT`. O congelamento da correção nativa insere essa linha dentro da transação, com `ON CONFLICT DO NOTHING`, e confere digest e base ou recusa `NATIVE_TASK_INPUT_MISMATCH`.

Seleção continua a aceitar só artefatos com QA e revisão aprovados. `observe` em schema 2 exige seleção da revisão 0 e uma decisão para cada tarefa concluída que não foi selecionada.

Bootstrap segue default-off e ativação bloqueada. SQL 042 e Capacity não foram afrouxados. Não há segundo scheduler, chat, editor, conta real, inferência, deploy ou migração. O programador não aprova revisão. Nenhum dos 111 requisitos foi aceito.

`src/templates.ts`, `src/workflows.ts` e `src/contracts.ts` não precisaram de edição. `src/engineering.ts` só acrescenta o reconhecimento da evidência de revisão nativa sobre o veredito já existente. Esse veredito dispara a correção quando a evidência é aceita e a receita é schema 2.

## Preparação

Node v24.22.1 em `/home/app/.local/share/node24/bin`. `upstream/cezar/node_modules` e `upstream/cezar/packages/cezar/dist` já existiam. `npm ci` e `npm --prefix upstream/cezar run build:server` não foram executados. `packages/api-client`, `packages/contract`, `packages/desktop` e `packages/web` não têm `dist`; chat e editor não foram reconstruídos. A ausência desses diretórios não é defeito deste incremento.

## Prova neste runner

Não há `AC_TEST_DATABASE_URL`, não há `/usr/bin/ruby` e não há socket Docker em `/var/run/docker.sock` nem em `/run/docker.sock`. Não há binário `postgres`, `psql` ou `ruby` no PATH. PostgreSQL local não foi iniciado. `.state/bench` não foi usado. `deploy/compose.lab.yml` não foi iniciado. A ausência desses recursos não é defeito do código. A prova Git/CAS com adaptadores injetados continua sem execução neste runner: o teste de laboratório foi ignorado, então os três percursos não têm resultado.

A fixture foi corrigida para não exigir rollback da integração já aprovada. O primeiro cenário continua a integrar `task-gamma` em `refs/heads/protected`. O teste grava esse commit em `approvedTarget`, distinto do commit inicial. Antes e depois do limite esgotado, e antes e depois da falha de infraestrutura, a ref protegida tem de continuar nesse commit. O commit reprovado do limite não pode ser essa ref nem a base da decisão. O produto não foi alterado para devolver a branch ao commit inicial.

```text
npm run typecheck
TYPECHECK_EXIT:0
```

```text
node --import tsx --test --test-concurrency=1 tests/native-corrections.test.ts
TEST_EXIT:0
pass 1
fail 0
skipped 1
duration_ms 3488.39338
```

O teste sem banco cobre receita nativa com identidades novas na revisão 1, aceites e caminhos reais, arestas de falha e de reprovação, parada no limite, recusa de sobreposição, ciclo e especialista, preservação de `nativeExecutionRecipe` e de `executionRecipe` sintético, `assertNativeCorrectionDistinct` e o predicado de evidência. Esse predicado aceita a reprovação com saída zero e recusa juiz, QA, saída de contentor diferente de zero, `workerExitCode` diferente de zero, digest divergente, `finishedAt` de `0001` e assinatura curta. O teste com banco exige `AC_TEST_DATABASE_URL` e `/usr/bin/ruby` de `deploy/compose.lab.yml`. Ele descreve três percursos com adaptadores injetados e sem modelo: reprovação seguida de correção e aprovação, com a ref protegida no commit de `gamma`; limite esgotado com uma decisão e essa mesma ref preservada; falha de transporte de QA sem decisão e sem grant na correção, também sem mover a ref. Também recusa o mesmo plano fora do modo nativo com `MANAGED_CORRECTION_EXECUTOR_UNAVAILABLE`. Esse teste foi ignorado aqui.

```text
node --import tsx --test --test-concurrency=1 tests/native-multitask.test.ts
TEST_EXIT:0
pass 2
fail 0
skipped 1
duration_ms 2129.896622
```

O negativo de correção em `nativeExecutionRecipe` continua válido. O laboratório desse arquivo também ficou ignorado sem banco e sem Ruby.

```text
node --import tsx --test --test-concurrency=1 --test-name-pattern "correction graph is bounded" tests/managed-corrections.test.ts
TEST_EXIT:0
pass 1
fail 0
skipped 0
duration_ms 1996.659645
```

O grafo sintético v2 limitado permaneceu depois do compartilhamento da receita. `tests/managed-core-negative.test.ts` não foi executado nesta rodada e não foi alterado.

## Prova isolada administrativa — 03/11/2026

A administração informou que o impedimento deste runner foi resolvido fora dele. A prova com PostgreSQL e Ruby sintéticos rodou em contêiner descartável, com este worktree montado somente leitura, sem contas e sem socket Docker. Este runner não reexecutou essa prova e não instalou dependências. Os diretórios citados não estão montados aqui, então os logs não foram reabertos.

Resultado informado, sem skips:

```text
tests/native-corrections.test.ts
2/2
skipped 0

tests/native-multitask.test.ts
3/3
skipped 0
```

Caminhos citados:

```text
/home/app/srv_projetos/orchestration/reports/native-corrections-isolated-20261103
/home/app/srv_projetos/orchestration/reports/native-multitask-isolated-20261103
```

O teste autenticado de correções cobre, com adaptadores injetados e sem modelo, reprovação seguida de correção e aprovação, limite esgotado e falha de infraestrutura que não consome tentativa. A administração não informou o comando literal interno do contêiner, a imagem nem o exit code bruto; o resumo acima é o resultado declarado. Limites: substitutos sintéticos, sem inferência, sem conta real, sem deploy, sem migração e sem homologação. Esse relato não aceita os 111 e não substitui revisão independente.

## Prova neste runner — registro de 03/11/2026

`AC_TEST_DATABASE_URL` está ausente. Não há `ruby` no PATH nem socket Docker. Node v24.22.1 em `/home/app/.local/share/node24/bin`. O teste autenticado foi ignorado. A rodada anterior deste runner permanece na seção acima.

```text
npm run typecheck
TYPECHECK_EXIT:0
```

```text
node --import tsx --test --test-concurrency=1 tests/native-corrections.test.ts
TEST_EXIT:0
pass 1
fail 0
skipped 1
duration_ms 3099.865251
skip: AC_TEST_DATABASE_URL and /usr/bin/ruby from deploy/compose.lab.yml are required
```

```text
node --import tsx --test --test-concurrency=1 tests/native-multitask.test.ts
TEST_EXIT:0
pass 2
fail 0
skipped 1
duration_ms 2156.079903
skip: AC_TEST_DATABASE_URL and /usr/bin/ruby from deploy/compose.lab.yml are required
```

Nenhum código de produto foi alterado nesta rodada.

## Limites

A prova isolada com PostgreSQL, Git e CAS foi relatada pela administração no contêiner descartável, com 2/2 e 3/3 e zero skips. Este runner não a repetiu e continua sem observar o banco: aqui o teste autenticado segue ignorado. O grafo, as recusas, a distinção de identidade e o predicado de revisão continuam cobertos pelo teste sem banco. A fixture exige que o limite esgotado e a falha de infraestrutura preservem o commit aprovado de `gamma`; essa preservação entra no 2/2 relatado e não foi reobservada aqui. A evidência de revisão nativa é reconhecida por `EngineeringStages` e não por uma alteração de `src/quality.ts`. Esta nota não promove aceite dos 111, não fecha revisão independente e não homologa produção. O programador não aprova revisão. SQL 042, Capacity e o bootstrap default-off com ativação bloqueada permanecem.
