# Relatório — Parte A.5 R2 (preservar a autoria visual do produto)

Executado conforme [ORDEM-FINAL-A5-R2.md](/home/app/projects/agent-control/docs/ORDEM-FINAL-A5-R2.md) no worktree `/home/app/projects/ac-wt/final-a5` (ramo `task/final-a5`), pelo trabalhador `gemini-4-argon-high`.

## Resumo das alterações

1. **Simplificação sobre a base `82c8d368` e preservação da autoria visual (`src/design-create.ts`)**
   - Removida a constante `FALLBACK_BATCH_DIRECTIONS` e toda extração por regex de ações, paletas, rótulos de assinantes e seções de variedade. O modelo do próprio produto (`claude-opus-5-5` com esforço `medium`) interpreta o briefing diretamente.
   - `createTask` envia `input.briefing` integralmente em todas as rodadas (criação e retrabalho), sem o corte anterior de `8000` caracteres.
   - Adicionada uma única instrução condicional genérica em linguagem natural no prompt:
     `Quando o briefing pedir conceitos diferentes da mesma tela, preserve a função e as ações e siga as direções fornecidas a cada conceito, inclusive no retrabalho dos nomes rejeitados.`
   - Validado o teto real de `MAX_CREATE_TASK_CHARS = 100_000` caracteres do prompt montado antes de reservar assento ou disparar o worker (tanto na rodada 1 quanto nas rodadas de retrabalho). Quando excedido, lança `Refusal('DESIGN_CREATE_PROMPT_TOO_LARGE', 400)` com mensagem clara informando o limite de `100000` caracteres e o tamanho real do prompt.
   - Preservados integralmente o caminho de telas distintas e os contratos existentes de dados de saída (`readCreateBundle`, `parseCreateBundle`, `runDesignCreate`, arquivos gerados e `index.html`).

2. **Testes compactos (`tests/design-create.test.ts`)**
   - Briefing longo completo (>8.000 caracteres, incluindo `/home/app/design-briefings/tela-inicial-assinante.md` com direções de lote) enviado sem corte na criação e no retrabalho, com a instrução condicional genérica.
   - Lote explicitamente direcionado de outro domínio e modo de telas distintas, provando que o briefing original é preservado sem injeção de direções de faturas/internet/pagamentos.
   - Retrabalho por nome rejeitado, solicitando apenas a tela rejeitada com o mesmo `name`, preservando o arquivo aprovado da rodada anterior e mantendo o briefing completo.
   - Estouro do teto de `100000` caracteres (na rodada 1 e no retrabalho da rodada 2), falhando com `DESIGN_CREATE_PROMPT_TOO_LARGE` e mensagem explícita antes de reservar assento ou acionar o worker, além de aceitar exatamente `100000` caracteres.

## Verificações executadas

- `npx tsc --noEmit --skipLibCheck`: passou (saída `0`).
- `node --import tsx --test tests/design-create.test.ts`: 4/4 testes passaram.
