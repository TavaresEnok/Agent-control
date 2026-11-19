# C8-R4 — Cadeias Mermaid e resolução de módulos

Base `bdcaa6c6`, na branch `task/final-c8`. Execução individual conforme a ordem C8-R4.

## Resultado

- O coletor lê cadeias compactas e setas com rótulos entre delimitadores ou entre segmentos da seta. A comparação exige um flowchart aceito pelo parser Mermaid. Trechos fora do subconjunto analisado, como arestas agrupadas com `&`, são contabilizados em `trechos_doc_nao_medidos`.
- A comparação exige que os dois módulos estejam no grafo e que a origem tenha dependências medidas. Falha da ferramenta, origem incompleta e resolução parcial deixam arestas reconhecidas como `arestas_doc_nao_conferidas`.
- O coletor lê a configuração TypeScript ou JavaScript como dados do snapshot e usa sua própria configuração para as ferramentas. A política é conservadora. Opções divergentes ou desconhecidas, modos de resolução implícitos, herança e configurações não analisáveis ou omitidas suspendem a comparação. Isso pode reduzir a cobertura de um projeto cujas opções adicionais sejam inofensivas para aquele grafo.
- Os avisos de `@param` procuram a tag no comentário da declaração. A busca ignora menções em prosa e exemplos cercados.

## Provas locais

- O dependency-cruiser 18.8.0 conferiu sete arestas documentadas em cada fixture do par. Na fixture com defeito, as linhas 6, 7 e 8 registraram a falta de `billing.ts → third.ts`. O controle importa `third.ts` e teve zero divergências. Em cada fixture, a origem `api.test.ts` ficou fora do grafo e a instrução com `&` foi registrada como trecho não medido. O Mermaid 12.3.0 aceitou os dois diagramas.
- O TypeScript 5.9.3 resolveu `./billing` para `billing.native.ts` com `moduleSuffixes`. O coletor registrou cobertura parcial e zero divergências nesse caso. Ao retirar a opção da fixture sintética, o grafo coletado apontou para `billing.ts` e a comparação encontrou a divergência esperada.
- O TypeDoc 0.28.20 apontou as tags obsoletas nas linhas 6 e 12 de `coverage-defect/src/billing.ts`. O teste de localização também distingue uma tag de um exemplo cercado. O controle ficou sem achados.
- `npx tsc --noEmit --skipLibCheck` e `git diff --check` passaram. `env -u AC_MODULE_LAB C8_TEST_LOCAL_TOOLS=1 node --import tsx --test tests/module-documentacao.test.ts` passou com 17 testes, zero falhas e um teste de laboratório ignorado. A execução local usou Node.js 24.22.1 e dados sintéticos.
- O diff contra `bdcaa6c6` confirmou a preservação do digest, do writer comum e da montagem de artefatos. A alteração está restrita ao coletor C8, às suas provas sintéticas e a este relatório.

## Pendências

O laboratório real, o build da imagem e a fixação do novo digest ficam com o gerente. Suíte completa, instalações vivas e logins reais ficaram fora desta rodada.
