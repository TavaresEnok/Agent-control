# C2 Matriz · Operação e resultado esperado

A matriz classifica cada referência qualificada pelo texto da oração em que ela aparece. O coletor lê o contexto antes e depois da expressão, incluindo o qualificador posterior a `símbolo` de `arquivo` e o fechamento dos parênteses. Pontos dentro dos nomes de arquivos e sinais dentro de trechos de código não delimitam orações. Quando a prosa deixa o papel da referência ambíguo, a linha indica cobertura limitada.

- REQ-143 mantém a descrição de `OK` como saída esperada antes da referência. REQ-144 testa a referência simples seguida de `como resultado esperado`. REQ-149 testa o mesmo qualificador depois de uma expressão parentetizada introduzida por `calcular com`. A asserção sobre a função homônima `OK` conclui nas três passadas e aparece na linha da própria função. Os requisitos que descrevem o resultado esperado ficam `skipped` por cobertura limitada.
- REQ-156 e REQ-157 comprovam `primeira` nas formas parentetizada e simples de `calcular com` após a oração `Para obter o resultado esperado`. REQ-158 comprova dois alvos em operações coordenadas depois de uma oração sobre o resultado. REQ-159 comprova uma operação antes de outra oração sobre o resultado.
- REQ-145 e REQ-147 conservam a identificação da operação quando a mesma linha também descreve um retorno qualificado. REQ-148 e REQ-160 mantêm cobertura limitada para uma menção em prosa, nas formas simples e parentetizada.

## Verificação local

- A fixture focal reproduziu os dois achados em `cc2d5127`. REQ-144 e REQ-149 foram indevidamente comprovados, enquanto REQ-156 e REQ-157 ficaram com cobertura limitada.
- `npx tsc --noEmit --skipLibCheck` e `git diff --check` passaram com Node `24.22.1`.
- A execução isolada de `tests/module-qa.test.ts` com dados sintéticos teve 40 testes aprovados e uma prova privada pulada por depender de configuração externa. As variáveis de laboratório e de prova privada foram desativadas.
