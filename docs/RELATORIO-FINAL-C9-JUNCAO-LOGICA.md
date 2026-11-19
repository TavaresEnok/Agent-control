# C9 — Fatos comuns em expressões de curto-circuito

Os coletores preservam os efeitos de avaliar o operando esquerdo e incluem o direito quando algum caminho pode alcançá-lo. Na junção dos valores, o caminho que encerra `&&` ou `and` fornece um valor falso. O que encerra `||` ou `or` fornece um valor verdadeiro. Isso permite que uma constante à direita determine a verdade do resultado mesmo quando a verdade do primeiro operando é desconhecida.

Em JavaScript e TypeScript, a junção conserva cada fato (`truthy`, `nullish`, `undefined`) que coincide em todos os caminhos alcançáveis. A regra também cobre `??`, cujo caminho de curto-circuito garante um valor diferente de `null` e de `undefined`. O resumo dos efeitos de chamadas locais e a leitura do valor de um argumento usam esses fatos. Quando `undefined` ainda é possível, o resumo mantém o efeito possível do valor padrão e a cobertura parcial correspondente.

As regressões reproduzem `(gate && false) && stop()`, `((gate is None) and False) and stop()` e `clear((gate && false) || {})`. As duas primeiras preservam o vínculo de `emit` e a linha de origem do log posterior. A terceira conserva o conteúdo do objeto que só seria alterado pelo valor padrão. Os controles incluem efeitos alcançáveis do lado esquerdo, cadeias de operadores e argumentos com `null` ou `undefined` possíveis.

## Verificação local

- `npx tsc --noEmit --skipLibCheck` passou.
- `node --import tsx --test tests/module-conformidade.test.ts` passou com 30 testes. O teste de curto-circuito e presença de argumento cobre 31 variantes sintéticas e verifica a cobertura parcial e as linhas de origem e destino.
- `git diff --check` passou.
