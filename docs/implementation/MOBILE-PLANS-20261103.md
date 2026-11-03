# Percurso móvel de propostas — 03/11/2026

A lista estreita de propostas em Settings (`AgentControlManagerPlans`) carrega objetivo e origem por revisão. Uma prévia que falha, vem inválida ou diverge da revisão/digest listados permanece nessa revisão. As outras continuam com objetivo, origem e digest completo. O botão "Tentar novamente" refaz só essa revisão; um clique enquanto a carga está em voo não abre outra requisição (`cancelRefetch: false`). A divergência não fica fresca no cache (`staleTime` 0): o retry chama `refetch` e, se a prévia seguinte confere, a linha passa a mostrar objetivo e origem. `plan.start` segue usando a revisão e o digest exibidos. `MANAGER_UNAVAILABLE` repete o mesmo `intentId` com outro `deliveryAttemptId`.

A resposta de prévia não entra no estado visível. Falha de carga usa o alerta fixo "Não foi possível carregar o objetivo e a origem desta proposta." Divergência usa "A prévia recebida divergiu da revisão listada. Nada foi solicitado." O digest listado continua inteiro (`break-all`, 64 hex). Viewport estreito é `(max-width: 390px)`. O alvo mínimo é 44 px. No desktop a lista segue compacta, sem esses campos na linha.

O erro de `plan.start` só aparece se o código for exatamente um dos reconhecidos (`MANAGER_UNAVAILABLE`, `AUTH_REQUIRED`, `REQUEST_BODY_TOO_LARGE`, `INVALID_CONTRACT`, `INTERNAL_ERROR`, `PROJECT_RUNTIME_MISMATCH`, `PROPOSAL_NOT_READY`, `PENDING_COMMAND_INVALID`, `COMMAND_RESPONSE_MISMATCH`) ou `HTTP_` seguido de um status 100–599 gerado no cliente. Qualquer outro texto, inclusive um código conhecido com token colado, vira "Não foi possível solicitar a execução desta proposta." O texto bruto não entra na mensagem, no `aria-label` nem em log.

Isto não promove os 111 RF/RNF/T. O programador não aprova a revisão.

## Provado

Os testes usam Vitest 4.1.10 e jsdom, com `fetch` e `matchMedia` substituídos. Não há PostgreSQL, Ruby, Docker, conta real, inferência, deploy nem migração.

Rodada anterior, preservada. Node v24.22.1 em `/home/app/.local/share/node24/bin`. `upstream/cezar/node_modules` e `upstream/cezar/packages/cezar/dist` já existiam; `npm ci` e `npm --prefix upstream/cezar run build:server` não foram executados. O comando abaixo contou 10 testes naquele código; a suíte atual está na correção.

- `npm --prefix upstream/cezar run typecheck -w @open-mercato/cezar-web` — exit 0. O `tsconfig` do pacote web lê `@open-mercato/cezar-api-client` da fonte.
- `npm --prefix upstream/cezar test -w @open-mercato/cezar-web -- --run src/routes/settings/agent-control-manager-plans.test.tsx src/routes/settings/agent-control-fetch.test.ts` — exit 0, 10 testes (7 de `agent-control-manager-plans.test.tsx` e 3 de `agent-control-fetch.test.ts`). O arquivo de planos está coberto por essa invocação.

O que esses testes exercitam:

- Viewports simulados 360 e 390: objetivo, origem e digest completo na lista e em `plan.start`; nome acessível com a revisão e o digest exibidos; `minHeight`/`minWidth` de 44 px; foco no botão; classe `focus-visible:ring-[3px]`; `type="button"`.
- `MANAGER_UNAVAILABLE` e a repetição: o mesmo `intentId`, outro `deliveryAttemptId`, payload `proposalRevision`/`proposalDigest` iguais aos exibidos.
- Três propostas no viewport 360: HTTP 500 numa prévia e, na tentativa seguinte, JSON 200 inválido. As outras duas mantêm objetivo, origem e digest. A segunda tentativa fica única enquanto a resposta não chega. A terceira tentativa recupera só a proposta que falhou. Nenhum `plan.start` é enviado. O marcador secreto da resposta não aparece no texto da página.
- Digest que não confere com a lista: o botão de execução fica desligado e o digest aberto não é exibido.
- Largura simulada 1280: a linha da lista permanece "Proposta 1 · 1 tarefas", sem os campos móveis; o digest completo aparece depois da seleção.
- `settleDisplayedProposalIdentities` resolve o lote quando um carregamento rejeita ou discorda da revisão listada. O motivo da rejeição não volta no resultado.
- `planStartErrorMessage` mantém código reconhecido ou `HTTP_409` e troca texto com segredo pela frase genérica.

### Correção da revisão (mesma data, rodada seguinte)

Node v24.22.1 em `/home/app/.local/share/node24/bin`. `upstream/cezar/node_modules` e `upstream/cezar/packages/cezar/dist` já existiam; `npm ci` e `npm --prefix upstream/cezar run build:server` não foram executados. Sem PostgreSQL, Ruby, Docker, conta real, inferência, deploy ou migração.

- `npm --prefix upstream/cezar run typecheck -w @open-mercato/cezar-web` — exit 0.
- `npm --prefix upstream/cezar test -w @open-mercato/cezar-web -- --run src/routes/settings/agent-control-manager-plans.test.tsx` — exit 0, 9 testes.
- `npm --prefix upstream/cezar test -w @open-mercato/cezar-web -- --run src/routes/settings/agent-control-manager-plans.test.tsx src/routes/settings/agent-control-fetch.test.ts` — exit 0, 13 testes (9 de planos e 4 de `agent-control-fetch.test.ts`).

O que a correção acrescenta aos testes:

- Viewport 360: a primeira prévia de uma proposta devolve digest diferente do listado e um `objectiveRef` com `bearer:…`. A linha fica em `mismatch`, com alerta e botão de retry de 44 px, sem objetivo da prévia divergente e sem o segredo nem o digest divergente. O segundo carregamento, só depois do clique, confere com a lista e mostra objetivo e origem. A outra proposta não é recarregada. Nenhum `plan.start` é enviado.
- `plan.start` com `error` contendo `MANAGER_UNAVAILABLE` mais `Bearer eyJ…`: a tela mostra só a frase genérica. O segredo não aparece no texto, no HTML, no `aria-label`, no `sessionStorage` nem nas capturas de `console.error`, `console.warn`, `console.log`, `console.info` e `console.debug`.

## Não provado

- Aparelho físico, tela nativa Happier e percursos completos do produto.
- Chromium, layout computado, overflow real e leitura de tela em dispositivo.
- `npm --prefix upstream/cezar run build:server` nesta rodada. O `dist` já estava presente; esta verificação não o regenerou e não prova o build do pacote `@open-mercato/cezar`.
- Banco, restore operacional, contas reais, inferência, deploy e migração.
- Aceite dos 111 requisitos.
