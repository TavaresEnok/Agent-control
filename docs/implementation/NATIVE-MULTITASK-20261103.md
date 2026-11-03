# Plano nativo com várias tarefas — 03/11/2026

## Contrato

A execução nativa de um `ManagerPlan` entra pelo comando já existente `managed-synthetic-v1` com `native: true`. O ledger não foi alterado: o aceite continua a chamar `freezeManagedExecution`, e o grafo devolvido é o plano congelado do Cezar. O nome dinâmico usa o prefixo `engineering-native-plan-`. A receita `engineering-native-v1` de uma única tarefa raiz permanece.

`nativeExecutionRecipe` não chama `executionRecipe`. Os dois compartilham a construção do grafo de lotes, fork, QA, revisão e composição. O modo sintético continua a exigir `acceptanceRefs` igual a `acceptance:synthetic-effect-v1` e exatamente um caminho por tarefa. O modo nativo não herda essas duas recusas. Cada tarefa nativa guarda os `acceptanceRefs` e todos os `writePaths` do plano, com `taskId`. A unidade de composição guarda a união estável desses aceites e caminhos. A receita nativa permanece `schemaVersion: 1` e `mode: 'native'`, para o congelamento de base em `ac_native_task_inputs` seguir o caminho já existente.

O filho de tarefa continua `engineering-native-v1`. A composição continua `engineering-synthetic-v1`, com recibo `synthetic: true`, para o CAS já existente. Tarefas nativas gravam recibo `synthetic: false`.

O texto da tarefa é o canônico `native-managed-task-v1` do plano publicado. Não é plaintext do Happier. A base de cada lote é o `HEAD` do alvo no momento do lote, gravada em `ac_native_task_inputs` antes do clone. O programador finaliza um commit Git por tarefa. Esse commit é copiado para o clone isolado, para a composição enxergar `HEAD` e o pai. A integração continua no CAS do alvo. QA e revisão de tarefa e de composição usam os executores nativos quando o modo é `native`.

Antes de inserir filhos, capacidade, worktrees ou jobs, o aceite recusa:

- ciclo, com `PLAN_DEPENDENCY_CYCLE`, também na publicação da proposta;
- caminhos sobrepostos entre tarefas, com `NATIVE_PLAN_SCOPE_OVERLAP`, antes de a compilação serializar o conflito;
- alvo sem commit, com `NATIVE_TASK_BASE_MISSING`;
- template ativo que não seja `engineering-native-v1` com `execution: 'plan'`, com `NATIVE_PLAN_TEMPLATE_REQUIRED`;
- caminho fora do template, com `NATIVE_PLAN_SCOPE_UNDECLARED`;
- `maxCorrections > 0`, com `NATIVE_PLAN_CORRECTION_UNAVAILABLE`;
- política que exige especialista, com `NATIVE_PLAN_SPECIALIST_UNAVAILABLE`.

O caminho sintético sem `native: true` permanece o contrato de referência e conserva as recusas `MANAGED_ACCEPTANCE_EXECUTOR_UNAVAILABLE` e `MANAGED_WRITE_SCOPE_UNAVAILABLE`. Correções e especialista sintéticos não foram abertos por este modo.

## Prova neste runner

Node v24.22.1. `PATH` incluiu `/home/app/.local/share/node24/bin`. `upstream/cezar/packages/cezar/dist` já estava presente. `npm ci` e `build:server` não foram executados. Chat e editor não foram reconstruídos.

Não há socket Docker neste ambiente do programador, não há `/usr/bin/ruby` e `AC_TEST_DATABASE_URL` não estava definido. `deploy/compose.lab.yml` não foi iniciado. O cache antigo em `.state/bench` não foi usado: o lock `postmaster.pid` não foi removido e nenhum `pg_ctl` foi chamado. O teste não baixa binários, não extrai pacotes e não inicia PostgreSQL.

```text
npm run typecheck
TYPECHECK_EXIT:0
```

