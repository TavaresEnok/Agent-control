# Recusa prévia da Capacity — 04/11/2026

## Contrato

`reserve()` continua a recusar com `NO_ELIGIBLE_CAPACITY` quando nenhum perfil da cadeia serve. A espera em `ac_capacity_waits` passa a guardar, na coluna opcional `exclusions`, a lista ordenada `{profileId, reason}` de cada perfil excluído. A ordem é a caminhada já usada na reserva: regular, com o perfil regular sticky na frente quando ele ainda pertence a essa cadeia, e depois emergência. Não há fallback para conta fora da cadeia, API paga ou outro transporte.

Saturação segue distinta: `CAPACITY_BUSY` e `CAPACITY_QUEUED`. Esse caminho não grava a lista. `ORIGINAL_RESERVE_NOT_NEEDED` também permanece outro código.

A recusa não escreve nem altera `ac_quota_observations`. Perfil inelegível, conta removida do projeto, conta desabilitada ou observação expirada não vira cota esgotada. Só uma observação vigente com status `exhausted` recebe `quota_exhausted`.

O grant continua gravando `policy_revision` do contexto no momento da reserva. Publicar outra revisão, e reatribuir o contexto a ela, não altera o grant já emitido. A reserva seguinte usa a revisão então atribuída. Revisão cujo snapshot canônico não bate com o digest armazenado recusa `POLICY_DIGEST_MISMATCH` antes de criar espera ou grant. A linha de revisão publicada segue imutável no banco; a prova de adulteração insere uma revisão nova com digest divergente.

`POLICY_PROFILE_FORBIDDEN`, `MODEL_EFFORT_NOT_IN_CATALOG` e `ACCOUNT_PROFILE_FORBIDDEN` já eram as recusas de publicação, catálogo e `setEnabled`. Este lote não troca esses códigos.

## Motivos

Função pura `classifyProfileExclusion` em `src/capacity-exclusions.ts`. O primeiro gate que falha define o motivo:

| Ordem | Motivo | Quando |
| --- | --- | --- |
| 1 | `profile_missing` | o id não existe em `ac_profiles` |
| 2 | `access_removed` | o perfil existe, sem acesso ao projeto |
| 3 | `not_synthetic` | modo diferente de `synthetic` |
| 4 | `account_disabled` | conta desabilitada |
| 5 | `profile_disabled` | perfil desabilitado |
| 6 | `ineligible` | elegibilidade diferente de `documented_supported` |
| 7 | `quota_exhausted` | observação vigente com status `exhausted` |
| 8 | `quota_unknown` | sem observação, observação expirada, ou status vigente que não é `available` nem `exhausted` |

Conta não sintética também nasce desabilitada. O modo é classificado antes do enablement, senão `not_synthetic` nunca apareceria. Perfil selecionável não entra na lista. `orderedProfileExclusions` preserva a ordem da cadeia.

## Leitura

`readCapacityWaits` em `src/observability.ts` devolve os campos já usados na lista de esperas: `attempt_id`, `resource_kind`, `role`, `reason`, `desired_profile`, `priority`, `sequence`. `exclusions` só aparece quando o jsonb é um array válido. `NULL`, o caso das linhas anteriores à coluna, omite o campo. O snapshot agregado e o texto Prometheus não ganham id de perfil.

## Migração

`db/migrations/056_capacity_wait_exclusions.sql` adiciona `exclusions jsonb` anulável. O conjunto fechado fica na função `ac_valid_capacity_exclusions(jsonb)`, `LANGUAGE plpgsql` e `IMMUTABLE`. O `CHECK` só a chama. Um `CHECK` do PostgreSQL não aceita subquery: `jsonb_array_elements` direto na constraint falha com `cannot use subquery in check constraint`, e uma função SQL seria incorporada ao `CHECK`. plpgsql não é incorporado. O corpo percorre o array com `jsonb_array_length` e `->`, sem `UPDATE` nem default. Linhas antigas permanecem `NULL`, e `NULL` satisfaz a função. Não é migração de produção; o laboratório aplica pelo `ledger.migrate()` do banco descartável.

## Limites

Sem conta real, inferência, deploy ou migração de produção. A lista de esperas em `src/control.ts` não foi alterada: está fora dos arquivos autorizados. A superfície autorizada é `readCapacityWaits`. Nenhum perfil fora da cadeia é consultado para substituir um recusado.

## Checks

Neste runner:

- `npm run typecheck` — saída 0. A primeira execução falhou porque `upstream/cezar/packages/cezar/dist` não estava neste worktree. `npm --prefix upstream/cezar run build:server` compilou o pacote já vendido, sem rede e sem API paga; o `dist` continua ignorado pelo Git. A segunda execução saiu 0. Os arquivos deste lote não apareciam na lista de erros da primeira.
- `node --import tsx --test --test-concurrency=1 tests/capacity-exclusions.test.ts` — saída 0. Quatro testes, sem banco.
- `node --import tsx --test --test-concurrency=1 tests/capacity-prelaunch-refusals.test.ts` — saída 0. `AC_TEST_DATABASE_URL` ausente. A suíte `capacity prelaunch refusals` foi ignorada com a mensagem de prova reservada ao laboratório. Nenhum caso PG rodou aqui.

Correção do `CHECK`: a forma com `NOT EXISTS (SELECT ... FROM jsonb_array_elements(...))` não aplica no PostgreSQL. A migração passou a usar `ac_valid_capacity_exclusions`. Depois dessa troca, os três comandos acima rodaram de novo: `typecheck` saiu 0; a parte pura passou os quatro testes; a suíte PG foi ignorada de novo. Este runner não tem cliente PostgreSQL, a porta 5432 local está fechada e o runtime de container está bloqueado pela política de execução. A aplicação da migração 056 e a suíte com banco continuam reservadas ao laboratório isolado. Este documento não declara esse resultado nem aceite dos critérios.

A prova PG, quando a gerência a rodar no laboratório isolado com `tests/fixtures/isolated-database.ts`, cobre: `POLICY_PROFILE_FORBIDDEN`; `MODEL_EFFORT_NOT_IN_CATALOG`; `ACCOUNT_PROFILE_FORBIDDEN`; uma cadeia com `profile_missing`, `access_removed`, `account_disabled`, `profile_disabled`, `not_synthetic`, `ineligible`, `quota_exhausted` e quota expirada como `quota_unknown`, sem grant, sem alteração de `ac_quota_observations` e sem uso da conta elegível que ficou fora da cadeia; `CAPACITY_BUSY` sem `exclusions`; espera antiga com a coluna nula; grant que preserva `policy_revision` depois de nova publicação e reatribuição, com a reserva seguinte na revisão nova; snapshot com digest divergente em `POLICY_DIGEST_MISMATCH`, sem grant e sem espera. Este documento não declara esse resultado nem aceite dos critérios.
