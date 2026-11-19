# C2 R12 · Matriz de requisitos e asserções

Base do worktree `9e72a930`. Implementação da ordem C2 R12 a partir do parecer sobre `735da841..2a440fd9`.

## Atribuição e cobertura

- A matriz preserva cada par de símbolo e arquivo em listas e em prosa, inclusive quando as referências são separadas por `além de`. Um teste com o ID correto e uma importação homônima de outro arquivo fica fora da prova para o alvo qualificado. Se o requisito começa com uma lista de nomes sem origem e o texto seguinte os descreve como valores esperados, a referência fica ambígua. Uma lista isolada de nomes ainda pode indicar alvos.
- Uma condição `if` que usa uma função importada do snapshot e pode lançar no próprio ramo gera um candidato de cobertura limitada. A instrumentação continua exigindo uma asserção observada para comprovar a função. Um `failed`, `skipped` ou `todo` observado elimina o candidato do critério de três aprovações. Os resultados de cada passada continuam visíveis.
- A linha por funcionalidade descreve a conclusão e a reprovação a partir dos eventos da identidade exportada. Uma asserção reprovada e capturada aparece mesmo quando o teste conclui outra asserção. Um vínculo de exportação instável deixa a atribuição da asserção limitada.
- A presença de testes Python ou Go no inventário limita a conclusão de ausência de evidência pela matriz Node. Provas Node positivas continuam válidas. Um inventário vazio confirmado mede a ausência de testes inclusive para referências resolvidas com vínculo instável.
- Os callbacks simples de `assert.throws` e `assert.doesNotThrow` marcam o despacho depois dos argumentos, preservando a chamada direta ao alvo, o receptor e a quantidade de argumentos. O matcher de exceção pode observar o callback como chamador imediato do alvo.

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou com Node 24.22.1 e com Node 22.23.4. `git diff --check` passou.
- `env -u AC_MODULE_LAB -u QA_SYNTHETIC_PROOF -u QA_MODULE_RUNTIME node --import tsx --test tests/module-qa.test.ts` executou somente o arquivo de testes alterado com Node 24.22.1. Foram 40 aprovações e um caso pulado por depender da configuração de prova privada.
- Os testes cobrem valores esperados com exportações homônimas, duas referências separadas por `além de`, caminho qualificado em prosa, verificação manual, a sequência `passed,failed,passed` com `unsupported`, falha de asserção capturada e inventário vazio com vínculo instável. Para o projeto misto, o coletor local confirmou o escopo parcial. Em diretórios temporários os três resultados Node foram entregues à matriz, que conservou a prova positiva e classificou o segundo requisito como limitado.
- Uma reprodução isolada da divisão por zero com matcher de pilha reprovou com o coletor e o runner da base e passou na R12 sob Node 24.22.1.

## Pendências de validação

- A medição local de V8 falhou sob Node 22.23.4 com `QA_V8_WORKER_COVERAGE_MISSING`. A reprodução isolada confirmou o mesmo erro na base e na R12. A prova funcional do runner foi obtida sob Node 24.22.1.
- A prova privada e a homologação em contêiner ficaram pendentes. A suíte completa, o laboratório, as imagens, os logins e a instalação viva ficaram fora do escopo da ordem.