```text
node --import tsx --test --test-concurrency=1 tests/native-multitask.test.ts
TEST_EXIT:0
pass 2
fail 0
skipped 1
```

A saída registra 2 testes passando e 1 ignorado. Sem `AC_TEST_DATABASE_URL` no runner, o teste de laboratório fica ignorado. O motivo impresso também cita `/usr/bin/ruby` de `deploy/compose.lab.yml`. O teste não instala PostgreSQL nem Ruby. Os dois testes sem banco cobrem, sem efeitos:

- ciclo, sobreposição exata, caminho aninhado e correção;
- plano com `acceptance:real-tests` e outro aceite, recusado pelo executor sintético e aceito pela receita nativa;
- `src/a.ts` com `src/b.ts`, e o caminho `src/a+b.ts`, recusados só pelo executor sintético;
- lote paralelo `alpha`/`beta` no fork `launch-0`, com `gamma` somente depois de `compose-0-integrate`;
- a receita sintética de dois arquivos disjuntos continua `synthetic-only`, com o aceite sintético e sem `taskId`.

## Evidência externa da administração

A prova Git do finalizador, da composição e do CAS, com PostgreSQL e Ruby isolados, já foi executada pela administração no worktree desta tarefa. O programador não repetiu essa bateria. Resumo sanitizado de `evidence/agent-control-native-multitask-20261103.json` (hora UTC `2026-11-03T14:39:39.969066+00:00`, job `5e95aef73635`):

```text
docker compose -p ac-multitask-validation-20261103 -f deploy/compose.lab.yml run --rm runtime node --import tsx --test --test-concurrency=1 tests/native-multitask.test.ts
```

Ambiente declarado: PostgreSQL e Ruby descartáveis da imagem de laboratório; sem contas reais de IA e sem chamadas de modelo.

Resultado: exit `0`; passaram `3`; falharam `0`; ignorados `0`; duração `13258` ms. A prova interna registra 3 tarefas, 2 programadores paralelos, dependência `gamma`, `modelCalls` `0`, QA como substituto injetado, revisão como substituto sintético de modelo, e Git com finalizador e CAS reais.

`worktree_digest`: `1a85a46af415e7427f65dff49e0074bf7024a4f8a51068a125a5ffc80dfcae36`.

SHA-256 conferido neste runner, igual ao registrado na evidência:

- `tests/native-multitask.test.ts`: `a2b564da95ce68026df061afc80f2d9d366e417322bb4b5c0500a5fac18c6491`
- `src/managed-plan.ts`: `fffc047aba0880d9de7c49a7281abc1d4e65068a6e954b853d4896cf4873b3ab`

Limites dessa evidência: QA e revisor sintéticos; sem inferência de provedor; não é homologação de produção. O texto original da evidência diz que a prova usa QA e revisor sintéticos, PostgreSQL real e finalizador Git/CAS reais, e que isso não prova inferência de provedor nem prontidão de produção.

## Limites

Nenhum dos 111 critérios foi aceito. Esta prova não é gate de produto nem homologação. O programador não aprova revisão.

Não há correção nativa depois de reprovação nem especialista neste incremento. A recuperação de `recoverManagedGraph` para modo `native` observa o job e o artefato já registrados; não cobre todos os intervalos de falha do supervisor. O replay da composição ainda exige evidência de sandbox nas tarefas de origem, então uma recomposição nativa depois de queda continua fora desta prova. A primeira composição não passa por esse replay.

Sobreposição continua válida como proposta, porque a compilação a serializa. A execução nativa a recusa antes dos efeitos. Bootstrap segue administrativo e a ativação de conta real continua bloqueada. SQL042 e Capacity não foram afrouxados. Não há segundo scheduler, chat ou editor. A ausência de `AC_TEST_DATABASE_URL` no runner do programador só ignora o teste de laboratório; não altera o contrato do produto e não autoriza inferência. A evidência externa também não homologa produção.
