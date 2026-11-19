# Relatório — Parte A.5 (conceitos da mesma tela no modo criar)

Executado conforme [ORDEM-FINAL-A5.md](docs/ORDEM-FINAL-A5.md) no worktree `/home/app/projects/ac-wt/final-a5` (ramo `task/final-a5`), pelo trabalhador `gemini-4-argon-high`.

## Resumo das alterações

1. **Remoção do corte silencioso de 8.000 caracteres do briefing e respeito explícito aos limites do runtime (`src/design-create.ts`)**
   - `createTask` não trunca mais `input.briefing` em `8000` caracteres (o briefing real `/home/app/design-briefings/tela-inicial-assinante.md` possui 8.565 caracteres, e sua seção final `## Variedade entre as telas` e parte do item 9 ficavam após o caractere 8.000) nem trunca silenciosamente o prompt final com `.slice(0, 100000)`.
   - Quando o briefing é vazio/inválido ou quando o prompt montado (na criação da rodada 1 ou no retrabalho com `HTML anterior` de até 8.000 caracteres por tela rejeitada, achados medidos e notas visuais) ultrapassa o limite do runtime (`MAX_CREATE_TASK_CHARS = 100_000` de `DesignWorkerCall` e `NativeExecutionRequest`), `createTask` falha explicitamente com `Refusal('DESIGN_CREATE_INVALID', 400)` antes de reservar assento.
   - `readCreateBundle` e `runDesignCreate` também recusam explicitamente com `Refusal('DESIGN_CREATE_INVALID', 400)` telas cujo HTML ou CSS ultrapasse `MAX_CREATE_FILE_BYTES = 200_000` bytes (ou parâmetros `screens`/`rounds` não inteiros/fora da faixa), sem truncar HTML/CSS pela metade e garantindo liberação do assento no `finally`.

2. **Modo variedade da mesma tela na criação e no retrabalho (`src/design-create.ts`)**
   - `isSameScreenVarietyBriefing` identifica quando o briefing pede variedade ou conceitos visuais distintos da mesma tela (`Variedade entre as telas`, `variedade da mesma tela`, `conceitos visuais diferentes da mesma tela`, `não telas diferentes do app`, etc.), mantendo inalterado o modo normal de telas distintas quando o briefing pede fluxos/telas diferentes.
   - `extractSameScreenVarietyContext` extrai do briefing (e de `referenceNote`, quando presente):
     - **Intenção da tela**: título e objetivo principal da tela e do usuário final, instruindo que todos os itens de `screens` são conceitos visuais distintos da mesma tela (nunca telas de etapas secundárias como uma tela separada de pagamento ou detalhe).
     - **Ações**: tarefas principais, atalhos secundários e regra de hierarquia (uma única ação primária preenchida acima da dobra e as demais ações na própria tela).
     - **Rótulos**: rótulos de botões, ações, atalhos e navegação extraídos do briefing (incluindo `PIX copia e cola`, `Código de barras`, `2ª via`, etc.) com instrução explícita de preservação em linha única (`white-space: nowrap`, sem quebrar rótulos em 2 linhas, hifenizar ou cortar texto).
     - **Todas as direções por lote**: extrai todas as direções visuais do lote (em seções `## Variedade`, `## Direções`, `## Lote`, `## Conceitos`, subcabeçalhos `###`, itens numerados, bullets ou linhas `Direções por lote:`), complementando com arquétipos visuais distintos quando o briefing só traz a regra geral de variedade, e preserva todas as direções do lote tanto na rodada de criação quanto nas rodadas de retrabalho (vinculando ainda cada tela rejeitada à sua direção específica e posição no lote `k de N`).
   - Apenas o worker do produto (`forcedModel: 'claude-opus-5-5'`, `forcedEffort: 'medium'`) desenha telas.

3. **Testes próprios de criação (`tests/design-create.test.ts`)**
   - Briefing real `/home/app/design-briefings/tela-inicial-assinante.md` (>8.000 caracteres) em criação e retrabalho, validando preservação do trecho final (`## Variedade entre as telas`), intenção, ações, rótulos (`Código de barras`, `PIX copia e cola`, `2ª via` em linha única) e todas as direções do lote.
   - Lote de 4 conceitos com direções explícitas por lote e retrabalho parcial de 2 conceitos rejeitados, preservando todas as 4 direções do lote e vinculando cada conceito rejeitado à sua direção (`2 de 4` e `4 de 4`).
   - Extração de direções em subcabeçalhos `###` e linhas `Direções por lote:` / `Rótulos:`.
   - Briefing longo (>12.000 caracteres) em modo normal de telas distintas com retrabalho, confirmando que o modo variedade da mesma tela não é ativado indevidamente e que o final do briefing longo é preservado.
   - Falhas explícitas (`Refusal('DESIGN_CREATE_INVALID', 400)`) nos limites do runtime (briefing vazio, `screens`/`rounds` inválidos, briefing acima de 100.000 caracteres na rodada 1, estouro de 100.000 caracteres na rodada 2 ao somar retrabalho, e HTML/CSS acima de 200.000 bytes), sem truncamento silencioso nem vazamento de assento.

## Verificações executadas

- `npx tsc --noEmit --skipLibCheck`: passou (código de saída `0`).
- `node --import tsx --test tests/design-create.test.ts tests/design-create-sanitize.test.ts`: 47/47 testes passaram (`5` em `tests/design-create.test.ts` e `42` em `tests/design-create-sanitize.test.ts`).
