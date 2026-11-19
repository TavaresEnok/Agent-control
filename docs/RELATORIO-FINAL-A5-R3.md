# Relatório — Parte A.5 R3 (mensagem da CLI e fixture reproduzível)

Executado conforme [ORDEM-FINAL-A5-R3.md](/home/app/projects/agent-control/docs/ORDEM-FINAL-A5-R3.md) no worktree `/home/app/projects/ac-wt/final-a5` (ramo `task/final-a5`, base `8ca113fa`), preservando o trabalho anterior em `src/design-create.ts`, `docs/RELATORIO-FINAL-A5-ARGON.md` e `docs/RELATORIO-FINAL-A5-R2.md`.

## Auditoria do estado anterior (`8ca113fa`)

- `src/design-create.ts` já aplicava `MAX_CREATE_TASK_CHARS = 100_000` antes de reservar assento ou acionar o worker, lançando `Refusal('DESIGN_CREATE_PROMPT_TOO_LARGE', 400)`.
- `src/personal-design-cli.ts` ainda não possuía entrada para `DESIGN_CREATE_PROMPT_TOO_LARGE` em `messages`, fazendo `designCliFailureText` cair na mensagem genérica `'O exame de design falhou.'`.
- `tests/design-create.test.ts` ainda consultava `/home/app/design-briefings/tela-inicial-assinante.md` com `existsSync`/`readFileSync`, tornando a prova do briefing longo dependente do ambiente externo.

## Alterações realizadas

1. **P2 — Mensagem da CLI para `DESIGN_CREATE_PROMPT_TOO_LARGE` (`src/personal-design-cli.ts`, `tests/personal-design-cli-message.test.ts`)**
   - Importado `MAX_CREATE_TASK_CHARS` de `./design-create.ts` e registrada a entrada `DESIGN_CREATE_PROMPT_TOO_LARGE` em `messages` com texto fixo em português informando o limite de `100000` caracteres e orientando reduzir o briefing ou o retrabalho, sem expor `error.message` nem qualquer conteúdo do prompt.
   - Adicionado teste em `tests/personal-design-cli-message.test.ts` verificando que `designCliFailureText` exibe o limite de `100000` caracteres, a orientação para reduzir briefing/retrabalho e não vaza conteúdo anexado em `refusal.message`, tanto para `Refusal` quanto para `Error`.

2. **P3 — Fixture sintética determinística na prova longa (`tests/design-create.test.ts`)**
   - Removida a dependência de `/home/app/design-briefings/tela-inicial-assinante.md` (`BRIEFING_FILE`, `existsSync` e `readFileSync`).
   - A prova longa agora usa entrada sintética determinística acima de `8000` caracteres com as direções do lote ao final, verificando preservação integral do briefing, das direções finais e da porção após `8000` caracteres na criação e no retrabalho.
   - Preservados o caso de retrabalho por tela rejeitada e os testes do teto de `100000` caracteres do runtime (na rodada 1 e no retrabalho da rodada 2).

## Verificações executadas

- `npx tsc --noEmit --skipLibCheck`: passou (código de saída `0`).
- `node --import tsx --test tests/personal-design-cli-message.test.ts tests/design-create.test.ts`: `10/10` testes passaram (`6` em `tests/personal-design-cli-message.test.ts` e `4` em `tests/design-create.test.ts`), sem testes ignorados ou falhos.
