# C2 · Referências entre aspas na matriz de QA

A gramática explícita lê a mensagem entre aspas como uma unidade. Pontos, ponto e vírgula, parênteses e backticks dentro da mensagem deixam de interferir na separação das orações. A matriz mantém a mensagem como contexto. Uma aspa sem fechamento sinaliza cobertura parcial, inclusive quando a mensagem não contém backticks. Quando uma oração anterior já comprovou uma operação, a matriz mantém essa evidência na linha parcial.

- `REQ-180` reproduz ``Retornar a mensagem "Falhou. Calcular com `OK` de `a.mjs`. Tente novamente."``. A matriz marca cobertura limitada mesmo com um teste aprovado que menciona o requisito e chama `OK`.
- `REQ-181` remove as aspas da mesma frase. Nesse caso, `` Calcular com `OK` de `a.mjs` `` é uma oração e o vínculo é comprovado em três passadas.
- Os controles adicionais cobrem aspas simples, tipográficas e escapadas, apóstrofo em palavra, mensagem sem fechamento e operação explícita antes ou depois da mensagem.

## Verificações

- O teste focal reproduziu o falso positivo em `3096142a`, com `REQ-180` marcado como `ok`. A regressão usa fontes e testes nominais em diretórios temporários.
- `npx tsc --noEmit --skipLibCheck`, `node --check deploy/modules/qa/collect.mjs` e `git diff --check` passaram.
- `env -u AC_MODULE_LAB -u QA_SYNTHETIC_PROOF -u QA_MODULE_RUNTIME node --import tsx --test tests/module-qa.test.ts` registrou 41 aprovações e um caso pulado, condicionado à prova privada.
