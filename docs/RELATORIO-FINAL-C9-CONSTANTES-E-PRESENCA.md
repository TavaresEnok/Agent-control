# C9 — Constantes compostas e presença de argumento

O resumo de efeitos de funções locais em JavaScript/TypeScript e Python propaga constantes por operadores lógicos compostos. Quando o operando esquerdo determina o curto-circuito, o resumo conserva seus efeitos alcançáveis e descarta o operando direito. Assim, `(false && true) && stop()` e `(False and True) and stop()` preservam o vínculo de `emit` e a linha de origem no LOG posterior. Os controles de condição verdadeira e desconhecida incluem o efeito possível de `stop()`.

Em JavaScript/TypeScript, o resumo verifica se a posição de um parâmetro com valor padrão pode receber `undefined`. Um objeto literal em `clear({})` dentro da função intermediária exclui o valor padrão. O argumento omitido e o `undefined` global selecionam o padrão. Um argumento sem valor estático, inclusive uma referência a um parâmetro chamado `undefined`, ou uma expansão que torna a posição incerta mantém o efeito possível do padrão e gera cobertura parcial específica. A análise independente dos corpos também pode indicar vínculos capturados ou efeitos opacos sobre argumentos.

Os fatos de curto-circuito são guardados por expressão em cada arquivo. A deduplicação dos resumos de JavaScript/TypeScript considera o receptor e as posições dos parâmetros com padrão comprovadamente preenchidas. A análise usa os limites vigentes de leitura, expansão e profundidade estrutural.

## Verificação local

As 15 variantes sintéticas conferem o tipo do achado, as linhas de destino e de origem, a cobertura parcial esperada e a ausência de campos e valores das fixtures no relatório. [Testes de conformidade](../tests/module-conformidade.test.ts)

- `npx tsc --noEmit --skipLibCheck`
- `node --import tsx --test tests/module-conformidade.test.ts` — 30 testes
- `git diff --check`
