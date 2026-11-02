# UI administrativa — resultado de 02/11/2026

A interface apresenta objetivo, origem e digest das propostas e reutiliza o grafo ReactFlow em modo somente leitura. A solicitação `plan.start` usa a revisão e o digest exibidos e a revisão de política da conversa. Uma resposta aceita indica apenas que a solicitação foi aceita; `MANAGER_UNAVAILABLE` aparece como erro. A intenção é preservada em sessionStorage por principal, projeto, contexto, digest e política. Tentativas repetidas usam a mesma intenção e novo identificador de entrega; dados corrompidos bloqueiam o reenvio.

A seleção usa a árvore nativa de Settings e as rotas `/p/:projectId`, alimentadas pela projeção PG de `/api/v1/projects`. No modo gerenciado, o projeto inicial também mantém seu UUID explícito no `ProjectScopeProvider`. A árvore roteada é remontada na troca, as consultas administrativas têm chaves escopadas e as chamadas AC enviam `X-Agent-Control-Project` quando existe escopo nativo.

O stream gerenciado usa `/api/v1/p/:uuid/workspace/events`, calculado a partir da rota; não abre conexão sem UUID de projeto. A troca fecha a conexão anterior e remonta o provider e seu armazenamento de uso. O stream de webhooks permanece desativado no modo gerenciado. A integração depende do handler seguro do gateway e não habilita o SSE nativo com probes.

## Evidência

Em `upstream/cezar`:

- `npm test -w @open-mercato/cezar-web -- --run src/routes/settings/agent-control-manager-plans.test.tsx src/routes/settings/agent-control-fetch.test.ts src/routes/settings/agent-control-integration-approval.test.tsx src/routes/settings/agent-control-provider-operations.test.tsx`: exit 0, 4 arquivos e 6 testes. Cobre gerente indisponível, retry idempotente, identidade da proposta e cabeçalho.
- `npm test -w @open-mercato/cezar-web -- --run src/routes.test.tsx src/api/agent-control-streams.test.tsx src/hooks/use-webhooks.test.tsx src/routes/settings/agent-control-fetch.test.ts src/routes/settings/settings.test.tsx`: exit 0, 5 arquivos e 181 testes. Cobre troca de escopo, navegação nativa, cabeçalho e streams.
- Após chavear o provider por projeto, o teste focado `src/api/agent-control-streams.test.tsx` passou com 2 testes; `npm run typecheck -w @open-mercato/cezar-web` terminou com exit 0.

A primeira execução do typecheck terminou com exit 1 por indexação potencialmente indefinida no teste novo; a asserção foi corrigida e o typecheck repetido passou. O build não foi executado nesta frente. Os testes do drawer móvel usam jsdom; não houve percurso de navegador móvel nem telefone físico por esta frente. Não foram utilizadas contas reais ou APIs pagas, nem houve execução operacional ou publicação.

A integração requer `policy_revision` em `GET /api/v1/ac/contexts` e a resposta `{intentId,runId,state}` de `POST /api/v1/ac/commands`, incluindo a recusa `MANAGER_UNAVAILABLE` quando aplicável. A validação integrada do gateway e o build final cabem ao coordenador; os testes desta frente não constituem gate de produto completo.
