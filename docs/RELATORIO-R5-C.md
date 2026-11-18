# Relatório — reconstrução do design, rodada 5 (bloco C)

Trabalhador C (Gemini 4 Hydrogen High). Worktree `/home/app/projects/agent-control-design-c`, ramo `task/design-r5-c`.
Executados somente os itens 3 e 4 de `docs/ORDEM-GROK-DESIGN-RECONSTRUCAO-5.md`. Nenhum arquivo de outro bloco, instalação viva, conta, banco `ac_ispagent`, gateway ou `ac-personal-pg` foi alterado.

## Commits

| Item | Commit | O que entrou |
|---|---|---|
| 3. Sanitizador do criar por lista permitida | `e534223a` | `src/design-create.ts`, `tests/design-create-sanitize.test.ts` |
| 4. `preparar` | `6cd8c927` | `src/design-prepare.ts`, `tests/design-prepare.test.ts` |
| Relatório C | este commit | `docs/RELATORIO-R5-C.md` |

## O que foi feito

### Item 3 — Sanitizador do criar por lista permitida

- Substituída a lista de bloqueio em `src/design-create.ts` por `isAllowedUrl`, que aceita somente URLs relativas sem esquema e sem `//` (normalizando escapes CSS e barras invertidas `\\` / `/\\`), `data:image/png`, `data:image/jpeg` e `data:image/webp`, além de `https://fonts.googleapis.com` e `https://fonts.gstatic.com` exclusivamente em `<link href>`, `@import` e `@font-face` (em `<style>` e no CSS da tela, nunca em atributo `style`).
- `sanitizeCss` agora trata também `image-set()` e `-webkit-image-set()` (inclusive com escapes CSS), removendo candidatos com URL ou string fora da lista permitida ou substituindo por `none` quando nada resta.
- Esquemas como `ftp:`, `ws:`, `wss:`, `file:`, `blob:`, `javascript:`, `vbscript:` e `data:` fora de `image/png`, `image/jpeg` e `image/webp` (como `data:image/svg+xml`, `data:text/html`, `data:text/css`, `data:image/gif`) são removidos em HTML (`href`, `src`, `srcset`, etc.) e em CSS (`url()`, `image-set()`, `-webkit-image-set()`, `@import`).
- `<noscript>` foi incluído em `DROPPED_TAGS` para remoção integral do elemento e do seu conteúdo.
- `tests/design-create-sanitize.test.ts` recebeu testes cobrindo todos esses vetores.

### Item 4 — `preparar`

- `prepareDesignSpecialist` em `src/design-prepare.ts` agora registra `claude-opus-5-5` em `ac_model_catalog` com `efforts: ['medium']` e `roles: ['specialist']` apenas. Quando a linha já existe no catálogo com `medium` e `specialist` (mesmo com outros papéis/esforços), não é alterada; se existir sem `medium` ou sem `specialist`, recusa com `DESIGN_CREATE_MODEL_UNAVAILABLE` sem alterar a linha.
- Quando o projeto já possui `roles.specialist`, os perfis existentes em `regular` e `emergency` são preservados na ordem original e apenas os perfis que faltam são acrescentados à cadeia, evitando duplicatas entre `regular` e `emergency`.
- A leitura do plano (`loadFacts`) e a aplicação das mudanças passam a ocorrer em uma única transação (`ledger.tx`), com bloqueio `FOR UPDATE` em `ac_projects` quando `apply` é verdadeiro.
- `tests/design-prepare.test.ts` agora verifica o registro mínimo no catálogo, a preservação de linha existente do Opus no catálogo, a recusa sem alterar linha incompatível, a preservação de uma cadeia `specialist` própria pré-existente (incluindo perfis não-Claude e Claude antigos) e a execução em uma única transação.

## Verificações executadas

Para rodar `tsc` e `tests/design-prepare.test.ts` neste worktree (que já trazia `node_modules` em symlink para `/home/app/projects/agent-control-design/node_modules`), foram criados symlinks locais não versionados para `upstream/cezar/packages/cezar/dist` e `upstream/cezar/packages/cezar/node_modules` (já ignorados para commit).

- `node --import tsx --test tests/design-create-sanitize.test.ts`: passou **29/29** (`fail 0`, `skipped 0`).
- `AC_TEST_DATABASE_URL="postgresql://postgres:synthetic-design-r3@127.0.0.1:54333/ac_implementation_test" node --import tsx --test tests/design-prepare.test.ts`: passou **9/9** (`fail 0`, `skipped 0`), usando bancos descartáveis por `isolatedDatabase`.
- `npx tsc --noEmit`: código 1 com **4 erros apenas em arquivos `.d.ts` gerados de `upstream/cezar/packages/cezar/dist/`** (`automations/types.d.ts`, `server/forge/github.d.ts`, `server/server.d.ts` por tipos de `zod`). Nenhum erro em `src/` nem em `tests/`.
- `npx tsc --noEmit --skipLibCheck`: código **0**, sem erros.

## O que não foi feito (fora do escopo do bloco C)

- Itens 1 (1a a 1d), 2 e 5 (blocos A e B).
- Suíte completa (`npm test`), laboratório Docker (`AC_DESIGN_LAB=1`), reconstrução de imagens e edição de `docs/RELATORIO-GROK-DESIGN.md` (ficam para o gerente após juntar os três ramos).
