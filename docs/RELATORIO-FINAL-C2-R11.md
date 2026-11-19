# C2-R11 · Prova de asserção e invocação no QA

## Comportamento

- A matriz exige um teste aprovado e uma asserção nativa concluída nas três passadas. Os operandos diretos já foram avaliados quando a asserção retorna. Em `throws` e `doesNotThrow`, o marcador do alvo só é acionado depois de avaliar os argumentos da chamada e fica associado àquela avaliação do callback. Uma falha capturada e uma exceção no cálculo de um argumento deixam o vínculo sem prova, mesmo quando o teste termina aprovado. A medição de casos funcionais conserva a evidência de reprovação em separado.
- Cada alvo usa o nome exportado e seu caminho no snapshot. O vínculo admite aliases de funções declaradas com `const` e requer uma exportação estável. O caminho de cada símbolo parte da raiz do snapshot. Em prosa histórica, a forma final `` (`símbolo` de `arquivo`) `` mantém um caminho ausente visível como referência sem resolução. Um trecho parentético ambíguo ou um símbolo com exportações homônimas pede qualificação. Texto de valor esperado permanece como contexto.
- Matchers e mensagens após o primeiro argumento de `throws` e `doesNotThrow` preservam o vínculo do callback. Spreads em posição de operando e chamadas opcionais podem limitar a prova de um alvo independentemente do título. A auditoria de `skip` e `todo` verifica o vínculo lexical com o parâmetro de `node:test`.
- Um inventário completo sem candidatos registra a falta medida com `QA-REQUISITO-SEM-PROVA`. A linha de cobertura fica `ok` quando a medição termina, inclusive quando constata uma falta. Uma linha parcial fica `skipped` e conserva os achados das faltas medidas em outros alvos do mesmo requisito. Com execução indisponível, a ausência de candidato ativo é um achado estático separado, `QA-REQUISITO-SEM-CANDIDATO`.

## Provas

- `npx tsc --noEmit --skipLibCheck` passou.
- `env -u AC_MODULE_LAB -u QA_SYNTHETIC_PROOF -u QA_MODULE_RUNTIME node --import tsx --test --test-concurrency=1 tests/module-qa.test.ts` teve 38 aprovações e 1 caso pulado por depender da prova privada.
- Os controles aritméticos com `node:test` e V8 exercitaram falha capturada, exceção de argumento, avaliações intercaladas no mesmo ponto, matcher, mensagem, ordem e quantidade de avaliações, receptor, alias, vínculo mutável e função homônima de outro arquivo. Também verificaram sombra léxica, spreads, lacuna medida junto de cobertura parcial e inventário vazio diante de execução indisponível ou seleção parcial.
- `node --check` nos quatro scripts alterados e `git diff --check` passaram.

## Pendências

A homologação no contêiner e a validação de um novo digest ficam para uma rodada autorizada. A prova da CLI mencionada na ordem está no ramo integrado.
