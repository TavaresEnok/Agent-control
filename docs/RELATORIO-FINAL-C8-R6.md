# C8-R6 — Projetos TypeScript ativos e origem das arestas documentadas

Implementado no worktree `final-c8`, no ramo `task/final-c8`, a partir de `5c92b552`. A alteração responde à revisão de `fafc14d3` e inclui regressões com dados sintéticos no arquivo de testes do módulo.

## Resultados

| Cenário | Evidência local |
| --- | --- |
| Seleção TypeScript com atribuições de ambiente | O TypeScript 5.9.3, invocado diretamente sobre a fixture, resolveu `./billing` para `billing.native.ts` com `moduleSuffixes`. O coletor reconheceu `build.json` após duas atribuições literais e `npx --no-install`. Registrou resolução parcial e zero divergências. Ao retirar `moduleSuffixes` de `build.json`, o coletor apontou `billing.ts` no grafo isolado, apesar de o outro projeto citado em comentários ainda conter a opção. |
| Comentários e palavras do shell | O teste cobre uma linha comentada com `;`, `cd` e `&&`, além de uma cauda comentada após o `tsc`. A seleção também aceita `#` literal em valor entre aspas e no nome de um projeto com `tsc -b`. Expansões em atribuições ou argumentos reconhecidos deixam a resolução parcial. Os scripts são lidos como dados e removidos do manifesto entregue às ferramentas. |
| Identidade e cobertura de arestas Mermaid | No Mermaid 12.3.0, dois identificadores reaproveitados por subgrafos mantiveram a identidade de grupo. Na mesma fixture, um nome de arquivo ambíguo, um ausente e uma ligação de layout também ficaram sem medição. O coletor conferiu duas arestas, registrou uma com arquivo conhecido fora do grafo e cinco trechos não medidos. O arquivo ausente gerou apenas o achado próprio do Mermaid. |
| Linha da evidência Mermaid | Com front matter, CRLF, comentário e entidades em outras linhas, a divergência ficou na linha 27 do Markdown e citou `B -->\|chama #43;\| T`. O achado do módulo ausente ficou na linha 22. |
| JSDoc de `export default` | O TypeDoc 0.28.20 detectou o `@param legacy` obsoleto na função anônima. O coletor localizou a tag em `coverage-defect/src/billing.ts:36`. Um diagnóstico sintético de classe anônima apontou o `@link` da linha 2. |

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou com Node.js 22.23.4.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test tests/module-documentacao.test.ts` registrou 20 testes aprovados e um teste de laboratório desativado. Usou as dependências locais fixadas, incluindo dependency-cruiser 18.8.0 e jsdom 31.0.1.
- `node --check deploy/modules/documentacao/collect.mjs` e `git diff --check` passaram.

## Limites e pendências

- A descoberta de projetos cobre invocações reconhecíveis nos manifestos e usa análise estática de palavras de shell. A cobertura de construções arbitrárias do shell continua limitada. O Mermaid usa a linha original quando os alinhamentos concordam e cita o início do bloco com a aresta efetiva nos demais casos.
- O laboratório em contêiner e a suíte completa ficam com o gerente. As regressões sintéticas estão em `tests/module-documentacao.test.ts` e na fixture `coverage-defect`.
