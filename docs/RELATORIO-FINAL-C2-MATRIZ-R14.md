# C2 Matriz R14 · Referências qualificadas e guardas assíncronas

A rodada corrige os dois achados do parecer C2-MATRIZ-R13 sobre a base `f5c5bfea`.

## Referências de requisitos

- REQ-89 e REQ-142 voltaram à redação original das fixtures. A extração reconhece `Calcular com` no início do requisito e `e conferir com` na sequência da primeira referência qualificada. REQ-89 mantém `primeira` em `b.mjs` e registra a lacuna medida quando o teste importa o homônimo de `a.mjs`. REQ-142 comprova `primeira` em `a.mjs` e `segunda` em `b.mjs` nas três passadas.
- A matriz mantém a cobertura limitada quando o contexto de resultado esperado cerca uma referência parentetizada. A fixture de `OK` exercita uma exportação homônima com asserção concluída e ID de requisito no título. Outra fixture mantém a identificação de `primeira` quando a frase também menciona `OK` como retorno. Uma qualificação em prosa sem os marcadores aceitos continua ambígua.

## Guardas manuais

- O coletor acompanha a variável inicializada diretamente por `await` sobre a chamada importada. A guarda `if` com `throw` precisa referenciar a mesma variável sem reatribuição, na mesma função.
- REQ-155 fica `skipped` por cobertura limitada. O teste passa três vezes e conclui a asserção independente em cada passada. Os três conjuntos de evidência por funcionalidade ficam vazios para `somarAsync`. O controle com variável sombreada continua gerando a lacuna medida e a guarda direta mantém o histórico `passed,failed,passed`.

## Verificação local

- A base reproduziu a perda de vínculo do REQ-142 e a ausência de `somarAsync` em `limitedFeatures` com as fixtures atualizadas.
- `npx tsc --noEmit --skipLibCheck` passou com Node 24.22.1.
- A execução isolada de `tests/module-qa.test.ts` com Node 24.22.1 e as variáveis de laboratório e prova privada desativadas teve 40 aprovações e um caso pulado por depender da prova privada. O teste sintético do REQ-91 também confirmou os detalhes de reprovação por título e por funcionalidade.
- `git diff --check` passou.
