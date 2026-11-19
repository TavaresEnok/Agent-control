# C8-R3 — cobertura do grafo e atribuição de símbolos

Base: `f5e54c3b`. As alterações atendem à ordem C8-R3 nos arquivos do coletor e seus testes e fixtures sintéticos.

- A comparação de dependências só emite divergência quando ambas as pontas estão no grafo e a origem não tem importação sem resolução. A cobertura informa arestas conferidas e não conferidas por diagrama e no total.
- A configuração TypeScript continua isolada e sem execução de configurações do repositório. Optou-se pela cobertura parcial explicitamente permitida pela ordem: `paths` ou `extends` em configurações copiadas, configurações JSONC/não analisáveis, ou configurações omitidas por limites/erro, suspendem a comparação de arestas e geram `dependency-cruiser:resolucao` com status `skipped`. Aliases, inclusive os herdados, não são resolvidos nessa situação. Isso é conservador e pode reduzir a cobertura de projetos cujo `extends` não contém aliases.
- A reflexão inclui membros públicos de classes e interfaces, preservando qualificadores; avisos ambíguos não são atribuídos por um nome curto arbitrário. Linhas de `@param` e links são procuradas no comentário associado à declaração, com fallback para a linha da declaração.
- Comentários Mermaid não redefinem nós, e cada aresta de uma cadeia é conferida. A fixture anterior foi ajustada para que a divergência de dependência esteja entre módulos efetivamente cobertos.

Validação com dados sintéticos:

- `C8_TEST_LOCAL_TOOLS=1 node --import tsx --test tests/module-documentacao.test.ts`: 15 aprovados, nenhum erro, um teste de laboratório ignorado. Inclui ferramentas TypeDoc, dependency-cruiser e Mermaid fixadas, fixtures com defeito e controle, alias herdado, teste fora do grafo, comentário Mermaid, segunda aresta divergente, membros e `@param` repetido. Dependências locais do módulo instaladas com `npm ci --ignore-scripts --no-audit --no-fund`; nenhuma imagem foi construída.
- `npx tsc --noEmit --skipLibCheck`: falhou com 130 erros fora dos arquivos alterados; faltam módulos compilados em `upstream/cezar/packages/cezar/dist` e há erros de tipos correlatos no projeto. Não houve diagnóstico nos testes ou fixtures desta alteração.
- `git diff --check`: sem erros.

O laboratório, a suíte completa, imagens e instalação viva não foram executados ou modificados. Não houve acesso a logins reais.
