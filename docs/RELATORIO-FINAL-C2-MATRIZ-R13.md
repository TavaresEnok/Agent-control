# C2 Matriz R13 · Atribuição de prova em JS

Correção dos dois achados de atribuição do parecer C2-MATRIZ-R12 sobre a base `77afc70d`.

## Requisitos e testes

- A matriz conserva a cobertura limitada quando o resultado de uma chamada importada inicializa uma variável sem reatribuição e o mesmo vínculo lexical aparece em uma guarda `if` com `throw` na mesma função. Na fixture de `somar`, a asserção independente conclui nas três passadas e nenhuma delas atribui essa conclusão a `somar`. O requisito fica `skipped` por cobertura limitada. O controle com variável sombreada continua gerando a lacuna medida e a guarda direta reprovada continua exibindo `passed,failed,passed`.
- A extração usa a posição e os delimitadores da referência. Permanecem válidas a lista isolada de símbolos, a lista qualificada no início e a referência qualificada entre parênteses. Continuam cobertos os caminhos individuais, `de` e `from`, os aliases exportados e a vinculação por título quando o texto não contém referência ambígua. Um trecho como `` A saída esperada é o texto `OK` de `a.mjs`. `` fica `skipped` por cobertura limitada. O teste da exportação homônima `OK` permanece fora da prova, mesmo com o ID no título. Se a frase também declara um alvo explícito, a matriz conserva a identificação desse alvo e indica a ambiguidade na cobertura do requisito.
- O teste real de `REQ-91` passou na base com três execuções sintéticas de `node:test`. A linha por título exibe `asserção reprovada em pelo menos uma passada`. A linha por funcionalidade exibe `asserção do alvo reprovada em pelo menos uma passada`. `outra asserção concluída` faz parte do título do segundo teste. As verificações focadas conferem o detalhe de cada linha e confirmam que esse segundo teste conclui uma asserção, enquanto os eventos de `capturada` registram apenas reprovação.

## Verificação local

- As duas regressões reproduziram na base com as fixtures novas. Após a correção, os três testes focados da matriz passaram.
- `npx tsc --noEmit --skipLibCheck` e `git diff --check` passaram com Node `24.22.1`.
- A execução isolada de `tests/module-qa.test.ts` com as variáveis de laboratório e de prova privada desativadas teve 40 aprovações e um caso pulado por depender da prova privada. O laboratório de 96 casos foi citado na ordem como validação anterior.
