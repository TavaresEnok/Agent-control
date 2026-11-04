# Regressão de fechamento 2026-11-04 — defeitos preexistentes

Três falhas já presentes no baseline `d4470436`. Não são regressão dos lotes 1–9 do consolidado `c0118600`. Este documento registra causa e correção. Não declara aceite de requisito.

## 1. `tests/notifications.test.ts` — `PROJECT_RUNTIME_MISMATCH`

O teste `durable completion batching and immediate blockers use one encrypted outbox with fenced retry receipts` chama `HappierEndpoint.tick()`, que executa `validateLink`. Desde `bdabbe19`, `src/happier.ts` recusa o elo quando `context.project_id !== runtime.projectId` (`PROJECT_RUNTIME_MISMATCH`). A fixture do runtime (objeto parcial com `repo`, `reconcileCancellations` e `recoverManaged`) não trazia `projectId`, embora o teste já criasse o projeto e o contexto nesse id.

Correção: a fixture passa `projectId: project`, o mesmo id inserido em `ac_projects` e usado em `createContext`. A checagem do produto permanece intacta.

## 2. `tests/happier.test.ts:145` — histórico sem o texto `Cezar`

Causa: expectativa obsoleta do teste, não falha de publicação, ordem ou paginação.

Em `b00efc31`, `HappierEndpoint.tick` publicava no histórico canônico o texto `Cezar ${run.id}: ${run.status} (contexto ${contextId}, evento ${seq}).`. Em `b7ab7bcb` essa linha foi removida. O estado do runtime passou a ser publicado por `Notifications` (`src/notifications.ts`), chamado em `flushNotifications` e `deliverQueuedMessages` (`src/happier.ts`). A conclusão entra na caixa de saída cifrada da sessão e segue para o histórico da mesma conversa. O texto atual da conclusão é `Plano ${planRevision}: execução concluída; confira o artefato e a integração.`, no objeto com `meta.agentControl.kind === 'completion'`. Esse texto não contém `Cezar`.

No ponto da asserção o histórico tem poucas mensagens (pedido do usuário, conclusão e, na primeira conversa, as duas entregas de fixture). O limite `limit=150` não corta a resposta. A busca é no JSON decodificado inteiro, então a ordem também não explica a falha. A stdout do worker sintético (`Synthetic implementation completed.`) continua só no evento interno do Cezar; o contrato publicado na conversa é o aviso de conclusão.

Correção: a asserção deixa de exigir a substring `Cezar` e passa a exigir `execução concluída` e `"kind":"completion"` em cada histórico. Continuam as provas de que o texto desta conversa está presente e o texto da outra conversa está ausente.

## 3. Typecheck do Cezar — `TS2322`

`upstream/cezar/packages/cezar/src/core/agent-control-effort.test.ts` espalhava um union de dois objetos literais em `env`. O tipo resultante tinha propriedades opcionais com `undefined` e não era atribuível a `Record<string, string>`. Os dois cenários (`MOCK_CODEX_REMOTE_STATE=disconnected` e `MOCK_CODEX_REMOTE_WRONG=1`) foram preservados, com o array anotado como `Array<Record<string, string>>`. Sem `any`, sem `@ts-ignore` e sem mudança de `tsconfig`.

## Checks

Executados neste runner, em sequência, depois das correções. Uma tentativa anterior em paralelo foi encerrada pelo processo (código 137) antes de terminar; o resultado abaixo é o da execução isolada de cada comando:

- `npm run typecheck` — saiu 0.
- `npm --prefix upstream/cezar run typecheck` — saiu 0. O script cobre `typecheck:contract`, `typecheck:client`, `typecheck:server`, `typecheck:web` e `typecheck:release`. O typecheck do servidor inclui `agent-control-effort.test.ts`.

Reservados ao laboratório isolado (PostgreSQL e servidor Happier ausentes neste runner). Este documento não afirma o resultado deles e não declara aceite de requisito:

- `tests/notifications.test.ts` (PostgreSQL)
- `tests/happier.test.ts` com `scripts/start-happier-lab.sh` na porta 18401 e PostgreSQL novo
