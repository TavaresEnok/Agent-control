# C8 R5 — Origem das arestas e da configuração TypeScript

Implementado no ramo `task/final-c8`, a partir de `da58dca6`. Escopo do coletor de documentação e dos seus testes sintéticos.

## Cenários verificados

| Cenário | Resultado |
| --- | --- |
| Configuração com nome livre | O TypeScript 5.9.3, chamado diretamente com `-p` sobre os dados sintéticos, resolveu `./billing` para `billing.native.ts` tanto com `build.json` quanto com `tsconfig.build.json`. Com `build.json` selecionado no manifesto e contendo `moduleSuffixes`, o coletor registrou cobertura parcial, deixou a aresta sem comparação e não emitiu divergência. Ao retirar a opção da configuração selecionada, o coletor conferiu a aresta e apontou `billing.ts` no grafo isolado. O arquivo `tsconfig.build.json` permaneceu como controle de configuração sem referência. |
| Descrição de acessibilidade | O grafo efetivo do Mermaid 12.3.0 não incluiu a aresta nem o nó escritos dentro de `accDescr { … }`. A mesma aresta foi conferida quando declarada fora da descrição, na linha 17 considerando o deslocamento do bloco. |
| Rótulo redefinido | Ao redefinir o nó como `Operador`, a ligação ficou com cobertura parcial e o rótulo antigo não gerou achado de dependência nem de arquivo ausente. A redefinição para outro caminho explícito mudou o módulo associado à aresta. |
| Cadeia com seta grossa | `A-->B==chama==>C` e a variante com espaço antes do fechamento produziram as mesmas duas arestas direcionadas, ambas atribuídas à linha da cadeia. |
| Linha de JSDoc | Com `const text = "/**";` dentro da cerca, o diagnóstico sintético localizou `@param legacy` na linha 5. O TypeDoc 0.28.20 também produziu o aviso no fixture real de teste, e o coletor o atribuiu à linha 31 do comentário. |

Foram conferidas a configuração JSONC selecionada por `tsc -b` num manifesto aninhado, a herança local com `extends` em lista e a configuração de nome livre alcançada por `references`. A seleção usa os scripts como dados e as ferramentas recebem apenas o manifesto sanitizado e a configuração isolada. Para a semântica das opções, consulte [seleção de projeto no TypeScript](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html) e [moduleSuffixes](https://www.typescriptlang.org/tsconfig/#moduleSuffixes).

Os testes instalaram zero dependências novas. Foram usadas as versões locais fixadas de Mermaid 12.3.0, TypeScript 5.9.3, TypeDoc 0.28.20, dependency-cruiser 18.8.0 e jsdom 31.0.1. As fixtures de cadeia e ramificação tiveram nove arestas conferidas, uma com origem fora do grafo e quatro divergências plantadas. No controle com as dependências presentes, as mesmas nove arestas foram conferidas e o coletor retornou zero achados. Consulte [flowcharts](https://mermaid.js.org/syntax/flowchart.html) e [descrições de acessibilidade](https://mermaid.js.org/config/accessibility#accessible-description).

## Provas locais

- `npx tsc --noEmit --skipLibCheck` passou.
- `AC_MODULE_LAB=0 C8_TEST_LOCAL_TOOLS=1 node --import tsx --test tests/module-documentacao.test.ts` registrou 19 aprovados e um teste de laboratório pulado.
- `node --check deploy/modules/documentacao/collect.mjs` e `git diff --check` passaram.

## Limites e pendências

- A origem documental usa o banco do parser fixado para os flowcharts. A comparação de imports exige setas direcionadas e caminhos relativos completos em rótulos explícitos. A sintaxe sem grafo disponível e as arestas sem vínculo confiável ficam com cobertura parcial. Quando o pré-processamento impede associar o texto a uma linha original única, o achado cita o início do bloco e a aresta ou o caminho efetivo.
- A seleção TypeScript cobre nomes convencionais e invocações literais de `tsc` reconhecíveis em manifestos. Argumentos dinâmicos reconhecidos, configurações omitidas ou externas, modos implícitos e fronteiras de projetos referenciados geram cobertura parcial. A descoberta estática tem alcance limitado diante de comandos arbitrários de shell e de configurações selecionadas fora dos manifestos.
- A suíte completa, o laboratório do módulo e o aceite do digest ficam com o gerente na integração.
