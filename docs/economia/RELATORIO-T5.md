# T5 — índice e grafo

- Candidato: [codebase-memory-mcp v0.12.1](https://github.com/DeusData/codebase-memory-mcp/tree/v0.12.1), [MIT](https://github.com/DeusData/codebase-memory-mcp/blob/v0.12.1/LICENSE), local, sem chave. Segundo candidato: nenhum.
- NexoISP: `21f692d212ed1410b774d1847a08eb6783f20271`. Índice `fast`: 9,59 s; 58 arquivos não indexados; 121 arquivos com análise parcial.
- `/tmp/econ-t5-nexo` já existia; clone independente em `/tmp/econ-t5-piloto-owned`, removido ao final.

| Pergunta | Base: tokens | Ferramenta: tokens | Acerto | Indexação |
|---|---:|---:|---|---:|
| 1. Login na API | 13.623 | 2.919 | Acertou | 9,59 s |
| 2. Tabela de clientes/assinantes | 86.821 | 2.949 | Incompleta | 9,59 s |
| 3. Painel inicial e hooks | 8.701 | 210 | Incompleta | 9,59 s |
| 4. Rotas Anatel | 40.936 | 840 | Incompleta | 9,59 s |
| 5. Escritas do agente de rede | 1.097 | 2.268 | Incompleta | 9,59 s |
| Total | 151.178 | 9.186 | 1/5 | 9,59 s |

Tokens estimados: caracteres Unicode / 4, arredondados para cima. Base: saída de `rg -n -H` mais conteúdo integral de cada arquivo encontrado, uma vez por pergunta; ferramenta: saída integral de `search_code` (`limit=100`, `result_limit=100`, `match_limit=100`, `max_output_tokens=20000`). Consultas da ferramenta, respectivamente: `login`, `subscribers`, `ErpOverview`, `anatel`, `insert into`. Base: `/api/auth/login` em `apps/api-go`; `(from|join|update|into) (customers|subscribers|clientes|assinantes)` em `apps/api-go`; `ErpOverview|use[A-Z][A-Za-z]+` em `apps/web/features/operations/overview.tsx`; `anatel` em `apps/api-go/internal/modules` e `apps/web/features/admin`; `insert into|update ` em `apps/api-go/internal/agent`. Busca SQL sem distinção de maiúsculas, com `public.` opcional e espaços variáveis; testes excluídos.

A economia bruta é 93,92%, mas compara consultas de escopos e precisão diferentes; não inclui leituras de conferência nem páginas adicionais. A base da pergunta 5 também é incompleta: os SQLs estão em arquivos separados e a busca não encontra as funções chamadoras. Portanto não comprova economia para respostas completas.

Conferência:

1. `apps/api-go/internal/modules/identity/service.go`: `login`; `cryptox.VerifyPassword`.
2. `apps/api-go/internal/modules/cadastro/queries/subscriber.sql`; `apps/api-go/internal/modules/cadastro/gen/subscriber.sql.go`; resultado limitado a 100 de 333 e com conteúdo adicional pendente.
3. `apps/web/features/operations/application.tsx`; `apps/web/features/operations/overview.tsx`: `ErpOverview`, `useSession`, `useOverviewPreferences`, `useNavigate`, `useQueryState`, `useSWR`. A consulta retornou o componente, sem enumerar os hooks.
4. `apps/web/features/operations/pages.ts`; `apps/web/features/operations/application.tsx`; `apps/api-go/internal/modules/escrita/rotas.json`; `apps/api-go/internal/modules/escrita/dici.go`. A consulta não apresentou as rotas de backend.
5. `apps/api-go/internal/agent/server.go`; `apps/api-go/internal/agent/sql/`: `authenticate`, `checks`, `run`. A consulta não relacionou de forma completa SQLs e funções; resultado limitado a 100 de 347.

**Recomendação: não adotar** como resposta autônoma: 1/5, abaixo de 5/5. Uso exploratório apenas, com leitura de código e verificação de paginação.
