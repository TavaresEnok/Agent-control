# Motivos de espera no cockpit — 04/11/2026

## Contrato

A coluna `exclusions` já é gravada por `reserve()` e lida por `readCapacityWaits`. Esta fatia liga essa lista à superfície existente `Control.view`, que é o corpo de `GET /api/v1/ac/contexts/:id/resources`. Não há endpoint novo nem middleware global.

A consulta permanece dentro da transação que já chamou `authorize` e comparou `projectScope`. `readCapacityWaits` não é chamado da view: ele abriria outra transação e perderia o lock da leitura. A validação reutilizada é `capacityWaitExclusions`. A classificação de Capacity não foi duplicada.

O campo só entra no JSON quando o valor é um array fechado de `{profileId, reason}`. `NULL`, o caso das esperas antigas, e qualquer lista que não passe no schema estrito omitem o campo. Os demais campos da espera permanecem os que a consulta já devolvia, na ordem `priority DESC, sequence`.

A view não grava espera, grant, cota nem auditoria. Não consulta perfil de outro projeto. Um `profileId` que não está nas contas do projeto autorizado continua na lista, sem rótulo vindo de fora.

## Cockpit

`AgentControlCapacityWaits` renderiza a lista já parseada por `AgentControlSection`. Os oito motivos ficam em português, nesta ordem de exibição, que é a ordem recebida:

| Motivo | Texto |
| --- | --- |
| `profile_missing` | Perfil removido |
| `access_removed` | Acesso ao projeto removido |
| `account_disabled` | Conta desativada |
| `profile_disabled` | Perfil desativado |
| `not_synthetic` | Conta fora do modo sintético |
| `ineligible` | Inelegível para o plano ou modo |
| `quota_exhausted` | Cota esgotada |
| `quota_unknown` | Cota desconhecida |

`CAPACITY_BUSY` continua "Aguardando vaga". `CAPACITY_QUEUED` continua "Aguardando sua vez". Composição local continua "Composição determinística local" e não mostra motivos de perfil. O rótulo `conta · modelo · esforço` só aparece se o perfil já está em `profiles` e a conta já está em `accounts` dessa view. Caso contrário o texto é "Perfil indisponível neste projeto" mais os oito primeiros caracteres do id.

Campo ausente, `null` ou lista inválida são descartados antes do schema da página. A página de recursos não quebra e não mostra um motivo inventado.

## O que não mudou

Grants, cota, seleção, catálogo, migração e autoridade permanecem. Não houve conta real, inferência, deploy nem migração de produção.

## Comandos neste runner

- `npm run typecheck` — exit 0.
- `node --import tsx --test --test-concurrency=1 tests/capacity-wait-resources.test.ts` — exit 0. A suíte foi ignorada com a mensagem `AC_TEST_DATABASE_URL ausente; prova PG reservada ao laboratório isolado`. A saída contou 0 testes. Nenhum teste PG rodou. Isso é ausência de evidência, não aprovação da leitura real. Não há cliente PostgreSQL nem URL neste runner.
- `npm --prefix upstream/cezar/packages/web run test -- src/routes/settings/agent-control-capacity-waits.test.tsx src/routes/settings/agent-control-section-diagnostics.test.tsx` — exit 0 na execução isolada. Três testes: motivos ordenados, campo legado, lista inválida, saturação, fila e composição local dentro de `AgentControlSection`; o teste de diagnóstico existente passou. Uma tentativa paralela aos outros checks estourou 5000 ms nesse diagnóstico; a repetição isolada passou em cerca de 1 s. A falha paralela foi contenção, não regressão da página.
- `npm --prefix upstream/cezar/packages/web run typecheck` — a tentativa paralela foi morta (exit 137) sem diagnóstico de tipo. A execução isolada saiu 0 depois que este runner ganhou `upstream/happier/packages/protocol/dist/index.d.ts`, ignorado pelo Git. O tsconfig do cockpit já importa a autenticação Happier, e o build de `@happier-dev/protocol` não existia. O arquivo só declara as funções que esses dois módulos já chamam. Não é mudança de produto nem aceite.

Nenhum dos 111 requisitos foi aceito.
