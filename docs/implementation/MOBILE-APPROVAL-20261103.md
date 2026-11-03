# Aprovação de integração em viewport estreito — 03/11/2026

A carta em Settings continua sendo `AgentControlIntegrationApproval`. Em largura até 390 px (360 e 390) ela mostra digest, política e destino, a prévia do diff e o bloqueio quando `truncated` é verdadeiro. O botão de aprovar fica desabilitado e aponta para o alerta. Enter e espaço disparam a mesma ação, com alvo mínimo de 44 px. Viewport largo mantém a carta anterior, sem o bloco Digest e sem altura mínima de 44 px.

`AgentControlSection` não foi alterado. O callback real continua `payload => mutate.mutate(...)`, que devolve `void` e guarda a rejeição no cache do React Query. A carta espera essa mutation pendente de `integration.approve` no mesmo `QueryClient`. O erro HTTP, inclusive `MANAGER_UNAVAILABLE`, passa a ser o `Error` da mutation. O foco volta ao botão "Tentar novamente a aprovação" quando ele está habilitado.

Os atributos `data-approval-intent` e `data-approval-delivery` vêm do corpo do POST `/api/v1/ac/control` observado por `agentControlFetch`. Não são o identificador de entrega reservado só na carta. A intenção gravada em `sessionStorage` (`ac-control-pending:<contexto>`) é a que o envio reutiliza; o identificador de entrega não é persistido. Registro corrompido ou semântico divergente gera `PENDING_COMMAND_INVALID` e não chama a aprovação. Campo extra `token` da resposta do diff não entra no DOM, no pedido nem no registro.

O teste de `MANAGER_UNAVAILABLE` monta esse contrato em memória: `useMutation` com o mesmo formato de corpo assinado da seção, `signControl` simulado e `agentControlFetch`. A primeira resposta é 409 `MANAGER_UNAVAILABLE`; a segunda é `state: applied`. Os dois POSTs têm o mesmo `intentId` e `deliveryAttemptId` distintos, iguais aos atributos da carta. `mutate()` devolve `undefined`. Não houve PostgreSQL.

## Preparação

Node v24.22.1 em `/home/app/.local/share/node24/bin`. `upstream/cezar/node_modules` e `packages/cezar/dist` já existiam. `npm ci` e `build:server` não foram executados.

O typecheck do web segue o adaptador até duas fontes Happier que importam `@happier-dev/protocol`. Não há declaração ambiente substituta. O teste de fetch voltou a ser módulo com `import` normal.

Para o `tsc` resolver o pacote real, nesta árvore apenas: o script `generate-embedded-feature-policies.mjs` (exit 0), `npm install --prefix upstream/happier/packages/protocol --ignore-scripts --no-audit --no-fund --no-package-lock` (exit 0, 8 pacotes) e `tsc -p upstream/happier/packages/protocol/tsconfig.json` (exit 0). O link `upstream/happier/node_modules/@happier-dev/protocol` aponta para esse pacote. `dist`, `node_modules` e o arquivo gerado estão no `.gitignore`. Não são patch de produto.

## Comandos

- `npm --prefix upstream/cezar run typecheck -w @open-mercato/cezar-web` antes do pacote Happier — exit 1. `TS2307` em `terminalProvisioningResponse.ts` e `cli-common/src/links/index.ts`.
- O mesmo typecheck depois do build local de `@happier-dev/protocol` — exit 0. `tsc --noEmit` de `@open-mercato/cezar-web`.
- `npm --prefix upstream/cezar test -w @open-mercato/cezar-web -- --run src/routes/settings/agent-control-integration-approval.test.tsx src/routes/settings/agent-control-fetch.test.ts` — exit 0. 2 arquivos, 10 testes, sem skips. Vitest 4.1.10, jsdom.

PATH=`/home/app/.local/share/node24/bin:$PATH` nos três.

## Provado

- jsdom, sem Chromium e sem aparelho: 360 e 390 exibem digest, política, destino e diff; prévia truncada bloqueia clique e teclado.
- Alvos com `min-height`/`min-width` de 44 px e classe `min-h-11`, foco, `type="button"`, nomes acessíveis e `aria-describedby` no bloqueio e no erro.
- `MANAGER_UNAVAILABLE` pelo `mutate()` que devolve `void`, retry com o mesmo payload e a mesma intenção enviada, entrega nova, foco no botão de nova tentativa e recusa de registro inválido.
- `intentId` e `deliveryAttemptId` dos POSTs conferidos com os atributos da carta.
- Carta de desktop preservada no teste de 1280 px e nos casos de prévia completa ou truncada.
- Cabeçalho do diff e do controle sem `Authorization`; segredo extra da resposta não é renderizado nem gravado.
- Typecheck do pacote web com o `@happier-dev/protocol` compilado, sem tipos escritos à mão.

## Não provado

- Aparelho físico, teclado físico, leitor de tela e tela nativa Happier.
- A página Settings inteira (`AgentControlSection`) não foi renderizada neste teste. O arquivo da seção não faz parte do escopo e não foi editado. O transporte em memória repete o `mutate` e o POST; não substitui o percurso de login, dispositivo real ou resposta de um gerente.
- Layout computado do Tailwind ou quebra visual no Chromium. O jsdom não aplica a folha. Os 44 px vêm do estilo inline testado.
- Diff grande, crash durante a espera e aprovação humana independente.
- Árvore limpa sem o `dist` local de `@happier-dev/protocol`: o typecheck volta a `TS2307`. Este build não é o monorepo Happier instalado por yarn.
- `npm ci` e `build:server` do Cezar nesta rodada.
- Nenhum dos 111 requisitos é aceito por esta prova. Não houve conta real, inferência, deploy, migração, credencial, scheduler nem banco.
