# Relatório — reconstrução do design, rodada 6 (bloco C)

Trabalhador C (Gemini 4 Hydrogen High). Worktree `/home/app/projects/agent-control-design-c`, ramo `task/design-r5-c`.
Executado somente o item 6 (bloco C) de `docs/ORDEM-DESIGN-RECONSTRUCAO-6.md`. Nenhum arquivo de outro bloco, instalação viva, conta ou credencial real foi alterado ou tocado.

## Commits

| Item | Commit | O que entrou |
|---|---|---|
| 6. `url()` em atributos de apresentação | `01ebb8b8` | `src/design-create.ts`, `tests/design-create-sanitize.test.ts` |
| Relatório C | este commit | `docs/RELATORIO-R6-C.md` |

## O que foi feito

### Item 6 — `url()` em atributos de apresentação

- `sanitizeCss` em `src/design-create.ts` passou a delegar para `scanCss(css, options)`, que retorna `{css, hasBlockedUrl}` sem duplicar a varredura de CSS. `sanitizeImageSet` também passou a informar `{value, rejected}`.
- Em `sanitizeElement`, além de `style`, `srcset`/`imagesrcset`, atributos de URL (`URL_ATTRIBUTES`, `*:href`, `*:src`) e esquemas `javascript:`/`vbscript:`, todo atributo restante passa por `scanCss(attr.value, {allowFontRules: false})`.
- Quando qualquer `url()` (incluindo `url(//x)`, `https://`, `https://fonts.googleapis.com`, `data:image/svg+xml`, `url(` sem fechamento, e formas com escapes CSS em `url(` ou dentro da URL como `\75rl(...)`, `u\72 l(...)`, `\68 ttps://...` e `\2f\2f x`), `image-set()`/`-webkit-image-set()` ou `@import` no valor do atributo é recusada pelas regras do CSS (`allowFontHost: false`, `allowDataImage: true`), o atributo inteiro é removido do elemento.
- URLs locais, fragmentos (`url(#grad)`) e `data:image/{png,jpeg,webp}` continuam permitidos nos atributos de apresentação.
- `tests/design-create-sanitize.test.ts` recebeu testes cobrindo `fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker-start`, `marker-mid`, `marker-end`, `cursor`, `marker`, `mask-image` e `data-bg` (com `https://`, `url(//x)`, escapes CSS, `fonts.googleapis.com`, `data:image/svg+xml`, mistura de `url()` válida + inválida e `url(` não fechada), além da preservação de `url()` local/fragmento/`data:image/png`.

## Verificações executadas

- `npx tsc --noEmit --skipLibCheck`: código **0**, sem erros.
- `node --import tsx --test tests/design-create-sanitize.test.ts`: passou **42/42** (`fail 0`, `skipped 0`).
- `node --import tsx --test tests/design-model-failure.test.ts`: passou **4/4** (`fail 0`, `skipped 0`).

## O que não foi feito (fora do escopo do bloco C)

- Itens 1 a 5 (bloco A).
- Suíte completa (`npm test`) e laboratório Docker (`AC_DESIGN_LAB=1`), reservados ao gerente após a junção dos ramos.
